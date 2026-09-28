import { applyLookup, type LookupDiagnostics, type LookupOperation } from "@caden/json-cms/react";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import type { DatasetEntryRow } from "#/lib/dataset-rows";
import { fetchDatasetEntryRows } from "#/lib/dataset-rows";
import {
  PREVIEW_ROW_COUNT,
  matchStatLine,
  truncateOrphanKeys,
} from "#/lib/transform-model";

/**
 * The Transform tab's preview (stage 2, #95; docs/derived-datasets-design.md
 * §8): per-step match stats plus the first N resulting rows.
 *
 * The stats are DATASET-TRUE on purpose (§6's "87% of rows matched" is about
 * the whole dataset, and LookupDiagnostics is per-call-scoped): every row
 * set is materialized through the row-resolution seam's imperative path
 * (`fetchDatasetEntryRows` — this module owns no pagination), the stage 1
 * engine runs over `row.data` records client-side, and only the rendered
 * table is capped. Convex is uninvolved in computation; re-computation is
 * debounced and every run is cancellable, so a stale run never paints.
 */
export function TransformPreview({
  operations,
  sourceDatasetId,
}: {
  operations: LookupOperation[];
  sourceDatasetId: string;
}) {
  const [retry, setRetry] = useState(0);

  if (operations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Configure a lookup step to see matched rows and match stats.
      </p>
    );
  }
  // Keyed by the operation CONTENT: a config change remounts the runner
  // (fresh, debounced, cancellable) without effect-timer gymnastics here.
  return (
    <TransformPreviewRun
      key={`${JSON.stringify(operations)}#${retry}`}
      onRetry={() => {
        setRetry(retry + 1);
      }}
      operations={operations}
      sourceDatasetId={sourceDatasetId}
    />
  );
}

type PreviewResult = { rows: Array<Record<string, unknown>>; stats: LookupDiagnostics[] };

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `row.data` as the engine's generic record — keyless when the entry carries no object. */
function dataOf(row: DatasetEntryRow): Record<string, unknown> {
  const data: unknown = row.data;
  return isRecordShaped(data) ? data : {};
}

function TransformPreviewRun({
  operations,
  sourceDatasetId,
  onRetry,
}: {
  operations: LookupOperation[];
  sourceDatasetId: string;
  onRetry: () => void;
}) {
  const [result, setResult] = useState<PreviewResult | undefined>(undefined),
    [failed, setFailed] = useState(false),
    // Identity guard: the caller's operations array is a per-render
    // derivation, so the effect keys on its serialized CONTENT and re-runs
    // only when the spec actually changed.
    scheduledContentRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const content = JSON.stringify([sourceDatasetId, operations]);
    if (content === scheduledContentRef.current) {
      return undefined;
    }
    scheduledContentRef.current = content;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const lookupRows = new globalThis.Map<string, Array<Record<string, unknown>>>(),
            stats: LookupDiagnostics[] = [];
          let rows = (await fetchDatasetEntryRows(sourceDatasetId)).map(dataOf);
          for (const operation of operations) {
            let sideRows = lookupRows.get(operation.lookupDatasetId);
            if (sideRows === undefined) {
              // oxlint-disable-next-line no-await-in-loop -- one-shot debounced run; each dataset's rows load once and cache for the remaining steps.
              sideRows = (await fetchDatasetEntryRows(operation.lookupDatasetId)).map(dataOf);
              lookupRows.set(operation.lookupDatasetId, sideRows);
            }
            const applied = applyLookup(operation, rows, sideRows);
            rows = applied.rows;
            stats.push(applied.diagnostics);
          }
          if (!cancelled) {
            setResult({ rows, stats });
          }
        } catch {
          if (!cancelled) {
            setFailed(true);
          }
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [operations, sourceDatasetId]);

  // Columns come from the FULL output set, not the rendered slice: with a
  // left join whose first rows are all unmatched, a slice-derived column
  // list would hide the namespaced enrichment entirely. (Hook kept above
  // the early returns.)
  const columns = useMemo(() => (result === undefined ? [] : columnSetOf(result.rows)), [result]);

  if (failed) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">Could not load all rows for the preview.</p>
        <Button variant="outline" size="sm" type="button" onClick={onRetry} className="w-fit">
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
          Try again
        </Button>
      </div>
    );
  }
  if (result === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading every row of each dataset to compute dataset-wide match stats…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {operations.map((operation, index) => {
          const diagnostics = result.stats[index];
          return diagnostics === undefined ? null : (
            <MatchStatLine
              // oxlint-disable-next-line react/no-array-index-key -- steps are position-sensitive (ordered fold); id+index is the identity.
              key={`${operation.lookupDatasetId}-${index}`}
              baseKey={operation.baseKey}
              diagnostics={diagnostics}
              step={index + 1}
            />
          );
        })}
      </div>
      <PreviewTable columns={columns} rows={result.rows.slice(0, PREVIEW_ROW_COUNT)} />
      {result.rows.length > PREVIEW_ROW_COUNT && (
        <p className="text-xs text-muted-foreground">
          Showing the first {PREVIEW_ROW_COUNT} of {result.rows.length} rows — the stats above
          cover the whole dataset.
        </p>
      )}
    </div>
  );
}

/** Every column in first-seen order across the rows (base columns first, then namespaced enrichment). */
function columnSetOf(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>(),
    ordered: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

/** One step's §6 stat line: "87% matched; 214 orphan GrantId", with the human-readable orphan list. */
function MatchStatLine({
  baseKey,
  diagnostics,
  step,
}: {
  baseKey: string;
  diagnostics: LookupDiagnostics;
  step: number;
}) {
  const orphans = truncateOrphanKeys(diagnostics.unmatchedKeys);
  return (
    <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
      <p className="text-sm">
        <span className="font-medium">Step {step}</span>
        <span className="text-muted-foreground"> · {matchStatLine(diagnostics, baseKey)}</span>
      </p>
      {diagnostics.droppedRows > 0 && (
        <p className="text-xs text-muted-foreground">
          {diagnostics.droppedRows} {diagnostics.droppedRows === 1 ? "row" : "rows"} dropped by the
          inner match.
        </p>
      )}
      {orphans.shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {orphans.shown.map((key) => (
            <code
              key={key}
              className="rounded bg-muted px-1.5 py-0.5 text-xs"
              title={`No matching row for ${baseKey} ${JSON.stringify(key)}`}
            >
              {key}
            </code>
          ))}
          {orphans.remaining > 0 && (
            <span className="text-xs text-muted-foreground">
              +{orphans.remaining} more orphan {orphans.remaining === 1 ? "key" : "keys"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The preview's first rows, rendered into the full output's column set. */
function PreviewTable({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">This transform produces no rows.</p>;
  }
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
          {rows.map((row, rowIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- preview rows are anonymous record slices with no identity.
            <TableRow key={rowIndex}>
              {columns.map((column) => (
                <TableCell key={column} className="max-w-60 truncate font-mono text-xs">
                  {previewCell(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function previewCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
