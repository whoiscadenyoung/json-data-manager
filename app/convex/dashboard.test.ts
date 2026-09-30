// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The dashboard's foreign-domain stand-in (dashboard.ts) — behavioral
 * coverage beyond the sign-in gate (issue #138): CRUD validation, the
 * delete cascades, and the git-style commit feed every dashboard write
 * appends (the ops shape the sync engine's tail path consumes). These
 * tables are the source-of-truth side: writes here intentionally do NOT
 * touch the projected json-cms dataset — they stamp `sourceUpdatedAt` on
 * the binding row and append one commit to the `sourceCommits` feed.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app. */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

type TestConvex = ReturnType<typeof signedIn>;
/** The house lint bans optional chaining — index with an honest failure instead. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`test fixture: nothing at index ${index}`);
  }
  return item;
}

/** Lexicographic string compare (the app's lib target lacks es2023's `toSorted`). */
function byString(a: string, b: string): number {
  return a < b ? -1 : b < a ? 1 : 0;
}

/** A sorted copy — the lib target lacks `toSorted`. */
function sorted<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- a throwaway copy; the lib target lacks toSorted.
  return [...items].sort(compare);
}

/** The sourceCommits feed rows for the primary source, ascending by seq (raw table read — the feed has no public projection). */
async function feedOf(t: TestConvex): Promise<
  Array<{
    foreignCommitId: string;
    message: string;
    ops: Array<{ entryKey: string; op: string; fields: Array<{ name: string }> }>;
    seq: number;
  }>
> {
  return t.run(async (ctx) =>
    sorted(
      await ctx.db
        .query("sourceCommits")
        .withIndex("by_source_seq", (q) => q.eq("source", "restaurantLocations"))
        .collect(),
      (a, b) => a.seq - b.seq,
    ).map((commit) => ({
      foreignCommitId: commit.foreignCommitId,
      message: commit.message,
      ops: commit.ops.map((op) => ({
        entryKey: op.entryKey,
        op: op.op,
        fields: op.fields.map((field) => ({ name: field.name })),
      })),
      seq: commit.seq,
    })),
  );
}

/** The binding row for the primary source, or null (raw read). */
async function bindingRow(t: TestConvex) {
  return t.run(async (ctx) =>
    ctx.db
      .query("datasetBindings")
      .withIndex("by_source", (q) => q.eq("source", "restaurantLocations"))
      .first(),
  );
}

describe("restaurants", () => {
  it("lists by name ascending and refuses duplicates or blank fields", async () => {
    const t = signedIn();
    await t.mutation(api.dashboard.createRestaurant, { cuisine: "Cafe", name: "Zeta" });
    await t.mutation(api.dashboard.createRestaurant, { cuisine: "Bar", name: "Alpha" });
    const rows = await t.query(api.dashboard.listRestaurants, {});
    expect(rows.map((row) => row.name)).toStrictEqual(["Alpha", "Zeta"]);

    await expect(
      t.mutation(api.dashboard.createRestaurant, { cuisine: "Cafe", name: "Alpha" }),
    ).rejects.toThrow(/already exists/);
    await expect(
      t.mutation(api.dashboard.createRestaurant, { cuisine: "  ", name: "Beta" }),
    ).rejects.toThrow(/Name and cuisine are required/);
    // Names are trimmed on the way in.
    await t.mutation(api.dashboard.createRestaurant, { cuisine: "Deli", name: "  Trimmed  " });
    expect((await t.query(api.dashboard.listRestaurants, {})).map((row) => row.name)).toContain(
      "Trimmed",
    );
  });

  it("renames in place, refusing a collision with another row, and stamps the binding as stale", async () => {
    const t = signedIn();
    const a = await t.mutation(api.dashboard.createRestaurant, { cuisine: "Cafe", name: "A" });
    const b = await t.mutation(api.dashboard.createRestaurant, { cuisine: "Bar", name: "B" });
    await expect(
      t.mutation(api.dashboard.updateRestaurant, { cuisine: "Cafe", id: b, name: "A" }),
    ).rejects.toThrow(/already exists/);
    await expect(
      t.mutation(api.dashboard.updateRestaurant, { cuisine: "X", id: b, name: "  " }),
    ).rejects.toThrow(/Name and cuisine are required/);
    await t.mutation(api.dashboard.updateRestaurant, { cuisine: "Bar", id: b, name: "B2" });
    const rows = await t.query(api.dashboard.listRestaurants, {});
    expect(rows.map((row) => [row.name, row.cuisine])).toStrictEqual([
      ["A", "Cafe"],
      ["B2", "Bar"],
    ]);
    // The write stamped the binding's staleness marker — but only when a
    // binding exists (none does yet).
    expect(await bindingRow(t)).toBeNull();
    expect(a).toBeTruthy();
  });
});

describe("locations", () => {
  it("validates required fields and the lat/lng ranges, and refuses duplicate labels", async () => {
    const t = signedIn();
    await expect(
      t.mutation(api.dashboard.createLocation, {
        address: "1 Main",
        city: "TV",
        label: "",
        lat: 30,
        lng: -80,
        state: "TS",
      }),
    ).rejects.toThrow(/Label, address, city, and state are required/);
    await expect(
      t.mutation(api.dashboard.createLocation, {
        address: "1 Main",
        city: "TV",
        label: "L",
        lat: 90.5,
        lng: -80,
        state: "TS",
      }),
    ).rejects.toThrow(/Latitude must be between -90 and 90/);
    await expect(
      t.mutation(api.dashboard.createLocation, {
        address: "1 Main",
        city: "TV",
        label: "L",
        lat: 30,
        lng: -180.5,
        state: "TS",
      }),
    ).rejects.toThrow(/Longitude must be between -180 and 180/);
    await t.mutation(api.dashboard.createLocation, {
      address: "1 Main",
      city: "TV",
      label: "L",
      lat: 30,
      lng: -80,
      state: "TS",
    });
    await expect(
      t.mutation(api.dashboard.createLocation, {
        address: "2 Main",
        city: "TV",
        label: "L",
        lat: 31,
        lng: -81,
        state: "TS",
      }),
    ).rejects.toThrow(/already exists/);
  });
});

/** One restaurant + one location, unlinked — the join fixtures. */
async function fixture(
  t: TestConvex,
): Promise<{ locationId: Id<"locations">; restaurantId: Id<"restaurants"> }> {
  const restaurantId = await t.mutation(api.dashboard.createRestaurant, {
    cuisine: "Cafe",
    name: "Probe",
  });
  const locationId = await t.mutation(api.dashboard.createLocation, {
    address: "1 Main",
    city: "TV",
    label: "L0",
    lat: 30,
    lng: -80,
    state: "TS",
  });
  return { locationId, restaurantId };
}

describe("links (the join table)", () => {
  it("links a pair once, validates the ends and the opened-year range, and feeds the add", async () => {
    const t = signedIn();
    const { locationId, restaurantId } = await fixture(t);
    await expect(
      t.mutation(api.dashboard.createLink, {
        locationId,
        openedYear: 1899,
        restaurantId,
      }),
    ).rejects.toThrow(/Opened year must be between 1900 and 2100/);
    const linkId = await t.mutation(api.dashboard.createLink, {
      locationId,
      openedYear: 2020,
      restaurantId,
    });
    expect(linkId).toBeTruthy();
    await expect(
      t.mutation(api.dashboard.createLink, { locationId, restaurantId }),
    ).rejects.toThrow(/already linked/);
    // A missing end is refused: delete the restaurant, then link again.
    await t.run(async (ctx) => {
      await ctx.db.delete(restaurantId);
    });
    await expect(
      t.mutation(api.dashboard.createLink, { locationId, restaurantId }),
    ).rejects.toThrow(/Pick both a restaurant and a location/);
    const feed = await feedOf(t);
    expect(feed).toStrictEqual([
      {
        foreignCommitId: "restaurantLocations:1",
        message: "Linked Probe ↔ L0",
        ops: [
          {
            entryKey: linkId,
            fields: [
              { name: "address" },
              { name: "city" },
              { name: "cuisine" },
              { name: "label" },
              { name: "lat" },
              { name: "lng" },
              { name: "restaurantName" },
              { name: "state" },
            ],
            op: "add",
          },
        ],
        seq: 1,
      },
    ]);
  });

  it("updates openedYear without a commit (openedYear is not projected)", async () => {
    const t = signedIn();
    const { locationId, restaurantId } = await fixture(t);
    const linkId = await t.mutation(api.dashboard.createLink, {
      locationId,
      openedYear: 2020,
      restaurantId,
    });
    await t.mutation(api.dashboard.updateLink, { id: linkId, openedYear: null });
    await t.mutation(api.dashboard.updateLink, { id: linkId, openedYear: 1999 });
    // Only the link's add commit exists — openedYear is not part of the
    // projection, so no commit is appended for its edits.
    expect(await feedOf(t)).toHaveLength(1);
    const links = await t.query(api.dashboard.listLinks, {});
    expect(at(links, 0).openedYear).toBe(1999);
  });

  it("deleting a link feeds a remove op labeled by the projection", async () => {
    const t = signedIn();
    const { locationId, restaurantId } = await fixture(t);
    const linkId = await t.mutation(api.dashboard.createLink, { locationId, restaurantId });
    await t.mutation(api.dashboard.deleteLink, { id: linkId });
    expect(await t.query(api.dashboard.listLinks, {})).toStrictEqual([]);
    const feed = await feedOf(t);
    const removeCommit = feed[1];
    expect(removeCommit === undefined ? undefined : removeCommit.message).toBe("Unlinked L0");
    const removeOp = removeCommit === undefined ? undefined : removeCommit.ops[0];
    expect(removeOp === undefined ? undefined : removeOp.op).toBe("delete");
    expect(removeOp === undefined ? undefined : removeOp.fields).toStrictEqual([]);
    // Deleting a gone link is refused outright — the raw db delete throws.
    await expect(t.mutation(api.dashboard.deleteLink, { id: linkId })).rejects.toThrow(
      /non-existent/,
    );
    // No commit was appended for the refused delete: add + remove only.
    expect(await feedOf(t)).toHaveLength(2);
  });
});

describe("cascade and feed behavior", () => {
  it("deleting a restaurant cascades its links and feeds one remove per link", async () => {
    const t = signedIn();
    const restaurantId = await t.mutation(api.dashboard.createRestaurant, {
      cuisine: "Cafe",
      name: "Probe",
    });
    const first = await t.mutation(api.dashboard.createLocation, {
      address: "1 Main",
      city: "TV",
      label: "L0",
      lat: 30,
      lng: -80,
      state: "TS",
    });
    const second = await t.mutation(api.dashboard.createLocation, {
      address: "2 Main",
      city: "TV",
      label: "L1",
      lat: 30.1,
      lng: -80.1,
      state: "TS",
    });
    const linkA = await t.mutation(api.dashboard.createLink, {
      locationId: first,
      restaurantId,
    });
    const linkB = await t.mutation(api.dashboard.createLink, {
      locationId: second,
      restaurantId,
    });
    const cascaded = await t.mutation(api.dashboard.deleteRestaurant, { id: restaurantId });
    expect(cascaded).toBe(2);
    expect(await t.query(api.dashboard.listLinks, {})).toStrictEqual([]);
    expect(await t.query(api.dashboard.listRestaurants, {})).toStrictEqual([]);

    const feed = await feedOf(t);
    // Feed order: two link adds, then the delete (one op per cascaded link;
    // the cascade's op order follows the compound index, so compare as sets).
    expect(feed).toHaveLength(3);
    const deleteCommit = feed[2];
    expect(deleteCommit === undefined ? undefined : deleteCommit.message).toBe(
      "Deleted restaurant Probe",
    );
    expect(
      deleteCommit === undefined
        ? []
        : sorted(
            deleteCommit.ops.map((op) => op.entryKey),
            byString,
          ),
    ).toStrictEqual(sorted([linkA, linkB], byString));
    expect(deleteCommit === undefined ? [] : deleteCommit.ops.map((op) => op.op)).toStrictEqual([
      "delete",
      "delete",
    ]);
  });

  it("an update lands as field-level before/after ops, one per joined link, with lat marking geometry changed", async () => {
    const t = signedIn();
    const { locationId, restaurantId } = await fixture(t);
    const linkId = await t.mutation(api.dashboard.createLink, { locationId, restaurantId });
    await t.mutation(api.dashboard.updateLocation, {
      address: "1 Main",
      city: "TV",
      id: locationId,
      label: "L0",
      lat: 31,
      lng: -80,
      state: "TS",
    });
    const feed = await feedOf(t);
    const updateCommit = feed[1];
    expect(updateCommit === undefined ? undefined : updateCommit.seq).toBe(2);
    expect(updateCommit === undefined ? undefined : updateCommit.foreignCommitId).toBe(
      "restaurantLocations:2",
    );
    const updateOp = updateCommit === undefined ? undefined : updateCommit.ops[0];
    expect(updateOp === undefined ? undefined : updateOp.entryKey).toBe(linkId);
    expect(updateOp === undefined ? undefined : updateOp.fields).toStrictEqual([{ name: "lat" }]);
    const raw = await t.run(async (ctx) => {
      const rows = sorted(
        await ctx.db
          .query("sourceCommits")
          .withIndex("by_source_seq", (q) => q.eq("source", "restaurantLocations"))
          .collect(),
        (a, b) => a.seq - b.seq,
      );
      return rows[rows.length - 1];
    });
    const rawOp = raw === undefined ? undefined : raw.ops[0];
    expect(rawOp === undefined ? undefined : rawOp.geometryChanged).toBe(true);
    const rawField = rawOp === undefined ? undefined : rawOp.fields[0];
    expect(rawField === undefined ? undefined : rawField.before).toBe(30);
    expect(rawField === undefined ? undefined : rawField.after).toBe(31);
    // Deleting a location cascades its links silently and appends ONE
    // commit — the delete ops carry the cascaded keys, labeled from the
    // before-snapshot.
    await t.mutation(api.dashboard.deleteLocation, { id: locationId });
    const afterDelete = await feedOf(t);
    expect(afterDelete).toHaveLength(3);
    const removed = at(afterDelete, 2);
    expect(removed.message).toBe("Deleted location L0");
    expect(removed.ops.map((op) => op.op)).toStrictEqual(["delete"]);
  });

  it("every write with a live binding stamps sourceUpdatedAt (the staleness badge)", async () => {
    const t = signedIn();
    const { locationId, restaurantId } = await fixture(t);
    const linkId = await t.mutation(api.dashboard.createLink, { locationId, restaurantId });
    // No binding yet: writes work without a staleness target.
    expect(await bindingRow(t)).toBeNull();

    // Materialize a binding row the way the sync engine does.
    await t.run(async (ctx) => {
      await ctx.db.insert("datasetBindings", {
        schemaId: "projected-dataset-id",
        source: "restaurantLocations",
      });
    });
    await t.mutation(api.dashboard.updateLink, { id: linkId, openedYear: 2000 });
    const binding = await bindingRow(t);
    expect(binding === null ? undefined : binding.sourceUpdatedAt).toBeDefined();
  });
});
