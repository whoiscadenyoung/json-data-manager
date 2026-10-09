import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import {
  deleteLayerVersionsCascade,
  deletePlacementsForMembership,
  layerMembershipRow,
} from "./layerTeardown";
import { projectRoleFor } from "./projectAccess";
import { addDatasetMembership, insertMembership, projectForWrite } from "./projects";

/**
 * Layers (phase 3 of the project-workspace design, ADR 0012) — styling
 * decoupled from data, QGIS-style. A layer is one project's styling of one
 * dataset reference (kind "data") or an ordered group of layers (kind
 * "group"); it publishes, links, and clones exactly like a dataset's version
 * chain does, and a map (projectMaps.ts) is just an ordered list of layer
 * placements on a canvas.
 *
 * OWNERSHIP: a layer lives in exactly one project (`projectId`) and edits
 * answer to that project's editors-and-up (`projectForWrite`, ADR 0011's
 * role check). An owned layer is born WITH its membership row
 * (`projectArtifacts`, artifactKind "layer", artifactId = the layers row id,
 * role "owned") in one transaction — the createDraftDataset pattern — which
 * is what makes it workspace-visible and map-layerable (mapLayers placements
 * name layers THROUGH their membership).
 *
 * LINKING: a PUBLISHED layer (one with a `layerVersions` chain — phase 5's
 * publish mints rows; until then the chain's existence IS published-ness,
 * the existence-over-marker rule) can be linked INTO another project the
 * caller edits: a membership row (role "linked") whose artifactId IS the
 * pinned `layerVersions` row id. The pin is the membership — a linked layer
 * has no local `layers` row, renders the frozen definition, and never moves
 * until the layer-sync action (phase 5) re-pins it. The fork-edge pattern
 * (consumerReferences) stays dataset-only: a layer pin has no component
 * chain behind it, so there is no edge machinery to reuse.
 *
 * CLONING: a published layer clones into a project the caller edits as an
 * OWNED DRAFT built from its head version — deep for groups (each owned
 * child clones recursively from its own frozen version; linked children
 * re-pin the same frozen versions, staying read-only). A data layer's
 * dataset joins the target project as its linked member first (the
 * addArtifact semantics), so the clone's `datasetMemberId` names a real
 * membership.
 *
 * GROUPS: `layerChildren` rows are the membership (rows, not arrays); the
 * tree is guarded acyclic at every write (the parent walk in
 * `assertNotDescendant`), a layer sits in at most one group, and deleting a
 * group unparents its children rather than deleting them.
 */
const MAX_LAYERS = 500;
/** The cycle guard's walk bound — the tree is human-scale; a deeper "ancestor chain" can only mean corruption, which reads as a refusal. */
const MAX_TREE_DEPTH = 50;

/** The auto-layer palette (the map workspace's assignDatasetColors colors, moved server-side so a stored style lands with the layer — phase 4's editor replaces the client-side assignment). */
export const LAYER_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
] as const;

/** The default style an auto-created layer carries (the palette's first color — visible on every basemap). */
const DEFAULT_STYLE = { color: LAYER_COLORS[0] };

/** The stored style's shape, shared by the create/update args, the list/get returns, and the drift stamps. */
export const layerStyleValidator = v.object({
  color: v.optional(v.string()),
  fillColor: v.optional(v.string()),
  fillOpacity: v.optional(v.number()),
  opacity: v.optional(v.number()),
  radius: v.optional(v.number()),
  weight: v.optional(v.number()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes a client-sent layer id; null when the string isn't a layer id at all (the projectIdArg answer — a malformed id reads exactly as a missing row). */
function layerIdArg(ctx: { db: QueryCtx["db"] }, layerId: string): Id<"layers"> | null {
  return ctx.db.normalizeId("layers", layerId);
}

/** The layer row a write mutation writes into, or the friendly gone-error. Role-checked through the OWNING project (editor-and-up). */
async function layerForWrite(
  ctx: MutationCtx,
  actorId: string,
  layerId: Id<"layers">,
): Promise<Doc<"layers">> {
  const layer = await ctx.db.get(layerId);
  if (layer === null) {
    throw goneLayer();
  }
  await projectForWrite(ctx, actorId, layer.projectId);
  return layer;
}

/** The layer row a member-scoped read answers with, or null — any role reads (the projectForRead twin). */
async function layerForRead(
  ctx: Pick<QueryCtx, "db">,
  viewerId: string,
  layerId: Id<"layers">,
): Promise<Doc<"layers"> | null> {
  const layer = await ctx.db.get(layerId);
  if (layer === null) {
    return null;
  }
  return (await projectRoleFor(ctx, layer.projectId, viewerId)) === null ? null : layer;
}

function goneLayer(): ConvexError<string> {
  return new ConvexError("This layer no longer exists — it may have been deleted.");
}

/** The head (newest) frozen version of one layer, or null when it has none — the published-ness gate every link/clone path runs. */
async function headVersionOf(
  ctx: Pick<QueryCtx, "db">,
  layerId: Id<"layers">,
): Promise<Doc<"layerVersions"> | null> {
  return ctx.db
    .query("layerVersions")
    .withIndex("by_layer", (q) => q.eq("layerId", layerId))
    .order("desc")
    .first();
}

/**
 * The membership row an owned layer was born with (or a linked layer's
 * placement target) — the shared lookup in layerTeardown.ts (one
 * implementation for this module, projects.removeArtifact, and the project
 * teardown).
 */
async function layerMembershipOf(
  ctx: { db: QueryCtx["db"] },
  layer: Doc<"layers">,
): Promise<Doc<"projectArtifacts"> | null> {
  return layerMembershipRow(ctx, layer);
}

/** The group holding one layer (its parent), or null when it sits at the root — the by_child lookup the cycle guard and the tree reads share. */
async function parentGroupOf(
  ctx: Pick<QueryCtx, "db">,
  layerId: Id<"layers">,
): Promise<Doc<"layerChildren"> | null> {
  return ctx.db
    .query("layerChildren")
    .withIndex("by_child", (q) => q.eq("childLayerId", layerId))
    .first();
}

/**
 * The cycle guard: refuses `candidateAncestor` when it is `layerId` itself
 * or reachable upward from it (making it a descendant). Walks parent links
 * with a depth bound — the tree is acyclic by every guarded write, so a walk
 * that overruns the bound reads as corruption and refuses.
 */
async function assertNotDescendant(
  ctx: Pick<QueryCtx, "db">,
  candidateAncestor: Id<"layers">,
  layerId: Id<"layers">,
): Promise<void> {
  if (candidateAncestor === layerId) {
    throw new ConvexError("A layer can't be grouped inside itself.");
  }
  let cursor: Id<"layers"> | null = layerId;
  for (let depth = 0; cursor !== null && depth < MAX_TREE_DEPTH; depth += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one parent hop per step, bounded by MAX_TREE_DEPTH.
    const childRow = await parentGroupOf(ctx, cursor);
    if (childRow === null) {
      return;
    }
    const groupId = ctx.db.normalizeId("layers", childRow.groupId);
    if (groupId === null) {
      return;
    }
    if (groupId === candidateAncestor) {
      throw new ConvexError("That group is inside the layer's own subtree — grouping would cycle.");
    }
    cursor = groupId;
  }
  throw new ConvexError("The layer tree is too deep to group safely.");
}

/** The frozen definition fields one version carries, narrowed defensively (a junk `definition` degrades to the layer's name, never a crash). */
function definitionNameOf(definition: unknown, fallback: string): string {
  return isRecord(definition) && typeof definition.name === "string" ? definition.name : fallback;
}

function definitionKindOf(definition: unknown): "data" | "group" {
  return isRecord(definition) && definition.kind === "group" ? "group" : "data";
}

/**
 * Narrows a frozen definition's `style` blob to the stored-style shape,
 * field by field — the no-cast rule's answer for shapeless stored specs
 * (unknown fields drop, present ones keep their value). Exported for
 * projectMaps.ts's linked-placement projection, which draws the same frozen
 * definitions.
 */
export function narrowStyle(value: unknown): Doc<"layers">["style"] {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    color: typeof value.color === "string" ? value.color : undefined,
    fillColor: typeof value.fillColor === "string" ? value.fillColor : undefined,
    fillOpacity: typeof value.fillOpacity === "number" ? value.fillOpacity : undefined,
    opacity: typeof value.opacity === "number" ? value.opacity : undefined,
    radius: typeof value.radius === "number" ? value.radius : undefined,
    weight: typeof value.weight === "number" ? value.weight : undefined,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * One tree child resolved for reads: owned children answer from their live
 * rows, linked children from their pinned versions — a deleted answer reads
 * as missing, never crashes. The render fields (dataset ref, style, opacity,
 * visibility) ride along because the map editor draws group children straight
 * from this projection (phase 4): a linked child's dataset is its pinned
 * version's frozen dataset pin, its style the frozen definition's.
 */
type ResolvedChild =
  | {
      child: {
        datasetMemberId?: Id<"projectArtifacts">;
        kind: "data" | "group";
        lifecycle: "draft" | "published";
        name: string;
        needsAttention?: string;
        opacity?: number;
        style?: Doc<"layers">["style"];
        visible: boolean;
      };
      childKind: "owned";
      childLayerId: string;
      order: number;
    }
  | {
      child: {
        datasetPinnedSchemaId?: string;
        kind: "data" | "group";
        name: string;
        opacity?: number;
        style?: Doc<"layers">["style"];
        versionLabel: string;
      };
      childKind: "linked";
      childLayerId: string;
      order: number;
    }
  | { child: null; childKind: "owned" | "linked"; childLayerId: string; order: number };

async function resolveChild(ctx: QueryCtx, row: Doc<"layerChildren">): Promise<ResolvedChild> {
  if (row.childKind === "linked") {
    const versionId = ctx.db.normalizeId("layerVersions", row.childLayerId);
    const version = versionId === null ? null : await ctx.db.get(versionId);
    if (version === null) {
      return {
        child: null,
        childKind: row.childKind,
        childLayerId: row.childLayerId,
        order: row.order,
      };
    }
    const definition = isRecord(version.definition) ? version.definition : {};
    return {
      child: {
        datasetPinnedSchemaId:
          isRecord(version.dataset) && typeof version.dataset.pinnedSchemaId === "string"
            ? version.dataset.pinnedSchemaId
            : undefined,
        kind: definitionKindOf(version.definition),
        name: definitionNameOf(version.definition, "Linked layer"),
        opacity: typeof definition.opacity === "number" ? definition.opacity : undefined,
        style: narrowStyle(definition.style),
        versionLabel: version.versionLabel,
      },
      childKind: "linked",
      childLayerId: row.childLayerId,
      order: row.order,
    };
  }
  const layerId = ctx.db.normalizeId("layers", row.childLayerId);
  const layer = layerId === null ? null : await ctx.db.get(layerId);
  if (layer === null) {
    return {
      child: null,
      childKind: row.childKind,
      childLayerId: row.childLayerId,
      order: row.order,
    };
  }
  return {
    child: {
      datasetMemberId: layer.datasetMemberId,
      kind: layer.kind,
      lifecycle: layer.lifecycle,
      name: layer.name,
      needsAttention: layer.needsAttention,
      opacity: layer.opacity,
      style: layer.style,
      visible: layer.visible,
    },
    childKind: "owned",
    childLayerId: row.childLayerId,
    order: row.order,
  };
}

/**
 * The project's Layers section: every layer of one project, each with the
 * membership id its map placements name and its parent group (null at the
 * root). Member-scoped like the workspace read — a non-member's read answers
 * empty, so another project's draft layers never leak.
 */
export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null || (await projectRoleFor(ctx, projectId, viewer)) === null) {
      return [];
    }
    const rows = await ctx.db
      .query("layers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(MAX_LAYERS);
    return Promise.all(
      rows.map(async (layer) => {
        const membership = await layerMembershipOf(ctx, layer),
          parentRow = await parentGroupOf(ctx, layer._id);
        return {
          _creationTime: layer._creationTime,
          _id: layer._id,
          // This layer's position within its parent group (undefined at the
          // root) — the map editor draws group children in childOrder without
          // a per-group layers.get round trip.
          childOrder: parentRow === null ? undefined : parentRow.order,
          datasetMemberId: layer.datasetMemberId,
          kind: layer.kind,
          lifecycle: layer.lifecycle,
          membershipId: membership === null ? undefined : membership._id,
          name: layer.name,
          needsAttention: layer.needsAttention,
          opacity: layer.opacity,
          parentGroupId: parentRow === null ? undefined : parentRow.groupId,
          // The stored style (phase 4's editor draws and edits it — the
          // client-only assignDatasetColors is gone).
          style: layer.style,
          visible: layer.visible,
        };
      }),
    );
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("layers"),
      childOrder: v.optional(v.number()),
      datasetMemberId: v.optional(v.id("projectArtifacts")),
      kind: v.union(v.literal("data"), v.literal("group")),
      lifecycle: v.union(v.literal("draft"), v.literal("published")),
      membershipId: v.optional(v.id("projectArtifacts")),
      name: v.string(),
      needsAttention: v.optional(v.string()),
      opacity: v.optional(v.number()),
      parentGroupId: v.optional(v.id("layers")),
      style: v.optional(layerStyleValidator),
      visible: v.boolean(),
    }),
  ),
});

/**
 * One layer: the row, its membership id, its parent group, and its children
 * resolved in draw order (owned children from their live rows, linked from
 * their pinned versions). Member-scoped — null to a non-member, the same
 * read-null-vs-write-throw split the workspace uses.
 */
export const get = query({
  args: { layerId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null) {
      return null;
    }
    const layer = await layerForRead(ctx, viewer, layerId);
    if (layer === null) {
      return null;
    }
    const membership = await layerMembershipOf(ctx, layer),
      parentRow = await parentGroupOf(ctx, layer._id),
      childRows = await ctx.db
        .query("layerChildren")
        .withIndex("by_group", (q) => q.eq("groupId", layer._id))
        .order("asc")
        .collect(),
      children = await Promise.all(childRows.map(async (row) => resolveChild(ctx, row)));
    return {
      _creationTime: layer._creationTime,
      _id: layer._id,
      children,
      datasetMemberId: layer.datasetMemberId,
      filter: layer.filter,
      labels: layer.labels,
      kind: layer.kind,
      lifecycle: layer.lifecycle,
      membershipId: membership === null ? undefined : membership._id,
      name: layer.name,
      needsAttention: layer.needsAttention,
      opacity: layer.opacity,
      parentGroupId: parentRow === null ? undefined : parentRow.groupId,
      popup: layer.popup,
      projectId: layer.projectId,
      style: layer.style,
      visible: layer.visible,
    };
  },
  // The styling payloads (style/filter/labels/popup) are open shapes by
  // design — the stored-spec precedent — so this read validates the
  // envelope and leaves the payloads shapeless.
  returns: v.union(
    v.null(),
    v.object({
      _creationTime: v.number(),
      _id: v.id("layers"),
      children: v.array(v.any()),
      datasetMemberId: v.optional(v.id("projectArtifacts")),
      filter: v.optional(v.any()),
      labels: v.optional(v.any()),
      kind: v.union(v.literal("data"), v.literal("group")),
      lifecycle: v.union(v.literal("draft"), v.literal("published")),
      membershipId: v.optional(v.id("projectArtifacts")),
      name: v.string(),
      needsAttention: v.optional(v.string()),
      opacity: v.optional(v.number()),
      parentGroupId: v.optional(v.id("layers")),
      popup: v.optional(v.any()),
      projectId: v.id("projects"),
      style: v.optional(v.any()),
      visible: v.boolean(),
    }),
  ),
});

/** One layer's version chain, newest first — the link/clone pickers' read (phase 5's publish appends to it). */
export const versions = query({
  args: { layerId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null || (await layerForRead(ctx, viewer, layerId)) === null) {
      return [];
    }
    const rows = await ctx.db
      .query("layerVersions")
      .withIndex("by_layer", (q) => q.eq("layerId", layerId))
      .order("desc")
      .take(MAX_LAYERS);
    return rows.map((row) => ({
      _creationTime: row._creationTime,
      _id: row._id,
      frozenAt: row.frozenAt,
      versionLabel: row.versionLabel,
    }));
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("layerVersions"),
      frozenAt: v.number(),
      versionLabel: v.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates a layer as an OWNED member of the project — the layer row and its
 * membership (`projectArtifacts`, role "owned", artifactId = the layers row
 * id) born in ONE transaction, so a crash can never orphan either (the
 * createDraftDataset pattern). The data kind requires a dataset membership
 * OF THIS PROJECT (the styling quadruple styles that membership's dataset);
 * the group kind takes none. Editor-and-up.
 */
export const create = mutation({
  args: {
    datasetMemberId: v.optional(v.string()),
    filter: v.optional(v.any()),
    labels: v.optional(v.any()),
    kind: v.union(v.literal("data"), v.literal("group")),
    name: v.string(),
    opacity: v.optional(v.number()),
    popup: v.optional(v.any()),
    projectId: v.string(),
    style: v.optional(layerStyleValidator),
    visible: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, actorId, projectId),
      name = args.name.trim();
    if (name === "") {
      throw new ConvexError("Give the layer a name.");
    }
    let datasetMemberId: Id<"projectArtifacts"> | undefined;
    if (args.kind === "data") {
      if (args.datasetMemberId === undefined) {
        throw new ConvexError("A data layer needs a dataset — pick one from the project.");
      }
      const memberId = ctx.db.normalizeId("projectArtifacts", args.datasetMemberId),
        membership = memberId === null ? null : await ctx.db.get(memberId);
      if (
        membership === null ||
        membership.projectId !== projectId ||
        membership.artifactKind !== "dataset"
      ) {
        throw new ConvexError("That dataset isn't a member of this project.");
      }
      datasetMemberId = memberId ?? undefined;
    }
    const layerId = await ctx.db.insert("layers", {
      datasetMemberId,
      filter: args.filter,
      labels: args.labels,
      kind: args.kind,
      lifecycle: "draft",
      name,
      opacity: args.opacity,
      popup: args.popup,
      projectId,
      style: args.style,
      visible: args.visible ?? true,
    });
    await insertMembership(ctx, project, {
      addedBy: actorId,
      artifactId: layerId,
      artifactKind: "layer",
      role: "owned",
      syncMode: "manual",
    });
    return layerId;
  },
  returns: v.id("layers"),
});

/**
 * Restyles one owned layer — name/style/filter/labels/popup/opacity. The
 * styling write is also the drift reconciliation: a layer flagged
 * `needsAttention` (a dataset sync changed its fields) clears the flag here,
 * because whoever edited the definition just looked at it. A blank name is
 * refused, never trimmed away silently (the UI rule).
 */
export const update = mutation({
  args: {
    filter: v.optional(v.any()),
    labels: v.optional(v.any()),
    layerId: v.string(),
    name: v.optional(v.string()),
    opacity: v.optional(v.number()),
    popup: v.optional(v.any()),
    style: v.optional(layerStyleValidator),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null) {
      throw goneLayer();
    }
    const layer = await layerForWrite(ctx, actorId, layerId);
    const patch: {
      filter?: typeof layer.filter;
      labels?: typeof layer.labels;
      name?: string;
      needsAttention?: undefined;
      opacity?: number;
      popup?: typeof layer.popup;
      style?: typeof layer.style;
    } = { needsAttention: undefined };
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name === "") {
        throw new ConvexError("Give the layer a name.");
      }
      patch.name = name;
    }
    if (args.style !== undefined) {
      patch.style = args.style;
    }
    if (args.filter !== undefined) {
      patch.filter = args.filter;
    }
    if (args.labels !== undefined) {
      patch.labels = args.labels;
    }
    if (args.popup !== undefined) {
      patch.popup = args.popup;
    }
    if (args.opacity !== undefined) {
      patch.opacity = args.opacity;
    }
    await ctx.db.patch(layer._id, patch);
    return null;
  },
  returns: v.null(),
});

/** The eye toggle — one layer's own visibility (a map placement carries its map-local override separately; this is the layer-wide default). */
export const setVisible = mutation({
  args: { layerId: v.string(), visible: v.boolean() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null) {
      throw goneLayer();
    }
    const layer = await layerForWrite(ctx, actorId, layerId);
    await ctx.db.patch(layer._id, { visible: args.visible });
    return null;
  },
  returns: v.null(),
});

/**
 * Removes one layer: its child rows both ways (it stops being anyone's
 * child; its own children unparent UP a level — removing a group never
 * deletes the layers inside it), its version chain, then the membership
 * cascade — placements (which name it THROUGH its membership), the
 * membership row, and the project's count — and the row itself. The
 * cascade's shape is shared with projects.removeArtifact's layer arm
 * (layerTeardown.ts); the dataset behind a data layer is never touched.
 */
export const remove = mutation({
  args: { layerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null) {
      throw goneLayer();
    }
    const layer = await layerForWrite(ctx, actorId, layerId),
      membership = await layerMembershipRow(ctx, layer);
    // The tree answers only by the row's own id — swept first. Versions go
    // EXCEPT the frozen rows a foreign project's linked membership pins
    // (the retire-pin-refusal rule, carried to layers); placements go
    // BEFORE the membership row does, while it can still name them.
    for await (const edge of ctx.db
      .query("layerChildren")
      .withIndex("by_child", (q) => q.eq("childLayerId", layer._id))) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
      await ctx.db.delete(edge._id);
    }
    for await (const edge of ctx.db
      .query("layerChildren")
      .withIndex("by_group", (q) => q.eq("groupId", layer._id))) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
      await ctx.db.delete(edge._id);
    }
    await deleteLayerVersionsCascade(ctx, layer._id, layer.projectId);
    if (membership !== null) {
      await deletePlacementsForMembership(ctx, membership);
      await ctx.db.delete(membership._id);
      const project = await ctx.db.get(layer.projectId);
      if (project !== null) {
        await ctx.db.patch(project._id, {
          artifactCount: Math.max(0, project.artifactCount - 1),
        });
      }
    }
    await ctx.db.delete(layer._id);
    return null;
  },
  returns: v.null(),
});

/**
 * Links a PUBLISHED layer into a project the caller edits — the pinned
 * read-only member. The pin is the membership: its artifactId IS the head
 * `layerVersions` row at link time, so the linked project renders exactly
 * that frozen definition regardless of what the source does next (the
 * layer-sync action, phase 5, re-pins). Refuses an unpublished source (no
 * chain to pin — "publish it first", the setMemberSync answer's shape) and a
 * double link (the in-transaction re-check over the project's layer
 * memberships, resolved back to source layers).
 *
 * With `mapId`, the linked layer is ALSO placed on that map in the SAME
 * transaction (the editor's "Link & place" one-click flow): the map must
 * belong to the project being linked INTO, and a duplicate placement is
 * refused exactly as projectMaps.addLayer refuses one. Placing without the
 * membership read racing the client is why this rides the link mutation —
 * the placement names the membership, which only this transaction knows.
 */
export const link = mutation({
  args: { layerId: v.string(), mapId: v.optional(v.string()), projectId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId),
      sourceId = layerIdArg(ctx, args.layerId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, actorId, projectId),
      source = sourceId === null ? null : await ctx.db.get(sourceId);
    if (source === null) {
      throw goneLayer();
    }
    if (source.projectId === projectId) {
      throw new ConvexError("This project already owns that layer.");
    }
    // Published-ness is the chain's existence (the module doc): no head, no
    // pin — and a draft of one's own project is refused with the same
    // honest answer.
    const head = await headVersionOf(ctx, source._id);
    if (head === null) {
      throw new ConvexError("Only a published layer can be linked — publish it first.");
    }
    // The duplicate re-check walks this project's layer memberships back to
    // their sources: an owned membership naming the source directly, or a
    // linked one pinning any of its versions, means the layer is already
    // here. Bounded by the workspace's own display cap ( memberships are
    // human-scale; the walk is exact for any real project).
    const existing = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(500);
    for (const row of existing) {
      if (row.artifactKind !== "layer") {
        continue;
      }
      if (row.artifactId === source._id) {
        throw new ConvexError("That layer is already in this project.");
      }
      // oxlint-disable-next-line no-await-in-loop -- one version read per layer membership, project-scale bounded.
      const pinnedId = ctx.db.normalizeId("layerVersions", row.artifactId);
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const pinned = pinnedId === null || row.role !== "linked" ? null : await ctx.db.get(pinnedId);
      if (pinned !== null && pinned.layerId === source._id) {
        throw new ConvexError("That layer is already linked in this project.");
      }
    }
    const membershipId = await insertMembership(ctx, project, {
      addedBy: actorId,
      artifactId: head._id,
      artifactKind: "layer",
      role: "linked",
      syncMode: "manual",
    });
    if (args.mapId !== undefined) {
      const mapId = ctx.db.normalizeId("projectMaps", args.mapId),
        map = mapId === null ? null : await ctx.db.get(mapId);
      if (map === null || map.projectId !== projectId) {
        throw new ConvexError("That map isn't in this project.");
      }
      const placements = await ctx.db
        .query("mapLayers")
        .withIndex("by_map", (q) => q.eq("mapId", map._id))
        .collect();
      if (placements.some((placement) => placement.layerMemberId === membershipId)) {
        throw new ConvexError("That layer is already on this map.");
      }
      await ctx.db.insert("mapLayers", {
        layerMemberId: membershipId,
        mapId: map._id,
        order: placements.reduce((next, placement) => Math.max(next, placement.order + 1), 0),
        visible: true,
      });
    }
    return head._id;
  },
  returns: v.id("layerVersions"),
});

/**
 * The clone leg's recursive core: builds an owned draft of `version` (a
 * frozen definition of `sourceName`'s layer) in `project`. A data version
 * resolves its pinned dataset into a membership of the target project first
 * (the addArtifact semantics — already-a-member reuses the row); a group
 * version clones its frozen children (owned recursively from their own
 * versions, linked re-pinned as read-only memberships) and wires the child
 * rows. Returns the new layers row.
 */
async function cloneFromVersion(
  ctx: MutationCtx,
  actorId: string,
  project: Doc<"projects">,
  version: Doc<"layerVersions">,
): Promise<Id<"layers">> {
  const definition = isRecord(version.definition) ? version.definition : {},
    name = definitionNameOf(version.definition, "Cloned layer"),
    kind = definitionKindOf(version.definition);
  if (kind === "data") {
    if (version.dataset === undefined) {
      throw new ConvexError("The layer's dataset reference was never frozen — it can't be cloned.");
    }
    const datasetId = version.dataset.pinnedSchemaId;
    if (datasetId === undefined) {
      throw new ConvexError("The frozen version lost its dataset pin — it can't be cloned.");
    }
    // The dataset joins (or already sits in) the target project; the clone
    // styles THAT membership — the project's own view of the data.
    const { membership } = await addDatasetMembership(ctx, actorId, project, datasetId, "manual");
    const layerId = await ctx.db.insert("layers", {
      datasetMemberId: membership,
      filter: definition.filter,
      kind,
      labels: definition.labels,
      lifecycle: "draft",
      name,
      popup: definition.popup,
      projectId: project._id,
      style: isRecord(definition.style) ? definition.style : DEFAULT_STYLE,
      visible: definition.visible !== false,
    });
    // The clone is a member like any layer — its map placements and its
    // workspace row name it through this membership (the create flow's
    // atomic pair).
    await insertMembership(ctx, project, {
      addedBy: actorId,
      artifactId: layerId,
      artifactKind: "layer",
      role: "owned",
      syncMode: "manual",
    });
    return layerId;
  }
  const groupId = await ctx.db.insert("layers", {
    kind,
    lifecycle: "draft",
    name,
    opacity: typeof definition.opacity === "number" ? definition.opacity : undefined,
    projectId: project._id,
    visible: definition.visible !== false,
  });
  await insertMembership(ctx, project, {
    addedBy: actorId,
    artifactId: groupId,
    artifactKind: "layer",
    role: "owned",
    syncMode: "manual",
  });
  const frozen = version.frozenChildren ?? [];
  let order = 0;
  for (const child of frozen) {
    if (child.childKind === "linked") {
      // A linked child stays linked: one membership pinning the same frozen
      // version, read-only exactly as the source had it.
      const pinnedId = ctx.db.normalizeId("layerVersions", child.childLayerId),
        pinned = pinnedId === null ? null : await ctx.db.get(pinnedId);
      if (pinned === null) {
        throw new ConvexError(
          "A linked child's pinned version is gone — the group can't be cloned.",
        );
      }
      await insertMembership(ctx, project, {
        addedBy: actorId,
        artifactId: pinned._id,
        artifactKind: "layer",
        role: "linked",
        syncMode: "manual",
      });
      await ctx.db.insert("layerChildren", {
        childKind: "linked",
        childLayerId: child.childLayerId,
        groupId,
        order,
      });
    } else {
      const childVersionId =
          child.versionId === undefined
            ? null
            : ctx.db.normalizeId("layerVersions", child.versionId),
        childVersion = childVersionId === null ? null : await ctx.db.get(childVersionId);
      if (childVersion === null) {
        throw new ConvexError(
          "An owned child's frozen version is missing — the group can't be cloned.",
        );
      }
      const childLayerId = await cloneFromVersion(ctx, actorId, project, childVersion);
      await ctx.db.insert("layerChildren", {
        childKind: "owned",
        childLayerId,
        groupId,
        order,
      });
    }
    order += 1;
  }
  return groupId;
}

/**
 * Clones a PUBLISHED layer into a project the caller edits — an owned draft
 * built from the head version, deep for groups (each owned child clones
 * from its own frozen version; linked children stay linked pins). The
 * editable-copy side of the model's link-XOR-clone line: the source is
 * never touched, the copy edits freely and publishes on its own chain.
 */
export const clone = mutation({
  args: { layerId: v.string(), projectId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId),
      sourceId = layerIdArg(ctx, args.layerId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    const project = await projectForWrite(ctx, actorId, projectId),
      source = sourceId === null ? null : await ctx.db.get(sourceId);
    if (source === null) {
      throw goneLayer();
    }
    const head = await headVersionOf(ctx, source._id);
    if (head === null) {
      throw new ConvexError("Only a published layer can be cloned — publish it first.");
    }
    return cloneFromVersion(ctx, actorId, project, head);
  },
  returns: v.id("layers"),
});

/** The group ops' shared guard: the child must be an owned layer of the group's own project (a linked pin is referenced through its membership, never regrouped locally). */
async function ownedChildForGroup(
  ctx: MutationCtx,
  actorId: string,
  groupId: Id<"layers">,
  layerId: Id<"layers">,
): Promise<Doc<"layers">> {
  const group = await ctx.db.get(groupId),
    layer = await ctx.db.get(layerId);
  if (group === null || group.kind !== "group" || layer === null) {
    throw goneLayer();
  }
  await projectForWrite(ctx, actorId, group.projectId);
  if (layer.projectId !== group.projectId) {
    throw new ConvexError("Layers group within their own project.");
  }
  return layer;
}

/** Appends (or moves) one owned layer under a group — the group act of "group/ungroup". Cycle-guarded; a layer already in a group is refused (reparent moves it instead). */
export const addToGroup = mutation({
  args: { groupId: v.string(), layerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      groupId = layerIdArg(ctx, args.groupId),
      layerId = layerIdArg(ctx, args.layerId);
    if (groupId === null || layerId === null) {
      throw goneLayer();
    }
    await ownedChildForGroup(ctx, actorId, groupId, layerId);
    await assertNotDescendant(ctx, layerId, groupId);
    if ((await parentGroupOf(ctx, layerId)) !== null) {
      throw new ConvexError("That layer is already grouped — reparent it instead.");
    }
    const siblings = await ctx.db
        .query("layerChildren")
        .withIndex("by_group", (q) => q.eq("groupId", groupId))
        .collect(),
      order = siblings.reduce((next, row) => Math.max(next, row.order + 1), 0);
    await ctx.db.insert("layerChildren", {
      childKind: "owned",
      childLayerId: layerId,
      groupId,
      order,
    });
    return null;
  },
  returns: v.null(),
});

/** Ungroup: removes one child row — the layer survives, back at the root. */
export const removeFromGroup = mutation({
  args: { groupId: v.string(), layerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      groupId = layerIdArg(ctx, args.groupId),
      layerId = layerIdArg(ctx, args.layerId);
    if (groupId === null || layerId === null) {
      throw goneLayer();
    }
    await ownedChildForGroup(ctx, actorId, groupId, layerId);
    const edge = await ctx.db
      .query("layerChildren")
      .withIndex("by_child", (q) => q.eq("childLayerId", layerId))
      .first();
    if (edge === null || edge.groupId !== groupId) {
      throw new ConvexError("That layer isn't in this group.");
    }
    await ctx.db.delete(edge._id);
    return null;
  },
  returns: v.null(),
});

/**
 * Moves one owned layer under a new group (or to the root, when `groupId` is
 * undefined) — the reparent act. The layer's own subtree travels with it;
   the cycle guard refuses a move into the moved subtree.
 */
export const reparent = mutation({
  args: { groupId: v.optional(v.string()), layerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      layerId = layerIdArg(ctx, args.layerId);
    if (layerId === null) {
      throw goneLayer();
    }
    const layer = await ctx.db.get(layerId);
    if (layer === null) {
      throw goneLayer();
    }
    await projectForWrite(ctx, actorId, layer.projectId);
    const existing = await parentGroupOf(ctx, layerId);
    let nextGroupId: Id<"layers"> | undefined;
    if (args.groupId !== undefined) {
      const groupId = layerIdArg(ctx, args.groupId);
      if (groupId === null) {
        throw goneLayer();
      }
      const group = await ctx.db.get(groupId);
      if (group === null || group.kind !== "group") {
        throw goneLayer();
      }
      if (group.projectId !== layer.projectId) {
        throw new ConvexError("Layers group within their own project.");
      }
      await assertNotDescendant(ctx, layerId, groupId);
      nextGroupId = groupId;
    }
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
    if (nextGroupId !== undefined) {
      const siblings = await ctx.db
          .query("layerChildren")
          .withIndex("by_group", (q) => q.eq("groupId", nextGroupId))
          .collect(),
        order = siblings.reduce((next, row) => Math.max(next, row.order + 1), 0);
      await ctx.db.insert("layerChildren", {
        childKind: "owned",
        childLayerId: layerId,
        groupId: nextGroupId,
        order,
      });
    }
    return null;
  },
  returns: v.null(),
});

/**
 * Reorders one group's children — swaps the child with its neighbor in draw
 * order (`up` = toward the top / first drawn), a no-op at the ends. The
 * component's moveMapLayer shape, kept: order values stay put, only the two
 * neighbors swap.
 */
export const reorder = mutation({
  args: {
    direction: v.union(v.literal("up"), v.literal("down")),
    groupId: v.string(),
    layerId: v.string(),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      groupId = layerIdArg(ctx, args.groupId),
      layerId = layerIdArg(ctx, args.layerId);
    if (groupId === null || layerId === null) {
      throw goneLayer();
    }
    await ownedChildForGroup(ctx, actorId, groupId, layerId);
    const siblings = await ctx.db
      .query("layerChildren")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .order("asc")
      .collect();
    const index = siblings.findIndex((row) => row.childLayerId === layerId),
      neighbor = args.direction === "up" ? siblings[index - 1] : siblings[index + 1];
    if (index === -1 || neighbor === undefined) {
      return null;
    }
    const row = siblings[index];
    if (row === undefined) {
      return null;
    }
    await ctx.db.patch(row._id, { order: neighbor.order });
    await ctx.db.patch(neighbor._id, { order: row.order });
    return null;
  },
  returns: v.null(),
});

// ---------------------------------------------------------------------------
// Cross-module helpers (in-transaction, never public surfaces)
// ---------------------------------------------------------------------------

/**
 * Resolves one map placement's layer member (projectMaps.ts's read path):
 * the membership row plus whichever artifact answers — an OWNED member's
 * live `layers` row, or a LINKED member's pinned `layerVersions` row. A
 * deleted artifact answers nulls (the caller renders it defensively), the
 * workspace's missing-row convention.
 */
export async function resolveLayerMember(
  ctx: Pick<QueryCtx, "db">,
  layerMemberId: Id<"projectArtifacts">,
): Promise<{
  layer: Doc<"layers"> | null;
  membership: Doc<"projectArtifacts"> | null;
  version: Doc<"layerVersions"> | null;
}> {
  const membership = await ctx.db.get(layerMemberId);
  if (membership === null || membership.artifactKind !== "layer") {
    return { layer: null, membership, version: null };
  }
  if (membership.role === "linked") {
    const versionId = ctx.db.normalizeId("layerVersions", membership.artifactId),
      version = versionId === null ? null : await ctx.db.get(versionId);
    return { layer: null, membership, version };
  }
  const layerId = ctx.db.normalizeId("layers", membership.artifactId),
    layer = layerId === null ? null : await ctx.db.get(layerId);
  return { layer, membership, version: null };
}
