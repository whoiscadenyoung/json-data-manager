import { v } from "convex/values";

import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

/**
 * The bound-datasets proof of concept (docs/bound-datasets-design.md): the
 * app's own tables stand in for the "foreign" app's preexisting data, and
 * `syncRestaurantLocations` projects them into a read-only json-cms
 * geospatial dataset — the "live" dataset of the design, pointing at
 * "main head". One mutation does find-or-create of the collection, dataset,
 * and binding row, then rebuilds the projection.
 *
 * Everything the component needs for rendering happens automatically inside
 * these calls: geometry writes maintain `featureCount`/`boundingBox` and
 * bump `mapTileCacheVersion`, so opening the map picks the dataset up with
 * the existing staleness/rebuild machinery — no client changes at all.
 */

// Stable key of the source table in this schema. Stands in for the design's
// remote source descriptor (deployment + reader + geometry mapping) — with
// the source co-deployed, the binding only needs the table's name. Shared
// with the dashboard's CRUD mutations, which touch `sourceUpdatedAt` on the
// same row to mark the projection stale.
export const SOURCE_KEY = "restaurantLocations";

/** Creates the projected dataset with its read-only source marker and files it into the collection. */
async function createBoundDataset(
  ctx: Pick<MutationCtx, "runMutation">,
  collectionId: string,
): Promise<string> {
  const schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
    geometryType: "Point",
    kind: "geospatial",
    schema: restaurantLocationSchema,
    source: { name: SOURCE_KEY },
  });
  await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
    collectionId,
    schemaId,
  });
  return schemaId;
}

type ProjectionRow = {
  data: {
    address: string;
    city: string;
    cuisine: string;
    label: string;
    lat: number;
    lng: number;
    restaurantName: string;
    state: string;
  };
  geometry: string;
};

const ACTIVITY_OPS_LIMIT = 200;

/**
 * Diffs the previous projection against the incoming rows, keyed by the
 * location label (the projection's stable natural key). Returns per-op
 * records for the activity log plus add/remove/update counts — with field
 * detail on updates so the History tab can show what changed, GitHub-style.
 */
function diffProjection(
  previousData: Array<unknown>,
  nextRows: Array<ProjectionRow>,
): {
  added: number;
  ops: Array<{
    detail?: string;
    label: string;
    op: "add" | "remove" | "update";
  }>;
  removed: number;
  updated: number;
} {
  const previousByKey = new Map<string, Record<string, unknown>>();
  for (const entry of previousData) {
    // Component entry docs wrap the projected row in `data` — the natural
    // key lives at `data.label`, not on the doc itself.
    const data = (entry as { data?: unknown }).data as Record<string, unknown> | undefined;
    if (data !== undefined && typeof data.label === "string") {
      previousByKey.set(data.label, data);
    }
  }

  const ops: Array<{ detail?: string; label: string; op: "add" | "remove" | "update" }> = [];
  let added = 0,
    removed = 0,
    updated = 0;

  const nextLabels = new Set<string>();
  for (const row of nextRows) {
    nextLabels.add(row.data.label);
    const before = previousByKey.get(row.data.label);
    if (before === undefined) {
      added += 1;
      ops.push({ label: row.data.label, op: "add" });
      continue;
    }
    const after: Record<string, unknown> = row.data,
      changes: string[] = [],
      fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const field of fields) {
      const beforeValue = JSON.stringify(before[field]),
        afterValue = JSON.stringify(after[field]);
      if (beforeValue !== afterValue) {
        changes.push(`${field}: ${beforeValue} → ${afterValue}`);
      }
    }
    if (changes.length > 0) {
      updated += 1;
      ops.push({ detail: changes.join("; "), label: row.data.label, op: "update" });
    }
  }
  for (const label of previousByKey.keys()) {
    if (!nextLabels.has(label)) {
      removed += 1;
      ops.push({ label, op: "remove" });
    }
  }

  return { added, ops, removed, updated };
}

const COLLECTION_NAME = "External demo";
const COLLECTION_DESCRIPTION =
  "Datasets projected from the app's own tables — the bound-datasets PoC.";

const DATASET_TITLE = "Restaurant locations";

const restaurantLocationSchema = {
  description:
    "Live projection of the restaurants/locations/restaurantLocations tables. " +
    "Bound dataset — sync from the source tables; read-only here.",
  properties: {
    address: { title: "Address", type: "string" },
    city: { title: "City", type: "string" },
    cuisine: { title: "Cuisine", type: "string" },
    label: { title: "Location", type: "string" },
    lat: { title: "Latitude", type: "number" },
    lng: { title: "Longitude", type: "number" },
    restaurantName: { title: "Restaurant", type: "string" },
    state: { title: "State", type: "string" },
  },
  required: ["restaurantName", "label", "city", "state", "lat", "lng"],
  title: DATASET_TITLE,
  type: "object",
};

const bindingValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("datasetBindings"),
  collectionId: v.optional(v.string()),
  lastSyncedAt: v.optional(v.number()),
  schemaId: v.string(),
  source: v.string(),
  sourceUpdatedAt: v.optional(v.number()),
  syncedEntryCount: v.optional(v.number()),
});

export const syncRestaurantLocations = mutation({
  args: {},
  handler: async (ctx) => {
    // Find-or-create the collection that groups bound datasets.
    const collections = await ctx.runQuery(components.jsonCms.lib.listCollections, {});
    const existingCollection = collections.find((c) => c.name === COLLECTION_NAME);
    const collectionId = existingCollection
      ? existingCollection._id
      : await ctx.runMutation(components.jsonCms.lib.createCollection, {
          description: COLLECTION_DESCRIPTION,
          name: COLLECTION_NAME,
        });
    // Find-or-create the bound dataset, marked as a read-only projection of
    // this source. Real deployments would key this off the binding row only;
    // re-checking by title keeps a stray manual duplicate from forking the
    // projection.
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
      .first();
    let schemaId: string;
    if (binding) {
      schemaId = binding.schemaId;
      // Migrate datasets created before the source marker existed: a bound
      // dataset without `source` is deleted and recreated (deleteSchema
      // cascades its entries/archive; the projection is rebuilt below) so
      // the read-only marker is present everywhere it is read.
      const existing = await ctx.runQuery(components.jsonCms.lib.getSchema, {
        schemaId,
      });
      if (existing === null || existing.source === undefined) {
        await ctx.runMutation(components.jsonCms.lib.deleteSchema, { schemaId });
        schemaId = await createBoundDataset(ctx, collectionId);
      }
    } else {
      schemaId = await createBoundDataset(ctx, collectionId);
    }

    // Snapshot the previous projection before the rebuild so the diff can
    // record what this sync changed.
    const previousEntries = await ctx.runQuery(components.jsonCms.lib.listEntriesForSchemas, {
      schemaIds: [schemaId],
    });

    // Rebuild the projection: v1 sync is clear-then-reload (the design's
    // "simplest correct sync"; delete detection comes free at this scale).
    // `deleteEntriesBySchema` bumps the tile-cache version, so any archive
    // of the previous projection is invalidated before we write.
    await ctx.runMutation(components.jsonCms.lib.deleteEntriesBySchema, { schemaId });

    const links = await ctx.db.query("restaurantLocations").take(1000);
    const joined = await Promise.all(
      links.map(async (link) => {
        const location = await ctx.db.get(link.locationId);
        const restaurant = await ctx.db.get(link.restaurantId);
        if (!location || !restaurant) {
          return null;
        }
        return {
          data: {
            address: location.address,
            city: location.city,
            cuisine: restaurant.cuisine,
            label: location.label,
            lat: location.lat,
            lng: location.lng,
            restaurantName: restaurant.name,
            state: location.state,
          },
          // GeoJSON is [lng, lat]; geometry travels to the component as a
          // JSON string (its 8192-element array cap never applies to Points).
          geometry: JSON.stringify({
            coordinates: [location.lng, location.lat],
            type: "Point",
          }),
        };
      }),
    );
    const entries = joined.filter((entry) => entry !== null);
    const diff = diffProjection(previousEntries, entries);
    await ctx.runMutation(components.jsonCms.lib.createEntriesBulk, {
      entries,
      schemaId,
    });

    const syncedAt = Date.now();
    let bindingId: Id<"datasetBindings">;
    if (binding) {
      await ctx.db.patch(binding._id, {
        collectionId,
        lastSyncedAt: syncedAt,
        schemaId,
        syncedEntryCount: entries.length,
      });
      bindingId = binding._id;
    } else {
      bindingId = await ctx.db.insert("datasetBindings", {
        collectionId,
        lastSyncedAt: syncedAt,
        schemaId,
        source: SOURCE_KEY,
        syncedEntryCount: entries.length,
      });
    }
    await ctx.db.insert("datasetActivity", {
      added: diff.added,
      bindingId,
      entryCount: entries.length,
      ops: diff.ops.slice(0, ACTIVITY_OPS_LIMIT),
      removed: diff.removed,
      schemaId,
      syncedAt,
      truncated: diff.ops.length > ACTIVITY_OPS_LIMIT,
      updated: diff.updated,
    });

    return {
      changes: { added: diff.added, removed: diff.removed, updated: diff.updated },
      collectionId,
      entries: entries.length,
      schemaId,
    };
  },
  returns: v.object({
    changes: v.object({ added: v.number(), removed: v.number(), updated: v.number() }),
    collectionId: v.string(),
    entries: v.number(),
    schemaId: v.string(),
  }),
});

/**
 * Binding + projected dataset status, for CLI checks and a future
 * "synced N minutes ago" UI badge.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
      .first();
    if (!binding) {
      return null;
    }
    const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: binding.schemaId,
    });
    return { binding, schema };
  },
  returns: v.union(
    v.null(),
    v.object({
      binding: bindingValidator,
      schema: v.any(),
    }),
  ),
});

/**
 * The binding for one projected dataset (by the json-cms schema id) — how
 * the dataset page learns its sync state (lastSyncedAt vs sourceUpdatedAt).
 * `null` for ordinary, non-bound datasets.
 */
export const getBySchema = query({
  args: { schemaId: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("datasetBindings")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .first(),
  returns: v.union(v.null(), bindingValidator),
});

const activityValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("datasetActivity"),
  added: v.number(),
  bindingId: v.id("datasetBindings"),
  entryCount: v.number(),
  ops: v.array(
    v.object({
      detail: v.optional(v.string()),
      label: v.string(),
      op: v.union(v.literal("add"), v.literal("remove"), v.literal("update")),
    }),
  ),
  removed: v.number(),
  schemaId: v.string(),
  syncedAt: v.number(),
  truncated: v.optional(v.boolean()),
  updated: v.number(),
});

/**
 * The sync activity log for one bound dataset, newest first — the History
 * tab's data. Bounded to the 50 most recent syncs; this is per-sync
 * granularity until the design's commit-level feed lands (phase 4).
 */
export const history = query({
  args: { bindingId: v.id("datasetBindings") },
  handler: async (ctx, args) =>
    ctx.db
      .query("datasetActivity")
      .withIndex("by_bindingId", (q) => q.eq("bindingId", args.bindingId))
      .order("desc")
      .take(50),
  returns: v.array(activityValidator),
});
