import type { FunctionReturnType } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { auth } from "./auth";
import { LAYER_COLORS, layerStyleValidator, narrowStyle, resolveLayerMember } from "./layers";
import { projectRoleFor } from "./projectAccess";
import { addDatasetMembership, insertMembership, projectForWrite } from "./projects";
import { CATALOG_READ_LIMIT } from "./schemas";

/**
 * Project-owned maps (phase 3 of the project-workspace design, ADR 0012) —
 * the canvas tier of the model: viewport/basemap plus an ordered list of
 * root layer placements. A map exists ONLY inside its project (the
 * standalone component maps are retired with this module — `maps.ts` and the
 * component's map tables are gone); every write answers to the map's
 * project's editors-and-up, every read to any member (the ADR 0011 role
 * check, shared with layers.ts).
 *
 * A placement (`mapLayers`) names a layer THROUGH ITS MEMBERSHIP — a
 * projectArtifacts row of kind "layer" in the map's own project — so an
 * owned layer resolves to its live `layers` row and a linked one to its
 * pinned `layerVersions` row (layers.resolveLayerMember). `visible` is the
 * map-local override of the layer's own eye state.
 *
 * AUTO-LAYER ("add dataset to map", one click): `addDatasetToMap` ensures
 * the dataset is a member of the map's project (the addArtifact semantics —
 * visibility-checked, pin-at-head for published sources), creates an owned
 * data layer styling that membership with the default style (reusing a
 * layer that already styles it — the flow is idempotent), and places it on
 * the map. Collection/group targets expand to their geospatial datasets and
 * auto-layer each ("add all datasets from collection"); datasets without
 * geometry are counted and reported, never silently dropped.
 */

const MAX_MAPS = 200;
const MAX_PLACEMENTS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapIdArg(ctx: { db: QueryCtx["db"] }, mapId: string): Id<"projectMaps"> | null {
  return ctx.db.normalizeId("projectMaps", mapId);
}

function mapLayerIdArg(ctx: { db: QueryCtx["db"] }, mapLayerId: string): Id<"mapLayers"> | null {
  return ctx.db.normalizeId("mapLayers", mapLayerId);
}

function goneMap(): ConvexError<string> {
  return new ConvexError("This map no longer exists — it may have been deleted.");
}

/** The map row a write mutation writes into, or the friendly gone-error (editor-and-up of the owning project). */
async function mapForWrite(
  ctx: MutationCtx,
  actorId: string,
  mapId: Id<"projectMaps">,
): Promise<Doc<"projectMaps">> {
  const map = await ctx.db.get(mapId);
  if (map === null) {
    throw goneMap();
  }
  await projectForWrite(ctx, actorId, map.projectId);
  return map;
}

/** The map row a member-scoped read answers with, or null — any role reads. */
async function mapForRead(
  ctx: Pick<QueryCtx, "db">,
  viewerId: string,
  mapId: Id<"projectMaps">,
): Promise<Doc<"projectMaps"> | null> {
  const map = await ctx.db.get(mapId);
  if (map === null) {
    return null;
  }
  return (await projectRoleFor(ctx, map.projectId, viewerId)) === null ? null : map;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** The project's Maps section: every map in display order. Member-scoped — a non-member's read answers empty. */
export const list = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null || (await projectRoleFor(ctx, projectId, viewer)) === null) {
      return [];
    }
    const rows = await ctx.db
      .query("projectMaps")
      .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
      .order("asc")
      .take(MAX_MAPS);
    return Promise.all(
      rows.map(async (map) => ({
        _creationTime: map._creationTime,
        _id: map._id,
        basemap: map.basemap,
        description: map.description,
        layerCount: (
          await ctx.db
            .query("mapLayers")
            .withIndex("by_map", (q) => q.eq("mapId", map._id))
            .take(MAX_PLACEMENTS)
        ).length,
        name: map.name,
        viewport: map.viewport,
      })),
    );
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("projectMaps"),
      basemap: v.optional(v.string()),
      description: v.optional(v.string()),
      layerCount: v.number(),
      name: v.string(),
      viewport: v.optional(v.any()),
    }),
  ),
});

/**
 * One map's placements in draw order, each resolved through its layer
 * member: OWNED placements carry the live layer row, LINKED ones the pinned
 * version's frozen definition — a deleted member resolves to `missing`
 * (the defensive-answer convention; the placement stays until removed).
 * Member-scoped like the workspace.
 */
export const layers = query({
  args: { mapId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null || (await mapForRead(ctx, viewer, mapId)) === null) {
      return [];
    }
    const placements = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", mapId))
      .order("asc")
      .take(MAX_PLACEMENTS);
    return Promise.all(
      placements.map(async (placement) => {
        const resolved = await resolveLayerMember(ctx, placement.layerMemberId);
        if (resolved.layer !== null) {
          return {
            _creationTime: placement._creationTime,
            _id: placement._id,
            kind: "owned" as const,
            layer: {
              datasetMemberId: resolved.layer.datasetMemberId,
              kind: resolved.layer.kind,
              // The live layer row's id — the style panel's write target
              // (layers.update) and the group-detail lookup key (phase 4).
              layerId: resolved.layer._id,
              lifecycle: resolved.layer.lifecycle,
              name: resolved.layer.name,
              needsAttention: resolved.layer.needsAttention,
              opacity: resolved.layer.opacity,
              // The stored style rides the placement read — the editor draws
              // (and the style panel edits) it without a per-layer get
              // (phase 4).
              style: resolved.layer.style,
              // The layer-wide eye — the render gate ANDs it into the
              // placement's map-local one, so hiding a layer on the Layers
              // tab hides it on every map it sits on.
              visible: resolved.layer.visible,
            },
            layerMemberId: placement.layerMemberId,
            order: placement.order,
            visible: placement.visible,
          };
        }
        if (resolved.version !== null) {
          const definition = resolved.version.definition,
            record = isRecord(definition) ? definition : undefined,
            name =
              record !== undefined && typeof record.name === "string"
                ? record.name
                : "Linked layer",
            kind =
              record !== undefined && record.kind === "group"
                ? ("group" as const)
                : ("data" as const),
            dataset = resolved.version.dataset;
          return {
            _creationTime: placement._creationTime,
            _id: placement._id,
            kind: "linked" as const,
            layer: {
              kind,
              name,
              opacity:
                record !== undefined && typeof record.opacity === "number"
                  ? record.opacity
                  : undefined,
              // The frozen dataset pin (absent on group versions and on
              // versions that never froze one) — what the editor's geometry
              // subscription for this placement rides — plus the frozen
              // style, which is what draws it.
              pinnedSchemaId:
                dataset !== undefined && dataset.pinnedSchemaId !== undefined
                  ? dataset.pinnedSchemaId
                  : undefined,
              style: record === undefined ? undefined : narrowStyle(record.style),
              versionLabel: resolved.version.versionLabel,
            },
            layerMemberId: placement.layerMemberId,
            order: placement.order,
            visible: placement.visible,
          };
        }
        return {
          _creationTime: placement._creationTime,
          _id: placement._id,
          kind: "missing" as const,
          layerMemberId: placement.layerMemberId,
          order: placement.order,
          visible: placement.visible,
        };
      }),
    );
  },
  // The three placement shapes, typed at the envelope: OWNED carries the
  // live layer projection (its row id — the style panel's write target —
  // included), LINKED the pinned version's frozen render fields (the style
  // blob stays shapeless, the stored-spec precedent), MISSING the defensive
  // answer. The map editor's types key on this union.
  returns: v.array(
    v.union(
      v.object({
        _creationTime: v.number(),
        _id: v.id("mapLayers"),
        kind: v.literal("owned"),
        layer: v.object({
          datasetMemberId: v.optional(v.id("projectArtifacts")),
          kind: v.union(v.literal("data"), v.literal("group")),
          layerId: v.id("layers"),
          lifecycle: v.union(v.literal("draft"), v.literal("published")),
          name: v.string(),
          needsAttention: v.optional(v.string()),
          opacity: v.optional(v.number()),
          style: v.optional(layerStyleValidator),
          visible: v.boolean(),
        }),
        layerMemberId: v.id("projectArtifacts"),
        order: v.number(),
        visible: v.boolean(),
      }),
      v.object({
        _creationTime: v.number(),
        _id: v.id("mapLayers"),
        kind: v.literal("linked"),
        layer: v.object({
          kind: v.union(v.literal("data"), v.literal("group")),
          name: v.string(),
          opacity: v.optional(v.number()),
          pinnedSchemaId: v.optional(v.string()),
          style: v.optional(v.any()),
          versionLabel: v.string(),
        }),
        layerMemberId: v.id("projectArtifacts"),
        order: v.number(),
        visible: v.boolean(),
      }),
      v.object({
        _creationTime: v.number(),
        _id: v.id("mapLayers"),
        kind: v.literal("missing"),
        layerMemberId: v.id("projectArtifacts"),
        order: v.number(),
        visible: v.boolean(),
      }),
    ),
  ),
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Creates a map in the project — display order appends. The name is the only required field; a blank one is refused, never trimmed away silently. */
export const create = mutation({
  args: { description: v.optional(v.string()), name: v.string(), projectId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      projectId = ctx.db.normalizeId("projects", args.projectId);
    if (projectId === null) {
      throw new ConvexError("This project no longer exists — it may have been deleted.");
    }
    await projectForWrite(ctx, actorId, projectId);
    const name = args.name.trim();
    if (name === "") {
      throw new ConvexError("Give the map a name.");
    }
    if (args.description !== undefined && args.description.trim() === "") {
      throw new ConvexError("Leave the description empty instead of blank.");
    }
    const siblings = await ctx.db
        .query("projectMaps")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
      order = siblings.reduce((next, row) => Math.max(next, row.order + 1), 0);
    return ctx.db.insert("projectMaps", {
      description: args.description,
      name,
      order,
      projectId,
    });
  },
  returns: v.id("projectMaps"),
});

/** Edits a map's own fields — name/description/viewport/basemap. The editor captures the camera; this is its write. */
export const update = mutation({
  args: {
    basemap: v.optional(v.string()),
    description: v.optional(v.string()),
    mapId: v.string(),
    name: v.optional(v.string()),
    viewport: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId);
    const patch: {
      basemap?: string;
      description?: string;
      name?: string;
      viewport?: unknown;
    } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name === "") {
        throw new ConvexError("Give the map a name.");
      }
      patch.name = name;
    }
    if (args.description !== undefined) {
      if (args.description.trim() === "") {
        throw new ConvexError("Leave the description empty instead of blank.");
      }
      patch.description = args.description;
    }
    if (args.viewport !== undefined) {
      patch.viewport = args.viewport;
    }
    if (args.basemap !== undefined) {
      patch.basemap = args.basemap;
    }
    await ctx.db.patch(map._id, patch);
    return null;
  },
  returns: v.null(),
});

/** Removes a map and its placements. The layers themselves are members of the project, not of the map — nothing else is touched. */
export const remove = mutation({
  args: { mapId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId);
    for await (const placement of ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", map._id))) {
      // oxlint-disable-next-line no-await-in-loop -- one placement per hop.
      await ctx.db.delete(placement._id);
    }
    await ctx.db.delete(map._id);
    return null;
  },
  returns: v.null(),
});

/** Reorders the project's Maps list — swaps the map with its neighbor (the moveMapLayer shape). */
export const move = mutation({
  args: { direction: v.union(v.literal("up"), v.literal("down")), mapId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId),
      siblings = await ctx.db
        .query("projectMaps")
        .withIndex("by_project_order", (q) => q.eq("projectId", map.projectId))
        .order("asc")
        .collect();
    const index = siblings.findIndex((row) => row._id === map._id),
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

/** Places one of the project's layer members on the map — visible by default, appended in draw order, once (the duplicate guard is the component addMapLayer's). */
export const addLayer = mutation({
  args: { layerMemberId: v.string(), mapId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId),
      memberId = ctx.db.normalizeId("projectArtifacts", args.layerMemberId),
      membership = memberId === null ? null : await ctx.db.get(memberId);
    if (
      membership === null ||
      membership.projectId !== map.projectId ||
      membership.artifactKind !== "layer"
    ) {
      throw new ConvexError("That layer isn't a member of this map's project.");
    }
    const placements = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", map._id))
      .collect();
    if (placements.some((placement) => placement.layerMemberId === membership._id)) {
      throw new ConvexError("That layer is already on this map.");
    }
    return ctx.db.insert("mapLayers", {
      layerMemberId: membership._id,
      mapId: map._id,
      order: placements.reduce((next, placement) => Math.max(next, placement.order + 1), 0),
      visible: true,
    });
  },
  returns: v.id("mapLayers"),
});

/** Removes one placement. The layer member itself is untouched — this unhooks it from the canvas. */
export const removeLayer = mutation({
  args: { mapLayerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      placementId = mapLayerIdArg(ctx, args.mapLayerId);
    if (placementId === null) {
      throw goneMap();
    }
    const placement = await ctx.db.get(placementId);
    if (placement === null) {
      throw goneMap();
    }
    await mapForWrite(ctx, actorId, placement.mapId);
    await ctx.db.delete(placement._id);
    return null;
  },
  returns: v.null(),
});

/** The map-local eye toggle on one placement — the override of the layer's own `visible`. */
export const setLayerVisibility = mutation({
  args: { mapLayerId: v.string(), visible: v.boolean() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      placementId = mapLayerIdArg(ctx, args.mapLayerId);
    if (placementId === null) {
      throw goneMap();
    }
    const placement = await ctx.db.get(placementId);
    if (placement === null) {
      throw goneMap();
    }
    await mapForWrite(ctx, actorId, placement.mapId);
    await ctx.db.patch(placement._id, { visible: args.visible });
    return null;
  },
  returns: v.null(),
});

/** Reorders the map's placements — swaps with the neighbor in draw order. */
export const moveLayer = mutation({
  args: { direction: v.union(v.literal("up"), v.literal("down")), mapLayerId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      placementId = mapLayerIdArg(ctx, args.mapLayerId);
    if (placementId === null) {
      throw goneMap();
    }
    const placement = await ctx.db.get(placementId);
    if (placement === null) {
      throw goneMap();
    }
    await mapForWrite(ctx, actorId, placement.mapId);
    const siblings = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", placement.mapId))
      .order("asc")
      .collect();
    const index = siblings.findIndex((row) => row._id === placement._id),
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
// Auto-layer ("add dataset to map", ADR 0012)
// ---------------------------------------------------------------------------

/** The result of one auto-layer: the placement (new or existing) and whether a layer row was freshly created. */
type AutoLayerResult = { created: boolean; layerId: Id<"layers">; mapLayerId: Id<"mapLayers"> };

/**
 * The one-click flow, in ONE transaction: the dataset joins the map's
 * project (or is already a member), an owned data layer styles its
 * membership with the default palette color (or the flow reuses the layer
 * already styling it — auto-layer is idempotent; restyling differently is
 * the editor's job), and the layer is placed on the map (visible, appended).
 */
async function autoLayerForDataset(
  ctx: MutationCtx,
  actorId: string,
  map: Doc<"projectMaps">,
  datasetId: string,
): Promise<AutoLayerResult> {
  const project = await ctx.db.get(map.projectId);
  if (project === null) {
    throw goneMap();
  }
  const { membership } = await addDatasetMembership(ctx, actorId, project, datasetId, "manual");
  // Reuse: a data layer of this project already styling this membership
  // joins the map instead of a same-dataset twin (the component
  // addMapLayer's once-per-target guard, carried over the membership
  // indirection). Project-scale scan; human-scale result.
  const projectLayers = await ctx.db
    .query("layers")
    .withIndex("by_project", (q) => q.eq("projectId", map.projectId))
    .take(500);
  const existing = projectLayers.find(
    (layer) => layer.kind === "data" && layer.datasetMemberId === membership,
  );
  let layerId: Id<"layers">,
    created = false;
  if (existing !== undefined) {
    layerId = existing._id;
  } else {
    // The dataset's own title names the layer (the summary read is one
    // light component hop; a dataset deleted mid-flow reads as gone).
    const summary = await ctx.runQuery(components.jsonCms.lib.getSchemaSummaries, {
      schemaIds: [datasetId],
    });
    const row = summary[0];
    if (row === undefined) {
      throw new ConvexError("That dataset no longer exists — it may have been deleted.");
    }
    layerId = await ctx.db.insert("layers", {
      datasetMemberId: membership,
      kind: "data",
      lifecycle: "draft",
      name: row.title,
      projectId: map.projectId,
      style: { color: LAYER_COLORS[0] },
      visible: true,
    });
    // The layer's own membership (its placements and its workspace row name
    // it through it) — born with the row, the create flow's atomic pair.
    await insertMembership(ctx, project, {
      addedBy: actorId,
      artifactId: layerId,
      artifactKind: "layer",
      role: "owned",
      syncMode: "manual",
    });
    created = true;
  }
  // The layer's own membership (its placements name it through it).
  const holders = await ctx.db
      .query("projectArtifacts")
      .withIndex("by_artifact", (q) => q.eq("artifactKind", "layer").eq("artifactId", layerId))
      .take(200),
    layerMembership = holders.find((row) => row.projectId === map.projectId);
  if (layerMembership === undefined) {
    throw new ConvexError("The layer lost its membership — it can't be placed on the map.");
  }
  const placements = await ctx.db
    .query("mapLayers")
    .withIndex("by_map", (q) => q.eq("mapId", map._id))
    .collect();
  const placed = placements.find((placement) => placement.layerMemberId === layerMembership._id);
  if (placed !== undefined) {
    return { created, layerId, mapLayerId: placed._id };
  }
  const mapLayerId = await ctx.db.insert("mapLayers", {
    layerMemberId: layerMembership._id,
    mapId: map._id,
    order: placements.reduce((next, placement) => Math.max(next, placement.order + 1), 0),
    visible: true,
  });
  return { created, layerId, mapLayerId };
}

/**
 * Auto-layers one dataset onto a map — the "add dataset to map" click. The
 * dataset must be visible to the caller (addDatasetMembership's check
 * answers invisibles as missing), and only a GEOSPATIAL dataset layers
 * meaningfully: a standard one is refused with the reason, never layered
 * into nothing.
 */
export const addDatasetToMap = mutation({
  args: { datasetId: v.string(), mapId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId),
      doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: args.datasetId });
    if (doc === null) {
      throw new ConvexError("Dataset not found");
    }
    if (doc.kind !== "geospatial") {
      throw new ConvexError("Only a geospatial dataset can layer onto a map.");
    }
    return autoLayerForDataset(ctx, actorId, map, args.datasetId);
  },
  returns: v.object({
    created: v.boolean(),
    layerId: v.id("layers"),
    mapLayerId: v.id("mapLayers"),
  }),
});

/** One expansion target's datasets: the geospatial summaries to auto-layer, with the skipped (non-geospatial) count reported beside them. */
type ExpansionDataset = { summary: { title: string; _id: string } };

async function datasetsOfCollection(
  ctx: QueryCtx,
  collectionId: string,
  viewerId: string,
): Promise<{ skipped: number; targets: ExpansionDataset[] }> {
  // One component read that tolerates an id that isn't well-formed (the
  // tryGetSchema precedent): a junk id reads as a gone collection, never a
  // validator crash.
  let datasets: FunctionReturnType<typeof components.jsonCms.lib.listSchemasByCollection>;
  try {
    datasets = await ctx.runQuery(components.jsonCms.lib.listSchemasByCollection, {
      collectionId,
      viewerId,
    });
  } catch {
    throw new ConvexError("Collection not found");
  }
  return splitExpansion(datasets);
}

async function datasetsOfGroup(
  ctx: QueryCtx,
  groupId: string,
  viewerId: string,
): Promise<{ skipped: number; targets: ExpansionDataset[] }> {
  const datasets = await ctx.runQuery(components.jsonCms.lib.listSchemaSummaries, {
    limit: CATALOG_READ_LIMIT,
    viewerId,
  });
  return splitExpansion(datasets.filter((row) => row.groupId === groupId));
}

/** Splits an expansion's summaries into geospatial auto-layer targets and the skipped rest (reported, never silent). */
function splitExpansion<T extends { _id: string; kind?: string | undefined; title: string }>(
  datasets: ReadonlyArray<T>,
): { skipped: number; targets: ExpansionDataset[] } {
  const targets: ExpansionDataset[] = [];
  let skipped = 0;
  for (const row of datasets) {
    if (row.kind === "geospatial") {
      targets.push({ summary: { _id: row._id, title: row.title } });
    } else {
      skipped += 1;
    }
  }
  return { skipped, targets };
}

/**
 * "Add all datasets from collection" (the retired add-collection-as-one-
 * layer target): expands the collection's visible datasets and auto-layers
 * each geospatial one onto the map. Exactly one of `collectionId`/
 * `groupId` — the sheet's two targets share the flow. Idempotent per
 * dataset (autoLayerForDataset reuses layers and placements); returns the
 * counts so the UI says what happened, including how many datasets were
 * skipped for having no geometry.
 */
export const addAllDatasets = mutation({
  args: {
    collectionId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    mapId: v.string(),
  },
  // oxlint-disable-next-line eslint/complexity -- the exactly-one-target guard plus the per-dataset tally is one honest sequence.
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      mapId = mapIdArg(ctx, args.mapId);
    if (mapId === null) {
      throw goneMap();
    }
    const map = await mapForWrite(ctx, actorId, mapId);
    if ((args.collectionId === undefined) === (args.groupId === undefined)) {
      throw new ConvexError("Pick a collection or a group — exactly one.");
    }
    const expansion =
      args.collectionId !== undefined
        ? await datasetsOfCollection(ctx, args.collectionId, actorId)
        : await datasetsOfGroup(ctx, args.groupId ?? "", actorId);
    let added = 0;
    for (const target of expansion.targets) {
      // oxlint-disable-next-line no-await-in-loop -- one membership/layer/placement set per dataset, in collection order.
      await autoLayerForDataset(ctx, actorId, map, target.summary._id);
      added += 1;
    }
    return { added, skipped: expansion.skipped };
  },
  returns: v.object({ added: v.number(), skipped: v.number() }),
});
