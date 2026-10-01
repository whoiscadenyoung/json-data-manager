import { ConfirmDialog } from "@caden/json-cms/react/ui";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Database, Play, Plus, Rocket, Table2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DatasetPickerSheet } from "#/components/dataset-picker-sheet";
import { DerivedHealthBadges } from "#/components/dataset-type-tags";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { Textarea } from "#/components/ui/textarea";
import { runAnalysis } from "#/lib/analysis";
import type { AnalysisRunPhase } from "#/lib/analysis";
import { ANALYSIS_PREVIEW_ROWS, MAX_ANALYSIS_RESULT_ROWS } from "#/lib/analysis-caps";
import { sharedClient } from "#/lib/dataset-rows";
import { errorMessage } from "#/lib/errors";
import { publishDataset } from "#/lib/publish";
import { api } from "#convex/_generated/api";

/**
 * The dataset page's Analyze tab (roadmap stage 9, #105;
 * docs/analysis-layer-design.md): freeform read-only SQL over THIS dataset
 * (registered as "source") plus optional side tables — the power-user
 * escape hatch beside the Transform tab's guided rollup. ONE system, not
 * two: an analysis is a derivedDatasets registry row whose spec carries a
 * sql operation — it drafts (autosaved), saves, publishes, and joins
 * projects exactly like any transform ("zero new lifecycle concepts"), and
 * runs through the same engine interface (`applySql`) a publish executes.
 *
 * Execution shape (the invariants, each load-bearing):
 * - The editor resolves each table target SERVER-side first
 *   (`consumption.analysisTargets` — stage-6 pin/float semantics, the same
 *   `resolveSourceHead` core the map layers use), then hands the RESOLVED
 *   ids to the worker; the worker registers tables from the row-resolution
 *   seam and never fetches rows itself.
 * - The DuckDB-WASM bundle loads only here — first Run of the surface
 *   (and, in-page, a publish whose spec actually carries a sql operation).
 * - Strings materialize into the registered tables as canonical keys (the
 *   0.4 policies): "Aldine"/"aldine" and 42/"42" group together; display
 *   casing is not preserved inside GROUP BY results (recorded in sql.ts).
 * - The Parquet sidecar (doc §3) is conditional and NOT built in v1 — the
 *   worker's registration path is its future substitute point.
 */

const AUTOSAVE_DELAY_MS = 800;

/** Draft ids whose auto-resume the user closed — module-level so it survives the tab panel's unmounts (the dismissedDraftIds precedent). */
const dismissedAnalysisDraftIds = new Set<string>();

type RegistryRow = FunctionReturnType<typeof api.derivedDatasets.listBySource>[number];
type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];
type TargetResolution = FunctionReturnType<typeof api.consumption.analysisTargets>[number];

/** One configured side table: the SQL alias the query uses + the dataset feeding it. */
interface SideTable {
  alias: string;
  datasetId: string;
}

interface EditorDraft {
  description: string;
  sql: string;
  tables: SideTable[];
  title: string;
}

const EMPTY_DRAFT: EditorDraft = { description: "", sql: "", tables: [], title: "" };

/** What the user explicitly opened: an existing row, or a brand-new analysis. */
type EditingTarget = { id: string } | { isNew: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The signed-in user's newest sql-kind draft for this source, or undefined (the TransformBuilder resume rule, scoped to this editor's kind — the server stamps each list row `carriesSql`). */
function newestOwnSqlDraftId(rows: RegistryRow[] | undefined, myAuthId: string | undefined) {
  if (rows === undefined || myAuthId === undefined) {
    return undefined;
  }
  const draft = rows.find(
    (row) => row.createdBy === myAuthId && row.status === "draft" && row.carriesSql,
  );
  return draft === undefined ? undefined : draft._id;
}

/** The spec one editor state serializes into — the same plain data every other transform stores. A HALF-PICKED table row (alias or dataset still empty) stays LOCAL — the transform-model rule ("half-picked steps stay local"): serializing it would submit a spec the save gate rejects, wedging the autosave in a generic error the user cannot clear without finishing the row. */
function draftToSpec(schemaId: string, draft: EditorDraft) {
  return {
    operations: [
      {
        kind: "sql",
        sourceAs: "source",
        sql: draft.sql,
        tables: draft.tables
          .filter((table) => table.alias.trim() !== "" && table.datasetId !== "")
          .map((table) => ({ as: table.alias.trim(), datasetId: table.datasetId })),
      },
    ],
    sourceDatasetId: schemaId,
  };
}

/** The editor state a stored row loads back into (round-trip: same shape draftToSpec writes). */
function draftFromDoc(docId: string | undefined, doc: RegistryRowGet | undefined): EditorDraft {
  if (docId === undefined || doc === null || doc === undefined) {
    return EMPTY_DRAFT;
  }
  const spec = doc.spec;
  if (!isRecord(spec) || !Array.isArray(spec.operations)) {
    return EMPTY_DRAFT;
  }
  const operation = spec.operations.find(
    (candidate: unknown) => isRecord(candidate) && candidate.kind === "sql",
  );
  if (!isRecord(operation) || typeof operation.sql !== "string") {
    return EMPTY_DRAFT;
  }
  const tables: SideTable[] = Array.isArray(operation.tables)
    ? operation.tables.flatMap((table: unknown) =>
        isRecord(table) && typeof table.as === "string" && typeof table.datasetId === "string"
          ? [{ alias: table.as, datasetId: table.datasetId }]
          : [],
      )
    : [];
  return {
    description: doc.description ?? "",
    sql: operation.sql,
    tables,
    title: doc.title,
  };
}

type RegistryRowGet = FunctionReturnType<typeof api.derivedDatasets.get>;

/** The columns a result table renders: first-seen across the (capped) preview rows. */
function resultColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  return columns;
}

/** One result cell as display text — primitives stringify, structures print as JSON (never "[object Object]"). */
function cellText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/** One side-table row: alias input, dataset name, remove. */
function SideTableRow({
  index,
  onChange,
  onRemove,
  summaries,
  table,
}: {
  index: number;
  onChange: (patch: Partial<SideTable>) => void;
  onRemove: () => void;
  summaries: DatasetSummary[] | undefined;
  table: SideTable;
}) {
  const [pickerOpen, setPickerOpen] = useState(false),
    chosen = (summaries ?? []).find((entry) => entry._id === table.datasetId),
    title = chosen === undefined ? undefined : chosen.title;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label={`SQL name for table ${index + 1}`}
        className="w-40"
        placeholder="e.g. restaurants"
        value={table.alias}
        onChange={(event) => {
          onChange({ alias: event.target.value });
        }}
      />
      <Button
        size="sm"
        type="button"
        variant="outline"
        onClick={() => {
          setPickerOpen(true);
        }}
      >
        <Database className="h-3.5 w-3.5" />
        {title ?? "Choose a dataset…"}
      </Button>
      <Button
        aria-label={`Remove table ${index + 1}`}
        size="icon-sm"
        type="button"
        variant="ghost"
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
      <DatasetPickerSheet
        title="Choose the dataset to join"
        description="Its rows register under the SQL name you set — reference them in the query by that name."
        candidates={(summaries ?? []).filter((entry) => entry._id !== table.datasetId)}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (dataset) => {
          onChange({ datasetId: dataset._id });
        }}
      />
    </div>
  );
}

/** The result grid: the first ANALYSIS_PREVIEW_ROWS rows of the (already-capped) run. */
function ResultTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = resultColumns(rows),
    preview = rows.slice(0, ANALYSIS_PREVIEW_ROWS);
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- result rows are positional query output; re-runs replace the array wholesale.
            <TableRow key={index}>
              {columns.map((column) => (
                <TableCell key={column} className="max-w-72 truncate font-mono text-xs">
                  {row[column] === null || row[column] === undefined ? "—" : cellText(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** One analysis run's outcome as the preview renders it. */
interface RunOutcome {
  diagnosticsMessage: string | undefined;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup (the dataset/project page precedent).
function AnalysisEditorForm({
  columns,
  datasetTitle,
  docId,
  initial,
  onClose,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  docId: string | undefined;
  initial: EditorDraft;
  onClose: () => void;
  schemaId: string;
}) {
  const save = useMutation(api.derivedDatasets.save),
    remove = useMutation(api.derivedDatasets.remove),
    candidates = useQuery({ ...convexQuery(api.schemas.listSummaries, { limit: 500 }) }).data,
    [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [autosave, setAutosave] = useState<"error" | "idle" | "saved" | "saving">("idle"),
    [savedId, setSavedId] = useState<string | undefined>(docId),
    // Issue #135, defect 7: deleting a saved analysis is irreversible — the
    // destructive button opens this confirm instead of firing.
    [pendingDelete, setPendingDelete] = useState(false),
    [savedStatus, setSavedStatus] = useState<"draft" | "saved">(
      docId === undefined ? "draft" : "saved",
    ),
    [running, setRunning] = useState(false),
    [runPhase, setPhase] = useState<AnalysisRunPhase | undefined>(undefined),
    [runOutcome, setRunOutcome] = useState<RunOutcome | undefined>(undefined),
    [publishing, setPublishing] = useState(false),
    // The in-flight autosave's promise (the TransformEditor rule): explicit
    // Save and Publish await it so both share one minted row id.
    pendingSaveRef = useRef<Promise<string | undefined> | null>(null),
    // Counts every edit since mount (the TransformEditor rule, issue #135):
    // a save that finishes clears `dirty` only when nothing was typed while
    // it ran — a moved revision means the mid-save edit re-armed the debounce
    // and must survive to its own save.
    revisionRef = useRef(0),
    // The debounce-armed save closure (the TransformEditor rule): the unmount
    // flush fires it when the editor closes inside the 800 ms window.
    flushSaveRef = useRef<(() => void) | undefined>(undefined),
    edit = (patch: Partial<EditorDraft>) => {
      revisionRef.current += 1;
      setDraft({ ...draft, ...patch });
      setDirty(true);
    },
    canAutosave = draft.title.trim() !== "" && draft.sql.trim() !== "",
    sqlText = draft.sql,
    tableDatasetIds = draft.tables
      .filter((table) => table.datasetId !== "")
      .map((table) => table.datasetId),
    // Form hygiene across the joined tables (alias names + a chosen
    // dataset per row) — blocks Run with honest copy instead of letting a
    // half-picked row surface as the resolver's access-denial "missing".
    formProblem = formProblemOf(draft.tables);

  // Debounced draft autosave — the lifecycle doc's "autosave early and
  // often"; a reload reconstructs the analysis from the registry. State
  // changes land in async callbacks only — never synchronously in the
  // effect body (the TransformEditor's rule, its deps list included). The
  // refs it reads/writes (flushSaveRef, revisionRef) are stable by design
  // and deliberately absent from the deps list — re-arming on their mutation
  // would restart the debounce mid-typing.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  useEffect(() => {
    if (!dirty || !canAutosave) {
      flushSaveRef.current = undefined;
      return undefined;
    }
    const run = () => {
      flushSaveRef.current = undefined;
      const revisionAtSave = revisionRef.current,
        runPromise = (async () => {
          setAutosave("saving");
          try {
            // Serialize behind any in-flight save so two debounced saves never
            // race to mint the row id — a duplicate draft row (the
            // TransformEditor rule, issue #135).
            const pending = pendingSaveRef.current,
              baseId = pending === null ? savedId : ((await pending) ?? savedId),
              id = await save({
                description: draft.description.trim() === "" ? undefined : draft.description.trim(),
                id: baseId,
                spec: draftToSpec(schemaId, draft),
                status: "draft",
                title: draft.title.trim(),
              });
            setSavedId(id);
            setSavedStatus("draft");
            if (revisionRef.current === revisionAtSave) {
              setDirty(false);
            }
            setAutosave("saved");
            return id;
          } catch {
            setAutosave("error");
            return undefined;
          }
        })();
      pendingSaveRef.current = runPromise;
    };
    const timer = setTimeout(run, AUTOSAVE_DELAY_MS);
    flushSaveRef.current = run;
    return () => {
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the refs this effect reads/writes (flushSaveRef, revisionRef) are stable by design; listing them would re-arm the debounce mid-typing without changing behavior.
  }, [
    canAutosave,
    dirty,
    draft,
    save,
    savedId,
    schemaId,
    setAutosave,
    setDirty,
    setSavedId,
    setSavedStatus,
  ]);

  // Closing inside the debounce window must not lose the edit (issue #135,
  // defect 2): fire the armed save. A no-op once it already fired, was
  // replaced, or nothing was ever dirty.
  useEffect(() => {
    return () => {
      const flush = flushSaveRef.current;
      if (flush !== undefined) {
        flush();
      }
    };
  }, []);

  /** Persists with `status`, awaiting any in-flight autosave (one row id, always). */
  const persist = async (status: "draft" | "saved"): Promise<string | undefined> => {
    const revisionAtSave = revisionRef.current,
      pending = pendingSaveRef.current,
      settledId = pending === null ? savedId : ((await pending) ?? savedId);
    const id = await save({
      description: draft.description.trim() === "" ? undefined : draft.description.trim(),
      id: settledId,
      spec: draftToSpec(schemaId, draft),
      status,
      title: draft.title.trim(),
    });
    setSavedId(id);
    setSavedStatus(status);
    // An edit made while this save ran keeps `dirty` armed so it autosaves,
    // instead of being cleared away (the TransformEditor rule).
    if (revisionRef.current === revisionAtSave) {
      setDirty(false);
    }
    flushSaveRef.current = undefined;
    setAutosave("saved");
    return id;
  };

  const handleSave = async () => {
    if (draft.title.trim() === "") {
      toast.error("Give the analysis a title — it names the derived dataset.");
      return;
    }
    if (draft.sql.trim() === "") {
      toast.error("Write the SQL query to save.");
      return;
    }
    try {
      await persist("saved");
      toast.success("Analysis saved.");
    } catch (error) {
      toast.error(errorMessage(error, "Could not save the analysis."));
    }
  };

  const handleRun = async () => {
    if (sqlText.trim() === "") {
      toast.error("Write a SQL query to run.");
      return;
    }
    if (formProblem !== undefined) {
      toast.error(formProblem);
      return;
    }
    setRunning(true);
    setRunOutcome(undefined);
    setPhase(undefined);
    try {
      // Resolve-then-feed: each target resolves SERVER-side first (stage-6
      // pin/float semantics), the worker receives concrete component ids.
      const resolutions = await resolveTargetsOf([schemaId, ...tableDatasetIds]),
        byId = new globalThis.Map(resolutions.map((target) => [target.datasetId, target])),
        unresolvable = resolutions.find(
          (target) => target.status !== "identity" && target.status !== "float",
        );
      if (unresolvable !== undefined) {
        setRunOutcome({
          diagnosticsMessage:
            unresolvable.status === "registry"
              ? "This analysis reads another derived dataset — analyze imported datasets (run it after publishing the derived one) for now."
              : "A dataset in this analysis doesn't exist or you don't have access to it.",
          rows: [],
          truncated: false,
        });
        return;
      }
      const source = byId.get(schemaId),
        sourceTarget =
          source === undefined || source.resolvedSchemaId === undefined
            ? undefined
            : { as: "source", schemaId: source.resolvedSchemaId },
        sideTargets = draft.tables.flatMap((table) => {
          const resolved = byId.get(table.datasetId);
          return resolved === undefined || resolved.resolvedSchemaId === undefined
            ? []
            : [{ as: table.alias, schemaId: resolved.resolvedSchemaId }];
        });
      if (sourceTarget === undefined) {
        setRunOutcome({
          diagnosticsMessage: "This dataset couldn't be resolved for analysis.",
          rows: [],
          truncated: false,
        });
        return;
      }
      const result = await runAnalysis({
        limit: MAX_ANALYSIS_RESULT_ROWS,
        onPhase: setPhase,
        source: sourceTarget,
        sql: sqlText,
        tables: sideTargets,
      });
      setRunOutcome({
        diagnosticsMessage: result.diagnostics.error,
        rows: result.rows,
        truncated: result.diagnostics.truncated,
      });
    } catch (error) {
      toast.error(errorMessage(error, "The analysis run failed."));
    } finally {
      setRunning(false);
      setPhase(undefined);
    }
  };

  const handlePublish = async () => {
    if (savedId === undefined) {
      return;
    }
    setPublishing(true);
    try {
      // Publish IS the existing path: a saved registry row through the 5b
      // machine — the server refuses a draft ("save this analysis before
      // publishing it"), so the button says the same up front.
      if (savedStatus !== "saved") {
        toast.error("Save this analysis before publishing it — a draft can't publish.");
        return;
      }
      await publishDataset({ datasetKey: savedId });
      toast.success("Publishing started — materializing the analysis into the catalog.");
    } catch (error) {
      toast.error(errorMessage(error, "Could not publish the analysis."));
    } finally {
      setPublishing(false);
    }
  };

  const handleDelete = async () => {
    const id = savedId;
    if (id === undefined) {
      return;
    }
    try {
      // Disarm the unmount flush first: the row is about to be deleted, and
      // a debounced edit still armed must not re-insert it as a draft.
      flushSaveRef.current = undefined;
      await remove({ id });
      toast.success("Analysis deleted.");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the analysis."));
    }
  };

  const status =
    autosave === "saving"
      ? "Saving draft…"
      : autosave === "error"
        ? "The draft could not be saved — edit anything to retry."
        : autosave === "saved"
          ? "Draft saved — reload any time and resume from the analyses list."
          : dirty && !canAutosave
            ? "Give it a title and a query to start autosaving."
            : "";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{docId === undefined ? "New analysis" : "Edit analysis"}</CardTitle>
          <CardDescription>
            Read-only SQL over {datasetTitle} (registered as <code>source</code>). Nothing here ever
            changes {datasetTitle}&apos;s data — the result saves as a derived dataset and publishes
            like any transform.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="analysis-title">Title</Label>
              <Input
                id="analysis-title"
                placeholder={`e.g. “${datasetTitle} by state”`}
                value={draft.title}
                onChange={(event) => {
                  edit({ title: event.target.value });
                }}
              />
              <p className="text-xs text-muted-foreground">
                Required — the derived dataset&apos;s name in the catalog.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="analysis-description">Description</Label>
              <Input
                id="analysis-description"
                placeholder="Optional — what this analysis is for."
                value={draft.description}
                onChange={(event) => {
                  edit({ description: event.target.value });
                }}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="analysis-sql">SQL</Label>
            <Textarea
              id="analysis-sql"
              className="min-h-40 font-mono text-sm"
              placeholder={`SELECT state, count(*) AS n FROM source GROUP BY state\n\nColumns on source: ${columns.join(", ") || "(declared columns appear here)"}`}
              value={draft.sql}
              onChange={(event) => {
                edit({ sql: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Read-only. String keys group by their canonical form — &quot;Aldine&quot; and
              &quot;aldine&quot; are one group, and 42 groups with &quot;42&quot; (the same policies
              the rollup uses).
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label>Joined tables</Label>
              <Button
                className="w-fit"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  edit({ tables: [...draft.tables, { alias: "", datasetId: "" }] });
                }}
              >
                <Plus className="h-4 w-4" />
                Add table
              </Button>
            </div>
            {draft.tables.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None — the query reads this dataset as <code>source</code>. Add a table to JOIN a
                second dataset by its SQL name.
              </p>
            ) : (
              draft.tables.map((table, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- side tables are positional in a small ordered list; removal remounts the tail harmlessly.
                <SideTableRow
                  key={index}
                  index={index}
                  summaries={candidates}
                  table={table}
                  onChange={(patch) => {
                    edit({
                      tables: draft.tables.map((entry, entryIndex) =>
                        entryIndex === index ? { ...entry, ...patch } : entry,
                      ),
                    });
                  }}
                  onRemove={() => {
                    edit({ tables: draft.tables.filter((_, entryIndex) => entryIndex !== index) });
                  }}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Table2 className="h-5 w-5" />
            Preview
          </CardTitle>
          <CardDescription>
            Runs in the analysis worker over the full dataset — first {ANALYSIS_PREVIEW_ROWS} rows
            shown, capped at {MAX_ANALYSIS_RESULT_ROWS.toLocaleString()}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={running || formProblem !== undefined}
              onClick={() => {
                void handleRun();
              }}
              type="button"
            >
              <Play className="h-4 w-4" />
              {running ? "Running…" : "Run query"}
            </Button>
            {formProblem !== undefined && <p className="text-xs text-destructive">{formProblem}</p>}
            {running && runPhase !== undefined && (
              <p className="text-xs text-muted-foreground">{phaseLabel(runPhase)}</p>
            )}
            {runOutcome !== undefined && runOutcome.truncated && (
              <Badge
                variant="outline"
                title="Raised the cap — the run returned more rows than the limit."
              >
                Result truncated at {MAX_ANALYSIS_RESULT_ROWS.toLocaleString()} rows
              </Badge>
            )}
          </div>
          {runOutcome === undefined ? (
            <p className="text-sm text-muted-foreground">Run the query to see its result here.</p>
          ) : runOutcome.diagnosticsMessage !== undefined ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {runOutcome.diagnosticsMessage}
            </p>
          ) : runOutcome.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">The query returned no rows.</p>
          ) : (
            <ResultTable rows={runOutcome.rows} />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Back to analyses
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{status}</p>
        {savedId !== undefined && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setPendingDelete(true);
            }}
          >
            Delete
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void handlePublish();
          }}
          disabled={savedId === undefined || savedStatus !== "saved" || publishing}
          title={
            savedId === undefined || savedStatus !== "saved"
              ? "Save the analysis first — a draft can't publish."
              : "Materialize the analysis as a published dataset (the same path every transform publishes through)."
          }
        >
          <Rocket className="h-4 w-4" />
          {publishing ? "Publishing…" : "Publish"}
        </Button>
        <Button
          type="button"
          onClick={() => {
            void handleSave();
          }}
        >
          Save analysis
        </Button>
      </div>

      <ConfirmDialog
        destructive
        open={pendingDelete}
        onOpenChange={setPendingDelete}
        title={`Delete "${draft.title.trim() || "this analysis"}"?`}
        description="The saved analysis and its registry row are deleted. Published datasets created from it stay."
        confirmLabel="Delete"
        onConfirm={() => {
          setPendingDelete(false);
          void handleDelete();
        }}
      />
    </div>
  );
}

/** The worker run's transient phase, phrased for the person waiting — the first run downloads the WASM engine (tens of MB), which must never read as a slow query. */
function phaseLabel(phase: AnalysisRunPhase): string {
  if (phase === "loading-engine") {
    return "Loading the SQL engine — the first run downloads it once…";
  }
  return phase === "loading-rows" ? "Loading the dataset's rows…" : "Running the query…";
}

/** The first form problem across the joined tables, or undefined — alias hygiene AND the added-but-unchosen dataset (a half-picked row must block Run with honest copy, not surface later as the resolver's access-denial "missing"). applySql double-checks the server side of the run. */
function formProblemOf(tables: SideTable[]): string | undefined {
  const seen = new Set<string>(["source"]);
  for (const [index, table] of tables.entries()) {
    const name = table.alias.trim();
    if (name === "") {
      return `Joined table ${index + 1}: give it a SQL name.`;
    }
    if (table.datasetId === "") {
      return `Joined table ${index + 1} ("${name}"): choose its dataset.`;
    }
    if (seen.has(name)) {
      return `The SQL name "${name}" is used more than once.`;
    }
    seen.add(name);
  }
  return undefined;
}

/** Resolves the analysis' table targets server-side (stage-6 semantics), typed for the editor's use. */
async function resolveTargetsOf(datasetIds: string[]): Promise<TargetResolution[]> {
  return sharedClient().query(api.consumption.analysisTargets, { datasetIds });
}

/** Loads the opened registry row (or starts a new analysis) and hosts the form — the TransformEditor shape: spinner while the row loads, the same card a deleted row gets, and the form keyed per target so `initial` seeds state exactly once. */
function AnalysisEditor({
  columns,
  datasetTitle,
  docId,
  onClose,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  docId: string | undefined;
  onClose: () => void;
  schemaId: string;
}) {
  const doc = useQuery({
    ...convexQuery(api.derivedDatasets.get, docId === undefined ? "skip" : { id: docId }),
  }).data;

  if (docId !== undefined && doc === undefined) {
    return (
      <div className="flex justify-center items-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (doc === null) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Analysis not found</CardTitle>
          <CardDescription className="mb-4">
            It may have been deleted from another tab.
          </CardDescription>
          <Button type="button" onClick={onClose}>
            Back to analyses
          </Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <AnalysisEditorForm
      key={docId ?? "new"}
      columns={columns}
      datasetTitle={datasetTitle}
      docId={docId}
      initial={draftFromDoc(docId, doc)}
      onClose={onClose}
      schemaId={schemaId}
    />
  );
}

/** The analyses list for this source (sql-kind rows only — the Transform tab lists the rest). */
function AnalysisList({
  datasetTitle,
  myAuthId,
  onEdit,
  onNew,
  rows,
}: {
  datasetTitle: string;
  myAuthId: string | undefined;
  onEdit: (id: string) => void;
  onNew: () => void;
  rows: RegistryRow[] | undefined;
}) {
  const analyses = rows === undefined ? undefined : rows.filter((row) => row.carriesSql);
  return (
    <Card>
      <CardHeader>
        <CardTitle>SQL analyses of {datasetTitle}</CardTitle>
        <CardDescription>
          A saved analysis is a derived dataset — publish it with the same button every transform
          uses. Guided enrichment lives in the Transform tab; this is the freeform escape hatch.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {analyses === undefined ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : analyses.length === 0 ? (
          <Empty className="min-h-40 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Table2 />
              </EmptyMedia>
              <EmptyTitle>No analyses yet</EmptyTitle>
              <EmptyDescription>
                Write SQL over this dataset — e.g. count its rows per state.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" onClick={onNew}>
                <Plus className="h-4 w-4 mr-2" />
                New analysis
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {analyses.map((row) => (
              <li
                key={row._id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{row.title}</p>
                    {row.status === "draft" && (
                      <Badge
                        variant="outline"
                        title={
                          row.createdBy === myAuthId
                            ? "Autosaved draft — save the analysis to surface it in the catalog."
                            : "Another editor's autosaved draft. Editing it continues their draft."
                        }
                      >
                        {row.createdBy === myAuthId ? "Draft" : "Draft (another editor)"}
                      </Badge>
                    )}
                    <DerivedHealthBadges health={row.health} reason={row.healthReason} />
                  </div>
                  {row.description !== undefined && (
                    <p className="truncate text-xs text-muted-foreground">{row.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onEdit(row._id);
                  }}
                >
                  {row.status === "draft" && row.createdBy === myAuthId ? "Resume" : "Edit"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Analyze tab: the list of this dataset's sql analyses and the editor —
 * the TransformBuilder's two-view, one-query shape, resumed drafts included
 * (the module-level dismissal set survives the tab's unmounts, same rule).
 */
export function AnalysisPanel({
  columns,
  datasetTitle,
  schemaId,
}: {
  columns: string[];
  datasetTitle: string;
  schemaId: string;
}) {
  const rows = useQuery({
      ...convexQuery(api.derivedDatasets.listBySource, { sourceDatasetId: schemaId }),
    }).data,
    me = useQuery({ ...convexQuery(api.users.me, {}) }).data,
    myAuthId = me === null || me === undefined ? undefined : me.authId,
    [editing, setEditing] = useState<EditingTarget | undefined>(undefined),
    resumedDraftId = newestOwnSqlDraftId(rows, myAuthId),
    autoResumeId =
      resumedDraftId !== undefined && !dismissedAnalysisDraftIds.has(resumedDraftId)
        ? resumedDraftId
        : undefined,
    activeId = editing === undefined ? autoResumeId : "isNew" in editing ? "new" : editing.id;

  return activeId === undefined ? (
    <AnalysisList
      datasetTitle={datasetTitle}
      myAuthId={myAuthId}
      rows={rows}
      onEdit={(id) => {
        setEditing({ id });
      }}
      onNew={() => {
        setEditing({ isNew: true });
      }}
    />
  ) : (
    <AnalysisEditor
      columns={columns}
      datasetTitle={datasetTitle}
      docId={activeId === "new" ? undefined : activeId}
      onClose={() => {
        if (activeId !== "new") {
          dismissedAnalysisDraftIds.add(activeId);
        }
        setEditing(undefined);
      }}
      schemaId={schemaId}
    />
  );
}
