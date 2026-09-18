import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

/**
 * Idempotent seed for the foreign-domain stand-in tables (see schema.ts and
 * docs/bound-datasets-design.md). Safe to run on any deployment, any number
 * of times: restaurants are upserted by name, locations by label, and join
 * rows by the (restaurant, location) pair — re-running only backfills what
 * is missing and reports what already existed.
 *
 * Run with: `bunx convex run seed:seedRestaurants` (from app/)
 */

const RESTAURANTS = [
  { cuisine: "Seafood", name: "Red Lobster" },
  { cuisine: "Italian", name: "Olive Garden" },
  { cuisine: "Fast Food", name: "Chick-fil-A" },
  { cuisine: "Steakhouse", name: "Outback Steakhouse" },
  { cuisine: "Mexican Grill", name: "Chipotle Mexican Grill" },
] as const;

// Synthetic but plausible Hampton Roads / Richmond, VA coordinates. Labels
// double as the idempotency key, so they must stay unique.
const LOCATIONS = [
  // Red Lobster — the design conversation's canonical example (3 locations).
  {
    address: "3472 Virginia Beach Blvd",
    city: "Virginia Beach",
    label: "Red Lobster — Virginia Beach",
    lat: 36.8518,
    lng: -75.9985,
    state: "VA",
  },
  {
    address: "5800 E Virginia Beach Blvd",
    city: "Norfolk",
    label: "Red Lobster — Norfolk",
    lat: 36.8665,
    lng: -76.232,
    state: "VA",
  },
  {
    address: "1544 Sam's Dr",
    city: "Chesapeake",
    label: "Red Lobster — Chesapeake",
    lat: 36.8085,
    lng: -76.238,
    state: "VA",
  },
  {
    address: "2225 Upton Dr",
    city: "Virginia Beach",
    label: "Olive Garden — Virginia Beach",
    lat: 36.8235,
    lng: -75.972,
    state: "VA",
  },
  {
    address: "12380 Jefferson Ave",
    city: "Newport News",
    label: "Olive Garden — Newport News",
    lat: 37.105,
    lng: -76.49,
    state: "VA",
  },
  {
    address: "4901 W Broad St",
    city: "Richmond",
    label: "Olive Garden — Richmond",
    lat: 37.612,
    lng: -77.53,
    state: "VA",
  },
  {
    address: "250 Monticello Ave",
    city: "Norfolk",
    label: "Chick-fil-A — Norfolk Downtown",
    lat: 36.846,
    lng: -76.293,
    state: "VA",
  },
  {
    address: "1700 Atlantic Ave",
    city: "Virginia Beach",
    label: "Chick-fil-A — Virginia Beach Oceanfront",
    lat: 36.857,
    lng: -75.979,
    state: "VA",
  },
  {
    address: "1430 Richmond Rd",
    city: "Williamsburg",
    label: "Chick-fil-A — Williamsburg",
    lat: 37.271,
    lng: -76.708,
    state: "VA",
  },
  {
    address: "1411 Greenbrier Pkwy",
    city: "Chesapeake",
    label: "Chick-fil-A — Chesapeake Greenbrier",
    lat: 36.762,
    lng: -76.213,
    state: "VA",
  },
  {
    address: "4551 Virginia Beach Blvd",
    city: "Virginia Beach",
    label: "Outback Steakhouse — Virginia Beach",
    lat: 36.801,
    lng: -76.152,
    state: "VA",
  },
  {
    address: "2100 Power Plant Pkwy",
    city: "Hampton",
    label: "Outback Steakhouse — Hampton",
    lat: 37.021,
    lng: -76.352,
    state: "VA",
  },
  {
    address: "6001 W Broad St",
    city: "Richmond",
    label: "Outback Steakhouse — Richmond",
    lat: 37.553,
    lng: -77.462,
    state: "VA",
  },
  {
    address: "741 Monticello Ave",
    city: "Norfolk",
    label: "Chipotle — Norfolk",
    lat: 36.869,
    lng: -76.287,
    state: "VA",
  },
  {
    address: "500 Virginia Beach Town Center",
    city: "Virginia Beach",
    label: "Chipotle — Virginia Beach Town Center",
    lat: 36.848,
    lng: -76.132,
    state: "VA",
  },
  {
    address: "12170 Jefferson Ave",
    city: "Newport News",
    label: "Chipotle — Newport News",
    lat: 37.065,
    lng: -76.445,
    state: "VA",
  },
] as const;

// restaurant -> location memberships, by the natural keys above. Red
// Lobster's three locations are the design conversation's running example.
const RESTAURANT_LOCATIONS = [
  { location: "Red Lobster — Virginia Beach", openedYear: 1998, restaurant: "Red Lobster" },
  { location: "Red Lobster — Norfolk", openedYear: 2004, restaurant: "Red Lobster" },
  { location: "Red Lobster — Chesapeake", openedYear: 2011, restaurant: "Red Lobster" },
  { location: "Olive Garden — Virginia Beach", openedYear: 2002, restaurant: "Olive Garden" },
  { location: "Olive Garden — Newport News", openedYear: 2006, restaurant: "Olive Garden" },
  { location: "Olive Garden — Richmond", openedYear: 2000, restaurant: "Olive Garden" },
  { location: "Chick-fil-A — Norfolk Downtown", openedYear: 2015, restaurant: "Chick-fil-A" },
  {
    location: "Chick-fil-A — Virginia Beach Oceanfront",
    openedYear: 2012,
    restaurant: "Chick-fil-A",
  },
  { location: "Chick-fil-A — Williamsburg", openedYear: 2018, restaurant: "Chick-fil-A" },
  {
    location: "Chick-fil-A — Chesapeake Greenbrier",
    openedYear: 2016,
    restaurant: "Chick-fil-A",
  },
  {
    location: "Outback Steakhouse — Virginia Beach",
    openedYear: 2003,
    restaurant: "Outback Steakhouse",
  },
  { location: "Outback Steakhouse — Hampton", openedYear: 2007, restaurant: "Outback Steakhouse" },
  { location: "Outback Steakhouse — Richmond", openedYear: 1999, restaurant: "Outback Steakhouse" },
  { location: "Chipotle — Norfolk", openedYear: 2019, restaurant: "Chipotle Mexican Grill" },
  {
    location: "Chipotle — Virginia Beach Town Center",
    openedYear: 2017,
    restaurant: "Chipotle Mexican Grill",
  },
  { location: "Chipotle — Newport News", openedYear: 2021, restaurant: "Chipotle Mexican Grill" },
] as const;

export const seedRestaurants = internalMutation({
  args: {},
  handler: async (ctx) => {
    const restaurantIds = new Map<string, Id<"restaurants">>();
    let restaurantsCreated = 0;
    await Promise.all(
      RESTAURANTS.map(async (restaurant) => {
        const existing = await ctx.db
          .query("restaurants")
          .withIndex("by_name", (q) => q.eq("name", restaurant.name))
          .first();
        if (existing) {
          restaurantIds.set(restaurant.name, existing._id);
          return;
        }
        const id = await ctx.db.insert("restaurants", { ...restaurant });
        restaurantIds.set(restaurant.name, id);
        restaurantsCreated += 1;
      }),
    );

    const locationIds = new Map<string, Id<"locations">>();
    let locationsCreated = 0;
    await Promise.all(
      LOCATIONS.map(async (location) => {
        const existing = await ctx.db
          .query("locations")
          .withIndex("by_label", (q) => q.eq("label", location.label))
          .first();
        if (existing) {
          locationIds.set(location.label, existing._id);
          return;
        }
        const id = await ctx.db.insert("locations", { ...location });
        locationIds.set(location.label, id);
        locationsCreated += 1;
      }),
    );

    let linksCreated = 0,
      linksExisting = 0;
    await Promise.all(
      RESTAURANT_LOCATIONS.map(async (link) => {
        const restaurantId = restaurantIds.get(link.restaurant),
          locationId = locationIds.get(link.location);
        if (restaurantId === undefined || locationId === undefined) {
          throw new Error(
            `Seed data references unknown key: ${link.restaurant} / ${link.location}`,
          );
        }
        const existing = await ctx.db
          .query("restaurantLocations")
          .withIndex("by_restaurantId_and_locationId", (q) =>
            q.eq("restaurantId", restaurantId).eq("locationId", locationId),
          )
          .first();
        if (existing) {
          linksExisting += 1;
          return;
        }
        await ctx.db.insert("restaurantLocations", {
          locationId,
          openedYear: link.openedYear,
          restaurantId,
        });
        linksCreated += 1;
      }),
    );

    return {
      linksCreated,
      linksExisting,
      locationsCreated,
      restaurantsCreated,
      totals: {
        links: linksCreated + linksExisting,
        locations: locationIds.size,
        restaurants: restaurantIds.size,
      },
    };
  },
  returns: v.object({
    linksCreated: v.number(),
    linksExisting: v.number(),
    locationsCreated: v.number(),
    restaurantsCreated: v.number(),
    totals: v.object({ links: v.number(), locations: v.number(), restaurants: v.number() }),
  }),
});
