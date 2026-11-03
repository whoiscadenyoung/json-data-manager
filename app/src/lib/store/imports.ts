import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, queryScalar, type StoreOptions } from "./client";

/**
 * The imports store (design doc §8.1 "imports.ts # start/chunk/complete over
 * import_entries") — the import pipeline's per-attempt history rows
 * (`public.imports`, DDL §3.2) plus the chunked bulk insert over the
 * `import_entries` RPC (§5.3).
 *
 * The pipeline itself is a client-side loop (§10): `@caden/importers` parses
 * the file, `chunkRowsForRpc` splits the rows into HTTP-sized chunks, and
 * each chunk is one `import_entries` call — one SQL statement per chunk,
 * atomic by itself, so the workflow machinery the Convex backend needed
 * (chunk blobs, a durable journal, server-side resume) collapses into a
 * sequential loop. The `imports` row is the durable record of every attempt:
 * the RPC bumps `processed` per chunk server-side (the §5.3 progress
 * rule), and `complete`/`fail` close it out. One row PER ATTEMPT — a Retry
 * starts a fresh one.
 */

/**
 * One row headed into `import_entries` — the RPC's payload shape (§5.3).
 * `data` is required and object-shaped (the RPC validates both); exactly one
 * of `geometry` (inline GeoJSON) / `geometrySourcePath` (Storage-backed
 * oversized payload, with `geometrySourceBytes` and a client-supplied `bbox`)
 * per row — the `geometries` table's source/source_path pairing (§3.2).
 */
export interface ImportRpcRow {
  data: unknown;
  geometry?: unknown;
  /** The denormalized geometry type; required for storage-backed rows (no inline source to derive it from). */
  geometryType?: string;
  geometrySourcePath?: string;
  geometrySourceBytes?: number;
  /** [minLon, minLat, maxLon, maxLat] — required for storage-backed rows. */
  bbox?: number[];
}

const textEncoder = new TextEncoder();

/**
 * Byte budget per chunk. The design's §10 band is ~1–2 MB of HTTP body per
 * `import_entries` call ("this bound is purely HTTP-shaped" — the Convex
 * action-size budgets do not apply); 1.5 MB sits mid-band.
 */
export const IMPORT_CHUNK_MAX_BYTES = 1_500_000;

/**
 * Rows per chunk, whichever cap binds first — the Convex chunker's row cap
 * kept as an HTTP-shape guard so a chunk of tiny rows still travels as a
 * reasonable single request.
 */
export const IMPORT_CHUNK_MAX_ROWS = 500;

/**
 * Splits parsed import rows into `import_entries`-sized chunks, capped by
 * both row count and serialized byte size (the `chunkRowsForImport`
 * algorithm — estimate each row's JSON length with the same TextEncoder the
 * wire will use — re-targeted at the RPC's chunk band). Runs client-side:
 * the browser already holds every parsed row.
 */
export function chunkRowsForRpc(
  rows: ReadonlyArray<ImportRpcRow>,
  options?: { maxRows?: number; maxBytes?: number },
): ImportRpcRow[][] {
  const maxRows =
      options && options.maxRows !== undefined ? options.maxRows : IMPORT_CHUNK_MAX_ROWS,
    maxBytes =
      options && options.maxBytes !== undefined ? options.maxBytes : IMPORT_CHUNK_MAX_BYTES,
    chunks: ImportRpcRow[][] = [];
  let current: ImportRpcRow[] = [],
    currentBytes = 0;

  for (const row of rows) {
    const rowBytes = textEncoder.encode(JSON.stringify(row)).length;
    if (current.length > 0 && (current.length >= maxRows || currentBytes + rowBytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// The imports row — one per attempt (status, counts, error; §3.2 DDL)
// ---------------------------------------------------------------------------

/** The `imports` wire shape — the columns a consumer needs (`created_by` stays server-side). */
export interface ImportRow {
  id: string;
  datasetId: string;
  status: "pending" | "processing" | "completed" | "failed";
  total: number;
  processed: number;
  skipped: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const IMPORT_SELECT =
  "id,datasetId:dataset_id,status,total,processed,skipped,error,createdAt:created_at,updatedAt:updated_at";

/**
 * Opens the attempt's history row (`status: "pending"`, the declared total).
 * The `import_entries` chunks that follow bump its `processed` server-side
 * (the RPC targets the dataset's most recent open row, §5.3).
 */
export async function start(
  args: { datasetId: string; total: number },
  options?: StoreOptions,
): Promise<string> {
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("imports")
      .insert({ dataset_id: args.datasetId, total: args.total })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Import insert returned no row.");
  }
  return row.id;
}

/**
 * One chunk of rows through `import_entries` (§5.3). Returns the number of
 * rows inserted — the value the caller reports as progress — and bumps the
 * dataset's open import row's `processed` by the same amount server-side.
 * The RPC answers a bare integer (the scalar-RPC shape `queryScalar` reads).
 */
export async function importChunk(
  args: { datasetId: string; rows: ReadonlyArray<ImportRpcRow> },
  options?: StoreOptions,
): Promise<number> {
  const inserted = await queryScalar<number>(
    clientOf(options).rpc("import_entries", {
      p_dataset: args.datasetId,
      p_rows: [...args.rows],
    }),
  );
  if (typeof inserted !== "number") {
    throw new Error("import_entries returned no count.");
  }
  return inserted;
}

/** Closes the attempt as completed — the dataset's row counts are the triggers' work, already done. */
export async function complete(args: { importId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("imports")
      .update({ status: "completed" })
      .eq("id", args.importId)
      .select("id"),
  );
}

/** Closes the attempt as failed with its error — the record a Retry path reads (issue #129 parity). */
export async function fail(
  args: { importId: string; error: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("imports")
      .update({ status: "failed", error: args.error })
      .eq("id", args.importId)
      .select("id"),
  );
}

/** One attempt's row by id, or null when RLS hides it. */
export async function get(
  args: { importId: string },
  options?: StoreOptions,
): Promise<ImportRow | null> {
  return await queryRow<ImportRow>(
    clientOf(options).from("imports").select(IMPORT_SELECT).eq("id", args.importId).limit(1),
  );
}

/** A dataset's import attempts, newest first (the `imports_by_dataset` index). */
export async function listForDataset(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<ImportRow[]> {
  return await queryRows<ImportRow>(
    clientOf(options)
      .from("imports")
      .select(IMPORT_SELECT)
      .eq("dataset_id", args.datasetId)
      .order("created_at", { ascending: false })
      .limit(50),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads)
// ---------------------------------------------------------------------------

export function getQueryOptions(args: { importId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:imports", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listForDatasetQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:imports", "listForDataset", args],
    queryFn: async () => await listForDataset(args, options),
  });
}
