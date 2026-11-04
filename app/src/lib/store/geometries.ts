import type { SupabaseClient } from "@supabase/supabase-js";
import { queryOptions } from "@tanstack/react-query";

import {
  clientOf,
  nextPageCursor,
  queryRow,
  queryRows,
  queryScalar,
  STORAGE_SIGNED_URL_TTL_SECONDS,
  type PagedRpcRow,
  type StoreOptions,
} from "./client";
import type { DatasetGeometryType } from "./datasets";

/**
 * The geometries store (design doc §8.1) — the PG counterpart of today's
 * `api.cms.geometries.*`: `list` / `getByEntry` plus the row writes
 * (`create` / `replace` / `remove`) and `rowsForTiles` paging over the
 * `public.geometries` table (DDL §3.2) and the `dataset_rows_for_tiles` RPC
 * (§5.5).
 *
 * Today's Convex surface has NO client-facing geometry writes (a geometry
 * always rode `entries.create`/`entries.update`'s `geometry` arg) — the
 * writes here are the design's PG-native counterparts for the same jobs:
 * entries.ts routes its geometry arg through them, and the import flow's
 * oversized-payload path (§10) uses the storage-backed mode directly.
 *
 * Row identity is the ENTRY (1:1 — `geometries.entry_id` is UNIQUE, the key
 * `dataset_rows_for_tiles` hands back in §5.5); the table's own uuid id is
 * an implementation detail no consumer needs.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL/RPC
 * signatures, not the generated `database.types.ts` (see `./client`).
 *
 * The module also hosts the stage-2 TILE-ARCHIVE store functions (§5.6/§6):
 * the worker's pre-build dataset read, the archive-pointer read, signed
 * read/upload URLs, and the `install_tile_archive` CAS — see the marked
 * section near the bottom for why they live here.
 */

/**
 * One geometry row, as every reader of `geometries` gets it. Exactly one of
 * `geometry`/`sourcePath` is set (the DDL's source/source_path pairing):
 * inline rows carry the verbatim GeoJSON (round-trip fidelity column, §3.2);
 * oversized rows (> `INLINE_GEOMETRY_SOURCE_BYTES`) ride Storage with a
 * client-supplied `bbox` and no inline source.
 */
export interface GeometryRow {
  entryId: string;
  datasetId: string;
  /** The owning entry's data jsonb — the tile feed's feature properties (the §5.5 RPC hands it back alongside the payload). */
  data: unknown;
  /** Verbatim GeoJSON when stored inline; null when the payload rides Storage. */
  geometry: unknown;
  /** Storage path in the `geometries` bucket when oversized; null when inline. */
  sourcePath: string | null;
  /** Per-geometry envelope [minLon, minLat, maxLon, maxLat]; trigger-filled for inline rows, client-supplied for storage-backed ones (§3.2). */
  bbox: number[] | null;
  type: DatasetGeometryType;
}

/**
 * Oversized-geometry threshold: geometry sources above this ride Storage
 * instead of the inline `source` jsonb (design §6 — "set at 256 KB, the
 * Convex INLINE_GEOMETRY_BYTE_LIMIT concept"). Exported for the import
 * flow's splitter, which is what actually enforces it.
 */
export const INLINE_GEOMETRY_SOURCE_BYTES = 256 * 1024;

/** The `geometries` bucket holding oversized geometry payloads (design §6). */
export const GEOMETRY_BUCKET = "geometries";

/**
 * One `dataset_rows_for_tiles` row — the tile worker's feed (design §5.5).
 * `next_cursor` is the page's continuation per the RPC section's blanket
 * rule ("every RPC that pages returns next_cursor, null = exhausted", §5
 * intro — the §5.5 sketch omits the column; the preamble covers it; flagged
 * for reconciliation with the generated types).
 */
export interface GeometryRowsRpcRow extends PagedRpcRow {
  entry_id: string;
  data: unknown;
  geometry: unknown;
  geometry_source_path: string | null;
  geometry_type: DatasetGeometryType;
  bbox: number[] | null;
}

function geometryRowOf(row: GeometryRowsRpcRow, datasetId: string): GeometryRow {
  return {
    bbox: row.bbox,
    data: row.data,
    datasetId,
    entryId: row.entry_id,
    geometry: row.geometry,
    sourcePath: row.geometry_source_path,
    type: row.geometry_type,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface GeometryRowsArgs {
  datasetId: string;
  /** Opaque continuation from the previous page's `nextCursor`; null/absent = first page. */
  cursor?: string | null;
  limit?: number;
}

export interface GeometryRowsPage {
  rows: GeometryRow[];
  /** null = exhausted (the `isDone` analogue, design §5 intro). */
  nextCursor: string | null;
}

/**
 * Pages the dataset's full-geometry rows via `dataset_rows_for_tiles` — the
 * ONLY read path that pulls coordinate payloads, reserved for map rendering,
 * exports, and the tile worker (the properties table never touches it).
 * Cursor-chained to exhaustion: `nextCursor === null` is done.
 */
export async function rowsForTiles(
  args: GeometryRowsArgs,
  options?: StoreOptions,
): Promise<GeometryRowsPage> {
  const client = clientOf(options);
  const rows = await queryRows<GeometryRowsRpcRow>(
    client.rpc("dataset_rows_for_tiles", {
      p_cursor: args.cursor ?? null,
      p_dataset: args.datasetId,
      p_limit: args.limit ?? DEFAULT_GEOMETRY_ROWS_LIMIT,
    }),
  );
  return {
    nextCursor: nextPageCursor(rows),
    rows: rows.map((row) => geometryRowOf(row, args.datasetId)),
  };
}

/** The tile worker's feed width when a caller doesn't pin one (the §5.5 RPC default). */
export const DEFAULT_GEOMETRY_ROWS_LIMIT = 5000;

/**
 * The reactive geometry paging — `api.cms.geometries.list` parity. Same feed
 * as `rowsForTiles` (one RPC serves both; the Convex split was a
 * byte-budget artifact that Postgres does not have).
 */
export async function list(
  args: GeometryRowsArgs,
  options?: StoreOptions,
): Promise<GeometryRowsPage> {
  return await rowsForTiles(args, options);
}

/** `api.cms.geometries.getEntryGeometry` parity: the entry's single geometry (1:1), or null when it has none. Storage-backed rows return `sourcePath` — resolve the payload via `resolveGeometryRows`/a signed URL, exactly as the Convex read handed back a `geometryUrl`. */
export async function getByEntry(
  args: { entryId: string },
  options?: StoreOptions,
): Promise<GeometryRow | null> {
  const rows = await queryRows<GeometryRow>(
    clientOf(options)
      .from("geometries")
      .select("entryId:entry_id,datasetId:dataset_id,geometry,sourcePath:source_path,bbox,type")
      .eq("entry_id", args.entryId)
      .limit(1),
  );
  const first = rows[0];
  return first === undefined ? null : first;
}

/** Read helper for the reactive layer's per-cursor geometry queries. */
export function rowsForTilesQueryOptions(args: GeometryRowsArgs, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:geometries", "rowsForTiles", args],
    queryFn: async () => await rowsForTiles(args, options),
  });
}

/** Reactive point read of one entry's geometry row — the edit-panel prefill / entry-details feed. */
export function getByEntryQueryOptions(args: { entryId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:geometries", "getByEntry", args],
    queryFn: async () => await getByEntry(args, options),
  });
}

/**
 * Uploads one oversized geometry payload (a JSON-serialized GeoJSON geometry,
 * above `INLINE_GEOMETRY_SOURCE_BYTES`) into the dataset's `geometries/`
 * folder — the import flow's §10 step 2. Returns the storage path and the
 * exact byte size the import row records alongside it; the entry is keyed by
 * INDEX (the row's position in the parsed rows), not by an entry id, which
 * does not exist until the `import_entries` chunk generates one.
 */
export async function uploadGeometrySource(
  args: { datasetId: string; rowIndex: number; source: unknown },
  options?: StoreOptions,
): Promise<{ path: string; bytes: number }> {
  const text = JSON.stringify(args.source);
  const path = `${args.datasetId}/row-${args.rowIndex}.json`;
  // Upsert: a Retry regenerates the same row-indexed paths — the failed
  // attempt's leftover copies are overwritten, not rejected.
  const { error } = await clientOf(options)
    .storage.from(GEOMETRY_BUCKET)
    .upload(path, new Blob([text], { type: "application/json" }), { upsert: true });
  if (error !== null) {
    throw new Error(error.message);
  }
  return { bytes: textEncoder.encode(text).length, path };
}

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * One geometry write's source shape. Exactly one of `geometry` (inline
 * verbatim GeoJSON) / `sourcePath` (Storage-backed oversized payload) must
 * be given — the DDL's source/source_path pairing, §3.2. Inline rows get
 * their envelope from the bbox trigger (the generated geom derives it);
 * storage-backed rows have no geom, so `bbox` is REQUIRED there and the
 * trigger never sees the row's shape.
 */
export interface UpsertGeometryArgs {
  /** The owning dataset — required by the FK on INSERT; `replace` may omit it when it can only be updating an existing row (PostgREST upsert: present row = update path). */
  datasetId?: string;
  entryId: string;
  /** The denormalized type column (`type text not null`); derived from the inline geometry when omitted. */
  type?: DatasetGeometryType;
  geometry?: unknown;
  sourcePath?: string;
  /** [minLon, minLat, maxLon, maxLat] — required for storage-backed rows, ignored for inline ones. */
  bbox?: number[];
}

/** The insert/update payload for one geometry row, or a thrown Error when the source shape is ambiguous. */
function geometryPayload(args: UpsertGeometryArgs): Record<string, unknown> {
  const hasInline = args.geometry !== undefined;
  const hasStorage = args.sourcePath !== undefined;
  if (hasInline === hasStorage) {
    throw new Error(
      "Geometry needs exactly one source: inline `geometry` or storage-backed `sourcePath`.",
    );
  }
  const payload: Record<string, unknown> = { entry_id: args.entryId };
  if (args.datasetId !== undefined) {
    payload.dataset_id = args.datasetId;
  }
  if (hasInline) {
    const type = args.type ?? geometryTypeOfInline(args.geometry);
    if (type === undefined) {
      throw new Error("Geometry payload must be a GeoJSON geometry object with a string 'type'.");
    }
    // bbox deliberately omitted: the trigger derives it from the generated geom (§3.2).
    payload.source = args.geometry;
    payload.type = type;
    return payload;
  }
  if (args.type === undefined) {
    throw new Error(
      "Storage-backed geometry rows must carry their `type` (no inline source to derive it from).",
    );
  }
  if (args.bbox === undefined) {
    throw new Error(
      "Storage-backed geometry rows must carry a client-supplied `bbox` (no geom to derive it from).",
    );
  }
  payload.source_path = args.sourcePath;
  payload.type = args.type;
  payload.bbox = args.bbox;
  return payload;
}

/** `type` of an inline GeoJSON value, when it is a geometry-shaped record. */
function geometryTypeOfInline(geometry: unknown): string | undefined {
  if (typeof geometry !== "object" || geometry === null || Array.isArray(geometry)) {
    return undefined;
  }
  if (!("type" in geometry)) {
    return undefined;
  }
  const type: unknown = geometry.type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Creates the entry's geometry row (the entry must exist — FK). One
 * PostgREST statement; summaries and the tile-cache version bump are the
 * geometry triggers' job (§3.2), so no client-side counter to maintain.
 */
export async function create(
  args: UpsertGeometryArgs,
  options?: StoreOptions,
): Promise<GeometryRow> {
  // The payload is built (and validated) BEFORE the client is touched — a
  // rejected shape must not leave a half-recorded query behind.
  const payload = geometryPayload(args);
  const row = await queryRow<GeometryRow>(
    clientOf(options)
      .from("geometries")
      .insert(payload)
      .select("entryId:entry_id,datasetId:dataset_id,geometry,sourcePath:source_path,bbox,type")
      .single(),
  );
  if (row === null) {
    throw new Error("Geometry insert returned no row.");
  }
  return row;
}

/**
 * Replaces the entry's geometry (the `entries.update` geometry-arg path):
 * upsert on the unique `entry_id`, so replace-on-existing and
 * fill-the-gap-on-absent are one statement.
 */
export async function replace(
  args: UpsertGeometryArgs,
  options?: StoreOptions,
): Promise<GeometryRow> {
  // Payload before client, as in `create`.
  const payload = geometryPayload(args);
  const row = await queryRow<GeometryRow>(
    clientOf(options)
      .from("geometries")
      .upsert(payload, { onConflict: "entry_id" })
      .select("entryId:entry_id,datasetId:dataset_id,geometry,sourcePath:source_path,bbox,type")
      .single(),
  );
  if (row === null) {
    throw new Error("Geometry upsert returned no row.");
  }
  return row;
}

/** Deletes the entry's geometry row (the `entries.update` geometry-null clear path). No-op-friendly: absent rows delete nothing. */
export async function remove(args: { entryId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("geometries").delete().eq("entry_id", args.entryId).select("entry_id"),
  );
}

/** A short-lived signed URL for an oversized geometry payload — the `fetchGeometryPayload` path's first half (design §6). Exported for callers resolving payloads outside the seam. */
export async function createGeometrySourceUrl(
  client: SupabaseClient,
  sourcePath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(GEOMETRY_BUCKET)
    .createSignedUrl(sourcePath, STORAGE_SIGNED_URL_TTL_SECONDS);
  if (error !== null) {
    throw new Error(error.message);
  }
  if (data === null) {
    throw new Error(`Geometry payload ${sourcePath} has no signed URL.`);
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Tile archives (design §5.6/§6 — stage 2)
//
// The PG counterparts of the component's tile-archive machinery
// (`api.cms.tile_archives.*` + the `setMapTileArchive` guard): the build
// worker's pre-build read, the archive-pointer reads the layer-source
// decision and the OPFS pin feed sign, and the `install_tile_archive`
// compare-and-set install. They live in THIS module rather than a dedicated
// tile-archive store because the §8.1 layout defines no such module and this
// stage's scope pins the store edits to `geometries.ts` — the design's
// `maps.ts` (the maps workstream's own module) must not become the dumping
// ground either. A later stage may re-home them wholesale; the exports are
// the contract, not the file.
// ---------------------------------------------------------------------------

/** The Storage bucket holding built PMTiles archives (design §6). */
export const TILE_ARCHIVE_BUCKET = "tile-archives";

/**
 * Signed-URL lifetime for archive reads. This is the §16 stage-2 pick: keep
 * `tile-archives` PRIVATE (the design §6 table — never a public-read bucket)
 * and sign for 24 h instead of the geometry-payload hour, because the OPFS
 * pin's re-backfill path (an LRU-evicted archive re-fetching over the wire)
 * replays a URL captured at wire time, and an hourly URL could 403 a tab
 * that outlives it. Self-hosted Storage caps signed-URL TTLs well above 24 h.
 */
export const TILE_ARCHIVE_SIGNED_URL_TTL_SECONDS = 86_400;

/**
 * The tile-relevant fields of the dataset row, read by the build worker
 * BEFORE it fetches any geometry (the expected-version snapshot — the guard's
 * liveness depends on capturing `mapTileCacheVersion` before paging). Mirrors
 * the fields the Convex worker read off `api.cms.schemas.get`.
 */
export interface TileDatasetInfo {
  featureCount: number;
  geometryType: DatasetGeometryType | null;
  isGeospatial: boolean;
  mapTileCacheVersion: number;
}

/**
 * Reads one dataset's tile-relevant row (the worker's pre-build read), or
 * null when RLS hides the dataset. Deliberately imperative (not a
 * `queryOptions` wrapper): the worker is a plain function context.
 */
export async function tileDatasetInfo(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<TileDatasetInfo | null> {
  return await queryRow<TileDatasetInfo>(
    clientOf(options)
      .from("datasets")
      .select(
        "isGeospatial:is_geospatial,geometryType:geometry_type,featureCount:feature_count,mapTileCacheVersion:map_tile_cache_version",
      )
      .eq("id", args.datasetId)
      .limit(1),
  );
}

/**
 * The raw archive-pointer columns for a set of datasets — what the layer-source
 * decision and the OPFS pin feed read. `mapTileArchiveFormat` comes back RAW
 * on purpose (the store never mirrors the format constant; the comparison is
 * the tile workstream's job — see `DatasetSummaryRow`'s field comment).
 */
export interface TileArchivePointer {
  id: string;
  mapTileArchiveBuiltVersion: number | null;
  mapTileArchiveBytes: number | null;
  mapTileArchiveFormat: number | null;
  mapTileArchivePath: string | null;
  mapTileCacheVersion: number;
}

/** Reads the archive-pointer columns for the given dataset ids (one `in` select). */
export async function tileArchivePointers(
  args: { datasetIds: ReadonlyArray<string> },
  options?: StoreOptions,
): Promise<TileArchivePointer[]> {
  if (args.datasetIds.length === 0) {
    return [];
  }
  return await queryRows<TileArchivePointer>(
    clientOf(options)
      .from("datasets")
      .select(
        "id,mapTileCacheVersion:map_tile_cache_version,mapTileArchivePath:map_tile_archive_path,mapTileArchiveBytes:map_tile_archive_bytes,mapTileArchiveBuiltVersion:map_tile_archive_built_version,mapTileArchiveFormat:map_tile_archive_format",
      )
      .in("id", [...args.datasetIds]),
  );
}

/** A short-lived signed read URL for a built archive in the `tile-archives` bucket (the §6 "range-read signed URLs" access shape). */
export async function createTileArchiveUrl(
  client: SupabaseClient,
  archivePath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(TILE_ARCHIVE_BUCKET)
    .createSignedUrl(archivePath, TILE_ARCHIVE_SIGNED_URL_TTL_SECONDS);
  if (error !== null) {
    throw new Error(error.message);
  }
  if (data === null) {
    throw new Error(`Tile archive ${archivePath} has no signed URL.`);
  }
  return data.signedUrl;
}

/**
 * Issues a signed UPLOAD URL for one archive object (design §6's upload
 * shape: "browser requests a signed URL, PUTs the bytes, then writes the
 * row/RPC"). The caller PUTs the bytes to `signedUrl` and passes `path` to
 * {@link installTileArchive}, which claims the object — a path that never
 * received its bytes installs an archive nobody can read, so callers upload
 * FIRST and install second.
 */
export async function createTileArchiveUploadUrl(
  args: { path: string },
  options?: StoreOptions,
): Promise<{ path: string; signedUrl: string }> {
  const { data, error } = await clientOf(options)
    .storage.from(TILE_ARCHIVE_BUCKET)
    .createSignedUploadUrl(args.path);
  if (error !== null) {
    throw new Error(error.message);
  }
  if (data === null) {
    throw new Error(`Tile archive upload URL for ${args.path} could not be issued.`);
  }
  return { path: data.path, signedUrl: data.signedUrl };
}

/** The {@link installTileArchive} argument set — the §5.6 RPC's parameters, camelCase. */
export interface InstallTileArchiveArgs {
  datasetId: string;
  /** Storage path the upload landed at (the RPC claims it into the dataset row). */
  path: string;
  bytes: number;
  maxZoom: number;
  /** The version the build STARTED at — the CAS guard value. */
  expectedVersion: number;
  /** Recorded alongside the install (the built-at snapshot the staleness check compares). */
  builtVersion: number;
  /** The builder layout generation this archive was produced by (the #125 archive-FORMAT gate). */
  format: number;
}

/**
 * Installs a built archive with the `setMapTileArchive expectedVersion`
 * guard, SQL edition (§5.6): returns true when `expectedVersion` matched the
 * dataset's live `map_tile_cache_version` (install recorded), false when a
 * geometry write raced the build (stale — the caller reports
 * `stale-discarded`; a queued/stale-on-view rebuild converges to fresh).
 * Returns false WITHOUT touching the row, exactly like the component guard.
 */
export async function installTileArchive(
  args: InstallTileArchiveArgs,
  options?: StoreOptions,
): Promise<boolean> {
  return await queryScalar<boolean>(
    clientOf(options).rpc("install_tile_archive", {
      p_built_version: args.builtVersion,
      p_bytes: args.bytes,
      p_dataset: args.datasetId,
      p_expected_version: args.expectedVersion,
      p_format: args.format,
      p_max_zoom: args.maxZoom,
      p_path: args.path,
    }),
  );
}
