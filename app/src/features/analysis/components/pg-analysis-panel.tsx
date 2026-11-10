import { ANALYSIS_PREVIEW_ROWS, MAX_ANALYSIS_RESULT_ROWS } from "@caden/analysis/caps";
import { declaredColumnTypes } from "@caden/data-core/transform";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
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
import { useQuery } from "@tanstack/react-query";
import { Database, Play, Plus, Table2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PgDatasetPickerSheet } from "#/features/catalog";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetRow, DatasetSummaryRow } from "#/lib/store/datasets";

import { runAnalysis } from "../lib/analysis";
import type { AnalysisRunPhase, AnalysisTableTarget } from "../lib/analysis";

/**
 * The Analyze tab's Postgres edition: freeform read-only SQL over THIS
 * dataset (registered as `source`) plus optional side tables, run by the same
 * worker and the same DuckDB-WASM engine (`@caden/analysis` unchanged),
 * fed from the PG row-resolution seam.
 *
 * Saved analyses (the derived registry) retired in #301: this is an unsaved
 * scratch pad now. Durable results are views (the view editor); the whole tab
 * retires in #306 when scratch queries move to the server.
 */

/** One configured side table: the SQL alias the query uses + the dataset feeding it. */
interface SideTable {
  alias: string;
  datasetId: string;
}

interface EditorDraft {
  sql: string;
  tables: SideTable[];
}

const EMPTY_DRAFT: EditorDraft = { sql: "", tables: [] };

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
export function PgAnalysisPanel({
  dataset,
  datasetTitle,
  schemaId,
}: {
  dataset: DatasetRow;
  datasetTitle: string;
  schemaId: string;
}) {
  const candidates = useQuery(datasetsStore.listSummariesQueryOptions()).data,
    [draft, setDraft] = useState(EMPTY_DRAFT),
    [running, setRunning] = useState(false),
    [runPhase, setPhase] = useState<AnalysisRunPhase | undefined>(undefined),
    [runOutcome, setRunOutcome] = useState<RunOutcome | undefined>(undefined),
    // The run-id guard (#133 item 8): a late result whose stamp is stale
    // never touches state.
    runSeqRef = useRef(0),
    mountedRef = useRef(true),
    // The source's declared column types, read off the store's dataset row
    // (the typed-structures invariant — columns register from the DECLARED
    // structure, engine inference only covers what rows carry beyond it).
    sourceColumns = declaredColumnTypes(dataset.jsonSchema),
    edit = (patch: Partial<EditorDraft>) => {
      setDraft({ ...draft, ...patch });
    },
    sqlText = draft.sql,
    tableDatasetIds = draft.tables
      .filter((table) => table.datasetId !== "")
      .map((table) => table.datasetId),
    formProblem = formProblemOf(draft.tables);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Scratch query</CardTitle>
          <CardDescription>
            Read-only SQL over {datasetTitle} (registered as <code>source</code>). Nothing here ever
            changes {datasetTitle}&apos;s data, and nothing is saved: to keep a result, build a
            view.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
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
