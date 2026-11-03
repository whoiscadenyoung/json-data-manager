import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "#/integrations/supabase/client";

/**
 * The store modules' client seam (design doc §8.1): every per-domain module
 * and the PG row-resolution seam (`dataset-rows-pg.ts`) resolve their
 * `SupabaseClient` through here, so a caller can run on a specific instance
 * (the tile-archive web worker passes its own) while everything else rides
 * the shared browser client — the same shape `dataset-rows.ts` had with its
 * shared `ConvexClient`.
 *
 * NOTE: the store modules deliberately define their own NARROW row and
 * RPC-argument interfaces, typed from the migration design doc's DDL and RPC
 * signatures (`docs/supabase-migration-design.md` §3/§5), instead of
 * importing the generated `app/src/lib/supabase/database.types.ts` — that
 * file is owned by the schema/RPC workstream, and a later stage reconciles
 * the store onto the generated types wholesale.
 */

/** Optional client override for any store call. */
export interface StoreOptions {
  supabase?: SupabaseClient;
}

let shared: SupabaseClient | undefined;

/**
 * The shared browser client — auth rides the session cookies the provider
 * keeps fresh (`integrations/supabase/provider.tsx`); no per-call token
 * re-assert exists to manage (design doc §8.3: "no token-fetch pause dance").
 */
export function sharedClient(): SupabaseClient {
  if (shared === undefined) {
    shared = supabase;
  }
  return shared;
}

/** The client one store call runs on: the override, else the shared client. */
export function clientOf(options: StoreOptions | undefined): SupabaseClient {
  if (options !== undefined && options.supabase !== undefined) {
    return options.supabase;
  }
  return sharedClient();
}

// ---------------------------------------------------------------------------
// Response shaping — every PostgREST/RPC call funnels through these, so the
// narrow row interfaces are produced in exactly one place per shape.
// ---------------------------------------------------------------------------

/**
 * Every store call turns a PostgREST error (an RLS denial, a constraint, a
 * malformed request) into one thrown `Error` carrying the message and code.
 * RLS denials keep their recorded shape here: writes throw, reads simply
 * return fewer rows (the invisible-row-reads-as-not-found rule, ADR 0010).
 */
export function throwPostgrestError(error: PostgrestError): never {
  throw new Error(`${error.message} (${error.code})`);
}

/** `data` as the caller's row-array shape; a non-array (null on empty selects) reads as no rows. */
export function asRows<T>(data: unknown): T[] {
  if (!Array.isArray(data)) {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the untyped (pre-reconciliation) supabase-js client hands rows back untyped; the store's narrow row interfaces are the intended shape until the generated Database types land (see the module comment).
  return data as T[];
}

/** The awaited shape of every supabase-js query: rows (any shape) or an error. */
export interface QueryResponse {
  data: unknown;
  error: PostgrestError | null;
}

/** Awaits one table/RPC query, error-checks it, and narrows the rows to `T[]`. */
export async function queryRows<T>(query: PromiseLike<QueryResponse>): Promise<T[]> {
  const { data, error } = await query;
  if (error !== null) {
    throwPostgrestError(error);
  }
  return asRows<T>(data);
}

/**
 * `queryRows` for one-row reads. Handles both response shapes the real
 * builders produce: an array (plain selects) answers its first row, and a
 * single object (`.single()`, the insert/update-returning shape) answers
 * itself. Null on neither.
 */
export async function queryRow<T>(query: PromiseLike<QueryResponse>): Promise<T | null> {
  const { data, error } = await query;
  if (error !== null) {
    throwPostgrestError(error);
  }
  if (Array.isArray(data)) {
    const first: T | undefined = asRows<T>(data)[0];
    return first === undefined ? null : first;
  }
  if (data === null || typeof data !== "object") {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a `.single()` response is the row object itself; the store's narrow row interface is the intended shape until the generated Database types land (see the module comment).
  return data as T;
}

/**
 * The awaited shape of a scalar-returning RPC (PostgREST answers
 * `returns integer`/`boolean` functions with the bare JSON value —
 * `import_entries`' count, `install_tile_archive`'s flag).
 */
export async function queryScalar<T>(query: PromiseLike<QueryResponse>): Promise<T> {
  const { data, error } = await query;
  if (error !== null) {
    throwPostgrestError(error);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the scalar response IS the caller's declared shape (the RPC signature pins it); same posture as `queryRow` until the generated Database types land.
  return data as T;
}

/**
 * Columns shared by every paged set-returning RPC. The design doc's RPC
 * section fixes this for ALL paging functions: "every RPC that pages returns
 * next_cursor (null = exhausted — the `isDone` analogue the seam requires)"
 * (§5 intro). `search_entries`' sketch shows the column; `dataset_rows_for_tiles`'
 * sketch omits it while its preamble sentence covers it — this interface
 * reads the preamble as binding until the generated types land.
 */
export interface PagedRpcRow {
  next_cursor: string | null;
}

/**
 * A paged RPC's `next_cursor`: read from the LAST returned row (the column
 * rides every row of the set; the last row's value is the page's continuation
 * either way). An empty page is exhausted by definition — the guard keeps a
 * mis-shaped RPC from looping the caller forever.
 */
export function nextPageCursor(rows: ReadonlyArray<PagedRpcRow>): string | null {
  const last = rows[rows.length - 1];
  if (last === undefined || rows.length === 0) {
    return null;
  }
  return last.next_cursor;
}

/** Signed-URL lifetime for private Storage reads (design doc §6). The TTL-vs-OPFS-pin tradeoff is a recorded stage-2 open question (§16); one hour keeps every read fresh without hammering the signer. */
export const STORAGE_SIGNED_URL_TTL_SECONDS = 3600;
