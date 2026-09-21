/** One row headed into a dataset import — matches the component's `{ data, geometry? }` upload row shape. */
export interface ImportRow {
  data: unknown;
  geometry?: unknown;
}

const textEncoder = new TextEncoder();

// Row-count cap per chunk. Matches the component's old per-batch insert
// size — still a reasonable default for a chunk that also has to travel as
// one HTTP upload.
const DEFAULT_MAX_ROWS_PER_CHUNK = 500;

// Byte-size cap per chunk, whichever limit is hit first. A chunk of even a
// handful of very large geometries could reach this well before
// DEFAULT_MAX_ROWS_PER_CHUNK rows — and it must stay small enough for the
// component's per-chunk action (`insertChunkFromStorage`) to safely
// download and `JSON.parse` it in Convex's default action runtime (~64 MB),
// which — since components can't use the Node runtime — is the only budget
// available server-side, no matter how large the original file is.
const DEFAULT_MAX_BYTES_PER_CHUNK = 4_000_000;

/**
 * Splits `rows` into upload-sized chunks, capped by both row count and
 * estimated serialized byte size. Runs client-side — the browser already
 * has every row fully parsed in memory at this point (for schema inference
 * / validation), so this reuses that work instead of re-parsing anything;
 * the resulting chunks are what get uploaded to file storage (one
 * `generateUploadUrl` + `fetch` POST each) and handed to `startImport`.
 */
export function chunkRowsForImport(
  rows: ImportRow[],
  options?: { maxRows?: number; maxBytes?: number },
): ImportRow[][] {
  const maxRows =
      options && options.maxRows !== undefined ? options.maxRows : DEFAULT_MAX_ROWS_PER_CHUNK,
    maxBytes =
      options && options.maxBytes !== undefined ? options.maxBytes : DEFAULT_MAX_BYTES_PER_CHUNK,
    chunks: ImportRow[][] = [];
  let current: ImportRow[] = [],
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
