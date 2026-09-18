import { v } from "convex/values";

import { components } from "./_generated/api";
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
    // Find-or-create the bound dataset. Real deployments would key this off
    // the binding row only; re-checking by title keeps a stray manual
    // duplicate from forking the projection.
    const binding = await ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
      .first();
    let schemaId: string;
    if (binding) {
      schemaId = binding.schemaId;
    } else {
      schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
        geometryType: "Point",
        kind: "geospatial",
        schema: restaurantLocationSchema,
      });
      await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
        collectionId,
        schemaId,
      });
    }

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
    await ctx.runMutation(components.jsonCms.lib.createEntriesBulk, {
      entries,
      schemaId,
    });

    const syncedAt = Date.now();
    if (binding) {
      await ctx.db.patch(binding._id, {
        collectionId,
        lastSyncedAt: syncedAt,
        syncedEntryCount: entries.length,
      });
    } else {
      await ctx.db.insert("datasetBindings", {
        collectionId,
        lastSyncedAt: syncedAt,
        schemaId,
        source: SOURCE_KEY,
        syncedEntryCount: entries.length,
      });
    }

    return {
      collectionId,
      entries: entries.length,
      schemaId,
    };
  },
  returns: v.object({
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
      binding: v.object({
        _creationTime: v.number(),
        _id: v.id("datasetBindings"),
        collectionId: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
        schemaId: v.string(),
        source: v.string(),
        sourceUpdatedAt: v.optional(v.number()),
        syncedEntryCount: v.optional(v.number()),
      }),
      schema: v.any(),
    }),
  ),
});
