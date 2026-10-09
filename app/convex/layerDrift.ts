import type { FunctionReturnType } from "convex/server";

import { components } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * The schema-drift stamp (phase 3 of the project-workspace design, ADR
 * 0012): when a dataset SYNC moves a linked member's pin onto a version
 * whose FIELDS differ, the data layers styling that membership are flagged
 * `needsAttention` — their stored style/filter/labels/popup may name fields
 * the new version doesn't have — rather than being broken silently or
 * blocked. The flag is a message (which version moved, what to review); the
 * layer's next styling write clears it (layers.update). Lives in its own
 * import-free module (the projectAccess.ts pattern) so consumption.ts can
 * call it in-transaction without a consumption → layers → projects →
 * consumption cycle.
 */

const MAX_LAYERS = 500;

/** One component schema read that tolerates a stored id that isn't well-formed (the projects.ts precedent). */
async function tryGetSchema(
  ctx: Pick<MutationCtx, "runQuery">,
  schemaId: string,
): Promise<FunctionReturnType<typeof components.jsonCms.lib.getSchema>> {
  try {
    return await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  } catch {
    return null;
  }
}

/** The stored schema JSON's top-level field names — the set whose change is drift. A junk payload degrades to an empty set (no false drift from unparseable shapes). */
export function schemaFieldNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof schema !== "object" || schema === null) {
    return names;
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) {
    return names;
  }
  for (const name of Object.keys(properties)) {
    names.add(name);
  }
  return names;
}

/** True when the two field sets are NOT identical (either direction — added or removed names both restyle-blind a layer). */
function fieldSetsDiffer(before: Set<string>, after: Set<string>): boolean {
  if (before.size !== after.size) {
    return true;
  }
  for (const name of before) {
    if (!after.has(name)) {
      return true;
    }
  }
  return false;
}

/**
 * The sync-side entry: called by consumption.syncReference after it moves a
 * fork edge's pin. Resolves the OLD and NEW pinned rows' field sets and, on
 * a difference, flags every data layer styling this membership. Everything
 * else (derived edges, non-membership consumers, equal field sets,
 * unresolvable rows) is a no-op — drift is a layered-dataset concern only.
 */
export async function markLayerDriftForPinMove(
  ctx: MutationCtx,
  ref: Doc<"consumerReferences">,
  head: { schemaId: string; versionLabel?: string },
): Promise<void> {
  if (ref.consumerKind !== "fork" || ref.pinnedSchemaId === undefined) {
    return;
  }
  const membershipId = ctx.db.normalizeId("projectArtifacts", ref.consumerId),
    membership = membershipId === null ? null : await ctx.db.get(membershipId);
  if (membershipId === null || membership === null) {
    return;
  }
  const [before, after] = await Promise.all([
    tryGetSchema(ctx, ref.pinnedSchemaId),
    tryGetSchema(ctx, head.schemaId),
  ]);
  if (before === null || after === null) {
    return;
  }
  if (!fieldSetsDiffer(schemaFieldNames(before.schema), schemaFieldNames(after.schema))) {
    return;
  }
  const message = `This dataset's fields changed at ${
    head.versionLabel === undefined ? "the synced version" : head.versionLabel
  } — review the layer's style, filter, labels, and popup.`;
  const layers = await ctx.db
    .query("layers")
    .withIndex("by_project", (q) => q.eq("projectId", membership.projectId))
    .take(MAX_LAYERS);
  for (const layer of layers) {
    if (layer.datasetMemberId === membershipId && layer.needsAttention !== message) {
      // oxlint-disable-next-line no-await-in-loop -- one layer patch per hit, project-scale bounded.
      await ctx.db.patch(layer._id, { needsAttention: message });
    }
  }
}
