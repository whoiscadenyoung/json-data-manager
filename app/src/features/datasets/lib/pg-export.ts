import type { Geometry } from "@caden/data-core/geojson";

import {
  fetchDatasetEntryRows,
  resolveDatasetGeometryRows,
  type DatasetEntryRow,
} from "#/lib/dataset-rows-pg";
import type { StoreOptions } from "#/lib/store/client";
import * as derivedStore from "#/lib/store/derived";
import type { DerivedDatasetSummaryRow } from "#/lib/store/derived";

import {
  enrichExportEntries,
  lookupDatasetIdsOf,
  readyRowsOf,
  type ExportableEntry,
  type ExportTransformSpec,
  type LookupRowsByDatasetId,
  type TransformSummaryLike,
} from "./export";

/**
 * The Postgres edition of the export flows' data half (stage 5, #204): the
 * dataset and group export dialogs' row reads, geometry resolution, and
 * joined-fields enrichment over the PG row-resolution seam, feeding the
 * SAME builders (`buildGeoJsonCollection` / `buildJsonPayload` /
 * `entryRows` / `exportExcelWorkbook`), the SAME readiness gate
 * (`readyRowsOf` — explicitly saved rows whose read-time health is
 * "ready"), and the SAME enrichment fold (`enrichExportEntries`) the Convex
 * dialogs use — the export semantics (completeness, byte-faithfulness,
 * joined-fields rules) live in `./export` and do not drift.
 *
 * Completeness rides the seam: `fetchDatasetEntryRows` pages
 * `entries.listPage` to exhaustion (`nextCursor === null` is done — design
 * §5 intro), so an export always writes the WHOLE dataset without a
 * standing subscription. Oversized geometry payloads (the storage-backed
 * rows, §6) resolve through `resolveDatasetGeometryRows`' short-lived
 * signed URLs; a failed row leaves its geometry unresolved instead of
 * failing the export.
 *
 * PG rows carry no `geometryId` — geometry rows are 1:1 with entries
 * (keyed by `entryId`, the shape `dataset_rows_for_tiles` hands back), so
 * the exported entry's geometry key IS its entry id and
 * `pgExportGeometries`' map is keyed to match.
 */

/** One PG entry row as the exporters' minimal entry shape — the geometry key is the entry id (see the module doc). */
export function pgExportEntryOf(row: DatasetEntryRow): ExportableEntry {
  return {
    _id: row.id,
    data: row.data,
    geometryId: row.geometryType === null ? undefined : row.id,
  };
}

/** The dataset's full entry set, materialized through the seam (specs applied inside it) and adapted for the export builders. */
export async function pgExportEntries(
  datasetId: string,
  options?: StoreOptions,
): Promise<ExportableEntry[]> {
  const rows = await fetchDatasetEntryRows(datasetId, options);
  return rows.map(pgExportEntryOf);
}

/** The dataset's geometry rows resolved to `Geometry` values, keyed by ENTRY id (the PG geometry-row identity — 1:1 with entries). Inline jsonb resolves synchronously; storage-backed payloads fetch through signed URLs, in parallel. */
export async function pgExportGeometries(
  datasetId: string,
  options?: StoreOptions,
): Promise<globalThis.Map<string, Geometry>> {
  const resolved = await resolveDatasetGeometryRows(datasetId, options);
  return new globalThis.Map(resolved);
}

/** The store's summary projection as the readiness gate's row shape (the one field-name difference: the PG row's `id`). */
function summaryAsTransformLike(row: DerivedDatasetSummaryRow): TransformSummaryLike {
  return {
    _id: row.id,
    health: row.health,
    sourceDatasetId: row.sourceDatasetId,
    status: row.status,
  };
}

/** The rows an export may apply over PG: `readyRowsOf`'s recorded rule, over the store's summary projection (explicitly SAVED whose read-time health is "ready" — drafts and stale/orphaned specs never fold into an export). */
export function pgReadyRowsOf(
  summaries: readonly DerivedDatasetSummaryRow[] | undefined,
): TransformSummaryLike[] {
  return readyRowsOf((summaries ?? []).map(summaryAsTransformLike));
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The full registry docs for the given ready summaries (an export is a
 * one-shot read — imperative `get`s, not a standing subscription) and their
 * stored specs as the fold's shape. Docs that vanished between listing and
 * read drop out; a doc whose stored spec lost its operations array
 * contributes an empty (no-op) spec rather than throwing mid-export — the
 * Convex `loadSpecsBySource`'s rules.
 */
async function loadSpecsBySource(
  readyIds: readonly string[],
  options?: StoreOptions,
): Promise<globalThis.Map<string, ExportTransformSpec[]>> {
  const specsBySource = new globalThis.Map<string, ExportTransformSpec[]>();
  for (const id of readyIds) {
    // oxlint-disable-next-line no-await-in-loop -- one doc read per ready row; the store read is a single-row select (bounded), and the fold groups after the loop.
    const doc = await readStoreDerivedDoc(id, options);
    if (doc === null) {
      continue;
    }
    const spec: unknown = doc.spec,
      operations = isRecordShaped(spec) ? spec.operations : undefined,
      exportSpec: ExportTransformSpec = {
        operations: Array.isArray(operations) ? operations : [],
      },
      sourceId = doc.sourceDatasetId ?? doc.sourceDerivedId;
    if (sourceId === null) {
      continue;
    }
    const existing = specsBySource.get(sourceId);
    if (existing !== undefined) {
      existing.push(exportSpec);
    } else {
      specsBySource.set(sourceId, [exportSpec]);
    }
  }
  return specsBySource;
}

/** One full registry row, read imperatively (the press's `runStoreRead` rule — the store queryFns close over their args and never read TanStack's context). */
async function readStoreDerivedDoc(
  id: string,
  options?: StoreOptions,
): Promise<{
  sourceDatasetId: string | null;
  sourceDerivedId: string | null;
  spec: unknown;
} | null> {
  const queryFn = derivedStore.getQueryOptions({ id }, options).queryFn;
  if (queryFn === undefined) {
    throw new Error("The derived store read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing (pg-bundle-publish's rule).
  const doc = await queryFn({} as never);
  return doc === null
    ? null
    : {
        sourceDatasetId: doc.sourceDatasetId,
        sourceDerivedId: doc.sourceDerivedId,
        spec: doc.spec,
      };
}

/**
 * The lookup rows for every dataset the given specs read, streamed through
 * the PG seam (`fetchDatasetEntryRows` — no bespoke pagination) and keyed
 * for the fold. Two specs (or two group members) sharing a lookup dataset
 * fetch it once. A lookup side that can't be read (deleted, or invisible to
 * the viewer) THROWS — the caller turns that into the error toast and
 * aborts the export, the Convex dialogs' behavior for a broken dependency.
 */
export async function pgLoadLookupRows(
  lookupDatasetIds: readonly string[],
  options?: StoreOptions,
): Promise<LookupRowsByDatasetId> {
  const unique = [...new Set(lookupDatasetIds)],
    pairs = await Promise.all(
      unique.map(async (datasetId) => {
        const rows = await fetchDatasetEntryRows(datasetId, options),
          records: Record<string, unknown>[] = [];
        for (const row of rows) {
          // The Convex loader's exact predicate (dataRecordOf): only rows
          // whose data IS an object feed the fold — entryDataRecord's `{}`
          // degradation must not inject a keyless row.
          if (isRecordShaped(row.data)) {
            records.push(row.data);
          }
        }
        return [datasetId, records] as const;
      }),
    );
  return new globalThis.Map(pairs);
}

/**
 * The toggled export's enrichment step over PG, shared by both dialogs:
 * keeps only the ready saved summaries (`pgReadyRowsOf`), loads their spec
 * docs, folds each source dataset's specs onto that source's rows IN PLACE
 * in `rowsBySource`, and returns how many listed rows were skipped for not
 * qualifying (the success toast reports it). Throws on a spec whose
 * duplicate-key policy rejects the data (`LookupKeyConflictError`) or a
 * lookup side that failed to load — callers turn that into the error toast
 * and abort the export.
 */
export async function pgApplyJoinedFields(args: {
  options?: StoreOptions;
  /** Every listed registry summary for the export's targets (saved and draft). */
  rows: readonly DerivedDatasetSummaryRow[];
  rowsBySource: globalThis.Map<string, ExportableEntry[]>;
}): Promise<number> {
  const ready = pgReadyRowsOf(args.rows),
    specsBySource = await loadSpecsBySource(
      ready.map((row) => row._id),
      args.options,
    ),
    lookupRows = await pgLoadLookupRows(
      lookupDatasetIdsOf([...specsBySource.values()].flat()),
      args.options,
    );
  for (const [sourceId, specs] of specsBySource) {
    const rows = args.rowsBySource.get(sourceId);
    if (rows !== undefined) {
      args.rowsBySource.set(sourceId, enrichExportEntries(rows, specs, lookupRows));
    }
  }
  return args.rows.length - ready.length;
}
