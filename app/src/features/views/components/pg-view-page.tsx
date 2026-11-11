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
import { Checkbox } from "@caden/ui/components/checkbox";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Database, Loader2, Play, Save, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "@/components/router-button";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import {
  inputMetaQueryOptions,
  savedDefinitionQueryOptions,
  viewHeaderQueryOptions,
} from "@/lib/store/view-reads";
import type { ViewHeaderRow } from "@/lib/store/view-reads";
import { listRunsQueryOptions, previewDraftView, runView, viewDeps } from "@/lib/store/views";
import { saveView } from "@/lib/views/view-save";

import { stepDiagnosticsOf } from "../lib/diagnostics";
import { relativeTime, stableJson } from "../lib/format";
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
import { PreviewPane, type PreviewRow } from "./preview-pane";
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
    [saving, setSaving] = useState(false),
    [running, setRunning] = useState(false),
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
    lastRun = (runsQuery.data ?? [])[0];

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
  const runBlocked = dirty
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
      refreshAll();
      toast.success("View saved. Run it to refresh its rows.");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the view."));
    } finally {
      setSaving(false);
    }
  };

  const run = async (): Promise<void> => {
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
        onRun={() => {
          void run();
        }}
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
          <RunHistory viewId={viewId} />
        </section>
      </div>
    </main>
  );
}

function ViewHeader({
  dirty,
  header,
  lastRun,
  onRun,
  onSave,
  projectId,
  runBlocked,
  running,
  saveBlocked,
  saving,
  viewId,
}: {
  dirty: boolean;
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
            <Badge variant="outline">Refresh: {header.refreshMode ?? "manual"}</Badge>
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
            Run
          </Button>
        </div>
      </div>
      {(saveBlocked !== undefined || runBlocked !== undefined) && (
        <ul className="text-xs text-muted-foreground" data-testid="action-reasons">
          {saveBlocked !== undefined && <li>Save: {saveBlocked}</li>}
          {runBlocked !== undefined && <li>Run: {runBlocked}</li>}
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

/** The output field list: which of the final fields the view keeps. Empty = every field. */
function OutputCard({
  draft,
  expanded,
  fields,
  onChange,
  onSelect,
}: {
  draft: ViewDefinition;
  expanded: boolean;
  fields: string[] | undefined;
  onChange: (next: ViewDefinition) => void;
  onSelect: () => void;
}) {
  const kept = draft.output.fields.map((field) => field.key);
  const keepsAll = kept.length === 0;
  const toggle = (name: string, on: boolean): void => {
    const all = fields ?? [];
    const current = keepsAll ? all : kept;
    const next = on ? [...current, name] : current.filter((key) => key !== name);
    const ordered = all.filter((field) => next.includes(field));
    const everything = ordered.length === all.length;
    onChange({
      ...draft,
      output: {
        ...draft.output,
        fields: everything ? [] : ordered.map((key) => ({ key })),
      },
    });
  };
  return (
    <Card className={expanded ? "border-primary/40" : undefined}>
      <button
        aria-expanded={expanded}
        className="flex flex-col items-start px-4 pt-3 pb-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <span className="text-sm font-medium">Output fields</span>
        <span className="text-xs text-muted-foreground">
          {keepsAll
            ? `All fields${fields === undefined ? "" : ` (${fields.length})`}`
            : `${kept.length} of ${fields === undefined ? kept.length : fields.length} fields kept`}
        </span>
      </button>
      {expanded && (
        <CardContent>
          {fields === undefined ? (
            <p className="text-sm text-muted-foreground">
              The final fields aren&apos;t known until the steps are complete.
            </p>
          ) : (
            <>
              <CardDescription className="mb-2">
                Untick fields to leave them out of the saved rows. Labels and hidden flags come
                later.
              </CardDescription>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {fields.map((name) => (
                  <label className="flex items-center gap-2 text-sm" key={name}>
                    <Checkbox
                      checked={keepsAll || kept.includes(name)}
                      onCheckedChange={(checked) => {
                        toggle(name, checked);
                      }}
                    />
                    <span className="truncate">{name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
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
