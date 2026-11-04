import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT, DATASET_FULL_SELECT, type DatasetRow } from "./datasets";

/**
 * The collections store (design doc §8.1; stage-3 catalog, issue #202) — the
 * PG counterpart of today's `api.cms.collections.*` (exposed in
 * `app/convex/cms/collections.ts`): `list` / `get` / `create` / `update` /
 * `remove` / `listDatasets` / `listMemberships` / `listCollectionsByDataset`
 * / `addToCollection` / `removeFromCollection`, over the `public.collections`
 * and `public.collection_datasets` tables (DDL §3.4, migration 0007).
 *
 * MODULE-NAME MAP (recorded for the §8.1 reader — the stage-3 review flagged
 * the missing record): §8.1 sketches `catalog.ts` and `styles.ts`, but the
 * shipped modules keep the domain names they already had — §8.1's
 * `catalog.ts` (collections/groups/membership) is SPLIT into this file +
 * `groups.ts` (+ membership in `collection_datasets` here, group assignment
 * in `groups.ts`), its map-store bullet stays in `maps.ts`, and §8.1's
 * `styles.ts` (layerStyles + markerSprites) is `layer-styles.ts`. The
 * exports are the contract, not the file names.
 *
 * Behavior parity notes (each traces to the component's
 * `packages/json-cms/src/component/collections.ts`):
 *   - Membership is MANY-TO-MANY (`collection_datasets`, PK
 *     (collection_id, dataset_id)): a dataset sits in any number of
 *     collections; `addToCollection` is a no-op when the pair already exists
 *     (the component's early return → the store's `ignoreDuplicates` upsert).
 *   - The join's denormalized `kind` is stamped by the database (the 0007
 *     trigger reads the dataset's `is_geospatial` at write time — the
 *     component's insert-time stamp, enforced for every writer), so this
 *     module never sends it.
 *   - `remove` is a plain delete: the FKs cascade (§3.4's "deleted-with-parent
 *     cascades replace the component's explicit cleanup walks"). The nested
 *     groups FLOAT standalone (groups.collection_id is ON DELETE SET NULL) —
 *     a recorded deviation from the component, whose deleteCollection deleted
 *     them; the binding DDL keeps them.
 *   - Membership rows whose dataset is RLS-invisible (someone's draft) simply
 *     don't appear in `listDatasets` — the `datasets!inner` embed drops the
 *     row when the joined dataset is filtered, exactly the component's
 *     null-filter + viewer scoping, but enforced by RLS instead of a
 *     `viewerId` argument (identity rides the session; design §4).
 *
 * `setSchemaGroup` (the group-assignment mutation the Convex wrapper exposed
 * under collections) lives in `./groups` — it writes `datasets.group_id` and
 * is group membership, not collection membership.
 *
 * Transactions: none needed — every mutation here is one statement, and the
 * two-statement flows the component ran as one Convex transaction (delete +
 * membership walk) are single FK cascades here.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL (§3.4), not
 * the generated `database.types.ts` (see `./client`).
 */

/** One collection, as every reader of `collections` gets it (DDL §3.4). */
export interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One `{dataset, collection}` membership row — the `listSchemaCollections`
 * shape (the browser's "count memberships without one query per collection"
 * read). `kind` is the trigger-stamped denormalization; null survives only on
 * rows whose dataset was RLS-invisible to the writer (inert — such members
 * drop out of every dataset join).
 */
export interface CollectionMembershipRow {
  collectionId: string;
  datasetId: string;
  kind: "standard" | "geospatial" | null;
}

const COLLECTION_SELECT =
  "id,name,description,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";
const MEMBERSHIP_SELECT = "collectionId:collection_id,datasetId:dataset_id,kind";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The collections, newest first — `api.cms.collections.list` parity. */
export async function list(options?: StoreOptions): Promise<CollectionRow[]> {
  return await queryRows<CollectionRow>(
    clientOf(options)
      .from("collections")
      .select(COLLECTION_SELECT)
      .order("created_at", { ascending: false })
      .limit(CATALOG_READ_LIMIT),
  );
}

/** One collection by id, or null when RLS hides it (invisible-row-reads-as-not-found). */
export async function get(
  args: { collectionId: string },
  options?: StoreOptions,
): Promise<CollectionRow | null> {
  return await queryRow<CollectionRow>(
    clientOf(options)
      .from("collections")
      .select(COLLECTION_SELECT)
      .eq("id", args.collectionId)
      .limit(1),
  );
}

/**
 * One collection's member datasets as full rows — `listSchemasByCollection`
 * parity (the component returned full public views, not summaries). The
 * `datasets!inner` embed joins through `collection_datasets.dataset_id`; RLS
 * filters the embedded side, so drafts/author-only rows drop their whole
 * membership row instead of surfacing.
 */
export async function listDatasets(
  args: { collectionId: string },
  options?: StoreOptions,
): Promise<DatasetRow[]> {
  const rows = await queryRows<{ datasets: DatasetRow }>(
    clientOf(options)
      .from("collection_datasets")
      .select(`datasets!inner(${DATASET_FULL_SELECT})`)
      .eq("collection_id", args.collectionId)
      .limit(CATALOG_READ_LIMIT),
  );
  return rows.map((row) => row.datasets);
}

/** Every membership row — `listSchemaCollections` parity (the UI passed limit 1000). */
export async function listMemberships(options?: StoreOptions): Promise<CollectionMembershipRow[]> {
  return await queryRows<CollectionMembershipRow>(
    clientOf(options)
      .from("collection_datasets")
      .select(MEMBERSHIP_SELECT)
      .limit(CATALOG_READ_LIMIT),
  );
}

/** The collections one dataset belongs to — `listCollectionsBySchema` parity, via the join's by_dataset index. */
export async function listCollectionsByDataset(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<CollectionRow[]> {
  const rows = await queryRows<{ collections: CollectionRow }>(
    clientOf(options)
      .from("collection_datasets")
      .select(`collections!inner(${COLLECTION_SELECT})`)
      .eq("dataset_id", args.datasetId)
      .limit(CATALOG_READ_LIMIT),
  );
  return rows.map((row) => row.collections);
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:collections", "list"],
    queryFn: async () => await list(options),
  });
}

export function getQueryOptions(args: { collectionId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:collections", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listDatasetsQueryOptions(args: { collectionId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:collections", "listDatasets", args],
    queryFn: async () => await listDatasets(args, options),
  });
}

export function listMembershipsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:collections", "listMemberships"],
    queryFn: async () => await listMemberships(options),
  });
}

export function listCollectionsByDatasetQueryOptions(
  args: { datasetId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:collections", "listCollectionsByDataset", args],
    queryFn: async () => await listCollectionsByDataset(args, options),
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The collection write may set — the component `createCollection`/`updateCollection` arg set. */
export interface CollectionArgs {
  name: string;
  description?: string;
}

/** The component's create/update validation (`ConvexError("Collection must have a name")`). */
function assertNamed(args: { name: string }): void {
  if (!args.name.trim()) {
    throw new Error("Collection must have a name");
  }
}

/** `api.cms.collections.create` parity. Returns the new collection's id. */
export async function create(args: CollectionArgs, options?: StoreOptions): Promise<string> {
  assertNamed(args);
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("collections")
      .insert({
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Collection insert returned no row.");
  }
  return row.id;
}

/** `api.cms.collections.update` parity. Absent fields stay untouched (the component's patch semantics); `updated_at` is the set_updated_at trigger's job. */
export async function update(
  args: { collectionId: string } & Partial<CollectionArgs>,
  options?: StoreOptions,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) {
    assertNamed({ name: args.name });
    patch.name = args.name;
  }
  if (args.description !== undefined) {
    patch.description = args.description;
  }
  await queryRows<unknown>(
    clientOf(options).from("collections").update(patch).eq("id", args.collectionId).select("id"),
  );
}

/** Deletes the collection; its memberships cascade with it and its groups float standalone (see the module comment's deviation note). */
export async function remove(
  args: { collectionId: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("collections").delete().eq("id", args.collectionId).select("id"),
  );
}

/**
 * Adds a dataset to a collection — `addSchemaToCollection` parity: a no-op
 * when the pair exists (`ignoreDuplicates` on the PK), an FK error when
 * either side is gone (the component's "not found" ConvexErrors). The
 * denormalized `kind` is left to the 0007 stamp trigger.
 */
export async function addToCollection(
  args: { collectionId: string; datasetId: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("collection_datasets")
      .upsert(
        { collection_id: args.collectionId, dataset_id: args.datasetId },
        { onConflict: "collection_id,dataset_id", ignoreDuplicates: true },
      )
      .select("dataset_id"),
  );
}

/** Removes one membership — `removeSchemaFromCollection` parity: other memberships and the dataset's group are untouched; absent pair = silent no-op. */
export async function removeFromCollection(
  args: { collectionId: string; datasetId: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("collection_datasets")
      .delete()
      .eq("collection_id", args.collectionId)
      .eq("dataset_id", args.datasetId)
      .select("dataset_id"),
  );
}
