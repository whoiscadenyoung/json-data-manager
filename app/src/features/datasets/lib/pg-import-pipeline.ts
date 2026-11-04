import {
  assertGeometry,
  computeBbox,
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  roundGeometryCoordinates,
} from "@caden/data-core/geojson";
import type {
  DatasetImportOptions,
  DatasetImportProgress,
  DatasetImportRow,
} from "@caden/json-cms/react/ui";

import type { StoreOptions } from "#/lib/store/client";
import { INLINE_GEOMETRY_SOURCE_BYTES, uploadGeometrySource } from "#/lib/store/geometries";
import {
  chunkRowsForRpc,
  complete,
  fail,
  importChunk,
  start,
  type ImportRpcRow,
} from "#/lib/store/imports";
import { errorMessage } from "@/lib/errors";

/**
 * The Postgres import pipeline (design doc §10) — the create/import flow's
 * ingest half. The Convex edition of this shipped as uploads + a
 * `@convex-dev/workflow` run; on Postgres the whole pipeline is a client-side
 * loop over one set-based RPC:
 *
 * 1. rows arrive already parsed (`@caden/importers`, unchanged — the
 *    `DatasetImporter` review screen owns that half);
 * 2. the dataset's opt-in geometry simplification applies client-side
 *    (rounding to the same 6 dp the component's `simplifyGeometryPayload`
 *    uses);
 * 3. oversized geometry payloads (> `INLINE_GEOMETRY_SOURCE_BYTES`, §6's
 *    256 KB) upload to the `geometries` bucket first and their rows ride
 *    `geometrySourcePath` + a client-supplied bbox instead of an inline
 *    source;
 * 4. an `imports` row opens the attempt, then `import_entries` runs per
 *    ~1.5 MB chunk (one SQL statement each, sequential), reporting progress
 *    per chunk — the chips stay up until the LAST chunk lands and the row
 *    closes as `completed`, never gating on a query's `isLoading`.
 *
 * Every step writes through the `#/lib/store/*` modules; the `imports` row is
 * the attempt's durable record (status, counts, error — one per attempt, so
 * a Retry opens a fresh one).
 */

/** The accumulated progress the pipeline reports through `onProgress`. */
export type PgImportProgress = DatasetImportProgress;

export interface PgImportRunArgs extends StoreOptions {
  datasetId: string;
  rows: ReadonlyArray<DatasetImportRow>;
  options: DatasetImportOptions;
  /** Per-chunk progress sink — the route feeds it into the importer's progress card. */
  onProgress: (progress: PgImportProgress) => void;
}

export interface PgImportRunResult {
  importId: string;
  /** Rows the RPC reported inserting — the attempt's `processed` total. */
  inserted: number;
}

/** Serialized size of one geometry payload — the oversized-upload split's measure (§6). */
function geometryByteLength(geometry: unknown): number {
  return new TextEncoder().encode(JSON.stringify(geometry)).length;
}

/** The row's validated geometry and its type, or null when the row carries none. */
function validatedGeometryOf(row: DatasetImportRow):
  | {
      geometry: ReturnType<typeof assertGeometry>;
      geometryType: string;
    }
  | undefined {
  if (row.geometry === undefined || row.geometry === null) {
    return undefined;
  }
  const geometry = assertGeometry(row.geometry);
  return { geometry, geometryType: geometry.type };
}

/**
 * The rows one chunk will carry: simplification applied, oversized geometries
 * split out to Storage (§10 step 2). Row order is preserved — `rowIndex` keys
 * the storage path, and `import_entries` preserves payload order.
 */
async function toRpcRows(
  datasetId: string,
  rows: ReadonlyArray<DatasetImportRow>,
  simplify: boolean,
  storeOptions: StoreOptions | undefined,
): Promise<ImportRpcRow[]> {
  const rpcRows: ImportRpcRow[] = [];
  let rowIndex = 0;
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- oversized payloads upload sequentially so a failed upload aborts before later chunks are sent.
    rpcRows.push(await toRpcRow(datasetId, row, rowIndex, simplify, storeOptions));
    rowIndex += 1;
  }
  return rpcRows;
}

async function toRpcRow(
  datasetId: string,
  row: DatasetImportRow,
  rowIndex: number,
  simplify: boolean,
  storeOptions: StoreOptions | undefined,
): Promise<ImportRpcRow> {
  const validated = validatedGeometryOf(row);
  if (validated === undefined) {
    return { data: row.data };
  }
  // The dataset-level simplify opt-in (the importer's checkbox): round every
  // coordinate to the component's 6 dp (~11 cm) exactly as the Convex write
  // path's `simplifyGeometryPayload` does — the original file stays retained
  // regardless.
  const geometry = simplify
    ? roundGeometryCoordinates(validated.geometry, GEOMETRY_SIMPLIFY_DECIMAL_PLACES)
    : validated.geometry;
  if (geometryByteLength(geometry) <= INLINE_GEOMETRY_SOURCE_BYTES) {
    return { data: row.data, geometry, geometryType: validated.geometryType };
  }
  // Oversized: PUT to Storage first (§10 step 2), then let the row carry the
  // path — the `geometries` table's storage-backed mode (source_path + a
  // client-supplied bbox; no inline source, no generated geom). Uploads run
  // while the progress card is still indeterminate ("Uploading N rows…").
  const { path, bytes } = await uploadGeometrySource(
    { datasetId, rowIndex, source: geometry },
    storeOptions,
  );
  return {
    bbox: computeBbox(geometry),
    data: row.data,
    geometrySourceBytes: bytes,
    geometrySourcePath: path,
    geometryType: validated.geometryType,
  };
}

/**
 * Runs one import attempt against `datasetId`: opens the `imports` row,
 * uploads oversized payloads, then streams the chunks through
 * `import_entries` sequentially — reporting `processing` progress per chunk —
 * and closes the row as `completed`. A failure inside the chunk loop closes
 * the row as `failed` with the error text (the attempt's durable record,
 * §3.2) before rethrowing; a failure BEFORE the row opened has nothing to
 * close, and the caller's catch owns the UI.
 */
export async function runPgImport(args: PgImportRunArgs): Promise<PgImportRunResult> {
  const { datasetId, rows, options, onProgress } = args,
    storeOptions: StoreOptions = { supabase: args.supabase },
    total = rows.length;

  const rpcRows = await toRpcRows(datasetId, rows, options.simplifyGeometry, storeOptions);
  const importId = await start({ datasetId, total }, storeOptions);

  try {
    const chunks = chunkRowsForRpc(rpcRows);
    let inserted = 0;
    for (const chunk of chunks) {
      // oxlint-disable-next-line no-await-in-loop -- chunks run sequentially: each is one atomic SQL statement, and a failed chunk aborts before later ones are sent.
      inserted += await importChunk({ datasetId, rows: chunk }, storeOptions);
      onProgress({ processed: inserted, skipped: 0, status: "processing", total });
    }
    await complete({ importId }, storeOptions);
    return { importId, inserted };
  } catch (error) {
    await fail(
      {
        error: errorMessage(error, "The import failed."),
        importId,
      },
      storeOptions,
    ).catch(() => {
      // The durable close-out is best-effort: the attempt's error propagates
      // either way, and the caller's recovery actions render it.
    });
    throw error;
  }
}
