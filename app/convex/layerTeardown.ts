import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * The layer teardown cascade (phase 3 of the project-workspace design, ADR
 * 0012) as a plain in-transaction helper — a dependency-free leaf module
 * (the layerDrift.ts pattern) so BOTH surfaces that remove layers share one
 * implementation without an import cycle (layers.ts imports projects.ts, so
 * projects.ts cannot import layers.ts):
 *
 * - `layers.remove` (the layer's own delete control), and
 * - `projects.removeArtifact` on a layer-kind membership (the workspace's
 *   RemoveButton), and
 * - `projects.remove`'s project teardown (a project-owned layer or map is
 *   an app-side ROW, not a reference — deleting the project deletes it,
 *   unlike the component datasets, which are references and survive).
 *
 * Everything a layer attached itself to goes with it, in dependency order:
 * its map placements (which name it THROUGH its membership), its group
 * child rows both ways, its version chain, and only then the row itself.
 * The dataset behind a data layer is never touched.
 */

const MAX_LAYERS = 500;

/**
 * Deletes every map placement naming `membership` — placements resolve
 * layers THROUGH their projectArtifacts row, so the membership's removal
 * (with it, the layer's) must sweep the maps of the membership's project.
 * Project-scale bounded; a placement per hop.
 */
export async function deletePlacementsForMembership(
  ctx: MutationCtx,
  membership: Doc<"projectArtifacts">,
): Promise<void> {
  const maps = await ctx.db
    .query("projectMaps")
    .withIndex("by_project", (q) => q.eq("projectId", membership.projectId))
    .take(MAX_LAYERS);
  for (const map of maps) {
    // oxlint-disable-next-line no-await-in-loop -- one map's placements per hop, project-scale bounded.
    const placements = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", map._id))
      .collect();
    for (const placement of placements) {
      if (placement.layerMemberId === membership._id) {
        // oxlint-disable-next-line no-await-in-loop -- one placement per hop.
        await ctx.db.delete(placement._id);
      }
    }
  }
}

/**
 * True when some layer membership of a DIFFERENT project pins `versionId` —
 * the retire-pin-refusal rule (tags.retireVersion refuses while a
 * consumerReference pins the row; existence over markers) carried to layer
 * versions: a frozen row a foreign project linked stays alive for its
 * consumers, whatever happens to the anchor.
 */
async function versionPinnedByForeignProject(
  ctx: { db: QueryCtx["db"] },
  versionId: Id<"layerVersions">,
  ownerProjectId: Id<"projects">,
): Promise<boolean> {
  const holders = await ctx.db
    .query("projectArtifacts")
    .withIndex("by_artifact", (q) => q.eq("artifactKind", "layer").eq("artifactId", versionId))
    .take(200);
  return holders.some((row) => row.projectId !== ownerProjectId);
}

/**
 * Deletes one layer's version chain EXCEPT the frozen rows a foreign
 * project's linked membership pins (see versionPinnedByForeignProject) —
 * read-only rows, harmless past their anchor, kept alive for their
 * consumers exactly like pinned dataset versions.
 */
export async function deleteLayerVersionsCascade(
  ctx: { db: MutationCtx["db"] },
  layerId: Id<"layers">,
  ownerProjectId: Id<"projects">,
): Promise<void> {
  const doomed: Array<Id<"layerVersions">> = [];
  for await (const version of ctx.db
    .query("layerVersions")
    .withIndex("by_layer", (q) => q.eq("layerId", layerId))) {
    // oxlint-disable-next-line no-await-in-loop -- one pin check per version.
    if (!(await versionPinnedByForeignProject(ctx, version._id, ownerProjectId))) {
      doomed.push(version._id);
    }
  }
  for (const versionId of doomed) {
    // oxlint-disable-next-line no-await-in-loop -- one delete per doomed version, bounded by the chain.
    await ctx.db.delete(versionId);
  }
}

/**
 * The full teardown of one layer-kind membership:
 *
 * - LINKED member (a pinned foreign version): its placements and the
 *   membership row go; the pinned `layerVersions` row belongs to the source
 *   project's chain and is never touched.
 * - OWNED member: its placements, its child rows both ways (it stops being
 *   anyone's child; its own children unparent UP a level — removing a group
 *   never deletes the layers inside it), its version chain, the `layers`
 *   row, the membership row, and the project's denormalized count.
 */
export async function deleteLayerMembershipCascade(
  ctx: MutationCtx,
  membership: Doc<"projectArtifacts">,
): Promise<void> {
  await deletePlacementsForMembership(ctx, membership);
  if (membership.role === "owned") {
    const layerId = ctx.db.normalizeId("layers", membership.artifactId);
    if (layerId !== null) {
      for await (const edge of ctx.db
        .query("layerChildren")
        .withIndex("by_child", (q) => q.eq("childLayerId", layerId))) {
        // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
        await ctx.db.delete(edge._id);
      }
      for await (const edge of ctx.db
        .query("layerChildren")
        .withIndex("by_group", (q) => q.eq("groupId", layerId))) {
        // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
        await ctx.db.delete(edge._id);
      }
      await deleteLayerVersionsCascade(ctx, layerId, membership.projectId);
      await ctx.db.delete(layerId);
    }
  }
  await ctx.db.delete(membership._id);
  // Every membership counts in the project's denormalized total, owned or
  // linked — the decrement rides the removal either way.
  const project = await ctx.db.get(membership.projectId);
  if (project !== null) {
    await ctx.db.patch(project._id, {
      artifactCount: Math.max(0, project.artifactCount - 1),
    });
  }
}

/**
 * The membership row an owned layer was born with (the unique
 * projectArtifacts row of kind "layer" naming `layerId` IN its own
 * project), or null — the lookup `layers.remove` and the project teardown
 * share. Uniqueness is the create path's in-transaction rule (Convex has
 * none by index).
 */
export async function layerMembershipRow(
  ctx: { db: QueryCtx["db"] },
  layer: Doc<"layers">,
): Promise<Doc<"projectArtifacts"> | null> {
  const holders = await ctx.db
    .query("projectArtifacts")
    .withIndex("by_artifact", (q) => q.eq("artifactKind", "layer").eq("artifactId", layer._id))
    .take(200);
  return holders.find((row) => row.projectId === layer.projectId) ?? null;
}

/**
 * Deletes one project's OWNED map rows: every map's placements, then the
 * map rows themselves. The layers placed on them are members of the
 * project, not of the map — their teardown is the membership cascade's job,
 * never this walk's.
 */
export async function deleteProjectMapsCascade(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<void> {
  const maps = await ctx.db
    .query("projectMaps")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const map of maps) {
    // oxlint-disable-next-line no-await-in-loop -- one map per hop, project-scale bounded.
    for await (const placement of ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", map._id))) {
      // oxlint-disable-next-line no-await-in-loop -- one placement per hop.
      await ctx.db.delete(placement._id);
    }
    // oxlint-disable-next-line no-await-in-loop -- one map per hop.
    await ctx.db.delete(map._id);
  }
}

/**
 * Deletes any `layers` rows of one project that no longer answer through a
 * membership — defensive (the create path mints the pair atomically), so a
 * stranded row can only mean an earlier bug. Its edges and versions go
 * with it; a row reached here contributes no placements (its membership is
 * gone, so no placement can name it).
 */
export async function deleteStrayLayers(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<void> {
  const rows = await ctx.db
    .query("layers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const layer of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one layer per hop.
    const membership = await layerMembershipRow(ctx, layer);
    if (membership !== null) {
      // Still anchored: deleteLayerMembershipCascade owns this row's fate.
      continue;
    }
    const layerId = layer._id;
    for await (const edge of ctx.db
      .query("layerChildren")
      .withIndex("by_child", (q) => q.eq("childLayerId", layerId))) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
      await ctx.db.delete(edge._id);
    }
    for await (const edge of ctx.db
      .query("layerChildren")
      .withIndex("by_group", (q) => q.eq("groupId", layerId))) {
      // oxlint-disable-next-line no-await-in-loop -- one edge per hop.
      await ctx.db.delete(edge._id);
    }
    await deleteLayerVersionsCascade(ctx, layerId, projectId);
    // oxlint-disable-next-line no-await-in-loop -- one row per hop.
    await ctx.db.delete(layerId);
  }
}
