import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { SOURCE_KEY } from "./sources";

/**
 * Basic CRUD over the foreign-domain stand-in tables for the /dashboard
 * route. These tables are the "source of truth" side of the bound-datasets
 * PoC (docs/bound-datasets-design.md): editing here intentionally does NOT
 * touch the projected json-cms dataset — every write only stamps
 * `sourceUpdatedAt` on the binding row so the UI can show that the
 * projection is stale until the next "Sync now".
 *
 * Deleting a restaurant or location cascades to its `restaurantLocations`
 * rows, mirroring how a real foreign app would keep its join table from
 * dangling. Link rows are joined with their restaurant/location names at
 * read time (the tables are tiny and dashboard-bounded); nothing here reads
 * the component's tables — projection state flows through `bindings.status`.
 */

const LIST_LIMIT = 500;

/** Stamps the binding row so the dashboard can show staleness. No-op before the first sync creates it. */
async function touchBindingSource(ctx: Pick<MutationCtx, "db">) {
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_source", (q) => q.eq("source", SOURCE_KEY))
    .first();
  if (binding) {
    await ctx.db.patch(binding._id, { sourceUpdatedAt: Date.now() });
  }
}

function assertValidRestaurant(name: string, cuisine: string): { cuisine: string; name: string } {
  const trimmedName = name.trim(),
    trimmedCuisine = cuisine.trim();
  if (!trimmedName || !trimmedCuisine) {
    throw new ConvexError("Name and cuisine are required.");
  }
  return { cuisine: trimmedCuisine, name: trimmedName };
}

type LocationFields = {
  address: string;
  city: string;
  label: string;
  lat: number;
  lng: number;
  state: string;
};

function assertLatLng(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new ConvexError("Latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new ConvexError("Longitude must be between -180 and 180.");
  }
}

function assertValidLocation(args: LocationFields): LocationFields {
  const label = args.label.trim();
  if (!label || !args.address.trim() || !args.city.trim() || !args.state.trim()) {
    throw new ConvexError("Label, address, city, and state are required.");
  }
  assertLatLng(args.lat, args.lng);
  return { ...args, label };
}

function assertOpenedYear(openedYear: number | null | undefined): void {
  if (openedYear !== undefined && openedYear !== null && (openedYear < 1900 || openedYear > 2100)) {
    throw new ConvexError("Opened year must be between 1900 and 2100.");
  }
}

/** Deletes the join rows in `links` and returns how many went away. */
async function deleteCascadingLinks(
  ctx: Pick<MutationCtx, "db">,
  links: Array<{ _id: Id<"restaurantLocations"> }>,
): Promise<number> {
  await Promise.all(
    links.map(async (link) => {
      await ctx.db.delete(link._id);
    }),
  );
  return links.length;
}

// -------------------------------------------------------- commit feed (#77)
//
// The foreign app versions its data git-style; this stand-in's equivalent is
// a commit row per dashboard write, in the design's ops shape
// (docs/bound-datasets-design.md §4/§8.2). The sync engine's primary path
// pages this feed; the full reconcile remains the drift fallback. Ops name
// projected rows by their foreign key (the restaurantLocations id), so
// editing a location or restaurant expands to one op per joined link row.

type ProjectionRowSnapshot = {
  data: Record<string, unknown>;
  geometry: { coordinates: number[]; type: string } | null;
};

type ProjectionSnapshot = Map<string, ProjectionRowSnapshot>;

/** Joins one link row into its projection row shape (mirrors sources.ts). */
async function projectionRowForLink(
  ctx: Pick<MutationCtx, "db">,
  link: {
    _id: Id<"restaurantLocations">;
    locationId: Id<"locations">;
    restaurantId: Id<"restaurants">;
    openedYear?: number;
  },
): Promise<ProjectionRowSnapshot | null> {
  const location = await ctx.db.get(link.locationId),
    restaurant = await ctx.db.get(link.restaurantId);
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
    geometry: { coordinates: [location.lng, location.lat], type: "Point" },
  };
}

async function snapshotKeys(
  ctx: Pick<MutationCtx, "db">,
  keys: Array<Id<"restaurantLocations">>,
): Promise<ProjectionSnapshot> {
  const snapshot: ProjectionSnapshot = new Map();
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- dashboard-sized key sets; reads are cheap.
    const link = await ctx.db.get(key);
    if (link === null) {
      continue;
    }
    const row = await projectionRowForLink(ctx, link);
    if (row !== null) {
      snapshot.set(key, row);
    }
  }
  return snapshot;
}

async function linkKeysForRestaurant(
  ctx: Pick<MutationCtx, "db">,
  restaurantId: Id<"restaurants">,
): Promise<Array<Id<"restaurantLocations">>> {
  const links = await ctx.db
    .query("restaurantLocations")
    .withIndex("by_restaurantId_and_locationId", (q) => q.eq("restaurantId", restaurantId))
    .take(LIST_LIMIT);
  return links.map((link) => link._id);
}

async function linkKeysForLocation(
  ctx: Pick<MutationCtx, "db">,
  locationId: Id<"locations">,
): Promise<Array<Id<"restaurantLocations">>> {
  const links = await ctx.db
    .query("restaurantLocations")
    .withIndex("by_locationId", (q) => q.eq("locationId", locationId))
    .take(LIST_LIMIT);
  return links.map((link) => link._id);
}

const COMMIT_FIELDS = [
  "address",
  "city",
  "cuisine",
  "label",
  "lat",
  "lng",
  "restaurantName",
  "state",
] as const;

/** Diffs two projection snapshots into the commits' ops shape. */
function diffProjectionSnapshots(before: ProjectionSnapshot, after: ProjectionSnapshot) {
  const ops: Array<{
    entryKey: string;
    fields: Array<{ after?: unknown; before?: unknown; name: string }>;
    geometryChanged: boolean;
    op: "add" | "delete" | "update";
  }> = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const beforeRow = before.get(key),
      afterRow = after.get(key);
    if (afterRow === undefined) {
      ops.push({ entryKey: key, fields: [], geometryChanged: false, op: "delete" });
      continue;
    }
    if (beforeRow === undefined) {
      ops.push({
        entryKey: key,
        fields: COMMIT_FIELDS.filter((name) => afterRow.data[name] !== undefined).map(
          (name) => ({ after: afterRow.data[name], name }),
        ),
        geometryChanged: afterRow.geometry !== null,
        op: "add",
      });
      continue;
    }
    const fields = COMMIT_FIELDS.filter(
      (name) => JSON.stringify(beforeRow.data[name]) !== JSON.stringify(afterRow.data[name]),
    ).map((name) => ({
      after: afterRow.data[name],
      before: beforeRow.data[name],
      name,
    }));
    const geometryChanged =
      afterRow.geometry !== null &&
      (beforeRow.geometry === null ||
        JSON.stringify(beforeRow.geometry.coordinates) !==
          JSON.stringify(afterRow.geometry.coordinates));
    if (fields.length > 0 || geometryChanged) {
      ops.push({ entryKey: key, fields, geometryChanged, op: "update" });
    }
  }
  return ops;
}

/** Appends one commit to the source's feed. No-op when nothing changed. */
async function appendSourceCommit(
  ctx: Pick<MutationCtx, "db">,
  message: string,
  ops: ReturnType<typeof diffProjectionSnapshots>,
): Promise<void> {
  if (ops.length === 0) {
    return;
  }
  const newest = await ctx.db
    .query("sourceCommits")
    .withIndex("by_source_seq", (q) => q.eq("source", SOURCE_KEY))
    .order("desc")
    .first();
  const seq = newest !== null ? newest.seq + 1 : 1;
  await ctx.db.insert("sourceCommits", {
    at: Date.now(),
    foreignCommitId: `${SOURCE_KEY}:${seq}`,
    message,
    ops,
    seq,
    source: SOURCE_KEY,
  });
}

/** Re-snapshots the affected keys and appends the commit for one write. */
async function recordProjectionCommit(
  ctx: Pick<MutationCtx, "db">,
  message: string,
  keys: Array<Id<"restaurantLocations">>,
  before: ProjectionSnapshot,
): Promise<void> {
  const after = await snapshotKeys(ctx, keys);
  await appendSourceCommit(ctx, message, diffProjectionSnapshots(before, after));
}

const linkRowValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("restaurantLocations"),
  city: v.string(),
  label: v.string(),
  locationId: v.id("locations"),
  openedYear: v.optional(v.number()),
  restaurantId: v.id("restaurants"),
  restaurantName: v.string(),
});

// ---------------------------------------------------------------- restaurants

export const listRestaurants = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("restaurants").withIndex("by_name").order("asc").take(LIST_LIMIT),
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("restaurants"),
      cuisine: v.string(),
      name: v.string(),
    }),
  ),
});

export const createRestaurant = mutation({
  args: { cuisine: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const fields = assertValidRestaurant(args.name, args.cuisine);
    const existing = await ctx.db
      .query("restaurants")
      .withIndex("by_name", (q) => q.eq("name", fields.name))
      .first();
    if (existing) {
      throw new ConvexError(`A restaurant named "${fields.name}" already exists.`);
    }
    const id = await ctx.db.insert("restaurants", fields);
    await touchBindingSource(ctx);
    return id;
  },
  returns: v.id("restaurants"),
});

export const updateRestaurant = mutation({
  args: { cuisine: v.string(), id: v.id("restaurants"), name: v.string() },
  handler: async (ctx, args) => {
    const fields = assertValidRestaurant(args.name, args.cuisine);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new ConvexError("Restaurant not found.");
    }
    const collision = await ctx.db
      .query("restaurants")
      .withIndex("by_name", (q) => q.eq("name", fields.name))
      .first();
    if (collision && collision._id !== args.id) {
      throw new ConvexError(`A restaurant named "${fields.name}" already exists.`);
    }
    const keys = await linkKeysForRestaurant(ctx, args.id),
      before = await snapshotKeys(ctx, keys);
    await ctx.db.patch(args.id, fields);
    await touchBindingSource(ctx);
    await recordProjectionCommit(ctx, `Updated restaurant ${fields.name}`, keys, before);
  },
  returns: v.null(),
});

export const deleteRestaurant = mutation({
  args: { id: v.id("restaurants") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    // Prefix query on the compound index — restaurantId is its first column.
    const links = await ctx.db
      .query("restaurantLocations")
      .withIndex("by_restaurantId_and_locationId", (q) => q.eq("restaurantId", args.id))
      .take(LIST_LIMIT);
    const keys = links.map((link) => link._id),
      before = await snapshotKeys(ctx, keys);
    const cascaded = await deleteCascadingLinks(ctx, links);
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
    const deletedName =
      existing !== null && existing !== undefined ? existing.name : args.id;
    await recordProjectionCommit(ctx, `Deleted restaurant ${deletedName}`, keys, before);
    return cascaded;
  },
  returns: v.number(),
});

// ------------------------------------------------------------------ locations

export const listLocations = query({
  args: {},
  handler: async (ctx) =>
    ctx.db.query("locations").withIndex("by_label").order("asc").take(LIST_LIMIT),
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("locations"),
      address: v.string(),
      city: v.string(),
      label: v.string(),
      lat: v.number(),
      lng: v.number(),
      state: v.string(),
    }),
  ),
});

export const createLocation = mutation({
  args: {
    address: v.string(),
    city: v.string(),
    label: v.string(),
    lat: v.number(),
    lng: v.number(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const fields = assertValidLocation(args);
    const existing = await ctx.db
      .query("locations")
      .withIndex("by_label", (q) => q.eq("label", fields.label))
      .first();
    if (existing) {
      throw new ConvexError(`A location labeled "${fields.label}" already exists.`);
    }
    const id = await ctx.db.insert("locations", fields);
    await touchBindingSource(ctx);
    return id;
  },
  returns: v.id("locations"),
});

export const updateLocation = mutation({
  args: {
    address: v.string(),
    city: v.string(),
    id: v.id("locations"),
    label: v.string(),
    lat: v.number(),
    lng: v.number(),
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new ConvexError("Location not found.");
    }
    const { id: _id, ...fields } = args,
      validated = assertValidLocation(fields);
    const collision = await ctx.db
      .query("locations")
      .withIndex("by_label", (q) => q.eq("label", validated.label))
      .first();
    if (collision && collision._id !== args.id) {
      throw new ConvexError(`A location labeled "${validated.label}" already exists.`);
    }
    const keys = await linkKeysForLocation(ctx, args.id),
      before = await snapshotKeys(ctx, keys);
    await ctx.db.patch(args.id, validated);
    await touchBindingSource(ctx);
    await recordProjectionCommit(ctx, `Updated location ${validated.label}`, keys, before);
  },
  returns: v.null(),
});

export const deleteLocation = mutation({
  args: { id: v.id("locations") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    const links = await ctx.db
      .query("restaurantLocations")
      .withIndex("by_locationId", (q) => q.eq("locationId", args.id))
      .take(LIST_LIMIT);
    const keys = links.map((link) => link._id),
      before = await snapshotKeys(ctx, keys);
    const cascaded = await deleteCascadingLinks(ctx, links);
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
    const deletedLabel =
      existing !== null && existing !== undefined ? existing.label : args.id;
    await recordProjectionCommit(ctx, `Deleted location ${deletedLabel}`, keys, before);
    return cascaded;
  },
  returns: v.number(),
});

// ---------------------------------------------------------------------- links

export const listLinks = query({
  args: {},
  handler: async (ctx) => {
    const links = await ctx.db.query("restaurantLocations").take(LIST_LIMIT);
    const joined = await Promise.all(
      links.map(async (link) => {
        const location = await ctx.db.get(link.locationId),
          restaurant = await ctx.db.get(link.restaurantId);
        if (!location || !restaurant) {
          return null;
        }
        return {
          _creationTime: link._creationTime,
          _id: link._id,
          city: location.city,
          label: location.label,
          locationId: link.locationId,
          openedYear: link.openedYear,
          restaurantId: link.restaurantId,
          restaurantName: restaurant.name,
        };
      }),
    );
    return joined.filter((row): row is NonNullable<(typeof joined)[number]> => row !== null);
  },
  returns: v.array(linkRowValidator),
});

export const createLink = mutation({
  args: {
    locationId: v.id("locations"),
    openedYear: v.optional(v.number()),
    restaurantId: v.id("restaurants"),
  },
  handler: async (ctx, args) => {
    assertOpenedYear(args.openedYear);
    const [restaurant, location] = await Promise.all([
      ctx.db.get(args.restaurantId),
      ctx.db.get(args.locationId),
    ]);
    if (!restaurant || !location) {
      throw new ConvexError("Pick both a restaurant and a location.");
    }
    const existing = await ctx.db
      .query("restaurantLocations")
      .withIndex("by_restaurantId_and_locationId", (q) =>
        q.eq("restaurantId", args.restaurantId).eq("locationId", args.locationId),
      )
      .first();
    if (existing) {
      throw new ConvexError(`${restaurant.name} is already linked to ${location.label}.`);
    }
    const id = await ctx.db.insert("restaurantLocations", {
      locationId: args.locationId,
      openedYear: args.openedYear,
      restaurantId: args.restaurantId,
    });
    await touchBindingSource(ctx);
    // The link's key didn't exist before, so an empty before-snapshot yields
    // the add op.
    await recordProjectionCommit(
      ctx,
      `Linked ${restaurant.name} ↔ ${location.label}`,
      [id],
      new Map(),
    );
    return id;
  },
  returns: v.id("restaurantLocations"),
});

export const updateLink = mutation({
  args: { id: v.id("restaurantLocations"), openedYear: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    assertOpenedYear(args.openedYear);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new ConvexError("Link not found.");
    }
    await ctx.db.patch(args.id, {
      openedYear: args.openedYear === null ? undefined : args.openedYear,
    });
    await touchBindingSource(ctx);
  },
  returns: v.null(),
});

export const deleteLink = mutation({
  args: { id: v.id("restaurantLocations") },
  handler: async (ctx, args) => {
    const before = await snapshotKeys(ctx, [args.id]),
      firstRow = [...before.values()][0],
      label =
        firstRow !== undefined && typeof firstRow.data.label === "string"
          ? firstRow.data.label
          : args.id;
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
    await recordProjectionCommit(ctx, `Unlinked ${label}`, [args.id], before);
  },
  returns: v.null(),
});
