import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/react-query";

import type {
  DatasetBoundingBox,
  DatasetGeometryType,
  DatasetRow,
  DatasetSummaryRow,
} from "./datasets";
import type { EntryRow } from "./entries";
import type { GeometryRow } from "./geometries";

/**
 * The realtime layer (design doc §7; issue #205): one `postgres_changes`
 * channel per ACTIVE dataset carrying the multi-user editing events into the
 * TanStack Query caches.
 *
 * ACTIVATION IS CACHE-DRIVEN, NOT ROUTE-DRIVEN. The issue sketches per-surface
 * `useEffect` subscriptions; this layer derives the same semantics from the
 * query cache itself: a dataset channel is open exactly while some mounted
 * surface observes a query that names or carries that dataset (the table's
 * `searchEntries` pages, an entry-details `get`, a version chain, …). A query
 * gaining its first observer opens the channel ("subscribed on mount"); the
 * last observer leaving closes it ("unsubscribed on unmount"). One channel
 * per active dataset, never app-wide — per-subscriber RLS is the documented
 * scaling limit, and per-active-dataset granularity is the mitigation. The
 * catalog-wide summaries (`pg:datasets` list projections) deliberately do NOT
 * activate anything by themselves: one channel per visible dataset would BE
 * the app-wide subscription the design forbids. They update live instead
 * through the events of whichever datasets are active (their summary rows
 * patch in place and the summary queries reconcile).
 *
 * THE MATRIX (the ask's surfaces): `entries` + `geometries` (dataset table
 * rows, entry details), `datasets` (the row itself — summaries and the
 * tile-cache live signal ride its trigger-maintained columns),
 * `dataset_versions` + `tags` (versions), `collection_datasets` (catalog
 * memberships), `map_layers` (`target_id` = the dataset a layer renders) and
 * `layer_styles` (`render_id` = the dataset a style paints). The bare
 * `groups`/`collections`/`maps` tables carry no dataset column, so their own
 * writes are not dataset-filterable — a group's member list still updates
 * live (the member dataset's row event patches the summary the group page
 * reads); group/collection/map row writes propagate through their own
 * mutation refetches, which is the accepted granularity for this stage.
 *
 * PATCH VS INVALIDATE (the design doc's split): UPDATE/DELETE patch cached
 * rows in place (`setQueryData` on the affected keys — never introducing a
 * row a fetch did not cache, so a patch can never surface an uncached page
 * or flip a complete surface's shape); INSERT bursts invalidate the owning
 * keys, coalesced to one refetch per key per tick (a 20k-row import is 20k
 * events and ONE refetch). Three exceptions where an UPDATE also invalidates:
 * `searchEntries` (server-side sort/filter can MOVE the row the patch pinned),
 * the `pg:datasets` summary projections (the design doc's literal
 * "setQueryData … invalidate for summaries" — a lifecycle flip moves a row
 * between the draft/published lists, which a patch cannot express), and the
 * `pg:geometries` tiles feed (its rows carry `data` — the §5.5 RPC's JOINed
 * `entries.data`, the tile feed's feature properties — a column the
 * `geometries` table does not have, so a payload patch would wipe every
 * feature property it touched).
 *
 * COMPLETENESS SURVIVES (ui-polish-expectations): patches only replace rows
 * inside loaded caches — status stays `success`, `fetchStatus` stays `idle`,
 * nothing re-skeletons. Invalidations refetch in place (`isLoading` is false
 * whenever data exists), and the completeness latch reads pagination
 * exhaustion, which neither operation touches. The last-write-wins stance is
 * the recorded binding decision (#205): patches overwrite whatever the cache
 * held — no OCC retry, no cell co-editing; the version machinery is where
 * consistency is enforced.
 *
 * ENABLEMENT (DB-side, migration 0012): `postgres_changes` reads the
 * `supabase_realtime` publication's table list server-side and delivers
 * nothing for tables outside it — `0012_realtime_publication.sql` adds
 * exactly the eight matrix tables above (guarded, default replica identity).
 * DELETE payloads carry the primary key only (the default replica identity):
 * `entries`/`datasets` deletes patch (their PK is the cached row's id);
 * `geometries` deletes invalidate (its PK is the geometry's own uuid, which
 * cached rows don't carry).
 *
 * The persisted light state is untouched by construction: the persister only
 * dehydrates `convexQuery` hashes (`light-namespaces.isPersistableQueryHash`),
 * so PG cache patches never change a persisted shape.
 */

/** The `postgres_changes` event kinds this layer dispatches. */
export type RealtimeChangeEvent = "DELETE" | "INSERT" | "UPDATE";

/**
 * One realtime payload, narrowed to what the cache handlers read. `new` is
 * the full committed row for INSERT/UPDATE and null otherwise; `old` is the
 * pre-change row for DELETE/UPDATE — under the DEFAULT replica identity that
 * is the primary key columns only — and null for INSERT.
 */
export interface RealtimeChange {
  eventType: RealtimeChangeEvent;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

/** One table the per-dataset channel subscribes, with its dataset filter column. */
export interface DatasetChannelTable {
  filterColumn: string;
  surface: string;
  table: string;
}

/**
 * The channel's `postgres_changes` subscriptions (§7: "events for
 * `entries`/`geometries` filtered `dataset_id=eq.<id>`", extended per the
 * stage-6 ask's matrix: datasets/maps/collections/groups/versions). Order is
 * the delivery contract of the tests, not of the broker.
 */
export const DATASET_CHANNEL_TABLES: readonly DatasetChannelTable[] = [
  { filterColumn: "dataset_id", surface: "dataset table rows / entry details", table: "entries" },
  { filterColumn: "dataset_id", surface: "maps layer data / entry geometry", table: "geometries" },
  { filterColumn: "id", surface: "dataset row (summaries + tile live signal)", table: "datasets" },
  { filterColumn: "dataset_id", surface: "versions", table: "dataset_versions" },
  { filterColumn: "dataset_id", surface: "versions (tags pin them)", table: "tags" },
  { filterColumn: "dataset_id", surface: "catalog memberships", table: "collection_datasets" },
  { filterColumn: "target_id", surface: "maps layer data (layer set)", table: "map_layers" },
  { filterColumn: "render_id", surface: "maps layer styles", table: "layer_styles" },
];

/** The channel topic for one active dataset (§7's `dataset:<id>`). */
export function datasetChannelTopic(datasetId: string): string {
  return `dataset:${datasetId}`;
}

// ---------------------------------------------------------------------------
// Narrowing — the realtime payload columns are raw wire records (the untyped
// client), read here into the store modules' row interfaces in one place.
// ---------------------------------------------------------------------------

/** The object view of a wire value, or null when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the object-shape check above is the runtime guard; the record view is how every column below is read.
  return value as Record<string, unknown>;
}

function columnString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function columnStringOrNull(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function columnNumber(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function columnNumberOrNull(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function columnJson(row: Record<string, unknown>, column: string): unknown {
  const value = row[column];
  return value === undefined ? null : value;
}

/** A geometry type column value (`datasets`/`geometries`/`entries` CHECK constraint names the strings). */
function columnGeometryType(
  row: Record<string, unknown>,
  column: string,
): DatasetGeometryType | null {
  const value = row[column];
  if (typeof value !== "string") {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column's CHECK constraint IS the runtime guarantee (design §3.2); the narrowed union is the intended shape.
  return value as DatasetGeometryType;
}

/** A string-array jsonb column (`datasets.properties`). */
function columnStringArray(row: Record<string, unknown>, column: string): string[] {
  const value = row[column];
  if (!Array.isArray(value)) {
    return [];
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      strings.push(item);
    }
  }
  return strings;
}

/** A check-constrained text column read into its store union, or null when the payload names nothing the union admits. */
function columnEnum<T extends string>(
  row: Record<string, unknown>,
  column: string,
  allowed: readonly T[],
): T | null {
  const value = row[column];
  if (typeof value !== "string") {
    return null;
  }
  const match = allowed.find((candidate) => candidate === value);
  return match === undefined ? null : match;
}

/** A bbox column: the [minLon,minLat,maxLon,maxLat] array (`geometries`). */
function columnBboxOrNull(row: Record<string, unknown>, column: string): number[] | null {
  const value = row[column];
  if (!Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the column is numeric[] by DDL (design §3.2); the array check above guards the container.
  return value as number[];
}

/** A datasets bbox column: the expand-only PostGIS envelope rendered as GeoJSON (§3.2). */
function columnDatasetBboxOrNull(
  row: Record<string, unknown>,
  column: string,
): DatasetBoundingBox | null {
  const value = row[column];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the object check above guards the container; the polygon shape is the column's PostGIS guarantee (design §3.2).
  return value as DatasetBoundingBox;
}

/** The realtime payload of one `postgres_changes` event, or null when it names nothing this layer dispatches. */
function realtimeChangeOf(payload: unknown): RealtimeChange | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  const eventType = record["eventType"];
  if (eventType !== "INSERT" && eventType !== "UPDATE" && eventType !== "DELETE") {
    return null;
  }
  return {
    eventType,
    new: asRecord(record["new"]),
    old: asRecord(record["old"]),
  };
}

/** The committed row of an INSERT/UPDATE event, or null (DELETE carries no new image). */
function newRowOf(change: RealtimeChange): Record<string, unknown> | null {
  if (change.eventType !== "INSERT" && change.eventType !== "UPDATE") {
    return null;
  }
  return change.new;
}

/** The pre-change row of a DELETE/UPDATE event, or null. */
function oldRowOf(change: RealtimeChange): Record<string, unknown> | null {
  if (change.eventType === "INSERT") {
    return null;
  }
  return change.old;
}

// ---------------------------------------------------------------------------
// Row mappings — raw realtime rows into the store modules' shapes, so a
// patched cache entry is byte-identical to what the owning queryFn cached.
// ---------------------------------------------------------------------------

function entryRowOf(raw: Record<string, unknown>, datasetId: string): EntryRow | null {
  const id = columnString(raw, "id");
  if (id === "") {
    return null;
  }
  return {
    createdAt: columnString(raw, "created_at"),
    data: columnJson(raw, "data"),
    datasetId,
    geometryType: columnGeometryType(raw, "geometry_type"),
    id,
  };
}

/**
 * The point-read cached shape of a geometry (`pg:geometries getByEntry` —
 * geometries.ts's queryFn selects `entry_id, dataset_id, geometry,
 * source_path, bbox, type` and NO `data`). The tiles-feed shape (`GeometryRow`
 * WITH `data`) is unreachable from realtime payloads: `data` is the §5.5
 * tiles RPC's JOIN column (`entries.data`), not a `geometries` column, so a
 * payload can never carry it — the tiles feed therefore reconciles by
 * invalidation only (see `applyGeometriesChange`).
 */
type GeometryGetRow = Omit<GeometryRow, "data">;

function geometryGetRowOf(raw: Record<string, unknown>, datasetId: string): GeometryGetRow | null {
  const entryId = columnString(raw, "entry_id");
  if (entryId === "") {
    return null;
  }
  const type = columnGeometryType(raw, "type");
  if (type === null) {
    return null;
  }
  return {
    bbox: columnBboxOrNull(raw, "bbox"),
    datasetId,
    entryId,
    geometry: columnJson(raw, "source"),
    sourcePath: columnStringOrNull(raw, "source_path"),
    type,
  };
}

function datasetRowOf(raw: Record<string, unknown>): DatasetRow | null {
  const id = columnString(raw, "id");
  const title = columnString(raw, "title");
  const editPolicy = columnEnum(raw, "edit_policy", ["locked", "open"]);
  const publishedVisibility = columnEnum(raw, "published_visibility", ["author", "everyone"]);
  const lifecycle = columnEnum(raw, "lifecycle", ["draft", "published"]);
  if (
    id === "" ||
    title === "" ||
    editPolicy === null ||
    publishedVisibility === null ||
    lifecycle === null
  ) {
    return null;
  }
  const geometryType = columnGeometryType(raw, "geometry_type");
  const rawGeometryType = raw["geometry_type"];
  if (rawGeometryType !== null && rawGeometryType !== undefined && geometryType === null) {
    return null;
  }
  return {
    bbox: columnDatasetBboxOrNull(raw, "bbox"),
    createdAt: columnString(raw, "created_at"),
    createdBy: columnString(raw, "created_by"),
    description: columnStringOrNull(raw, "description"),
    editPolicy,
    entryCount: columnNumber(raw, "entry_count"),
    featureCount: columnNumber(raw, "feature_count"),
    geometryType,
    groupId: columnStringOrNull(raw, "group_id"),
    id,
    isGeospatial: raw["is_geospatial"] === true,
    jsonSchema: columnJson(raw, "json_schema"),
    lifecycle,
    lineage: columnJson(raw, "lineage"),
    mapTileArchiveBytes: columnNumberOrNull(raw, "map_tile_archive_bytes"),
    mapTileArchiveBuiltVersion: columnNumberOrNull(raw, "map_tile_archive_built_version"),
    mapTileArchiveFormat: columnNumberOrNull(raw, "map_tile_archive_format"),
    mapTileArchiveMaxZoom: columnNumberOrNull(raw, "map_tile_archive_max_zoom"),
    mapTileArchivePath: columnStringOrNull(raw, "map_tile_archive_path"),
    mapTileCacheVersion: columnNumber(raw, "map_tile_cache_version"),
    maxGeometryRowBytes: columnNumberOrNull(raw, "max_geometry_row_bytes"),
    properties: columnStringArray(raw, "properties"),
    publishedVisibility,
    simplifyGeometry: raw["simplify_geometry"] === true,
    source: columnJson(raw, "source"),
    sourceFileName: columnStringOrNull(raw, "source_file_name"),
    sourceFilePath: columnStringOrNull(raw, "source_file_path"),
    sourceFileSize: columnNumberOrNull(raw, "source_file_size"),
    title,
    updatedAt: columnString(raw, "updated_at"),
  };
}

/** The list-page projection of a patched dataset row (`summaryOf` parity — `fieldCount` derives from the declared `properties`). */
function datasetSummaryRowOf(row: DatasetRow): DatasetSummaryRow {
  return {
    bbox: row.bbox,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    description: row.description,
    editPolicy: row.editPolicy,
    entryCount: row.entryCount,
    featureCount: row.featureCount,
    fieldCount: row.properties.length,
    geometryType: row.geometryType,
    groupId: row.groupId,
    id: row.id,
    isGeospatial: row.isGeospatial,
    lifecycle: row.lifecycle,
    lineage: row.lineage,
    mapTileArchiveBuiltVersion: row.mapTileArchiveBuiltVersion,
    mapTileArchiveBytes: row.mapTileArchiveBytes,
    mapTileArchiveFormat: row.mapTileArchiveFormat,
    mapTileArchiveMaxZoom: row.mapTileArchiveMaxZoom,
    mapTileCacheVersion: row.mapTileCacheVersion,
    publishedVisibility: row.publishedVisibility,
    source: row.source,
    title: row.title,
  };
}

// ---------------------------------------------------------------------------
// Cache application — patches (in place, never introducing rows) and the
// coalesced invalidations (INSERT bursts and the summary reconcile).
// ---------------------------------------------------------------------------

/** Reads a cached row's identity: `id` (entries/datasets) or `entryId` (geometries — row identity is the ENTRY, §3.2). */
function cachedRowId(column: "entryId" | "id"): (row: unknown) => string {
  return (row) => {
    const record = asRecord(row);
    if (record === null) {
      return "";
    }
    const value = record[column];
    return typeof value === "string" ? value : "";
  };
}

/**
 * Replaces or removes the row inside every cache entry the matcher finds
 * (flat row arrays and `{rows, nextCursor}` pages alike). Untouched caches
 * keep their reference, and `setQueryData` fires only on an actual change.
 */
function patchRowCaches(
  queryClient: QueryClient,
  matcher: readonly unknown[],
  rowId: string,
  idOf: (row: unknown) => string,
  replacementOf: (cached: unknown) => unknown,
): void {
  const cache = queryClient.getQueryCache();
  for (const query of cache.findAll({ queryKey: matcher })) {
    const next = remapCachedData(query.state.data, rowId, idOf, replacementOf);
    if (next !== query.state.data) {
      queryClient.setQueryData(query.queryKey, next);
    }
  }
}

function remapCachedData(
  data: unknown,
  rowId: string,
  idOf: (row: unknown) => string,
  replacementOf: (cached: unknown) => unknown,
): unknown {
  if (Array.isArray(data)) {
    return remapRowArray(data, rowId, idOf, replacementOf);
  }
  const record = asRecord(data);
  if (record === null) {
    return data;
  }
  const rows = record["rows"];
  if (!Array.isArray(rows)) {
    return data;
  }
  const nextRows = remapRowArray(rows, rowId, idOf, replacementOf);
  if (nextRows === rows) {
    return data;
  }
  return { ...record, rows: nextRows };
}

function remapRowArray(
  rows: unknown[],
  rowId: string,
  idOf: (row: unknown) => string,
  replacementOf: (cached: unknown) => unknown,
): unknown[] {
  const next: unknown[] = [];
  let touched = false;
  for (const row of rows) {
    if (idOf(row) === rowId) {
      touched = true;
      const replacement = replacementOf(row);
      if (replacement !== null) {
        next.push(replacement);
      }
      continue;
    }
    next.push(row);
  }
  return touched ? next : rows;
}

/**
 * Patches a point-read cache (`pg:entries get`, `pg:datasets get`, …) when the
 * cached row is the event's row. A loaded-but-absent cache (null) is filled
 * by an UPDATE only — the event itself proves the row is visible to this
 * subscriber (RLS filters the channel), so the authoritative row may land;
 * a never-loaded cache (undefined) is never fabricated.
 */
function patchGetCache(
  queryClient: QueryClient,
  key: readonly unknown[],
  rowId: string,
  idOf: (row: unknown) => string,
  replacement: unknown,
): void {
  const cached: unknown = queryClient.getQueryData(key);
  if (cached === undefined) {
    return;
  }
  if (cached === null) {
    if (replacement !== null) {
      queryClient.setQueryData(key, replacement);
    }
    return;
  }
  if (idOf(cached) !== rowId) {
    return;
  }
  queryClient.setQueryData(key, replacement);
}

/**
 * The coalescing invalidation queue: INSERT bursts (an import chunk fires
 * thousands of events) collapse into ONE refetch per owning key per macrotask
 * tick. Keys are TanStack matchers (prefix + partial-args objects), the same
 * shape `invalidateQueries` matches against.
 */
class PendingInvalidations {
  private readonly keys = new Map<string, readonly unknown[]>();
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly queryClient: QueryClient) {}

  add(key: readonly unknown[]): void {
    this.keys.set(JSON.stringify(key), key);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.flush();
      }, 0);
    }
  }

  /** Runs every pending invalidation now (also the detach path — pending reconcile work must not die with the layer). */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = [...this.keys.values()];
    this.keys.clear();
    for (const key of pending) {
      void this.queryClient.invalidateQueries({ queryKey: key }).catch(() => {
        // An invalidated refetch failing is that query's own error state;
        // the queue never throws into the realtime callback path.
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-table handlers — the patch/invalidate matrix. Invalidation keys mirror
// the store modules' query keys exactly; realtime.test.ts pins the mirror.
// ---------------------------------------------------------------------------

type ChangeHandler = (
  queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
) => void;

function applyEntriesChange(
  queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
): void {
  const idOf = cachedRowId("id");
  const rowId = change.eventType === "INSERT" ? "" : recordIdOf(oldRowOf(change));
  if (change.eventType === "INSERT") {
    // INSERT bursts invalidate — the new row's page position is the server's
    // decision (created_at order, search filter, keyset cursor), never a
    // client-side guess. The row counts (entry_count) ride the datasets row.
    invalidations.add(["pg:entries", "listPage", { datasetId }]);
    invalidations.add(["pg:entries", "searchEntries", { datasetId }]);
    invalidations.add(["pg:entries", "listForIds"]);
    return;
  }
  if (rowId === "") {
    return;
  }
  if (change.eventType === "DELETE") {
    patchGetCache(queryClient, ["pg:entries", "get", { entryId: rowId }], rowId, idOf, null);
    patchRowCaches(queryClient, ["pg:entries", "listPage", { datasetId }], rowId, idOf, () => null);
    patchRowCaches(
      queryClient,
      ["pg:entries", "searchEntries", { datasetId }],
      rowId,
      idOf,
      () => null,
    );
    patchRowCaches(queryClient, ["pg:entries", "listForIds"], rowId, idOf, () => null);
    // The removal leaves a page short of its width — a refetch repairs the
    // keyset pagination.
    invalidations.add(["pg:entries", "listPage", { datasetId }]);
    invalidations.add(["pg:entries", "searchEntries", { datasetId }]);
    return;
  }
  // UPDATE: patch in place …
  const raw = newRowOf(change);
  const entry = raw === null ? null : entryRowOf(raw, datasetId);
  if (entry === null) {
    return;
  }
  patchGetCache(queryClient, ["pg:entries", "get", { entryId: rowId }], rowId, idOf, entry);
  patchRowCaches(queryClient, ["pg:entries", "listPage", { datasetId }], rowId, idOf, () => entry);
  patchRowCaches(
    queryClient,
    ["pg:entries", "searchEntries", { datasetId }],
    rowId,
    idOf,
    () => entry,
  );
  patchRowCaches(queryClient, ["pg:entries", "listForIds"], rowId, idOf, () => entry);
  // … then let the server re-rank the sorted/filtered table (the patch pinned
  // the row's VALUE; its position under the active sort is the RPC's answer).
  invalidations.add(["pg:entries", "searchEntries", { datasetId }]);
}

function applyGeometriesChange(
  queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
): void {
  const idOf = cachedRowId("entryId");
  if (change.eventType === "DELETE") {
    // The delete payload carries the geometry table's own uuid (default
    // replica identity), which no cached row carries — invalidate, don't patch.
    invalidations.add(["pg:geometries", "getByEntry"]);
    invalidations.add(["pg:geometries", "rowsForTiles", { datasetId }]);
    return;
  }
  const raw = newRowOf(change);
  if (raw === null) {
    return;
  }
  const entryId = columnString(raw, "entry_id");
  if (entryId === "") {
    return;
  }
  if (change.eventType === "INSERT") {
    invalidations.add(["pg:geometries", "getByEntry", { entryId }]);
    invalidations.add(["pg:geometries", "rowsForTiles", { datasetId }]);
    return;
  }
  const row = geometryGetRowOf(raw, datasetId);
  if (row === null) {
    return;
  }
  // Patch ONLY the point read: the payload mirrors the `geometries` table's
  // own columns verbatim (the broker sends no columns the table lacks), and
  // that is exactly the getByEntry queryFn's select list, so the replacement
  // is byte-identical to what it caches. The rowsForTiles pages are NOT
  // patchable from this payload — their rows carry `data` (the tile feed's
  // feature properties, JOINed from `entries.data` by the §5.5 RPC), a
  // column the payload can never carry; a patch here would replace cached
  // rows with `data: null` (wiped feature properties until the refetch, and
  // permanently corrupt if it fails) — the exact violation of the
  // byte-identical contract above the review caught. The invalidation below
  // is the whole feed's update.
  patchGetCache(queryClient, ["pg:geometries", "getByEntry", { entryId }], entryId, idOf, row);
  // The reactive layer feeds redraw from these pages — reconcile by
  // invalidation (bbox/shape changed, so the rendered geometry must too).
  invalidations.add(["pg:geometries", "rowsForTiles", { datasetId }]);
}

function applyDatasetsChange(
  queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  _datasetId: string,
): void {
  const idOf = cachedRowId("id");
  if (change.eventType === "INSERT") {
    const raw = newRowOf(change);
    const createdBy = raw === null ? "" : columnString(raw, "created_by");
    invalidations.add(["pg:datasets", "list"]);
    invalidations.add(["pg:datasets", "listSummaries"]);
    invalidations.add(["pg:datasets", "listDraftSummaries"]);
    if (createdBy !== "") {
      invalidations.add(["pg:datasets", "listByCreator", { createdBy }]);
    }
    invalidations.add(["pg:datasets", "maxTileCacheVersion"]);
    return;
  }
  const rowId = recordIdOf(oldRowOf(change));
  if (rowId === "") {
    return;
  }
  if (change.eventType === "DELETE") {
    patchGetCache(queryClient, ["pg:datasets", "get", { datasetId: rowId }], rowId, idOf, null);
    patchRowCaches(queryClient, ["pg:datasets", "list"], rowId, idOf, () => null);
    patchRowCaches(queryClient, ["pg:datasets", "listSummaries"], rowId, idOf, () => null);
    patchRowCaches(queryClient, ["pg:datasets", "listDraftSummaries"], rowId, idOf, () => null);
    patchRowCaches(queryClient, ["pg:datasets", "listByCreator"], rowId, idOf, () => null);
    invalidations.add(["pg:datasets", "list"]);
    invalidations.add(["pg:datasets", "listSummaries"]);
    invalidations.add(["pg:datasets", "listDraftSummaries"]);
    invalidations.add(["pg:datasets", "listByCreator"]);
    invalidations.add(["pg:datasets", "maxTileCacheVersion"]);
    invalidations.add(["pg:tile-archives", "metas"]);
    // The delete cascades the dataset's children (§3.4) — their surfaces go with it.
    invalidations.add(["pg:versions", "head", { datasetId: rowId }]);
    invalidations.add(["pg:versions", "list", { datasetId: rowId }]);
    invalidations.add(["pg:tags", "list", { datasetId: rowId }]);
    invalidations.add(["pg:collections", "listCollectionsByDataset", { datasetId: rowId }]);
    return;
  }
  // UPDATE: patch the row caches, then the design doc's "invalidate for
  // summaries" — a lifecycle flip moves the row between the draft/published
  // lists (a patch can't), and the tile live signal rides the version/archive
  // columns the triggers maintain.
  const raw = newRowOf(change);
  const row = raw === null ? null : datasetRowOf(raw);
  if (row === null) {
    return;
  }
  const summary = datasetSummaryRowOf(row);
  patchGetCache(queryClient, ["pg:datasets", "get", { datasetId: rowId }], rowId, idOf, row);
  patchRowCaches(queryClient, ["pg:datasets", "list"], rowId, idOf, () => row);
  patchRowCaches(queryClient, ["pg:datasets", "listSummaries"], rowId, idOf, () => summary);
  patchRowCaches(queryClient, ["pg:datasets", "listDraftSummaries"], rowId, idOf, () => summary);
  patchRowCaches(queryClient, ["pg:datasets", "listByCreator"], rowId, idOf, () => summary);
  invalidations.add(["pg:datasets", "list"]);
  invalidations.add(["pg:datasets", "listSummaries"]);
  invalidations.add(["pg:datasets", "listDraftSummaries"]);
  if (row.createdBy !== "") {
    invalidations.add(["pg:datasets", "listByCreator", { createdBy: row.createdBy }]);
  }
  invalidations.add(["pg:datasets", "getSourceFileUrl", { datasetId: rowId }]);
  invalidations.add(["pg:datasets", "maxTileCacheVersion"]);
  invalidations.add(["pg:tile-archives", "metas"]);
}

function applyDatasetVersionsChange(
  _queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
): void {
  // Version rows are append-only (frozen materializations, §5 — no grants):
  // the chain only ever grows, so this surface invalidates and never patches.
  invalidations.add(["pg:versions", "head", { datasetId }]);
  invalidations.add(["pg:versions", "list", { datasetId }]);
  const rowId = change.eventType === "INSERT" ? "" : recordIdOf(oldRowOf(change));
  if (rowId !== "") {
    invalidations.add(["pg:versions", "get", { versionId: rowId }]);
    invalidations.add(["pg:versions", "versionEntries", { versionId: rowId }]);
  }
}

function applyTagsChange(
  _queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
): void {
  invalidations.add(["pg:tags", "list", { datasetId }]);
  const rowId = change.eventType === "INSERT" ? "" : recordIdOf(oldRowOf(change));
  if (rowId !== "") {
    invalidations.add(["pg:tags", "get", { tagId: rowId }]);
  }
}

function applyCollectionDatasetsChange(
  _queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  datasetId: string,
): void {
  // The composite PK (collection_id, dataset_id) rides every non-INSERT
  // payload; the new image carries it for INSERT/UPDATE.
  const row =
    change.eventType === "INSERT" || change.eventType === "UPDATE" ? change.new : change.old;
  const collectionId = row === null ? "" : columnString(row, "collection_id");
  invalidations.add(["pg:collections", "list"]);
  invalidations.add(["pg:collections", "listMemberships"]);
  invalidations.add(["pg:collections", "listCollectionsByDataset", { datasetId }]);
  if (collectionId !== "") {
    invalidations.add(["pg:collections", "listDatasets", { collectionId }]);
    return;
  }
  invalidations.add(["pg:collections", "listDatasets"]);
}

function applyMapLayersChange(
  _queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  _datasetId: string,
): void {
  // A layer's map_id rides INSERT/UPDATE payloads; a DELETE carries only the
  // layer's own uuid (default replica identity), so its map is unknown and
  // the map-scoped keys invalidate broadly.
  const row =
    change.eventType === "INSERT" || change.eventType === "UPDATE" ? change.new : change.old;
  const mapId = row === null ? "" : columnString(row, "map_id");
  invalidations.add(["pg:maps", "listAllLayers"]);
  if (change.eventType === "DELETE" || mapId === "") {
    invalidations.add(["pg:maps", "listLayers"]);
    invalidations.add(["pg:maps", "listOverrides"]);
    return;
  }
  invalidations.add(["pg:maps", "listLayers", { mapId }]);
  invalidations.add(["pg:maps", "listOverrides", { mapId }]);
}

function applyLayerStylesChange(
  _queryClient: QueryClient,
  invalidations: PendingInvalidations,
  change: RealtimeChange,
  _datasetId: string,
): void {
  const row =
    change.eventType === "INSERT" || change.eventType === "UPDATE" ? change.new : change.old;
  const mapId = row === null ? "" : columnString(row, "map_id");
  if (mapId !== "" && change.eventType !== "DELETE") {
    invalidations.add(["pg:layer-styles", "listForMap", { mapId }]);
    return;
  }
  invalidations.add(["pg:layer-styles", "listForMap"]);
}

const TABLE_HANDLERS: Record<string, ChangeHandler> = {
  collection_datasets: applyCollectionDatasetsChange,
  dataset_versions: applyDatasetVersionsChange,
  datasets: applyDatasetsChange,
  entries: applyEntriesChange,
  geometries: applyGeometriesChange,
  layer_styles: applyLayerStylesChange,
  map_layers: applyMapLayersChange,
  tags: applyTagsChange,
};

/** The PK of a non-INSERT payload under the default replica identity. */
function recordIdOf(row: Record<string, unknown> | null): string {
  if (row === null) {
    return "";
  }
  return columnString(row, "id");
}

// ---------------------------------------------------------------------------
// Active-dataset tracking — which datasets the observed queries name.
// ---------------------------------------------------------------------------

/** The dataset a pg query KEY names (the dataset-scoped key families carry `{datasetId}`). */
function datasetIdOfKey(key: readonly unknown[]): string | null {
  const scope = key[0];
  if (
    scope !== "pg:entries" &&
    scope !== "pg:collections" &&
    scope !== "pg:datasets" &&
    scope !== "pg:geometries" &&
    scope !== "pg:imports" &&
    scope !== "pg:tags" &&
    scope !== "pg:versions"
  ) {
    return null;
  }
  const args = asRecord(key[2]);
  if (args === null) {
    return null;
  }
  const datasetId = args["datasetId"];
  return typeof datasetId === "string" ? datasetId : null;
}

/**
 * The datasets a pg query's cached DATA carries: an entry/geometry row (the
 * `datasetId` property — the entry-details activation) or arrays of the same.
 * Dataset lists don't carry a `datasetId` property (their rows are keyed
 * `id`), so the catalog projections can never activate a channel — the
 * app-wide-subscription ban holds by construction.
 */
function collectDatasetIdsOfData(into: Set<string>, data: unknown): void {
  const record = asRecord(data);
  if (record !== null) {
    collectDatasetIdOfRow(into, record);
    const rows = record["rows"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const rowRecord = asRecord(row);
        if (rowRecord !== null) {
          collectDatasetIdOfRow(into, rowRecord);
        }
      }
    }
    return;
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      const rowRecord = asRecord(row);
      if (rowRecord !== null) {
        collectDatasetIdOfRow(into, rowRecord);
      }
    }
  }
}

function collectDatasetIdOfRow(into: Set<string>, record: Record<string, unknown>): void {
  const datasetId = record["datasetId"];
  if (typeof datasetId === "string") {
    into.add(datasetId);
  }
}

/** The datasets with at least one mounted observer right now. */
function activeDatasetIds(queryClient: QueryClient): Set<string> {
  const active = new Set<string>();
  const cache = queryClient.getQueryCache();
  for (const query of cache.getAll()) {
    if (query.getObserversCount() === 0) {
      continue;
    }
    const fromKey = datasetIdOfKey(query.queryKey);
    if (fromKey !== null) {
      active.add(fromKey);
      continue;
    }
    collectDatasetIdsOfData(active, query.state.data);
  }
  return active;
}

// ---------------------------------------------------------------------------
// The channel set + the attach entry point.
// ---------------------------------------------------------------------------

/**
 * One realtime channel per active dataset, refcounted by the active set.
 * `sync` diffs the set against the open channels: new ids join, vanished ids
 * leave — so a channel's lifetime is exactly "some mounted surface observes
 * this dataset".
 */
class DatasetChannelSet {
  private readonly open = new Map<string, RealtimeChannel>();

  constructor(
    private readonly client: SupabaseClient,
    private readonly onChange: (table: string, datasetId: string, change: RealtimeChange) => void,
  ) {}

  sync(activeIds: ReadonlySet<string>): void {
    for (const [datasetId, channel] of this.open) {
      if (activeIds.has(datasetId)) {
        continue;
      }
      this.open.delete(datasetId);
      void this.client.removeChannel(channel).catch(() => {
        // A failed leave is the socket's problem (the topic dies with the
        // client); the local state is already consistent.
      });
    }
    for (const datasetId of activeIds) {
      if (this.open.has(datasetId)) {
        continue;
      }
      this.open.set(datasetId, this.openChannel(datasetId));
    }
  }

  /** Tears every channel down without waiting for the active set (sign-in re-join, detach). */
  closeAll(): void {
    const channels = [...this.open.values()];
    this.open.clear();
    for (const channel of channels) {
      void this.client.removeChannel(channel).catch(() => {
        // See sync(): the local map is the source of truth for this layer.
      });
    }
  }

  private openChannel(datasetId: string): RealtimeChannel {
    const channel = this.client.channel(datasetChannelTopic(datasetId));
    for (const entry of DATASET_CHANNEL_TABLES) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          filter: `${entry.filterColumn}=eq.${datasetId}`,
          schema: "public",
          table: entry.table,
        },
        (payload) => {
          const change = realtimeChangeOf(payload);
          if (change !== null) {
            this.onChange(entry.table, datasetId, change);
          }
        },
      );
    }
    channel.subscribe();
    return channel;
  }
}

/**
 * Mounts the realtime layer onto a QueryClient (once, from the Supabase
 * auth provider — inside the QueryClientProvider, browser only). Returns the
 * detacher: it unsubscribes the cache/auth listeners, flushes any pending
 * invalidations, and closes every open channel.
 */
export function attachDatasetRealtime(
  queryClient: QueryClient,
  client: SupabaseClient,
): () => void {
  const invalidations = new PendingInvalidations(queryClient);
  const channels = new DatasetChannelSet(client, (table, datasetId, change) => {
    const handler = TABLE_HANDLERS[table];
    if (handler !== undefined) {
      handler(queryClient, invalidations, change, datasetId);
    }
  });
  const reconcile = (): void => {
    channels.sync(activeDatasetIds(queryClient));
  };
  const unsubscribeCache = queryClient.getQueryCache().subscribe(reconcile);
  const { data: authBinding } = client.auth.onAuthStateChange((event) => {
    // Channels joined before sign-in rode the anon identity, whose RLS view
    // delivers nothing: a fresh sign-in re-joins every open channel under the
    // new token. Token refreshes ride the shared client's own realtime auth.
    if (event === "SIGNED_IN") {
      channels.closeAll();
    }
    reconcile();
  });
  reconcile();
  return () => {
    authBinding.subscription.unsubscribe();
    unsubscribeCache();
    invalidations.flush();
    channels.closeAll();
  };
}
