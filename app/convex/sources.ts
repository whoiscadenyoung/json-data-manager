import { ConvexError } from "convex/values";

import type { QueryCtx } from "./_generated/server";

/**
 * The bound-datasets source layer (docs/bound-datasets-design.md §4/§8): a
 * `BoundSource` is everything the sync machinery knows about a connected
 * external source — a descriptor for the dataset its projection is created
 * from (schema, kind, geometry), the declared field → projection mapping,
 * and one full-state read. Co-deployed sources read the host's own tables;
 * a remote source (phase 5, #78) implements the same interface over HTTP
 * and the sync/versioning machinery is unchanged.
 *
 * Adding a second bound source means adding one entry to `SOURCES` — no
 * changes anywhere else.
 */

/** One row of a source's state, as the projection should materialize it. */
export type ProjectionRow = {
  // The foreign row's stable id — the projection's key. The sync applies
  // idempotently per key, so an interrupted run can neither duplicate nor
  // lose rows.
  key: string;
  data: Record<string, unknown>;
  // GeoJSON geometry (Points today). Null means "this row has no geometry";
  // absent only for non-geospatial sources.
  geometry?: { coordinates: number[]; type: string } | null;
};

/**
 * The declared projection mapping — where a row's key and fields come from.
 * Stored on the binding row for observability; the row builder below
 * implements it in code (the restaurantLocations join spans three tables,
 * which a purely declarative mapping can't express).
 */
export type SourceMapping = {
  // Where a projected row's key comes from, e.g. "restaurantLocations._id".
  entryKey: string;
  // Projection field → source path, e.g. { label: "locations.label" }.
  fields: Record<string, string>;
  geometry?: { kind: "latLng"; lat: string; lng: string };
};

export type SourceDataset = {
  description: string;
  geometryType?: "Point";
  kind: "standard" | "geospatial";
  schema: Record<string, unknown>;
  title: string;
};

/** One field-level change inside a commit op — the design's [name, before, after]. */
export type CommitField = {
  after?: unknown;
  before?: unknown;
  name: string;
};

/** One entry's change in a commit: adds carry full after-state, deletes nothing, updates the touched fields. */
export type CommitOp = {
  entryKey: string;
  fields: CommitField[];
  geometryChanged: boolean;
  op: "add" | "delete" | "update";
};

/** One entry of the design's §8.2 commit feed (co-deployed form). */
export type CommitFeedEntry = {
  at: number;
  foreignCommitId: string;
  message: string;
  ops: CommitOp[];
  seq: number;
};

export interface BoundSource {
  dataset: SourceDataset;
  key: string;
  mapping: SourceMapping;
  /** The design's §8.1 state reader, co-deployed form: read every row. */
  listRows(ctx: Pick<QueryCtx, "db">): Promise<ProjectionRow[]>;
  /**
   * The design's §8.2 ordered commit feed — everything after `sinceSeq`,
   * ascending. Absent means the source has no commit log; sync for such a
   * source always takes the full-state path.
   */
  commitsSince?(ctx: Pick<QueryCtx, "db">, sinceSeq: number): Promise<CommitFeedEntry[]>;
  /** The newest commit this source has issued, or null when it has none. */
  newestCommit?(ctx: Pick<QueryCtx, "db">): Promise<CommitFeedEntry | null>;
  /**
   * Rebuilds a row's geometry from its (merged) data — the commit-tail apply
   * uses this to refresh geometry after field deltas touch it. Absent for
   * non-geospatial sources.
   */
  buildGeometry?(data: Record<string, unknown>): { coordinates: number[]; type: string } | null;
}

/** The primary demo source's stable key (the running example from the PoC). */
export const SOURCE_KEY = "restaurantLocations";

const restaurantLocationsSource: BoundSource = {
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
  listRows: async (ctx) => {
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
          geometry: {
            coordinates: [location.lng, location.lat] as number[],
            type: "Point",
          },
          key: link._id,
        };
      }),
    );
    return joined.filter((row) => row !== null);
  },
  commitsSince: async (ctx, sinceSeq) => {
    const feed = await ctx.db
      .query("sourceCommits")
      .withIndex("by_source_seq", (q) => q.eq("source", SOURCE_KEY).gt("seq", sinceSeq))
      .take(500);
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
};

// A second, deliberately different source: non-geospatial, different join
// (none), different natural key — proves the sync machinery is
// descriptor-driven and not specific to the locations projection.
const restaurantsSource: BoundSource = {
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
  listRows: async (ctx) => {
    const restaurants = await ctx.db.query("restaurants").take(1000);
    return restaurants.map((restaurant) => ({
      data: { cuisine: restaurant.cuisine, name: restaurant.name },
      key: restaurant._id,
    }));
  },
  mapping: {
    entryKey: "restaurants._id",
    fields: { cuisine: "restaurants.cuisine", name: "restaurants.name" },
  },
};

/** The registry every bound source must be declared in. */
export const SOURCES: Record<string, BoundSource> = {
  [SOURCE_KEY]: restaurantLocationsSource,
  restaurants: restaurantsSource,
};

export function getSource(key: string): BoundSource {
  const source = SOURCES[key];
  if (source === undefined) {
    throw new ConvexError(`Unknown bound source: ${key}`);
  }
  return source;
}

// Mirrors the client importer's chunking intent (and the snapshot ingest's):
// small enough that one chunk's rows fit a request body and one apply pass
// stays well inside action memory.
const CHUNK_ROW_LIMIT = 500,
  CHUNK_BYTE_LIMIT = 768_000;

/** Splits rows into storage-sized chunks by their JSON encoding. */
export function chunkByJsonBytes<T>(
  items: T[],
  rowLimit = CHUNK_ROW_LIMIT,
  byteLimit = CHUNK_BYTE_LIMIT,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [],
    currentBytes = 0;
  for (const item of items) {
    const itemBytes = JSON.stringify(item).length;
    if (
      current.length > 0 &&
      (current.length >= rowLimit || currentBytes + itemBytes > byteLimit)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
