import { ANALYSIS_PREVIEW_ROWS, MAX_ANALYSIS_RESULT_ROWS } from "@caden/analysis/caps";
import { declaredColumnTypes } from "@caden/data-core/transform";
import { ConfirmDialog } from "@caden/json-cms/react/ui";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@caden/ui/components/table";
import { Textarea } from "@caden/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { Database, Play, Plus, Table2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DerivedHealthBadges } from "#/components/dataset-type-tags";
import { PgDatasetPickerSheet } from "#/features/catalog";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetRow, DatasetSummaryRow } from "#/lib/store/datasets";
import * as derivedStore from "#/lib/store/derived";
import type { DerivedDatasetSummaryRow, DerivedDatasetWithHealth } from "#/lib/store/derived";
import { useSession } from "@/integrations/supabase/provider";

import { runAnalysis } from "../lib/analysis";
import type { AnalysisRunPhase, AnalysisTableTarget } from "../lib/analysis";

/**
 * The Analyze tab's Postgres edition (stage 5, #204; the Convex
 * AnalysisPanel's counterpart, docs/analysis-layer-design.md invariants
 * intact): freeform read-only SQL over THIS dataset (registered as
 * `source`) plus optional side tables, run by the same worker and the same
 * DuckDB-WASM engine (`@caden/analysis` unchanged — including its blob-worker
 * `?url` absolutization), fed from the PG row-resolution seam
 * (`dataset-rows-pg.ts`) instead of the Convex one.
 *
 * What the backend swap changes, each load-bearing:
 * - The registry is the store's derived module (`#/lib/store/derived`,
 *   design §8.1): drafts autosave there and reload reconstructs them, the
 *   same lifecycle rule as the Convex tab.
 * - The run's backend rides the REQUEST (`backend: "pg"`); each table
 *   target's declared columns + title resolve MAIN-THREAD from the store's
 *   dataset row, so the worker's only fetch on this path is the seam's row
 *   paging. Target resolution is IDENTITY here — stage 5 analyzes live
 *   rows; pin/float over consumer_references lands with the registry's
 *   publishing leg, and the transitional rule keeps Convex datasets on
 *   their own panel unchanged.
 * - A PG run builds a worker-owned supabase client from a fresh access
 *   token (the tile worker's rule — a worker has no cookies).
 *
 * The publish button is deliberately absent: derived publishing over PG
 * lands with the registry/publishing leg (the bundle press still refuses
 * derived members), so this tab saves and runs but does not publish yet.
 */

const AUTOSAVE_DELAY_MS = 800;

/** Draft ids whose auto-resume the user closed — module-level so it survives the tab panel's unmounts (the dismissedAnalysisDraftIds precedent, scoped to this panel). */
const dismissedPgAnalysisDraftIds = new Set<string>();

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

/**
 * One registry save, then the list invalidates — the store modules' write
 * convention (writes invalidate by query key; the namespace follows the
 * store's `pg:` family). MODULE-level on purpose: a per-render closure in
 * the autosave effect's dependency list is an every-render identity, which
 * the hook rules reject in both directions — the editor's save calls this
 * directly, with the awaited in-flight autosave's `baseId` riding along so
 * the two racing saves of issue #135 always land on ONE row.
 */
async function saveRegistryRow(input: {
  baseId: string | undefined;
  description: string | undefined;
  queryClient: QueryClient;
  schemaId: string;
  spec: unknown;
  status: "draft" | "saved";
  title: string;
}): Promise<string> {
  const id = await derivedStore.save({
    description: input.description,
    id: input.baseId,
    spec: input.spec,
    status: input.status,
    title: input.title,
  });
  void input.queryClient.invalidateQueries({ queryKey: ["pg:derived"] });
  return id;
}

/** The signed-in user's newest sql-kind draft for this source, or undefined (the auto-resume rule, scoped to this editor's kind — the summary projection stamps each row `carriesSql`). */
function newestOwnSqlDraftId(
  rows: DerivedDatasetSummaryRow[] | undefined,
  myAuthId: string | undefined,
): string | undefined {
  if (rows === undefined || myAuthId === undefined) {
    return undefined;
  }
  for (const row of rows) {
    if (row.createdBy === myAuthId && row.status === "draft" && row.carriesSql) {
      return row.id;
    }
  }
  return undefined;
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
function draftFromRow(row: DerivedDatasetWithHealth | null | undefined): EditorDraft {
  if (row === null || row === undefined) {
    return EMPTY_DRAFT;
  }
  const spec: unknown = row.spec;
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
    description: row.description ?? "",
    sql: operation.sql,
    tables,
    title: row.title,
  };
}

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
  summaries: DatasetSummaryRow[] | undefined;
  table: SideTable;
}) {
  const [pickerOpen, setPickerOpen] = useState(false),
    chosen = (summaries ?? []).find((entry) => entry.id === table.datasetId),
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
      <PgDatasetPickerSheet
        title="Choose the dataset to join"
        description="Its rows register under the SQL name you set — reference them in the query by that name."
        candidates={(summaries ?? []).filter((entry) => entry.id !== table.datasetId)}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (dataset) => {
          onChange({ datasetId: dataset.id });
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
  /** Cells that carried a value but coerced to null under their column's type (#133 item 12) — surfaced so a silently-emptied column is visible. */
  coercedNulls: number;
  diagnosticsMessage: string | undefined;
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup (the dataset/project page precedent).
function PgAnalysisEditorForm({
  dataset,
  datasetTitle,
  docId,
  initial,
  onClose,
  schemaId,
}: {
  dataset: DatasetRow;
  datasetTitle: string;
  docId: string | undefined;
  initial: EditorDraft;
  onClose: () => void;
  schemaId: string;
}) {
  const queryClient = useQueryClient(),
    candidates = useQuery(datasetsStore.listSummariesQueryOptions()).data,
    [draft, setDraft] = useState(initial),
    [dirty, setDirty] = useState(false),
    [autosave, setAutosave] = useState<"error" | "idle" | "saved" | "saving">("idle"),
    [savedId, setSavedId] = useState<string | undefined>(docId),
    [pendingDelete, setPendingDelete] = useState(false),
    [running, setRunning] = useState(false),
    [runPhase, setPhase] = useState<AnalysisRunPhase | undefined>(undefined),
    [runOutcome, setRunOutcome] = useState<RunOutcome | undefined>(undefined),
    // The in-flight autosave's promise (the TransformEditor rule): explicit
    // Save awaits it so both share one minted row id.
    pendingSaveRef = useRef<Promise<string | undefined> | null>(null),
    // Counts every edit since mount (the TransformEditor rule, issue #135):
    // a save that finishes clears `dirty` only when nothing was typed while
    // it ran.
    revisionRef = useRef(0),
    // The debounce-armed save closure: the unmount flush fires it when the
    // editor closes inside the 800 ms window.
    flushSaveRef = useRef<(() => void) | undefined>(undefined),
    // The run-id guard (#133 item 8): a late result whose stamp is stale
    // never touches state.
    runSeqRef = useRef(0),
    mountedRef = useRef(true),
    // The source's declared column types, read off the store's dataset row
    // (the typed-structures invariant — columns register from the DECLARED
    // structure, engine inference only covers what rows carry beyond it).
    sourceColumns = declaredColumnTypes(dataset.jsonSchema),
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
              id = await saveRegistryRow({
                baseId,
                description: draft.description.trim() === "" ? undefined : draft.description.trim(),
                queryClient,
                schemaId,
                spec: draftToSpec(schemaId, draft),
                status: "draft",
                title: draft.title.trim(),
              });
            setSavedId(id);
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the refs this effect reads/writes (flushSaveRef, revisionRef) are stable by design; listing them would re-arm the debounce mid-typing without changing behavior. The save target is the MODULE-level saveRegistryRow (stable identity — no per-render closure in the list), and the content deps below are the freshness contract: a save captures exactly what the user sees.
  }, [
    canAutosave,
    dirty,
    draft,
    queryClient,
    savedId,
    schemaId,
    setAutosave,
    setDirty,
    setSavedId,
  ]);

  // Closing inside the debounce window must not lose the edit (issue #135,
  // defect 2): fire the armed save. The same cleanup disarms the run-id
  // guard's unmount half (#133 item 8).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
    const id = await saveRegistryRow({
      baseId: settledId,
      description: draft.description.trim() === "" ? undefined : draft.description.trim(),
      queryClient,
      schemaId,
      spec: draftToSpec(schemaId, draft),
      status,
      title: draft.title.trim(),
    });
    setSavedId(id);
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
    // The run-id guard (#133 item 8): a late result from THIS run is dropped
    // on every await boundary below once a newer run exists or the editor
    // unmounted.
    runSeqRef.current += 1;
    const runId = runSeqRef.current,
      stale = () => runSeqRef.current !== runId || !mountedRef.current;
    setRunning(true);
    setRunOutcome(undefined);
    setPhase(undefined);
    try {
      // PG target resolution is IDENTITY (stage 5 analyzes live rows): each
      // side table's declared structure reads once, imperatively, from the
      // store's dataset row — a standing subscription for a one-shot run
      // would be the standing-subscription smell the imperative seam
      // exists to avoid. A null read (invisible/deleted) reports the same
      // denial copy the Convex resolver's non-identity branch does.
      const sideTargets: AnalysisTableTarget[] = [];
      for (const datasetId of tableDatasetIds) {
        // oxlint-disable-next-line no-await-in-loop -- one metadata read per side table, in spec order; a side added twice reads twice (bounded by the editor's row count).
        const row = await readStoreDataset(datasetId);
        if (row === null) {
          setRunOutcome({
            coercedNulls: 0,
            diagnosticsMessage:
              "A dataset in this analysis doesn't exist or you don't have access to it.",
            rows: [],
            truncated: false,
          });
          return;
        }
        const table = draft.tables.find((entry) => entry.datasetId === datasetId),
          alias = table === undefined ? "" : table.alias.trim();
        if (alias === "") {
          continue;
        }
        sideTargets.push({
          as: alias,
          columns: declaredColumnTypes(row.jsonSchema),
          schemaId: row.id,
          title: row.title,
        });
      }
      if (stale()) {
        return;
      }
      const result = await runAnalysis({
        backend: "pg",
        limit: MAX_ANALYSIS_RESULT_ROWS,
        onPhase: (phase) => {
          if (!stale()) {
            setPhase(phase);
          }
        },
        source: {
          as: "source",
          columns: sourceColumns,
          schemaId,
          title: datasetTitle,
        },
        sql: sqlText,
        tables: sideTargets,
      });
      if (stale()) {
        return;
      }
      setRunOutcome({
        coercedNulls: result.diagnostics.coercedNulls,
        diagnosticsMessage: result.diagnostics.error,
        rows: result.rows,
        truncated: result.diagnostics.truncated,
      });
    } catch (error) {
      if (!stale()) {
        toast.error(errorMessage(error, "The analysis run failed."));
      }
    } finally {
      // A stale run's finally must not clear a NEWER run's running/phase
      // state — only its own.
      if (runSeqRef.current === runId && mountedRef.current) {
        setRunning(false);
        setPhase(undefined);
      }
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
      const removed = await derivedStore.remove({ id });
      if (removed === 0) {
        // The store's silent-denial rule: 0 rows = not the creator (or
        // already gone) — surfaced, never toasted as success.
        throw new Error("That analysis doesn't exist or you don't have access to it.");
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:derived"] });
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
            changes {datasetTitle}&apos;s data — the result saves as a derived dataset.
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
              placeholder={`SELECT state, count(*) AS n FROM source GROUP BY state\n\nColumns on source: ${sourceColumnNames(sourceColumns).join(", ") || "(declared columns appear here)"}`}
              value={draft.sql}
              onChange={(event) => {
                edit({ sql: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Read-only. Each string column keeps its text as typed and gains a canonical{" "}
              <code>&lt;column&gt;__key</code> twin: <code>GROUP BY state__key</code> folds
              &quot;Aldine&quot; and &quot;aldine&quot; into one group (and joins 42 with
              &quot;42&quot;); <code>GROUP BY state</code> groups the text as typed.
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
            {runOutcome !== undefined &&
              runOutcome.diagnosticsMessage === undefined &&
              runOutcome.coercedNulls > 0 && (
                <Badge
                  variant="outline"
                  title="Cells that carried a value which doesn't fit the column's type (e.g. text in a number column) — they read as empty."
                >
                  {runOutcome.coercedNulls.toLocaleString()}{" "}
                  {runOutcome.coercedNulls === 1 ? "cell reads" : "cells read"} as empty
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
        description="The saved analysis and its registry row are deleted. Derived datasets created from it stay."
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

/** The declared columns' names (the SQL placeholder's hint line). */
function sourceColumnNames(columns: ReturnType<typeof declaredColumnTypes>): string[] {
  return columns.map((column) => column.name);
}

/** The first form problem across the joined tables, or undefined — alias hygiene AND the added-but-unchosen dataset (a half-picked row must block Run with honest copy). */
function formProblemOf(tables: SideTable[]): string | undefined {
  // Aliases fold case (#133 item 5): SQL names are case-insensitive, so
  // "Restaurants" collides with "restaurants" the moment they register.
  const seen = new Set<string>(["source"]);
  for (const [index, table] of tables.entries()) {
    const name = table.alias.trim();
    if (name === "") {
      return `Joined table ${index + 1}: give it a SQL name.`;
    }
    if (table.datasetId === "") {
      return `Joined table ${index + 1} ("${name}"): choose its dataset.`;
    }
    if (seen.has(name.toLowerCase())) {
      return `The SQL name "${name}" is used more than once (SQL names are case-insensitive).`;
    }
    seen.add(name.toLowerCase());
  }
  return undefined;
}

/**
 * One store dataset row, read imperatively (a one-shot metadata read for the
 * run — the press's `runStoreRead` rule: the store queryFns close over their
 * args and never read TanStack's context).
 */
async function readStoreDataset(datasetId: string): Promise<DatasetRow | null> {
  const queryFn = datasetsStore.getQueryOptions({ datasetId }).queryFn;
  if (queryFn === undefined) {
    throw new Error("The dataset store read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing (pg-bundle-publish's rule).
  return await queryFn({} as never);
}

/** The analyses list for this source (sql-kind rows only — the Transform tab lists the rest). */
function PgAnalysisList({
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
  rows: DerivedDatasetSummaryRow[] | undefined;
}) {
  const analyses = rows === undefined ? undefined : rows.filter((row) => row.carriesSql);
  return (
    <Card>
      <CardHeader>
        <CardTitle>SQL analyses of {datasetTitle}</CardTitle>
        <CardDescription>
          A saved analysis is a derived dataset over this one. Guided enrichment lives in the
          Transform tab; this is the freeform escape hatch.
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
                key={row.id}
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
                  {row.description !== null && (
                    <p className="truncate text-xs text-muted-foreground">{row.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    onEdit(row.id);
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

/** Loads the opened registry row (or starts a new analysis) and hosts the form — the TransformEditor shape: spinner while the row loads, the same card a deleted row gets, and the form keyed per target so `initial` seeds state exactly once. */
function PgAnalysisEditor({
  dataset,
  datasetTitle,
  docId,
  onClose,
  schemaId,
}: {
  dataset: DatasetRow;
  datasetTitle: string;
  docId: string | undefined;
  onClose: () => void;
  schemaId: string;
}) {
  const doc = useQuery({
    ...derivedStore.getQueryOptions({ id: docId ?? "" }),
    enabled: docId !== undefined,
  }).data;

  if (docId !== undefined && doc === undefined) {
    return (
      <div className="flex justify-center items-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }
  if (docId !== undefined && doc === null) {
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
    <PgAnalysisEditorForm
      key={docId ?? "new"}
      dataset={dataset}
      datasetTitle={datasetTitle}
      docId={docId}
      initial={draftFromRow(docId === undefined ? undefined : doc)}
      onClose={onClose}
      schemaId={schemaId}
    />
  );
}

/**
 * The Analyze tab's Postgres edition: the list of this dataset's sql
 * analyses and the editor — the two-view, one-query shape, resumed drafts
 * included (the module-level dismissal set survives the tab's unmounts,
 * same rule as the Convex tab).
 */
export function PgAnalysisPanel({
  dataset,
  datasetTitle,
  schemaId,
}: {
  dataset: DatasetRow;
  datasetTitle: string;
  schemaId: string;
}) {
  const { session } = useSession(),
    myAuthId = session === null ? undefined : session.user.id,
    rows = useQuery(derivedStore.listBySourceQueryOptions({ sourceDatasetId: schemaId })).data,
    [editing, setEditing] = useState<EditingTarget | undefined>(undefined),
    resumedDraftId = newestOwnSqlDraftId(rows, myAuthId),
    autoResumeId =
      resumedDraftId !== undefined && !dismissedPgAnalysisDraftIds.has(resumedDraftId)
        ? resumedDraftId
        : undefined,
    activeId = editing === undefined ? autoResumeId : "isNew" in editing ? "new" : editing.id;

  return activeId === undefined ? (
    <PgAnalysisList
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
    <PgAnalysisEditor
      dataset={dataset}
      datasetTitle={datasetTitle}
      docId={activeId === "new" ? undefined : activeId}
      onClose={() => {
        if (activeId !== "new") {
          dismissedPgAnalysisDraftIds.add(activeId);
        }
        setEditing(undefined);
      }}
      schemaId={schemaId}
    />
  );
}
