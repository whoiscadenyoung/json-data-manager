import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The groups store (design doc §8.1; stage-3 catalog, issue #202) — the PG
 * counterpart of today's `api.cms.groups.*` (exposed in
 * `app/convex/cms/groups.ts`): `list` / `get` / `create` / `update` /
 * `remove` / `setCollection` / `setDatasetGroup`, over the `public.groups`
 * table and the datasets-side `group_id` column (DDL §3.4 + §3.2's stage-3
 * column, migration 0007).
 *
 * Behavior parity notes (each traces to the component's
 * `packages/json-cms/src/component/groups.ts`):
 *   - Groups join collections as SINGLE units: `collection_id` is nullable,
 *     a group lives in at most one collection, and `setCollection(null)`
 *     floats it standalone (the component's setGroupCollection, mirrored for
 *     datasets' setSchemaGroup shape).
 *   - A dataset belongs to at most one group, INDEPENDENT of its collection
 *     memberships — `setDatasetGroup` only ever touches
 *     `datasets.group_id`, never the join table (schema.ts:177-180).
 *   - `remove` is a plain delete: member datasets ungroup via the FK's ON
 *     DELETE SET NULL (the component's deleteGroup patch walk), and the
 *     group's own collection link dies with the row. Map layers pointing at
 *     the group are NOT cleaned up — map_layers.target_id is FK-less text
 *     (0005's dangling-target tolerance) and the stage-2 readers answer
 *     dangling targets defensively (deviation from the component's explicit
 *     layer cleanup walk; see also 0007's header note).
 *   - Regrouping a dataset is a datasets WRITE: RLS gates it with
 *     can_edit_dataset (a locked dataset regroups creator-only), matching
 *     the component host's assertDatasetWritable treatment of every
 *     dataset write. Denial shape: the UPDATE filters to zero rows and this
 *     module returns quietly — the recorded "reads as not found" rule.
 *
 * Transactions: none needed — every mutation is one statement; the component
 * runs each of these as one Convex transaction.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL (§3.4), not
 * the generated `database.types.ts` (see `./client`).
 */

/** One group, as every reader of `groups` gets it (DDL §3.4). */
export interface GroupRow {
  id: string;
  /** The collection the group lives in, or null when it floats standalone (component parity). */
  collectionId: string | null;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const GROUP_SELECT =
  "id,collectionId:collection_id,name,description,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";

/** The groups-list width when a caller doesn't pin one (the Convex call sites all passed 500). */
export const DEFAULT_GROUPS_LIMIT = 500;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The groups — every group when `collectionId` is omitted (standalone groups
 * included), or just the groups nested in that collection — `listGroups`
 * parity. Newest first in both branches.
 */
export async function list(
  args: { collectionId?: string; limit?: number },
  options?: StoreOptions,
): Promise<GroupRow[]> {
  let builder = clientOf(options).from("groups").select(GROUP_SELECT);
  if (args.collectionId !== undefined) {
    builder = builder.eq("collection_id", args.collectionId);
  }
  return await queryRows<GroupRow>(
    builder
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.trunc(args.limit ?? DEFAULT_GROUPS_LIMIT))),
  );
}

/** One group by id, or null when RLS hides it (invisible-row-reads-as-not-found). */
export async function get(
  args: { groupId: string },
  options?: StoreOptions,
): Promise<GroupRow | null> {
  return await queryRow<GroupRow>(
    clientOf(options).from("groups").select(GROUP_SELECT).eq("id", args.groupId).limit(1),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listQueryOptions(
  args: { collectionId?: string; limit?: number } = {},
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:groups", "list", args],
    queryFn: async () => await list(args, options),
  });
}

export function getQueryOptions(args: { groupId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:groups", "get", args],
    queryFn: async () => await get(args, options),
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** The group write may set — the component `createGroup`/`updateGroup` arg set. */
export interface GroupArgs {
  name: string;
  description?: string;
  /** Create-time only: the collection the group lives in (omit = standalone). */
  collectionId?: string;
}

/** The component's create/update validation (`ConvexError("Group must have a name")`). */
function assertNamed(args: { name: string }): void {
  if (!args.name.trim()) {
    throw new Error("Group must have a name");
  }
}

/** `api.cms.groups.create` parity: creates a group, optionally nested in a collection (an unknown collection id is the FK's 23503, the component's "Collection not found"). Returns the new group's id. */
export async function create(args: GroupArgs, options?: StoreOptions): Promise<string> {
  assertNamed(args);
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("groups")
      .insert({
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.collectionId === undefined ? {} : { collection_id: args.collectionId }),
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Group insert returned no row.");
  }
  return row.id;
}

/** `api.cms.groups.update` parity. Absent fields stay untouched (the component's patch semantics); `updated_at` is the set_updated_at trigger's job. */
export async function update(
  args: { groupId: string } & Partial<Omit<GroupArgs, "collectionId">>,
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
    clientOf(options).from("groups").update(patch).eq("id", args.groupId).select("id"),
  );
}

/** Deletes the group; member datasets ungroup via ON DELETE SET NULL (see the module comment). */
export async function remove(args: { groupId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("groups").delete().eq("id", args.groupId).select("id"),
  );
}

/**
 * `api.cms.groups.setCollection` parity: sets (or clears, via null) which
 * collection a group lives in. "Adding" a group to a collection IS setting
 * it here — it moves out of any collection it previously lived in. The
 * member datasets' own collection memberships are untouched (group
 * membership is independent of dataset membership).
 */
export async function setCollection(
  args: { groupId: string; collectionId: string | null },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("groups")
      .update({ collection_id: args.collectionId })
      .eq("id", args.groupId)
      .select("id"),
  );
}

/**
 * `api.cms.collections.setSchemaGroup` parity (the Convex wrapper exposed it
 * under collections; it lives HERE because it is group membership): sets (or
 * clears, via null) a dataset's group. Never touches the collection join
 * table. Gated by the datasets UPDATE policy — a locked dataset regroups
 * creator-only; a denial filters to zero rows and returns quietly (the
 * recorded RLS denial shape).
 */
export async function setDatasetGroup(
  args: { datasetId: string; groupId: string | null },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("datasets")
      .update({ group_id: args.groupId })
      .eq("id", args.datasetId)
      .select("id"),
  );
}
