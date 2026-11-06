import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";

/**
 * The layers store (issue #257 — the project-centric train's phase 3; ADR
 * 0019, porting the preserved branch's phase 3 to Postgres) — the
 * style-decoupled-from-data unit over `public.layers`,
 * `public.layer_children`, `public.layer_versions`, plus the kind-'layer'
 * memberships the module mints in `public.project_artifacts`.
 *
 * The recorded shapes (ADR 0019):
 *   - Layers are PROJECT-OWNED from birth: a data layer styles one dataset
 *     membership of its own project (CASCADE — the membership dies, its
 *     layers die); groups are layers (kind 'group'), so they publish/link/
 *     clone exactly like data layers; nesting lives only inside groups and
 *     cycles are rejected at EDIT time (the depth-bounded parent walk in
 *     {@link assertAddChildSafe}).
 *   - "Layers join by create/link only" (branch parity): {@link create}
 *     mints the owned layer's membership (kind 'layer', role 'owned',
 *     artifact_id = the layers row id) in the same flow; {@link linkLayer}
 *     mints the linked one (artifact_id IS the pinned layer_versions row).
 *     The client-facing projects.addArtifact never sees kind 'layer'.
 *   - `layer_versions` rows are append-only (no update/delete grants): a
 *     data version freezes the definition and pins its dataset ref at
 *     publish; a group version publishes its draft children first (the
 *     bundle-closure pattern) and freezes their pinned versions.
 *     Existence of a version — not the lifecycle marker — gates
 *     link/clone (the existence-over-marker rule).
 *   - Any styling write clears `needs_attention` (the drift message the
 *     dataset schema-edit flow stamps; a string says what moved).
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): RLS-filtered writes answer 0 rows / null instead of
 * throwing — a foreign project's write reads as not-found.
 *
 * NOTE: narrow local interfaces typed from the migration 0020 DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One layer — the style/filter/labels/popup unit (kind `group` carries children instead of data). */
export interface LayerRow {
  id: string;
  projectId: string;
  kind: "data" | "group";
  name: string;
  /** Data kind: the dataset membership this layer styles (same project); null on groups. */
  datasetMemberId: string | null;
  /** MapLibre style-spec fragment (`{}` = the assigned-color default); shapeless here, validated at the UI boundary. */
  style: unknown;
  filter: unknown;
  labels: unknown;
  popup: unknown;
  /** Group transparency 0–1; null = opaque default. */
  opacity: number | null;
  visible: boolean;
  lifecycle: "draft" | "published";
  /** The drift message (set by the schema-edit stamp, cleared by the next styling write). */
  needsAttention: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One child placement inside a group layer (rows, not arrays). */
export interface LayerChildRow {
  id: string;
  groupId: string;
  /** owned → childLayerId is a layers row; linked → a pinned layer_versions row id. */
  childKind: "owned" | "linked";
  childLayerId: string;
  order: number;
}

/** One frozen published definition (append-only chain; newest per layer is the head). */
export interface LayerVersionRow {
  id: string;
  layerId: string;
  versionLabel: string;
  /** The frozen name/style/filter/labels/popup/opacity/visible at publish. */
  definition: unknown;
  /** Data kind: {sourceMemberId, pinnedVersionId, pinnedRef} at publish; null on groups. */
  dataset: unknown;
  /** Group versions: [{childKind, childLayerId, versionId?}] at freeze; null on data layers. */
  frozenChildren: unknown;
  createdBy: string;
  createdAt: string;
}

const LAYER_SELECT =
    "id,projectId:project_id,kind,name,datasetMemberId:dataset_member_id,style,filter,labels,popup,opacity,visible,lifecycle,needsAttention:needs_attention,createdBy:created_by,createdAt:created_at,updatedAt:updated_at",
  CHILD_SELECT = "id,groupId:group_id,childKind:child_kind,childLayerId:child_layer_id,order",
  VERSION_SELECT =
    "id,layerId:layer_id,versionLabel:version_label,definition,dataset,frozenChildren:frozen_children,createdBy:created_by,createdAt:created_at";

/** The membership payload the module mints for one layer (kind-layer memberships join by create/link only). */
function layerMembershipRow(args: {
  projectId: string;
  artifactId: string;
  role: "owned" | "linked";
}): Record<string, unknown> {
  return {
    artifact_id: args.artifactId,
    artifact_kind: "layer",
    project_id: args.projectId,
    role: args.role,
    sync_mode: "manual",
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One project's layers, oldest first (the creation order the panel reproduces). */
export async function listForProject(
  args: { projectId: string },
  options?: StoreOptions,
): Promise<LayerRow[]> {
  return await queryRows<LayerRow>(
    clientOf(options)
      .from("layers")
      .select(LAYER_SELECT)
      .eq("project_id", args.projectId)
      .order("created_at", { ascending: true })
      .limit(CATALOG_READ_LIMIT),
  );
}

/** One layer by id, or null when RLS hides it (invisible reads as not-found). */
export async function get(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<LayerRow | null> {
  return await queryRow<LayerRow>(
    clientOf(options).from("layers").select(LAYER_SELECT).eq("id", args.layerId).limit(1),
  );
}

/** One group's children in draw order (the index scan IS the list). */
export async function listChildren(
  args: { groupId: string },
  options?: StoreOptions,
): Promise<LayerChildRow[]> {
  return await queryRows<LayerChildRow>(
    clientOf(options)
      .from("layer_children")
      .select(CHILD_SELECT)
      .eq("group_id", args.groupId)
      .order("order", { ascending: true })
      .order("id", { ascending: true })
      .limit(CATALOG_READ_LIMIT),
  );
}

/**
 * The children of MANY groups in one `in` read — the editor's tree load
 * (per-group reads would be one query per placed group). Rows carry only
 * their own columns; the caller groups by `groupId`.
 */
export async function listChildrenForGroups(
  args: { groupIds: string[] },
  options?: StoreOptions,
): Promise<LayerChildRow[]> {
  if (args.groupIds.length === 0) {
    return [];
  }
  return await queryRows<LayerChildRow>(
    clientOf(options)
      .from("layer_children")
      .select(CHILD_SELECT)
      .in("group_id", args.groupIds)
      .order("order", { ascending: true })
      .limit(CATALOG_READ_LIMIT),
  );
}

/** One layer's version chain, newest first. */
export async function listVersions(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<LayerVersionRow[]> {
  return await queryRows<LayerVersionRow>(
    clientOf(options)
      .from("layer_versions")
      .select(VERSION_SELECT)
      .eq("layer_id", args.layerId)
      .order("created_at", { ascending: false })
      .limit(CATALOG_READ_LIMIT),
  );
}

/** The head (newest) version of one layer, or null before the first publish. */
export async function headVersion(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<LayerVersionRow | null> {
  return await queryRow<LayerVersionRow>(
    clientOf(options)
      .from("layer_versions")
      .select(VERSION_SELECT)
      .eq("layer_id", args.layerId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
}

/** One version by id, or null when RLS hides it (the link/clone source read). */
export async function getVersion(
  args: { versionId: string },
  options?: StoreOptions,
): Promise<LayerVersionRow | null> {
  return await queryRow<LayerVersionRow>(
    clientOf(options)
      .from("layer_versions")
      .select(VERSION_SELECT)
      .eq("id", args.versionId)
      .limit(1),
  );
}

export function listForProjectQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:layers", "listForProject", args],
    queryFn: async () => await listForProject(args, options),
  });
}

export function getQueryOptions(args: { layerId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:layers", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listChildrenForGroupsQueryOptions(
  args: { groupIds: string[] },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:layers", "listChildrenForGroups", args],
    queryFn: async () => await listChildrenForGroups(args, options),
  });
}

export function listVersionsQueryOptions(args: { layerId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:layers", "listVersions", args],
    queryFn: async () => await listVersions(args, options),
  });
}

/** One project_artifacts row as the layer flows resolve it (the membership → artifact hop). */
export interface ArtifactRefRow {
  id: string;
  /** The referenced artifact — owned layer memberships name a layers row; linked ones a layer_versions row; dataset/derived memberships name their catalog row. */
  artifactId: string;
  artifactKind: "dataset" | "derived" | "layer";
  role: "owned" | "linked";
}

/**
 * Membership rows by id, in one `in` read — the editor's placement
 * resolution (placement.layerMemberId → the layer or pinned version it
 * names) and the data-leg hop (layer.datasetMemberId → the dataset id).
 */
export async function artifactsByIds(
  args: { ids: string[] },
  options?: StoreOptions,
): Promise<ArtifactRefRow[]> {
  if (args.ids.length === 0) {
    return [];
  }
  return await queryRows<ArtifactRefRow>(
    clientOf(options)
      .from("project_artifacts")
      .select("id,artifactId:artifact_id,artifactKind:artifact_kind,role")
      .in("id", args.ids)
      .limit(CATALOG_READ_LIMIT),
  );
}

/**
 * The kind-'layer' membership minted for a layer (create/link mint it
 * in-flow; this resolves it afterwards — the auto-layer flow's placement
 * input). Null when RLS hides it.
 */
export async function membershipIdForLayer(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<string | null> {
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("project_artifacts")
      .select("id")
      .eq("artifact_id", args.layerId)
      .eq("artifact_kind", "layer")
      .limit(1),
  );
  return row === null ? null : row.id;
}

/** One dataset/derived membership of a project (the auto-layer picker's candidates). */
export interface DatasetMembershipRow {
  id: string;
  /** The catalog row this membership names (a datasets or derived_datasets id — `artifactKind` says which table answers). */
  artifactId: string;
  artifactKind: "dataset" | "derived";
}

/**
 * A project's dataset + derived memberships, oldest first — the add-dataset
 * sheet's candidates (the auto-layer styles an EXISTING membership;
 * "references, never copies").
 */
export async function listDatasetMemberships(
  args: { projectId: string },
  options?: StoreOptions,
): Promise<DatasetMembershipRow[]> {
  return await queryRows<DatasetMembershipRow>(
    clientOf(options)
      .from("project_artifacts")
      .select("id,artifactId:artifact_id,artifactKind:artifact_kind")
      .eq("project_id", args.projectId)
      .in("artifact_kind", ["dataset", "derived"])
      .order("id", { ascending: true })
      .limit(CATALOG_READ_LIMIT),
  );
}

/** The linkable versions read: a published layer's frozen definition with its layer + project named (the linked-layer picker's rows). */
export interface LinkableVersionRow {
  id: string;
  versionLabel: string;
  createdAt: string;
  layer: { id: string; name: string; projectId: string; project: { id: string; title: string } };
}

/**
 * Recent published layer versions across every project the viewer can see,
 * newest first (RLS scopes the rows; the embeds name them). The
 * linked-layer picker's list — link = pin one of these into a project.
 */
export async function listLinkableVersions(options?: StoreOptions): Promise<LinkableVersionRow[]> {
  return await queryRows<LinkableVersionRow>(
    clientOf(options)
      .from("layer_versions")
      .select(
        "id,versionLabel:version_label,createdAt:created_at," +
          "layer:layers(id,name,projectId:project_id,project:projects(id,title))",
      )
      .order("created_at", { ascending: false })
      .limit(100),
  );
}

export function listLinkableVersionsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:layers", "listLinkableVersions"],
    queryFn: async () => await listLinkableVersions(options),
  });
}

// ---------------------------------------------------------------------------
// The cycle guard — depth-bounded parent/descendant walk (edit-time
// rejection; the DB keeps the tree shaped, this keeps it acyclic)
// ---------------------------------------------------------------------------

/** How deep the guard walks before refusing (a tree deeper than this is a bug, not a use case). */
export const LAYER_DEPTH_LIMIT = 32;

/**
 * Would adding `childLayerId` (an owned layer) under `groupId` close a
 * cycle? The new edge points group → child, so a cycle opens exactly when
 * the group is reachable FROM the child by descending through owned
 * children. Walks the child's descendants depth-first, bounded; a linked
 * child is a frozen foreign snapshot (it cannot contain project layers),
 * so only owned edges descend.
 */
export async function assertAddChildSafe(
  args: { groupId: string; childLayerId: string },
  options?: StoreOptions,
): Promise<void> {
  if (args.groupId === args.childLayerId) {
    throw new Error("A layer cannot be nested inside itself.");
  }
  const seen = new Set<string>([args.childLayerId]);
  let frontier: string[] = [args.childLayerId];
  for (let depth = 0; depth < LAYER_DEPTH_LIMIT; depth += 1) {
    if (frontier.length === 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- the frontier walk is inherently level-by-level; each level's children feed the next.
    const rows = await queryRows<LayerChildRow>(
      clientOf(options)
        .from("layer_children")
        .select(CHILD_SELECT)
        .in("group_id", frontier)
        .eq("child_kind", "owned")
        .limit(CATALOG_READ_LIMIT),
    );
    const next: string[] = [];
    for (const row of rows) {
      if (row.childLayerId === args.groupId) {
        throw new Error("That grouping closes a cycle — a layer cannot contain its own ancestor.");
      }
      if (!seen.has(row.childLayerId)) {
        seen.add(row.childLayerId);
        next.push(row.childLayerId);
      }
    }
    frontier = next;
  }
  throw new Error("The layer tree is too deep to verify — refactor the groups first.");
}

// ---------------------------------------------------------------------------
// Writes — layer rows (silent-denial returns; membership writes minted
// internally, "join by create/link only")
// ---------------------------------------------------------------------------

/** The layer create arg set (name the only required field, the UI rule). */
export interface CreateLayerArgs {
  projectId: string;
  kind: "data" | "group";
  name: string;
  /** Data kind: the dataset membership this layer styles (same project). */
  datasetMemberId?: string;
  style?: unknown;
}

/**
 * Creates a layer (owned, draft) and mints its kind-'layer' membership in
 * the same flow — the membership IS how maps place the layer. Returns the
 * new row's id (null = denied — not an editor of the project).
 */
export async function create(
  args: CreateLayerArgs,
  options?: StoreOptions,
): Promise<string | null> {
  const client = clientOf(options);
  const row = await queryRow<{ id: string }>(
    client
      .from("layers")
      .insert({
        kind: args.kind,
        name: args.name,
        ...(args.datasetMemberId === undefined ? {} : { dataset_member_id: args.datasetMemberId }),
        ...(args.style === undefined ? {} : { style: args.style }),
        project_id: args.projectId,
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    return null;
  }
  await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .insert(layerMembershipRow({ artifactId: row.id, projectId: args.projectId, role: "owned" }))
      .select("id"),
  );
  return row.id;
}

export interface UpdateLayerArgs {
  layerId: string;
  name?: string;
  style?: unknown;
  filter?: unknown;
  labels?: unknown;
  popup?: unknown;
  opacity?: number | null;
  visible?: boolean;
}

/**
 * Updates a layer. EVERY styling write (style/filter/labels/popup — the
 * fields the drift stamp watches) clears `needs_attention`: the editor
 * restyling a drifted layer is the fix.
 * Returns the affected row count (0 = denied/gone).
 */
export async function update(args: UpdateLayerArgs, options?: StoreOptions): Promise<number> {
  const patch: Record<string, unknown> = {};
  let styling = false;
  if (args.name !== undefined) {
    patch.name = args.name;
  }
  if (args.style !== undefined) {
    patch.style = args.style;
    styling = true;
  }
  if (args.filter !== undefined) {
    patch.filter = args.filter;
    styling = true;
  }
  if (args.labels !== undefined) {
    patch.labels = args.labels;
    styling = true;
  }
  if (args.popup !== undefined) {
    patch.popup = args.popup;
    styling = true;
  }
  if (args.opacity !== undefined) {
    patch.opacity = args.opacity;
  }
  if (args.visible !== undefined) {
    patch.visible = args.visible;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Layer update needs a field to set.");
  }
  if (styling) {
    patch.needs_attention = null;
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("layers").update(patch).eq("id", args.layerId).select("id"),
  );
  return rows.length;
}

/**
 * Removes a layer — and everything that names it: its kind-'layer'
 * membership first (the placements CASCADE with it), the child rows that
 * point at it (`child_layer_id` has no FK — the two-id-space rule), then
 * the row itself (its group's children CASCADE; its versions CASCADE).
 */
export async function remove(args: { layerId: string }, options?: StoreOptions): Promise<number> {
  const client = clientOf(options);
  await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .delete()
      .eq("artifact_id", args.layerId)
      .eq("artifact_kind", "layer")
      .select("id"),
  );
  await queryRows<{ id: string }>(
    client
      .from("layer_children")
      .delete()
      .eq("child_layer_id", args.layerId)
      .eq("child_kind", "owned")
      .select("id"),
  );
  const rows = await queryRows<{ id: string }>(
    client.from("layers").delete().eq("id", args.layerId).select("id"),
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Writes — the group tree
// ---------------------------------------------------------------------------

export interface AddChildArgs {
  groupId: string;
  childKind: "owned" | "linked";
  childLayerId: string;
  /** Overrides the computed position (append at the end otherwise). */
  order?: number;
}

/**
 * Adds one child to a group — OWNED children pass the cycle guard first
 * (a group cannot take its own ancestor); LINKED children are frozen
 * foreign snapshots and cannot close a cycle. Returns the child row (null
 * = denied) — a guard refusal THROWS (the honest edit-time rejection).
 */
export async function addChild(
  args: AddChildArgs,
  options?: StoreOptions,
): Promise<LayerChildRow | null> {
  if (args.childKind === "owned") {
    await assertAddChildSafe({ childLayerId: args.childLayerId, groupId: args.groupId }, options);
  }
  const client = clientOf(options);
  let order = args.order;
  if (order === undefined) {
    const existing = await listChildren({ groupId: args.groupId }, options);
    const last = existing[existing.length - 1];
    order = last === undefined ? 0 : last.order + 1;
  }
  return await queryRow<LayerChildRow>(
    client
      .from("layer_children")
      .insert({
        child_kind: args.childKind,
        child_layer_id: args.childLayerId,
        group_id: args.groupId,
        order,
      })
      .select(CHILD_SELECT)
      .single(),
  );
}

/** Removes one child placement from its group. */
export async function removeChild(
  args: { childId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("layer_children").delete().eq("id", args.childId).select("id"),
  );
  return rows.length;
}

/** Moves one child within its group by swapping positions with its neighbor (the map placement move semantics). */
export async function moveChild(
  args: { childId: string; direction: "up" | "down" },
  options?: StoreOptions,
): Promise<void> {
  const client = clientOf(options);
  const child = await queryRow<LayerChildRow>(
    client.from("layer_children").select(CHILD_SELECT).eq("id", args.childId).limit(1),
  );
  if (child === null) {
    return;
  }
  const siblings = await listChildren({ groupId: child.groupId }, options),
    index = siblings.findIndex((sibling) => sibling.id === child.id),
    neighborIndex = args.direction === "up" ? index - 1 : index + 1,
    neighbor = siblings[neighborIndex];
  if (neighbor === undefined) {
    return;
  }
  await queryRows<unknown>(
    client.from("layer_children").update({ order: child.order }).eq("id", neighbor.id).select("id"),
  );
  await queryRows<unknown>(
    client.from("layer_children").update({ order: neighbor.order }).eq("id", child.id).select("id"),
  );
}

// ---------------------------------------------------------------------------
// Writes — publish (the append-only version chain), link, clone
// ---------------------------------------------------------------------------

/** The next version label for a chain: vN+1 (v1 before the first publish). */
async function nextVersionLabel(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<string> {
  const versions = await listVersions({ layerId: args.layerId }, options);
  const head = versions[0];
  if (head === undefined) {
    return "v1";
  }
  const match = /^v(\d+)$/.exec(head.versionLabel);
  return match === null ? `v${versions.length + 1}` : `v${Number(match[1]) + 1}`;
}

/** The frozen definition of one layer as it stands right now (the publish snapshot's body). */
function definitionOf(layer: LayerRow): Record<string, unknown> {
  return {
    filter: layer.filter,
    labels: layer.labels,
    name: layer.name,
    opacity: layer.opacity,
    popup: layer.popup,
    style: layer.style,
    visible: layer.visible,
  };
}

/**
 * Publishes one layer (data or group) — freezes an append-only
 * `layer_versions` row and flips `lifecycle` to published. A data layer's
 * version pins its dataset ref at publish (the membership's dataset head
 * version; no chain yet → honest nulls). A GROUP version publishes its
 * draft children FIRST (the bundle-closure pattern — publishLayer
 * recurses), then freezes each child's pinned version.
 * Returns the new version's id (null = denied).
 */
// The publish walks the dataset pin, the recursive child closure, and the
// freeze — three legs whose branches are the layer kinds' contracts, read
// top to bottom.
// oxlint-disable-next-line eslint/complexity -- the publish legs are the contract, stated once.
export async function publishLayer(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<string | null> {
  const client = clientOf(options);
  const layer = await get({ layerId: args.layerId }, options);
  if (layer === null) {
    return null;
  }
  // The dataset pin (data kind): the membership's dataset + its chain head.
  let dataset: Record<string, unknown> | null = null;
  if (layer.kind === "data" && layer.datasetMemberId !== null) {
    const membership = await queryRow<{ artifactId: string }>(
      client
        .from("project_artifacts")
        .select("artifactId:artifact_id")
        .eq("id", layer.datasetMemberId)
        .limit(1),
    );
    if (membership !== null) {
      const head = await queryRow<{ id: string; ref: string }>(
        client
          .from("dataset_versions")
          .select("id,ref")
          .eq("dataset_id", membership.artifactId)
          .order("created_at", { ascending: false })
          .limit(1),
      );
      dataset = {
        pinnedRef: head === null ? null : head.ref,
        pinnedVersionId: head === null ? null : head.id,
        sourceMemberId: layer.datasetMemberId,
      };
    }
  }
  // The group closure: draft children publish first; every child freezes
  // with its HEAD version id at this instant.
  let frozenChildren: Array<Record<string, unknown>> | null = null;
  if (layer.kind === "group") {
    const children = await listChildren({ groupId: layer.id }, options);
    frozenChildren = [];
    for (const child of children) {
      // oxlint-disable-next-line no-await-in-loop -- the closure publishes in child order; each freeze feeds the group's snapshot.
      let versionId: string | null = child.childKind === "linked" ? child.childLayerId : null;
      if (child.childKind === "owned") {
        // oxlint-disable-next-line no-await-in-loop -- the closure publishes in child order; each freeze feeds the group's snapshot.
        versionId = await publishLayer({ layerId: child.childLayerId }, options);
        if (versionId === null) {
          throw new Error(
            `A child layer's publish was denied — publish "${layer.name}"'s children from their project first.`,
          );
        }
      }
      frozenChildren.push({
        childKind: child.childKind,
        childLayerId: child.childLayerId,
        versionId,
      });
    }
  }
  const label = await nextVersionLabel({ layerId: layer.id }, options);
  const version = await queryRow<{ id: string }>(
    client
      .from("layer_versions")
      .insert({
        dataset,
        definition: definitionOf(layer),
        frozen_children: frozenChildren,
        layer_id: layer.id,
        version_label: label,
      })
      .select("id")
      .single(),
  );
  if (version === null) {
    return null;
  }
  await queryRows<unknown>(
    client.from("layers").update({ lifecycle: "published" }).eq("id", layer.id).select("id"),
  );
  return version.id;
}

/**
 * Links a published layer into a project — the read-only pinned reference:
 * one kind-'layer' membership whose artifact_id IS the pinned
 * `layer_versions` row (the pin; the branch's "the pinned layerVersions
 * row IS the membership"). Returns the membership row (null = denied —
 * not an editor, or the version is invisible).
 */
export async function linkLayer(
  args: { projectId: string; sourceVersionId: string },
  options?: StoreOptions,
): Promise<{ id: string } | null> {
  const version = await getVersion({ versionId: args.sourceVersionId }, options);
  if (version === null) {
    throw new Error("That layer version doesn't exist (or isn't visible to you).");
  }
  return await queryRow<{ id: string }>(
    clientOf(options)
      .from("project_artifacts")
      .insert(
        layerMembershipRow({
          artifactId: args.sourceVersionId,
          projectId: args.projectId,
          role: "linked",
        }),
      )
      .select("id")
      .single(),
  );
}

/** Removes a linked layer's membership from a project (its placements CASCADE with it). */
export async function unlinkLayer(
  args: { membershipId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("project_artifacts")
      .delete()
      .eq("id", args.membershipId)
      .eq("artifact_kind", "layer")
      .eq("role", "linked")
      .select("id"),
  );
  return rows.length;
}

/**
 * Clones a published layer into a project as an OWNED editable draft —
 * the deep copy (groups clone recursively; a linked child stays a linked
 * reference to the same frozen version). The data leg re-resolves in the
 * TARGET project: the source dataset joins it as a linked pin if it isn't
 * a member yet (references, never copies), and the cloned layer styles
 * that membership.
 *
 * Returns the new layer's id (null = denied — not an editor of the target,
 * or the source version is invisible).
 */
export async function cloneLayer(
  args: { projectId: string; sourceVersionId: string },
  options?: StoreOptions,
): Promise<string | null> {
  const version = await getVersion({ versionId: args.sourceVersionId }, options);
  if (version === null) {
    return null;
  }
  const source = await get({ layerId: version.layerId }, options);
  if (source === null) {
    // The source layer row is invisible (foreign project) — the frozen
    // definition carries everything the clone needs anyway.
    return await cloneFromDefinition(args.projectId, version, options);
  }
  // oxlint-disable-next-line no-await-in-loop -- deep copies recurse in tree order; each level's rows feed the next.
  return await cloneOwnedLayer(args.projectId, source, options);
}

/** The clone's data leg: the source dataset's id from the version's pin, joined into the target project as a linked pin (or the existing membership). */
async function resolveDatasetLeg(
  args: { dataset: unknown; projectId: string },
  options?: StoreOptions,
): Promise<string | null> {
  if (typeof args.dataset !== "object" || args.dataset === null || Array.isArray(args.dataset)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record-shape guard above is the runtime check; publishLayer always stamps the pin's shape.
  const pin = args.dataset as Record<string, unknown>;
  if (typeof pin.sourceMemberId !== "string") {
    return null;
  }
  const client = clientOf(options);
  const sourceMember = await queryRow<{ artifactId: string }>(
    client
      .from("project_artifacts")
      .select("artifactId:artifact_id")
      .eq("id", pin.sourceMemberId)
      .limit(1),
  );
  if (sourceMember === null) {
    return null;
  }
  const datasetId = sourceMember.artifactId;
  // The target project's membership of this dataset — existing wins, else
  // a linked manual pin mints (references, never copies).
  const existing = await queryRow<{ id: string }>(
    client
      .from("project_artifacts")
      .select("id")
      .eq("artifact_id", datasetId)
      .eq("artifact_kind", "dataset")
      .eq("project_id", args.projectId)
      .limit(1),
  );
  if (existing !== null) {
    return existing.id;
  }
  const minted = await queryRow<{ id: string }>(
    client
      .from("project_artifacts")
      .insert({
        artifact_id: datasetId,
        artifact_kind: "dataset",
        project_id: args.projectId,
        role: "linked",
        sync_mode: "manual",
      })
      .select("id")
      .single(),
  );
  return minted === null ? null : minted.id;
}

/** Clones from a fully-frozen definition (the source layer row invisible — the version carries the whole shape). */
async function cloneFromDefinition(
  projectId: string,
  version: LayerVersionRow,
  options?: StoreOptions,
): Promise<string | null> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the definition is the publish snapshot's body (definitionOf's shape), shapeless jsonb by design.
  const definition = version.definition as Record<string, unknown>;
  const datasetMemberId = await resolveDatasetLeg({ dataset: version.dataset, projectId }, options);
  const client = clientOf(options);
  const row = await queryRow<{ id: string }>(
    client
      .from("layers")
      .insert({
        dataset_member_id: datasetMemberId,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- optional fields pass through as stored; the style validators re-check at render time.
        ...(definition.style === undefined ? {} : { style: definition.style }),
        ...(definition.filter === undefined ? {} : { filter: definition.filter }),
        ...(definition.labels === undefined ? {} : { labels: definition.labels }),
        ...(definition.popup === undefined ? {} : { popup: definition.popup }),
        ...(definition.opacity === undefined || definition.opacity === null
          ? {}
          : { opacity: definition.opacity }),
        kind: "data",
        name: typeof definition.name === "string" ? definition.name : "Cloned layer",
        project_id: projectId,
        ...(definition.visible === undefined ? {} : { visible: definition.visible }),
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    return null;
  }
  await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .insert(layerMembershipRow({ artifactId: row.id, projectId, role: "owned" }))
      .select("id"),
  );
  return row.id;
}

/** The owned deep copy: recreate the layer, then recurse for a group's owned children (linked children re-reference the same frozen versions). */
async function cloneOwnedLayer(
  projectId: string,
  source: LayerRow,
  options?: StoreOptions,
): Promise<string | null> {
  const client = clientOf(options);
  let datasetMemberId: string | null = source.datasetMemberId;
  if (source.kind === "data" && datasetMemberId !== null) {
    const resolved = await resolveDatasetLeg(
      { dataset: { sourceMemberId: datasetMemberId }, projectId },
      options,
    );
    datasetMemberId = resolved;
  }
  const row = await queryRow<{ id: string }>(
    client
      .from("layers")
      .insert({
        dataset_member_id: datasetMemberId,
        filter: source.filter,
        kind: source.kind,
        labels: source.labels,
        name: source.name,
        opacity: source.opacity,
        popup: source.popup,
        project_id: projectId,
        style: source.style,
        visible: source.visible,
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    return null;
  }
  await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .insert(layerMembershipRow({ artifactId: row.id, projectId, role: "owned" }))
      .select("id"),
  );
  if (source.kind === "group") {
    const children = await listChildren({ groupId: source.id }, options);
    let order = 0;
    for (const child of children) {
      if (child.childKind === "linked") {
        // oxlint-disable-next-line no-await-in-loop -- children clone in tree order.
        await queryRows<unknown>(
          client
            .from("layer_children")
            .insert({
              child_kind: "linked",
              child_layer_id: child.childLayerId,
              group_id: row.id,
              order,
            })
            .select("id"),
        );
      } else {
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const childLayer = await get({ layerId: child.childLayerId }, options);
        if (childLayer === null) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const clonedChildId = await cloneOwnedLayer(projectId, childLayer, options);
        if (clonedChildId === null) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await queryRows<unknown>(
          client
            .from("layer_children")
            .insert({
              child_kind: "owned",
              child_layer_id: clonedChildId,
              group_id: row.id,
              order,
            })
            .select("id"),
        );
      }
      order += 1;
    }
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// Writes — auto-layer, drift
// ---------------------------------------------------------------------------

/**
 * The auto-layer (ADR 0019): the owned default-style data layer for one
 * dataset membership — "add dataset to map" calls this, then places the
 * result. Deliberately NOT idempotent at the project level (two layers may
 * style one dataset — fill and labels, say); the CALLER stays idempotent
 * per map (the picker excludes placed datasets).
 * Returns the layer's id (null = denied).
 */
export async function createForDataset(
  args: { datasetMemberId: string; name?: string; projectId: string },
  options?: StoreOptions,
): Promise<string | null> {
  const membership = await queryRow<{ artifactId: string }>(
    clientOf(options)
      .from("project_artifacts")
      .select("artifactId:artifact_id")
      .eq("id", args.datasetMemberId)
      .limit(1),
  );
  if (membership === null) {
    return null;
  }
  const dataset = await queryRow<{ title: string }>(
    clientOf(options).from("datasets").select("title").eq("id", membership.artifactId).limit(1),
  );
  return await create(
    {
      datasetMemberId: args.datasetMemberId,
      kind: "data",
      name: args.name ?? (dataset === null ? "Layer" : dataset.title),
      projectId: args.projectId,
    },
    options,
  );
}

/**
 * The drift stamp (ADR 0019): the dataset-edit flow calls this after a
 * schema update — every layer styling that membership learns what moved.
 * Returns the stamped count.
 */
export async function stampDrift(
  args: { datasetMemberId: string; reason: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("layers")
      .update({ needs_attention: args.reason })
      .eq("dataset_member_id", args.datasetMemberId)
      .select("id"),
  );
  return rows.length;
}

/**
 * The dataset-edit flow's entry point: resolves every project holding this
 * dataset as a member, then stamps that project's styled layers with the
 * drift reason. Returns the stamped count (0 = no styled layers — the
 * common case, and not an error).
 */
export async function stampDriftForDataset(
  args: { datasetId: string; reason: string },
  options?: StoreOptions,
): Promise<number> {
  const client = clientOf(options);
  const memberships = await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .select("id")
      .eq("artifact_id", args.datasetId)
      .eq("artifact_kind", "dataset")
      .limit(CATALOG_READ_LIMIT),
  );
  let stamped = 0;
  for (const membership of memberships) {
    // oxlint-disable-next-line no-await-in-loop -- one stamp per holding membership, in membership order.
    stamped += await stampDrift({ datasetMemberId: membership.id, reason: args.reason }, options);
  }
  return stamped;
}

export function listDatasetMembershipsQueryOptions(
  args: { projectId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:layers", "listDatasetMemberships", args],
    queryFn: async () => await listDatasetMemberships(args, options),
  });
}
