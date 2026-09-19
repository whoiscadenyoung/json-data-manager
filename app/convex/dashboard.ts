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
    await ctx.db.patch(args.id, fields);
    await touchBindingSource(ctx);
  },
  returns: v.null(),
});

export const deleteRestaurant = mutation({
  args: { id: v.id("restaurants") },
  handler: async (ctx, args) => {
    // Prefix query on the compound index — restaurantId is its first column.
    const links = await ctx.db
      .query("restaurantLocations")
      .withIndex("by_restaurantId_and_locationId", (q) => q.eq("restaurantId", args.id))
      .take(LIST_LIMIT);
    const cascaded = await deleteCascadingLinks(ctx, links);
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
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
    await ctx.db.patch(args.id, validated);
    await touchBindingSource(ctx);
  },
  returns: v.null(),
});

export const deleteLocation = mutation({
  args: { id: v.id("locations") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("restaurantLocations")
      .withIndex("by_locationId", (q) => q.eq("locationId", args.id))
      .take(LIST_LIMIT);
    const cascaded = await deleteCascadingLinks(ctx, links);
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
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
    await ctx.db.delete(args.id);
    await touchBindingSource(ctx);
  },
  returns: v.null(),
});
