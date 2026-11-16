import { validateViewDefinition } from "@caden/data-core/views";
import type { FieldType, ViewDefinition } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Copy, Loader2, Play, Save, Table2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "@/components/router-button";
import { ViewStepGraph } from "@/features/view-graphs";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import * as projectsStore from "@/lib/store/projects";
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

import { canvasInputTitles, canvasOutputDetail, describeCanvasStep } from "../lib/canvas-nodes";
import { stepDiagnosticsOf } from "../lib/diagnostics";
import { relativeTime, stableJson } from "../lib/format";
import { explainCycle, extractJoinToView, joinPathOf } from "../lib/reuse-actions";
import {
  inputOf,
  nestedOf,
  openStepOf,
  OUTPUT,
  settleSelection,
  type Selection,
} from "../lib/selection";
import {
  fieldsAfter,
  declaredViewFieldTypes,
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
import { InputDetail } from "./input-detail";
import { OutputCard } from "./output-card";
import { PreviewPane, type PreviewRow } from "./preview-pane";
import { RefreshModeControl, type RefreshMode } from "./refresh-mode-control";
import {
  AddStepToolbar,
  InsertStepButton,
  newStepOf,
  StepList,
  type AddableKind,
  type StepEditorContext,
} from "./step-list";
import { StepOutline } from "./step-outline";

/**
 * The view editor (issue #301; docs/views-design.md §9): one full-height
 * workspace. A header with Save, Run, the run status and the stale badge;
 * under it, the step outline on the left, the flow canvas in the middle
 * (click a node to select it, "+" on a connection to insert a step), the
 * selected item's settings on the right, and the preview, run history and
 * exports docked under the canvas. Outline, canvas, settings and preview all
 * follow ONE selection: a step, a nested step, an input or the output.
 *
 * Preview and run go through the server functions (`@/lib/store/views`): the
 * browser sends the DRAFT DEFINITION as JSON, never SQL and never rows.
 */

type DetailTab = "preview" | "runs" | "exports";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "runs", label: "Run history" },
  { id: "exports", label: "Exports" },
];

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

/**
 * An auto refresh runs on the app server, so nothing in this tab learns that
 * it finished: the queue poll only sees the queue row disappear. When it does
 * (queued -> empty), re-read the header, runs and rows so the new run, its
 * counts and the cleared "Stale" badge show without a reload.
 */
function useRefreshWhenQueueDrains(queued: boolean, queryClient: QueryClient): void {
  const wasQueued = useRef(false);
  useEffect(() => {
    if (wasQueued.current && !queued) {
      for (const key of [
        "pg:views",
        "pg:view_runs",
        "pg:view-preview",
        "pg:datasets",
        "pg:entries",
      ]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
    wasQueued.current = queued;
  }, [queued, queryClient]);
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
    [pickedSelection, setSelected] = useState<Selection>(initial.steps.length > 0 ? 0 : OUTPUT),
    // Edits can pull the picked item out from under the selection (a removed sub-step).
    selected = settleSelection(pickedSelection, draft),
    [savedOutput, setSavedOutput] = useState(initial.output),
    [saving, setSaving] = useState(false),
    [running, setRunning] = useState(false),
    [duplicateOpen, setDuplicateOpen] = useState(false),
    [extracting, setExtracting] = useState<{ path: string; rightTitle: string } | undefined>(
      undefined,
    ),
    [extractBusy, setExtractBusy] = useState(false),
    [panelOpen, setPanelOpen] = useState(true),
    [detailTab, setDetailTab] = useState<DetailTab>("preview"),
    navigate = useNavigate(),
    viewSummaries = useQuery(listViewSummariesQueryOptions()),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    // The holding-project titles (#338): pickers suffix them so same-named
    // datasets from different projects don't look identical.
    membershipsQuery = useQuery(projectsStore.listVisibleArtifactMembershipsQueryOptions()),
    projectTitleByDatasetId = new globalThis.Map(
      (membershipsQuery.data ?? [])
        .filter((membership) => membership.artifactKind === "dataset")
        .map((membership) => [membership.artifactId, membership.project.title]),
    ),
    datasets = (datasetsQuery.data ?? [])
      .filter((dataset) => dataset.id !== viewId)
      .map((dataset) => ({
        ...dataset,
        projectTitle: projectTitleByDatasetId.get(dataset.id),
      })),
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
    nestedSelection = nestedOf(selected),
    selectedInput = inputOf(selected),
    selectedInputRef = draft.inputs.find((input) => input.alias === selectedInput),
    // An input selection previews the INPUT alone, as the view reads it: the
    // same one-input, no-steps shape a nested preview starts from.
    inputDraft =
      selectedInputRef === undefined
        ? undefined
        : {
            base: selectedInputRef.alias,
            inputs: [selectedInputRef],
            output: { fields: [], emptyFields: "keep" as const },
            steps: [],
          },
    // A nested selection previews its SUB-PIPELINE: the right input alone,
    // with the steps through the selected one (#334) — the same shape the
    // extract-to-view plan runs, so no compiler option is needed.
    nestedRight =
      nestedSelection === undefined
        ? undefined
        : (() => {
            const join = draft.steps[nestedSelection.join];
            return join !== undefined && join.kind === "join" ? join.right : undefined;
          })(),
    nestedDraft =
      nestedSelection === undefined || nestedRight === undefined || nestedRight.steps === undefined
        ? undefined
        : {
            base: nestedRight.input,
            inputs: draft.inputs.filter((input) => input.alias === nestedRight.input),
            // The view's output block only names fields the FULL pipeline
            // produces; the sub-preview projects nothing.
            output: { fields: [], emptyFields: "keep" as const },
            steps: nestedRight.steps.slice(0, nestedSelection.step + 1),
          },
    nestedStep =
      nestedSelection === undefined || nestedRight === undefined || nestedRight.steps === undefined
        ? undefined
        : nestedRight.steps[nestedSelection.step],
    nestedTitle =
      nestedSelection === undefined || nestedStep === undefined
        ? undefined
        : `Step ${nestedSelection.join + 1}.${nestedSelection.step + 1}: ${STEP_TITLES[nestedStep.kind]}`,
    openStep = openStepOf(selected),
    selectedStep = openStep === undefined ? undefined : draft.steps[openStep],
    uptoStep = typeof selected === "number" ? selected : undefined,
    previewKey = useDebounced(
      stableJson({ draft: nestedDraft ?? inputDraft ?? prunedInputs(draft), uptoStep }),
      450,
    ),
    previewQuery = useQuery({
      queryKey: ["pg:view-preview", viewId, previewKey],
      // An input's own rows don't depend on the steps being complete.
      enabled: metaReady && (inputDraft !== undefined || blockedReason === undefined),
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 30_000,
      queryFn: async () => {
        if (nestedDraft !== undefined && nestedSelection !== undefined) {
          return await previewDraftView(
            nestedDraft,
            inputRefsOf(nestedDraft),
            nestedSelection.step,
          );
        }
        if (inputDraft !== undefined) {
          return await previewDraftView(inputDraft, inputRefsOf(inputDraft));
        }
        const pruned = prunedInputs(draft);
        return await previewDraftView(pruned, inputRefsOf(pruned), uptoStep);
      },
    }),
    diagnosticsIndex = typeof selected === "number" ? selected : draft.steps.length - 1,
    diagnostics =
      previewQuery.data === undefined || diagnosticsIndex < 0 || inputDraft !== undefined
        ? undefined
        : stepDiagnosticsOf(previewQuery.data.diagnostics, diagnosticsIndex),
    runsQuery = useQuery(listRunsQueryOptions(viewId)),
    lastRun = (runsQuery.data ?? [])[0],
    queueQuery = useQuery({
      ...refreshQueueQueryOptions(viewId),
      enabled: header.refreshMode === "auto",
    });
  useRefreshWhenQueueDrains(queueQuery.data !== undefined && queueQuery.data !== null, queryClient);

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
  // Declared field types across the readable datasets (#335): the calculate
  // form names the result type instead of "depends on the data" whenever the
  // field is declared anywhere. Last writer wins on cross-dataset collisions.
  const fieldTypes = new globalThis.Map<string, FieldType>();
  for (const dataset of datasetsQuery.data ?? []) {
    for (const [name, declared] of declaredViewFieldTypes(dataset.jsonSchema)) {
      fieldTypes.set(name, declared);
    }
  }

  const stepContext: StepEditorContext = {
    datasets,
    fieldTypes,
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
    onSelectNestedStep: (joinIndex, stepIndex) => {
      setSelected({ join: joinIndex, step: stepIndex });
    },
    selectedNested: nestedSelection,
  };

  /** Adds a step at `index` of the main flow (the canvas toolbar appends; a connection's "+" inserts). */
  const insertStep = (index: number, kind: AddableKind): void => {
    const fields = fieldsAfter(draft, infos, index - 1) ?? [];
    const step = newStepOf(kind, fields[0] ?? "");
    setDraft((current) => ({
      ...current,
      steps: [...current.steps.slice(0, index), step, ...current.steps.slice(index)],
    }));
    setSelected(index);
  };

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

  const finalFields = fieldsAfter(draft, infos, draft.steps.length - 1);
  const selectedInputInfo = infos.find((info) => info.alias === selectedInput);
  const joinedAt = draft.steps.findIndex(
    (step) => step.kind === "join" && step.right.input === selectedInput,
  );
  const select = (next: Selection): void => {
    setSelected(next);
    setDetailTab("preview");
    setPanelOpen(true);
  };
  const stepList = (only: number | undefined) => (
    <StepList
      ctx={stepContext}
      expanded={openStep}
      nested={false}
      onChange={(steps) => {
        setDraft((current) => ({ ...current, steps }));
      }}
      onExpand={(index) => {
        setSelected(index ?? OUTPUT);
      }}
      only={only}
      pathPrefix="steps"
      startFields={fieldsAfter(draft, infos, -1)}
      steps={draft.steps}
    />
  );
  const outputCard = (expanded: boolean) => (
    <OutputCard
      draft={draft}
      expanded={expanded}
      fields={finalFields}
      onChange={patchDraft}
      onSelect={() => {
        setSelected(OUTPUT);
      }}
    />
  );
  const previewPane = (
    <PreviewPane
      blockedReason={inputDraft === undefined ? blockedReason : undefined}
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
        if (keyMapStep !== undefined && typeof selected === "number") {
          const index = selected;
          const next = withManualMapEntry(keyMapStep, from, to);
          setDraft((current) => ({
            ...current,
            steps: current.steps.map((s, i) => (i === index ? next : s)),
          }));
          toast.success("Added to the key map. The preview refreshes with it.");
        }
      }}
      order={
        savedOutput === undefined || inputDraft !== undefined
          ? undefined
          : savedOutput.fields.map((field) => field.from ?? field.key)
      }
      rows={previewQuery.data === undefined ? undefined : previewRowsOf(previewQuery.data.rows)}
      title={
        selectedInputInfo !== undefined
          ? `Input: ${selectedInputInfo.title}`
          : nestedTitle !== undefined
            ? nestedTitle
            : selectedStep === undefined
              ? "Result"
              : `Step ${Number(selected) + 1}: ${STEP_TITLES[selectedStep.kind]}`
      }
    />
  );
  const exportsCard = (
    <ExportProfilesCard datasetId={viewId} live={live} output={savedOutput} title={header.title} />
  );
  const canvasContext = {
    definition: draft,
    diagnostics: previewQuery.data === undefined ? undefined : previewQuery.data.diagnostics,
    errors: validation.ok ? [] : validation.errors,
    infos,
  };

  const outputDetail = canvasOutputDetail(draft, finalFields);

  return (
    <main className="flex min-h-[40rem] flex-col lg:h-[calc(100vh-7rem)]">
      <div className="border-b px-4 py-3">
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
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav
          aria-label="Step outline"
          className="shrink-0 overflow-y-auto border-b p-2 lg:w-64 lg:border-r lg:border-b-0"
        >
          <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">
            {draft.steps.length === 1 ? "1 step" : `${draft.steps.length} steps`}
          </p>
          <StepOutline
            context={canvasContext}
            onSelect={select}
            outputDetail={outputDetail}
            selected={selected}
          />
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section aria-label="Steps" className="relative min-h-72 flex-1">
            <ViewStepGraph
              className="h-full rounded-none border-0"
              definition={draft}
              onSelectInput={(alias) => {
                select({ input: alias });
              }}
              onSelectOutput={() => {
                select(OUTPUT);
              }}
              onSelectStep={(selection) => {
                select(
                  selection.sub === undefined
                    ? selection.index
                    : { join: selection.index, step: selection.sub },
                );
              }}
              options={{
                describeStep: (selection) => describeCanvasStep(canvasContext, selection),
                inputTitles: canvasInputTitles(infos),
                outputDetail,
              }}
              outputSelected={selected === OUTPUT}
              renderInsert={(index) => (
                <InsertStepButton
                  index={index}
                  onAdd={(kind) => {
                    insertStep(index, kind);
                  }}
                />
              )}
              selectedInput={selectedInput}
              selectedStep={
                typeof selected === "number"
                  ? { index: selected }
                  : nestedSelection === undefined
                    ? null
                    : { index: nestedSelection.join, sub: nestedSelection.step }
              }
            />
            <AddStepToolbar
              className="absolute top-3 left-3"
              disabledReason={metaReady ? undefined : "Loading the inputs…"}
              onAdd={(kind) => {
                insertStep(draft.steps.length, kind);
              }}
            />
          </section>
          <section aria-label="Preview" className="flex shrink-0 flex-col border-t">
            <div className="flex items-center justify-between gap-2 px-2">
              <div aria-label="Details" className="flex gap-1" role="tablist">
                {DETAIL_TABS.map((tab) => (
                  <button
                    aria-selected={panelOpen && detailTab === tab.id}
                    className={
                      panelOpen && detailTab === tab.id
                        ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
                        : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                    }
                    key={tab.id}
                    onClick={() => {
                      setDetailTab(tab.id);
                      setPanelOpen(true);
                    }}
                    role="tab"
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <Button
                aria-expanded={panelOpen}
                aria-label={panelOpen ? "Collapse the details panel" : "Expand the details panel"}
                onClick={() => {
                  setPanelOpen(!panelOpen);
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {panelOpen ? <ChevronDown /> : <ChevronUp />}
              </Button>
            </div>
            {panelOpen && (
              <div className="h-64 overflow-y-auto border-t p-4">
                {detailTab === "preview" && previewPane}
                {detailTab === "runs" && <RunHistory viewId={viewId} />}
                {detailTab === "exports" && exportsCard}
              </div>
            )}
          </section>
        </div>
        <aside
          aria-label="Step settings"
          className="flex shrink-0 flex-col gap-3 overflow-y-auto border-t p-3 lg:w-[26rem] lg:border-t-0 lg:border-l"
        >
          {openStep !== undefined ? (
            stepList(openStep)
          ) : selectedInput === undefined ? (
            outputCard(true)
          ) : (
            <InputDetail
              info={selectedInputInfo}
              projectId={projectId}
              role={
                selectedInput === draft.base
                  ? "Starts from"
                  : joinedAt >= 0
                    ? `Joined in step ${joinedAt + 1}`
                    : "Input"
              }
            />
          )}
        </aside>
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
          <h1 className="truncate text-lg font-semibold text-primary">{header.title}</h1>
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
