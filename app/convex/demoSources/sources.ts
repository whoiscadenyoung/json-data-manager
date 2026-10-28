import type { LocalSource, SourceSnapshot } from "../sources/registry";
import { COMMIT_TAIL_PAGE, SOURCE_READ_PAGE } from "../sources/sourcePaging";

/**
 * The demo foreign app's co-deployed bound sources
 * (docs/bound-datasets-design.md): the restaurants domain's tables
 * (./tables) projected through the core `LocalSource` adapter interface.
 * They join the core registry (`SOURCES` in ../sources/registry.ts) through one
 * spread of `DEMO_SOURCES`.
 */

/** The primary demo source's stable key (the running example from the PoC). */
export const SOURCE_KEY = "restaurantLocations";

const restaurantLocationsSource: LocalSource = {
  dataset: {
    description:
      "Live projection of the restaurants/locations/restaurantLocations tables. " +
      "Bound dataset — sync from the source tables; read-only here.",
    geometryType: "Point",
    kind: "geospatial",
    schema: {
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
      title: "Restaurant locations",
      type: "object",
    },
    title: "Restaurant locations",
  },
  key: SOURCE_KEY,
  // One page of the join, with the continuation cursor. Rows past the old
  // .take(1000) cap used to vanish from the projection when finalize swept
  // them as unseen (#127 defect 1) — callers now drain every page.
  listRows: async (ctx, cursor) => {
    const page = await ctx.db.query("restaurantLocations").paginate({
      cursor,
      numItems: SOURCE_READ_PAGE,
    });
    const joined = await Promise.all(
      page.page.map(async (link) => {
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
          geometry: {
            coordinates: [location.lng, location.lat] as number[],
            type: "Point",
          },
          key: link._id,
        };
      }),
    );
    return {
      cursor: page.isDone ? null : page.continueCursor,
      rows: joined.filter((row) => row !== null),
    };
  },
  commitsSince: async (ctx, sinceSeq) => {
    const feed = await ctx.db
      .query("sourceCommits")
      .withIndex("by_source_seq", (q) => q.eq("source", SOURCE_KEY).gt("seq", sinceSeq))
      .take(COMMIT_TAIL_PAGE);
    return feed.map((commit) => ({
      at: commit.at,
      foreignCommitId: commit.foreignCommitId,
      message: commit.message,
      ops: commit.ops,
      seq: commit.seq,
    }));
  },
  newestCommit: async (ctx) => {
    const newest = await ctx.db
      .query("sourceCommits")
      .withIndex("by_source_seq", (q) => q.eq("source", SOURCE_KEY))
      .order("desc")
      .first();
    return newest !== null
      ? {
          at: newest.at,
          foreignCommitId: newest.foreignCommitId,
          message: newest.message,
          ops: newest.ops,
          seq: newest.seq,
        }
      : null;
  },
  // The foreign app's tag registry (./snapshots registers into it): at most
  // 500 snapshots, oldest first — tag ingest's worklist source.
  listSnapshots: async (ctx): Promise<SourceSnapshot[]> => {
    const snapshots = await ctx.db.query("restaurantSnapshots").take(500);
    return snapshots.map((snapshot) => ({
      fileStorageId: snapshot.fileStorageId,
      label: snapshot.label,
      ref: snapshot.ref,
    }));
  },
  buildGeometry: (data) => {
    if (typeof data.lat !== "number" || typeof data.lng !== "number") {
      return null;
    }
    return { coordinates: [data.lng, data.lat], type: "Point" };
  },
  mapping: {
    entryKey: "restaurantLocations._id",
    fields: {
      address: "locations.address",
      city: "locations.city",
      cuisine: "restaurants.cuisine",
      label: "locations.label",
      lat: "locations.lat",
      lng: "locations.lng",
      restaurantName: "restaurants.name",
      state: "locations.state",
    },
    geometry: { kind: "latLng", lat: "locations.lat", lng: "locations.lng" },
  },
  transport: "local",
};

// A second, deliberately different source: non-geospatial, different join
// (none), different natural key — proves the sync machinery is
// descriptor-driven and not specific to the locations projection.
const restaurantsSource: LocalSource = {
  dataset: {
    description:
      "Live projection of the restaurants table. Bound dataset — sync from the source table; read-only here.",
    kind: "standard",
    schema: {
      properties: {
        cuisine: { title: "Cuisine", type: "string" },
        name: { title: "Name", type: "string" },
      },
      required: ["name", "cuisine"],
      title: "Restaurants",
      type: "object",
    },
    title: "Restaurants",
  },
  key: "restaurants",
  // One page per call, like the locations reader (#127 defect 1).
  listRows: async (ctx, cursor) => {
    const page = await ctx.db.query("restaurants").paginate({
      cursor,
      numItems: SOURCE_READ_PAGE,
    });
    return {
      cursor: page.isDone ? null : page.continueCursor,
      rows: page.page.map((restaurant) => ({
        data: { cuisine: restaurant.cuisine, name: restaurant.name },
        key: restaurant._id,
      })),
    };
  },
  mapping: {
    entryKey: "restaurants._id",
    fields: { cuisine: "restaurants.cuisine", name: "restaurants.name" },
  },
  transport: "local",
};

/** The demo's sources, in registry order (the primary source first). */
export const DEMO_SOURCES: LocalSource[] = [restaurantLocationsSource, restaurantsSource];
