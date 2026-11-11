import { queryOptions } from "@tanstack/react-query";

import {
  clientOf,
  nextPageCursor,
  queryRow,
  queryRows,
  queryScalar,
  type PagedRpcRow,
  type StoreOptions,
} from "./client";
import type { DatasetGeometryType } from "./datasets";
import * as geometries from "./geometries";

/**
 * The entries store (design doc §8.1) — the PG counterpart of today's
 * `api.cms.entries.*`: `listPage` / `listForIds` / `get` / `create` /
 * `update` / `remove` / `clearDatasetRows`, plus `searchEntries` over the
 * `search_entries` RPC (§5.1 — the server-side table sort/filter/search the
 * Convex backend never had).
 *
 * Transactions: PostgREST statements are single-statement, so a row write
 * with a geometry (`create`/`update`) is two calls where the Convex mutation
 * was one transaction — a crash between them leaves the entry present with
 * no geometry row (the properties table still renders it; a re-edit repairs
 * it). The bulk path doesn't have this shape: `import_entries` is one SQL
 * statement per chunk (§5.3) and is atomic by itself.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL/RPC
 * signatures, not the generated `database.types.ts` (see `./client`).
 */

/** One entry row, as every entries read hands it back (the `entries` DDL columns a consumer needs; `search`/`created_by`/`updated_at` stay server-side). */
export interface EntryRow {
  id: string;
  datasetId: string;
  data: unknown;
  /** Denormalized copy of the entry's geometry type (null = no geometry), trigger-maintained (§3.2). */
  geometryType: DatasetGeometryType | null;
  createdAt: string;
}

const ENTRY_SELECT = "id,datasetId:dataset_id,data,geometryType:geometry_type,createdAt:created_at";

// ---------------------------------------------------------------------------
// Paging — plain PostgREST keyset over (created_at, id)
// ---------------------------------------------------------------------------

/**
 * Entries paging rides a plain PostgREST read, NOT `search_entries`: the
 * seam's whole-dataset exports need every row in a stable order with no
 * filter/sort/search concerns, and the two-column keyset below does that in
 * one code path for both orders (the `entries_dataset_created` btree serves
 * the default desc; `search_entries` stays the table view's sorted/filtered/
 * searched path). The cursor is the base64 of the last row's
 * `[created_at, id]` tuple — opaque, JSON-safe, stable under inserts (the
 * §5.1 keyset rule: no OFFSET).
 */
export interface EntriesPageArgs {
  datasetId: string;
  /** Opaque continuation from the previous page's `nextCursor`; null = first page. */
  cursor: string | null;
  numItems: number;
  /** Row direction — "desc" (newest first) is the table default, as `listEntriesPage`'s default was. */
  order?: "asc" | "desc";
}

export interface EntriesPage {
  rows: EntryRow[];
  /** null = exhausted (the `isDone` analogue, design §8.3). */
  nextCursor: string | null;
}

/** The cursor is the base64 of the sort tuple + id — JSON-safe for query keys and the persisted light state. */
function encodeEntryCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]));
}

/**
 * The only shapes the cursor's two slots may carry. Both are PostgREST wire
 * values this store itself wrote: `created_at` is a `timestamptz` rendered by
 * PostgREST's JSON (ISO-8601 with `Z` or a numeric offset), `id` a uuid.
 * Pinning them here is the injection guard: the tuple feeds an `or=` filter
 * STRING, so an unconstrained value (the cursor is URL-shareable) could
 * smuggle filter grammar — `").or(id.eq.<row>),id.eq.` — past the builder's
 * bound-parameter path and into the parsed filter.
 */
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeEntryCursor(cursor: string): [string, string] {
  try {
    const decoded: unknown = JSON.parse(atob(cursor));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === "string" &&
      typeof decoded[1] === "string" &&
      CURSOR_TIMESTAMP_RE.test(decoded[0]) &&
      CURSOR_UUID_RE.test(decoded[1])
    ) {
      return [decoded[0], decoded[1]];
    }
  } catch {
    // Fall through to the shared error — a malformed cursor is a caller bug.
  }
  throw new Error("Invalid entries page cursor.");
}

/**
 * The strictly-after (created_at, id) keyset filter for one direction. Both
 * values are DOUBLE-QUOTED (PostgREST's quoted-value form): a quoted token
 * keeps any character the validated values could still carry (`.`/`+`/`:` in
 * timestamps) out of the filter grammar's operator/comma delimiters, so the
 * tuple stays one literal value per comparison.
 */
function entryKeysetFilter(createdAt: string, id: string, ascending: boolean): string {
  return ascending
    ? `and(created_at.eq."${createdAt}",id.gt."${id}"),created_at.gt."${createdAt}"`
    : `and(created_at.eq."${createdAt}",id.lt."${id}"),created_at.lt."${createdAt}"`;
}

/**
 * One entries page, cursor-chained. Internally fetches `numItems + 1` rows
 * and trims — the exhaustion probe without an extra round trip (the same
 * trick the RPC section prescribes for `search_entries`).
 */
export async function listPage(
  args: EntriesPageArgs,
  options?: StoreOptions,
): Promise<EntriesPage> {
  const ascending = args.order === "asc";
  const take = Math.max(1, Math.trunc(args.numItems));
  let builder = clientOf(options)
    .from("entries")
    .select(ENTRY_SELECT)
    .eq("dataset_id", args.datasetId)
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(take + 1);
  if (args.cursor !== null) {
    const [createdAt, id] = decodeEntryCursor(args.cursor);
    builder = builder.or(entryKeysetFilter(createdAt, id, ascending));
  }
  const rows = await queryRows<EntryRow>(builder);
  if (rows.length > take) {
    const last = rows[take - 1];
    if (last !== undefined) {
      return {
        nextCursor: encodeEntryCursor(last.createdAt, last.id),
        rows: rows.slice(0, take),
      };
    }
  }
  return { nextCursor: null, rows };
}

// ---------------------------------------------------------------------------
// search_entries (design §5.1) — the server-side table sort/filter/search
// ---------------------------------------------------------------------------

/** The filter ops `search_entries` accepts (§5.1: `eq` is jsonb containment; ranges/`in` compare `data->>key`). */
export type SearchFilterOp = "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "in";

export interface SearchFilter {
  /** A DECLARED property key — the RPC validates it against the dataset's `properties` column and raises `invalid key` otherwise (the injection guard). */
  key: string;
  op: SearchFilterOp;
  value: unknown;
}

export interface SearchSort {
  key: string;
  dir: "asc" | "desc";
}

export interface SearchEntriesArgs {
  datasetId: string;
  /** Websearch syntax; absent/empty = no search filter. */
  query?: string;
  filters?: ReadonlyArray<SearchFilter>;
  /** Absent = the RPC's `created_at desc, id desc` default. */
  sort?: SearchSort;
  /** Opaque continuation from the previous page's `nextCursor`. */
  cursor?: string | null;
  limit?: number;
}

export interface SearchEntriesPage {
  rows: EntryRow[];
  nextCursor: string | null;
}

/** The RPC's default page width (§5.1). */
export const SEARCH_ENTRIES_DEFAULT_LIMIT = 200;

/** One `search_entries` row — the RPC's set-return shape (§5.1), `next_cursor` carried per the §5 intro rule (see `./client`). */
interface SearchEntriesRpcRow extends PagedRpcRow {
  id: string;
  data: unknown;
  geometry_type: DatasetGeometryType | null;
  created_at: string;
}

function searchRowOf(row: SearchEntriesRpcRow, datasetId: string): EntryRow {
  return {
    createdAt: row.created_at,
    data: row.data,
    datasetId,
    geometryType: row.geometry_type,
    id: row.id,
  };
}

/**
 * The dataset's entries through `search_entries` — server-side
 * search/sort/filter with keyset cursors. Key validation happens inside the
 * RPC (undeclared keys are rejected there); this wrapper is a pass-through.
 */
export async function searchEntries(
  args: SearchEntriesArgs,
  options?: StoreOptions,
): Promise<SearchEntriesPage> {
  const rows = await queryRows<SearchEntriesRpcRow>(
    clientOf(options).rpc("search_entries", {
      p_cursor: args.cursor ?? null,
      p_dataset: args.datasetId,
      p_filters: args.filters === undefined ? null : [...args.filters],
      p_limit: args.limit ?? SEARCH_ENTRIES_DEFAULT_LIMIT,
      p_query: args.query ?? null,
      p_sort: args.sort === undefined ? null : { ...args.sort },
    }),
  );
  return {
    nextCursor: nextPageCursor(rows),
    rows: rows.map((row) => searchRowOf(row, args.datasetId)),
  };
}

// ---------------------------------------------------------------------------
// Column rewrite (#292)

/** Entries per `rewrite_entry_field` call — small enough to stay well under PostgREST's body limit. */
export const REWRITE_CHUNK_SIZE = 2000;

export interface RewriteFieldArgs {
  datasetId: string;
  field: string;
  /** `value: null` removes the key from that entry's data. */
  values: ReadonlyArray<{ id: string; value: unknown }>;
}

/**
 * Rewrites one field across a dataset's entries through the set-based
 * `rewrite_entry_field` RPC (0031), in chunks. RLS gates every row; the
 * return is the number of entries actually changed (fewer than sent means
 * some were denied or belong elsewhere — callers report it, never assume).
 * Chunks are separate statements: a failure mid-way leaves earlier chunks
 * applied, so callers re-run the whole rewrite (it is idempotent).
 */
export async function rewriteField(
  args: RewriteFieldArgs,
  options?: StoreOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < args.values.length; start += REWRITE_CHUNK_SIZE) {
    const chunk = args.values.slice(start, start + REWRITE_CHUNK_SIZE);
    // Sequential on purpose: one chunk at a time keeps the write load and
    // the lock footprint small, and a failure stops before the next chunk.
    // oxlint-disable-next-line eslint/no-await-in-loop
    changed += await queryScalar<number>(
      clientOf(options).rpc("rewrite_entry_field", {
        p_dataset: args.datasetId,
        p_field: args.field,
        p_values: chunk.map((item) => ({ id: item.id, value: item.value ?? null })),
      }),
    );
    if (onProgress !== undefined) {
      onProgress(Math.min(start + chunk.length, args.values.length), args.values.length);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Point reads
// ---------------------------------------------------------------------------

/** One entry by id, or null when RLS hides it — `api.cms.entries.get` parity. */
export async function get(
  args: { entryId: string },
  options?: StoreOptions,
): Promise<EntryRow | null> {
  return await queryRow<EntryRow>(
    clientOf(options).from("entries").select(ENTRY_SELECT).eq("id", args.entryId).limit(1),
  );
}

/** Hard cap on `listForIds` (the component's `LIST_ENTRIES_FOR_IDS_MAX` — an unbounded id list would still be an unbounded read). */
export const LIST_FOR_IDS_MAX = 200;

/**
 * Entries by id — the reference-field label lookup (issue #54). Missing or
 * RLS-invisible ids are simply absent; callers render the raw id as the
 * documented fallback.
 */
export async function listForIds(
  args: { entryIds: ReadonlyArray<string> },
  options?: StoreOptions,
): Promise<EntryRow[]> {
  if (args.entryIds.length > LIST_FOR_IDS_MAX) {
    throw new Error(`entryIds exceeds ${LIST_FOR_IDS_MAX} items`);
  }
  if (args.entryIds.length === 0) {
    return [];
  }
  return await queryRows<EntryRow>(
    clientOf(options)
      .from("entries")
      .select(ENTRY_SELECT)
      .in("id", [...new Set(args.entryIds)]),
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `api.cms.entries.create` parity. `geometry` is the GeoJSON JSON TEXT (the entry-form's arg shape — parsed here into the `geometries.source` jsonb). */
export interface CreateEntryArgs {
  datasetId: string;
  data: unknown;
  geometry?: string;
}

/** Parses the geometry JSON-text arg into the inline source value (the entry-form passes strings, as the Convex `geometry: v.string()` arg did). */
function geometrySourceOf(geometry: string): unknown {
  try {
    return JSON.parse(geometry);
  } catch {
    throw new Error("Geometry is not valid JSON.");
  }
}

/**
 * Creates one entry (and its geometry, when given). Returns the new entry's
 * id. NOT one transaction (see the module comment); the import flow's bulk
 * path is `import_entries`, which is.
 */
export async function create(args: CreateEntryArgs, options?: StoreOptions): Promise<string> {
  const client = clientOf(options);
  const row = await queryRow<{ id: string }>(
    client
      .from("entries")
      .insert({ data: args.data, dataset_id: args.datasetId })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Entry insert returned no row.");
  }
  if (args.geometry !== undefined) {
    await geometries.create(
      { datasetId: args.datasetId, entryId: row.id, geometry: geometrySourceOf(args.geometry) },
      options,
    );
  }
  return row.id;
}

/** `api.cms.entries.update` parity. `geometry`: undefined = leave untouched, null = clear the geometry, a JSON text = replace it (the component `updateEntry` arg contract, kept verbatim). */
export interface UpdateEntryArgs {
  entryId: string;
  data: unknown;
  geometry?: string | null;
  /** The owning dataset — needed by the geometry FK when setting a geometry on an entry that has no geometry row yet; call sites have it (the route param). */
  datasetId?: string;
}

/** Updates an entry's data (and geometry, per the arg contract above). NOT one transaction (see the module comment). */
export async function update(args: UpdateEntryArgs, options?: StoreOptions): Promise<void> {
  const client = clientOf(options);
  await queryRows<unknown>(
    client.from("entries").update({ data: args.data }).eq("id", args.entryId).select("id"),
  );
  if (args.geometry === undefined) {
    return;
  }
  if (args.geometry === null) {
    await geometries.remove({ entryId: args.entryId }, options);
    return;
  }
  await geometries.replace(
    { datasetId: args.datasetId, entryId: args.entryId, geometry: geometrySourceOf(args.geometry) },
    options,
  );
}

/** Deletes one entry; its geometry row and references go with it by cascade (design §3.2). New surface — the Convex wrapper set never exposed a single-entry delete. */
export async function remove(args: { entryId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("entries").delete().eq("id", args.entryId).select("id"),
  );
}

/**
 * Deletes EVERY entry of a dataset (the failed-import Retry path, issue
 * #129 parity) — the clear that resets the summaries via the triggers.
 * Returns the deleted count (the Convex mutation's return shape).
 */
export async function clearDatasetRows(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("entries").delete().eq("dataset_id", args.datasetId).select("id"),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listPageQueryOptions(args: EntriesPageArgs, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:entries", "listPage", args],
    queryFn: async () => await listPage(args, options),
  });
}

export function searchEntriesQueryOptions(args: SearchEntriesArgs, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:entries", "searchEntries", args],
    queryFn: async () => await searchEntries(args, options),
  });
}

export function listForIdsQueryOptions(
  args: { entryIds: ReadonlyArray<string> },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:entries", "listForIds", args],
    queryFn: async () => await listForIds(args, options),
  });
}

export function getQueryOptions(args: { entryId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:entries", "get", args],
    queryFn: async () => await get(args, options),
  });
}
