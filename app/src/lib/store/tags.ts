import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import { VERSIONS_READ_LIMIT } from "./versions";

/**
 * The tags store (stage 4, issue #203) — the PG counterpart of the tag
 * surface (`api.versions.tags.*`'s CRUD/retire legs) over the
 * `public.tags` table (DDL §3.5, migration 0009): named pins on a dataset's
 * frozen versions, unique per (dataset_id, name).
 *
 * Parity notes (each traces to `app/convex/versions/tags.ts`):
 *   - `retired_at` null = live; a retired tag stops pinning (the retention
 *     exemption reads live tags only — the migration's keep-N pass).
 *   - Retire REFUSES, never repins, while a consumer_reference still pins
 *     the tag's version (#126, `tags_guard_retire`): the DB trigger raises,
 *     and this module surfaces that error untouched — "This version is
 *     pinned by a consumer — float or unpin that reference before retiring
 *     it." (tags.ts:166-169).
 *   - Deleting a tag fires the same guard; deleting a VERSION while pinned
 *     is refused by the FK itself (ON DELETE RESTRICT — "the pin, as FK").
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): an RLS-filtered write answers 0 rows instead of
 * throwing, and the UI reports that honestly.
 *
 * The version-reads on this surface (the versions a tag can name) live in
 * `./versions` (`listVersionsQueryOptions`) — the §8.1 module split puts
 * datasetVersions there and tags here.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One named pin (the `tags` row). */
export interface TagRow {
  id: string;
  datasetId: string;
  /** Unique per dataset (the DB constraint); the human-facing version name. */
  name: string;
  /** The pinned version — the FK IS the pin (ON DELETE RESTRICT). */
  versionId: string;
  /** null = live. */
  retiredAt: string | null;
  createdBy: string;
  createdAt: string;
}

const TAG_SELECT =
  "id,datasetId:dataset_id,name,versionId:version_id,retiredAt:retired_at,createdBy:created_by,createdAt:created_at";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One dataset's tags, newest first (live and retired — `retiredAt` tells them apart). */
export function listQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:tags", "list", args],
    queryFn: async () =>
      await queryRows<TagRow>(
        clientOf(options)
          .from("tags")
          .select(TAG_SELECT)
          .eq("dataset_id", args.datasetId)
          .order("created_at", { ascending: false })
          .limit(VERSIONS_READ_LIMIT),
      ),
  });
}

/** One tag by id, or null when gone/invisible. */
export function getQueryOptions(args: { tagId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:tags", "get", args],
    queryFn: async () =>
      await queryRow<TagRow>(
        clientOf(options).from("tags").select(TAG_SELECT).eq("id", args.tagId).limit(1),
      ),
  });
}

// ---------------------------------------------------------------------------
// Writes — rows-affected returns (the stage-4 silent-denial rule)
// ---------------------------------------------------------------------------

/** The {@link create} argument set: a named pin on one frozen version. */
export interface CreateTagArgs {
  datasetId: string;
  name: string;
  versionId: string;
}

/**
 * Creates a tag — a named pin on one frozen version. Returns the row (the
 * SELECT policy passes RETURNING — `using (true)`, no definer helper, so
 * the 0008 trap cannot bite). A duplicate (dataset_id, name) raises the
 * 23505 constraint, exactly like the Convex unique read would have.
 */
export async function create(args: CreateTagArgs, options?: StoreOptions): Promise<TagRow> {
  const row = await queryRow<TagRow>(
    clientOf(options)
      .from("tags")
      .insert({ dataset_id: args.datasetId, name: args.name, version_id: args.versionId })
      .select(TAG_SELECT)
      .single(),
  );
  if (row === null) {
    throw new Error("Tag insert returned no row.");
  }
  return row;
}

/**
 * Retires a tag (soft): `retired_at` is set, the pin stops (retention
 * exempt reads live tags only). The #126 guard fires when a consumer still
 * pins the version — the trigger's raise propagates as the thrown error.
 * Returns the affected row count (0 = denied/gone).
 */
export async function retire(args: { tagId: string }, options?: StoreOptions): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("tags")
      .update({ retired_at: new Date().toISOString() })
      .eq("id", args.tagId)
      .select("id"),
  );
  return rows.length;
}

/**
 * Deletes a tag row. The same #126 guard applies; a version delete is
 * separately FK-restricted while any tag or consumer pins it. Returns the
 * affected row count (0 = denied/gone).
 */
export async function remove(args: { tagId: string }, options?: StoreOptions): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("tags").delete().eq("id", args.tagId).select("id"),
  );
  return rows.length;
}
