import { validateViewDefinition } from "@caden/data-core/views";
import type { ViewDefinition } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, Database, Loader2, Play, Save, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "@/components/router-button";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import {
  inputMetaQueryOptions,
  listViewSummariesQueryOptions,
  savedDefinitionQueryOptions,
  viewHeaderQueryOptions,
} from "@/lib/store/view-reads";
import type { ViewHeaderRow } from "@/lib/store/view-reads";
import {
  listRunsQueryOptions,
  previewDraftView,
  refreshQueueQueryOptions,
  runView,
  setViewRefreshMode,
  viewDeps,
} from "@/lib/store/views";
import { saveView } from "@/lib/views/view-save";

import { stepDiagnosticsOf } from "../lib/diagnostics";
import { relativeTime, stableJson } from "../lib/format";
import { explainCycle, extractJoinToView, joinPathOf } from "../lib/reuse-actions";
import {
  fieldsAfter,
  inputRefsOf,
  prunedInputs,
  stepProblem,
  STEP_TITLES,
  toCompileMeta,
  uniqueAlias,
  validationSummary,
  withManualMapEntry,
  type InputInfo,
} from "../lib/view-model";
import { DuplicateViewDialog } from "./duplicate-view-dialog";
import { ExportProfilesCard } from "./export-profiles-card";
import { ExtractViewDialog } from "./extract-view-dialog";
import { OutputCard } from "./output-card";
import { PreviewPane, type PreviewRow } from "./preview-pane";
import { RefreshModeControl, type RefreshMode } from "./refresh-mode-control";
import { StepList, type StepEditorContext } from "./step-list";

/**
 * The view editor (issue #301; docs/views-design.md §9): a linear step list
 * on the left, the selected step's preview and diagnostics on the right, and
 * a header with Save, Run, the run status and the stale badge.
 *
 * Preview and run go through the server functions (`@/lib/store/views`): the
 * browser sends the DRAFT DEFINITION as JSON, never SQL and never rows.
 */

const OUTPUT = "output" as const;
type Selection = number | typeof OUTPUT;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return debounced;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server's preview rows (`{row_id, d, geom}`) as the table's row shape. */
function previewRowsOf(rows: readonly unknown[]): PreviewRow[] {
  return rows.map((row) => {
    const record = isRecord(row) ? row : {};
    const geom = record["geom"];
    return {
      d: isRecord(record["d"]) ? record["d"] : {},
      geom: isRecord(geom)
        ? { type: typeof geom["type"] === "string" ? geom["type"] : undefined }
        : null,
    };
  });
}

/** The route component: loads the view, then mounts the editor with its saved definition. */
export function PgViewPage({ projectId, viewId }: { projectId: string; viewId: string }) {
  const header = useQuery(viewHeaderQueryOptions(viewId)),
    saved = useQuery(savedDefinitionQueryOptions(viewId));
  if (header.isPending || saved.isPending) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const row = header.data,
    definition = saved.data;
  if (row === null || row === undefined || definition === null || definition === undefined) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-xl font-semibold">View not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been deleted, or you may not have access to it.
        </p>
        <RouterButton className="mt-4" params={{ projectId }} to="/projects/$projectId/catalog">
          Back to the catalog
        </RouterButton>
      </main>
    );
  }
  const parsed = validateViewDefinition(definition.definition);
  if (row.kind !== "view" || !parsed.ok) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-xl font-semibold">{row.title}</h1>
        <p className="mt-2 text-sm text-destructive">
          {row.kind !== "view"
            ? "This dataset is not a view."
            : "The saved steps could not be read. They may have been written by a newer version."}
        </p>
      </main>
    );
  }
  return <ViewEditor header={row} initial={parsed.value} projectId={projectId} viewId={viewId} />;
}

function nameOfDataset(datasets: readonly { id: string; title: string }[], id: string): string {
  const found = datasets.find((dataset) => dataset.id === id);
  return found === undefined ? "dataset" : found.title;
}

// The editor owns the draft, selection, save and run state in one place; the
// pieces it renders are split into components, but the state is not.
// oxlint-disable-next-line eslint/complexity -- one state owner; see above.
function ViewEditor({
  header,
  initial,
  projectId,
  viewId,
}: {
  header: ViewHeaderRow;
  initial: ViewDefinition;
  projectId: string;
  viewId: string;
}) {
  const queryClient = useQueryClient(),
    [draft, setDraft] = useState<ViewDefinition>(initial),
    [baseline, setBaseline] = useState(() => stableJson(initial)),
    [selected, setSelected] = useState<Selection>(initial.steps.length > 0 ? 0 : OUTPUT),
    [savedOutput, setSavedOutput] = useState(initial.output),
    [saving, setSaving] = useState(false),
    [running, setRunning] = useState(false),
    [duplicateOpen, setDuplicateOpen] = useState(false),
    [extracting, setExtracting] = useState<{ path: string; rightTitle: string } | undefined>(
      undefined,
    ),
    [extractBusy, setExtractBusy] = useState(false),
    navigate = useNavigate(),
    viewSummaries = useQuery(listViewSummariesQueryOptions()),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    datasets = (datasetsQuery.data ?? []).filter((dataset) => dataset.id !== viewId),
    refs = inputRefsOf(draft),
    metaQuery = useQuery({ ...inputMetaQueryOptions(refs), placeholderData: keepPreviousData }),
    infos: InputInfo[] = (metaQuery.data ?? []).map((meta) => ({
      alias: meta.alias,
      datasetId: meta.datasetId,
      title: meta.title === null ? "A dataset you can't see" : meta.title,
      fields: meta.fields,
    })),
    metaReady = metaQuery.data !== undefined && metaQuery.data.length === refs.length,
    validation = validateViewDefinition(draft, toCompileMeta(infos)),
    stepProblems = draft.steps.map((step) => stepProblem(step)),
    firstStepProblem = stepProblems.findIndex((problem) => problem !== undefined),
    blockedReason = !metaReady
      ? undefined
      : firstStepProblem >= 0
        ? `Step ${firstStepProblem + 1}: ${stepProblems[firstStepProblem]}`
        : validation.ok
          ? undefined
          : validationSummary(validation.errors),
    dirty = stableJson(draft) !== baseline,
    selectedStep = selected === OUTPUT ? undefined : draft.steps[selected],
    uptoStep = selected === OUTPUT ? undefined : selected,
    previewKey = useDebounced(stableJson({ draft: prunedInputs(draft), uptoStep }), 450),
    previewQuery = useQuery({
      queryKey: ["pg:view-preview", viewId, previewKey],
      enabled: metaReady && blockedReason === undefined,
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 30_000,
      queryFn: async () => {
        const pruned = prunedInputs(draft);
        return await previewDraftView(pruned, inputRefsOf(pruned), uptoStep);
      },
    }),
    diagnosticsIndex = selected === OUTPUT ? draft.steps.length - 1 : selected,
    diagnostics =
      previewQuery.data === undefined || diagnosticsIndex < 0
        ? undefined
        : stepDiagnosticsOf(previewQuery.data.diagnostics, diagnosticsIndex),
    runsQuery = useQuery(listRunsQueryOptions(viewId)),
    lastRun = (runsQuery.data ?? [])[0],
    queueQuery = useQuery({
      ...refreshQueueQueryOptions(viewId),
      enabled: header.refreshMode === "auto",
    });

  const patchDraft = (next: ViewDefinition): void => {
    setDraft(next);
  };
  /** Declares (or reuses) an input for a dataset. Functional updates, so it composes with the step edit that follows. */
  const ensureInput = (datasetId: string): string => {
    const existing = draft.inputs.find((input) => input.ref.id === datasetId);
    if (existing !== undefined) {
      return existing.alias;
    }
    const alias = uniqueAlias(
      nameOfDataset(datasets, datasetId),
      draft.inputs.map((input) => input.alias),
    );
    setDraft((current) =>
      current.inputs.some((input) => input.alias === alias)
        ? current
        : {
            ...current,
            inputs: [...current.inputs, { alias, ref: { kind: "dataset", id: datasetId } }],
          },
    );
    return alias;
  };
  const stepContext: StepEditorContext = {
    datasets,
    diagnostics: previewQuery.data === undefined ? undefined : previewQuery.data.diagnostics,
    ensureInput,
    errors: validation.ok ? [] : validation.errors,
    extract: {
      disabledReason: !metaReady
        ? "Loading the inputs…"
        : blockedReason === undefined
          ? undefined
          : `Fix the steps first: ${blockedReason}`,
      onExtract: (path, rightTitle) => {
        setExtracting({ path, rightTitle });
      },
    },
    infos,
  };

  const baseInfo = infos.find((info) => info.alias === draft.base);
  const saveBlocked = !dirty
    ? "No changes to save."
    : !metaReady
      ? "Loading the inputs…"
      : blockedReason === undefined
        ? undefined
        : `Can't save yet: ${blockedReason}`;
  const live = header.refreshMode === "live";
  // A live view computes from its saved steps on every read, so "Refresh now"
  // only re-reads; the others run and save.
  const runBlocked = live
    ? undefined
    : dirty
      ? "Save your changes first: a run uses the saved steps."
      : header.kind !== "view"
        ? "Only views can be run."
        : undefined;

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["pg:views"] });
    void queryClient.invalidateQueries({ queryKey: ["pg:view_runs"] });
    void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const pruned = prunedInputs(draft);
      await saveView(viewDeps(), viewId, { definition: pruned, inputs: inputRefsOf(pruned) });
      setDraft(pruned);
      setBaseline(stableJson(pruned));
      setSavedOutput(pruned.output);
      refreshAll();
      toast.success("View saved. Run it to refresh its rows.");
    } catch (error) {
      toast.error(
        explainCycle(error, {
          inputIds: draft.inputs.map((input) => input.ref.id),
          viewId,
          views: (viewSummaries.data ?? []).map((view) => ({
            id: view.id,
            inputs: view.inputs,
            title: view.title,
          })),
        }) ?? errorMessage(error, "Couldn't save the view."),
      );
    } finally {
      setSaving(false);
    }
  };

  const extract = async (newTitle: string): Promise<void> => {
    if (extracting === undefined) {
      return;
    }
    setExtractBusy(true);
    try {
      const outcome = await extractJoinToView({
        definition: draft,
        newTitle,
        path: joinPathOf(extracting.path),
        projectId,
        rightTitle: extracting.rightTitle,
        viewId,
      });
      setDraft(outcome.definition);
      setBaseline(stableJson(outcome.definition));
      setSavedOutput(outcome.definition.output);
      setExtracting(undefined);
      refreshAll();
      void queryClient.invalidateQueries({ queryKey: ["pg:projects"] });
      toast.success(`Extracted "${newTitle}" (${outcome.rowCount.toLocaleString()} rows).`, {
        action: {
          label: "Open it",
          onClick: () => {
            void navigate({
              params: { projectId, viewId: outcome.newViewId },
              to: "/projects/$projectId/views/$viewId",
            });
          },
        },
      });
    } catch (error) {
      void queryClient.invalidateQueries({ queryKey: ["pg:views"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      setExtracting(undefined);
      toast.error(errorMessage(error, "Couldn't extract the steps."));
    } finally {
      setExtractBusy(false);
    }
  };

  const [modeBusy, setModeBusy] = useState(false);
  const changeMode = async (mode: RefreshMode): Promise<void> => {
    setModeBusy(true);
    try {
      await setViewRefreshMode(viewId, mode);
      refreshAll();
      void queryClient.invalidateQueries({ queryKey: ["pg:live"] });
      toast.success(
        mode === "auto"
          ? "Auto refresh is on. Runs execute as you."
          : mode === "live"
            ? "This view is live: rows are computed on read."
            : "Refresh set to manual.",
      );
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't change the refresh mode."));
    } finally {
      setModeBusy(false);
    }
  };

  const run = async (): Promise<void> => {
    if (live) {
      await queryClient.invalidateQueries({ queryKey: ["pg:live"] });
      toast.success("Live rows re-read.");
      return;
    }
    setRunning(true);
    try {
      const outcome = await runView(viewId);
      refreshAll();
      if (outcome.status === "ok") {
        toast.success(`Run finished: ${outcome.rowCount.toLocaleString()} rows saved.`);
      } else {
        toast.error(`Run failed: ${outcome.error}`);
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't run the view."));
    } finally {
      setRunning(false);
    }
  };

  const keyMapStep =
    selectedStep !== undefined && selectedStep.kind === "join" ? selectedStep : undefined;

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <ViewHeader
        dirty={dirty}
        header={header}
        lastRun={lastRun}
        onDuplicate={() => {
          setDuplicateOpen(true);
        }}
        onChangeMode={(mode) => {
          void changeMode(mode);
        }}
        modeBusy={modeBusy}
        onRun={() => {
          void run();
        }}
        queue={queueQuery.data}
        onSave={() => {
          void save();
        }}
        projectId={projectId}
        runBlocked={runBlocked}
        running={running}
        saveBlocked={saveBlocked}
        saving={saving}
        viewId={viewId}
      />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <section aria-label="Steps" className="flex flex-col gap-3">
          <Card className="px-4 py-3">
            <p className="text-xs font-medium text-muted-foreground">Starts from</p>
            <p className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4 text-muted-foreground" />
              {baseInfo === undefined ? "Loading…" : baseInfo.title}
            </p>
          </Card>
          <StepList
            ctx={stepContext}
            expanded={selected === OUTPUT ? undefined : selected}
            nested={false}
            onChange={(steps) => {
              setDraft((current) => ({ ...current, steps }));
            }}
            onExpand={(index) => {
              setSelected(index ?? OUTPUT);
            }}
            pathPrefix="steps"
            startFields={fieldsAfter(draft, infos, -1)}
            steps={draft.steps}
          />
          <OutputCard
            draft={draft}
            expanded={selected === OUTPUT}
            fields={fieldsAfter(draft, infos, draft.steps.length - 1)}
            onChange={patchDraft}
            onSelect={() => {
              setSelected(OUTPUT);
            }}
          />
        </section>
        <section aria-label="Preview" className="flex min-w-0 flex-col gap-6">
          <PreviewPane
            blockedReason={blockedReason}
            canMap={keyMapStep !== undefined && keyMapStep.on.length === 1}
            diagnostics={diagnostics}
            error={
              previewQuery.error === null
                ? undefined
                : errorMessage(previewQuery.error, "The preview failed.")
            }
            isLoading={previewQuery.isFetching}
            mapDisabledReason={
              keyMapStep !== undefined && keyMapStep.on.length > 1
                ? "The key map works on joins with a single key pair."
                : "Select a join step to add to its key map."
            }
            onAddToKeyMap={(from, to) => {
              if (keyMapStep !== undefined && selected !== OUTPUT) {
                const index = selected;
                const next = withManualMapEntry(keyMapStep, from, to);
                setDraft((current) => ({
                  ...current,
                  steps: current.steps.map((s, i) => (i === index ? next : s)),
                }));
                toast.success("Added to the key map. The preview refreshes with it.");
              }
            }}
            rows={
              previewQuery.data === undefined ? undefined : previewRowsOf(previewQuery.data.rows)
            }
            title={
              selectedStep === undefined
                ? "Result"
                : `Step ${Number(selected) + 1}: ${STEP_TITLES[selectedStep.kind]}`
            }
          />
          <ExportProfilesCard
            datasetId={viewId}
            live={live}
            output={savedOutput}
            title={header.title}
          />
          <RunHistory viewId={viewId} />
        </section>
      </div>
      <DuplicateViewDialog
        datasets={datasets}
        onOpenChange={setDuplicateOpen}
        open={duplicateOpen}
        projectId={projectId}
        title={header.title}
        viewId={viewId}
      />
      {extracting !== undefined && (
        <ExtractViewDialog
          busy={extractBusy}
          defaultTitle={`${extracting.rightTitle} (extracted)`}
          dirty={dirty}
          onConfirm={(newTitle) => {
            void extract(newTitle);
          }}
          onOpenChange={(next) => {
            if (!next && !extractBusy) {
              setExtracting(undefined);
            }
          }}
          open
          rightTitle={extracting.rightTitle}
        />
      )}
    </main>
  );
}

function ViewHeader({
  modeBusy,
  onChangeMode,
  queue,
  dirty,
  header,
  lastRun,
  onDuplicate,
  onRun,
  onSave,
  projectId,
  runBlocked,
  running,
  saveBlocked,
  saving,
  viewId,
}: {
  modeBusy: boolean;
  onChangeMode: (mode: RefreshMode) => void;
  queue: { dueAt: string; running: boolean } | null | undefined;
  dirty: boolean;
  onDuplicate: () => void;
  header: ViewHeaderRow;
  lastRun:
    | { status: "ok" | "error"; finishedAt: string; rowCount: number | null; error: string | null }
    | undefined;
  onRun: () => void;
  onSave: () => void;
  projectId: string;
  runBlocked: string | undefined;
  running: boolean;
  saveBlocked: string | undefined;
  saving: boolean;
  viewId: string;
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            <Link params={{ projectId }} to="/projects/$projectId/catalog">
              Catalog
            </Link>{" "}
            / View
          </p>
          <h1 className="truncate text-2xl font-bold text-primary">{header.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {header.stale ? (
              <Badge
                title="Inputs or steps changed since the last successful run."
                variant="secondary"
              >
                Stale
              </Badge>
            ) : (
              <Badge variant="outline">Up to date</Badge>
            )}
            {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
            {lastRun !== undefined && lastRun.status === "error" && (
              <Badge title={lastRun.error ?? undefined} variant="destructive">
                Last run failed
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {lastRun === undefined
                ? "Never run"
                : `Last run ${relativeTime(lastRun.finishedAt)}${lastRun.rowCount === null ? "" : `, ${lastRun.rowCount.toLocaleString()} rows`}`}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RouterButton
            params={{ projectId, schemaId: viewId }}
            to="/projects/$projectId/datasets/$schemaId"
            variant="outline"
          >
            <Table2 className="mr-2 h-4 w-4" />
            View rows
          </RouterButton>
          <Button
            onClick={onDuplicate}
            title={
              dirty
                ? "Copies the saved steps (your unsaved changes are not included)."
                : "Copy this view, optionally pointing its inputs at other datasets."
            }
            type="button"
            variant="outline"
          >
            <Copy className="mr-2 h-4 w-4" />
            Duplicate
          </Button>
          <Button disabled={saveBlocked !== undefined || saving} onClick={onSave} type="button">
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
          <Button
            disabled={runBlocked !== undefined || running}
            onClick={onRun}
            type="button"
            variant="outline"
          >
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Refresh now
          </Button>
        </div>
      </div>
      <RefreshModeControl
        autoRunsAs={
          header.autoRefreshBy === null
            ? undefined
            : header.autoRefreshBy === header.createdBy
              ? "the view's creator"
              : "the editor who turned Auto on"
        }
        busy={modeBusy}
        mode={header.refreshMode ?? "manual"}
        onChange={onChangeMode}
        queue={queue}
      />
      {(saveBlocked !== undefined || runBlocked !== undefined) && (
        <ul className="text-xs text-muted-foreground" data-testid="action-reasons">
          {saveBlocked !== undefined && <li>Save: {saveBlocked}</li>}
          {runBlocked !== undefined && <li>Refresh now: {runBlocked}</li>}
        </ul>
      )}
      {lastRun !== undefined && lastRun.status === "error" && lastRun.error !== null && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          The last run failed and the previous rows were kept: {lastRun.error}
        </p>
      )}
    </header>
  );
}

function RunHistory({ viewId }: { viewId: string }) {
  const runs = useQuery(listRunsQueryOptions(viewId));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Run history</CardTitle>
        <CardDescription>The last 50 runs. A failed run keeps the previous rows.</CardDescription>
      </CardHeader>
      <CardContent>
        {runs.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (runs.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet. Save the steps, then press Run.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {(runs.data ?? []).map((run) => (
              <li className="flex flex-wrap items-center gap-3 py-2 text-sm" key={run.id}>
                <Badge variant={run.status === "ok" ? "outline" : "destructive"}>
                  {run.status === "ok" ? "OK" : "Failed"}
                </Badge>
                <span className="text-muted-foreground">{relativeTime(run.finishedAt)}</span>
                {run.rowCount !== null && <span>{run.rowCount.toLocaleString()} rows</span>}
                {run.error !== null && (
                  <span className="min-w-0 flex-1 truncate text-destructive" title={run.error}>
                    {run.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
