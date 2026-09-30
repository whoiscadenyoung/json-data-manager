// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The bound-source descriptor layer (sources.ts) — characterization tests
 * (issue #138): pin the CURRENT behavior the sync engine (sync.ts) and the
 * tag ingest (tags.ts) both drive, so #127's fixes can prove they preserve
 * it. Covers the registry lookups, both shipped descriptors' state readers
 * and commit feeds over seeded host tables, the geometry builder, and the
 * chunk splitter the snapshot/sync transports share.
 *
 * The 1,000-row read cap in `listRows` is a known defect (#127 defect 1 —
 * a full pass then sweeps rows the capped read never saw); it is exercised
 * end-to-end in sync.test.ts as an `it.fails` against the intended
 * "keeps every row" behavior. Here only sub-cap behavior is pinned.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { chunkByJsonBytes, getSource, SOURCES, type CommitFeedEntry } from "./sources";

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
type QueryCtx = Parameters<Parameters<TestConvex["run"]>[0]>[0];
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

/** One restaurant + `count` locations, each linked — the projection's fixture. Returns the join-table ids (the projection's keys). */
async function seedLinks(t: TestConvex, count: number): Promise<Array<Id<"restaurantLocations">>> {
  return t.run(async (ctx) => {
    const restaurantId = await ctx.db.insert("restaurants", { cuisine: "Cafe", name: "Probe" });
    const linkIds: Array<Id<"restaurantLocations">> = [];
    for (let index = 0; index < count; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      const locationId = await ctx.db.insert("locations", {
        address: `${index} Main St`,
        city: "Testville",
        label: `L${index}`,
        lat: 30 + index * 0.01,
        lng: -80 - index * 0.01,
        state: "TS",
      });
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      const linkId = await ctx.db.insert("restaurantLocations", { locationId, restaurantId });
      linkIds.push(linkId);
    }
    return linkIds;
  });
}

/** Lands one commit on the stand-in feed. */
async function seedCommit(
  t: TestConvex,
  commit: { foreignCommitId: string; ops: CommitFeedEntry["ops"]; seq: number },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("sourceCommits", {
      at: 1000,
      foreignCommitId: commit.foreignCommitId,
      message: `commit ${commit.seq}`,
      ops: commit.ops,
      seq: commit.seq,
      source: "restaurantLocations",
    });
  });
}

describe("the source registry", () => {
  it("carries exactly the two shipped descriptors", () => {
    expect(sorted(Object.keys(SOURCES), byString)).toStrictEqual([
      "restaurantLocations",
      "restaurants",
    ]);
  });

  it("resolves a source by key", () => {
    expect(getSource("restaurantLocations").key).toBe("restaurantLocations");
    expect(getSource("restaurants").key).toBe("restaurants");
  });

  it("rejects an unknown key", () => {
    expect(() => getSource("nope")).toThrow(/Unknown bound source: nope/);
  });

  it("the locations descriptor declares the join mapping and the shared dataset shape", () => {
    const source = getSource("restaurantLocations");
    expect(source.mapping.entryKey).toBe("restaurantLocations._id");
    expect(source.mapping.geometry).toStrictEqual({
      kind: "latLng",
      lat: "locations.lat",
      lng: "locations.lng",
    });
    expect(source.dataset.kind).toBe("geospatial");
    expect(source.dataset.geometryType).toBe("Point");
    expect(source.dataset.title).toBe("Restaurant locations");
  });

  it("the restaurants descriptor is the non-geospatial control: no feed, no geometry", () => {
    const source = getSource("restaurants");
    expect(source.dataset.kind).toBe("standard");
    expect(source.dataset.geometryType).toBeUndefined();
    expect(source.mapping.geometry).toBeUndefined();
    // No commit feed → sync for this source always takes the full-state path.
    expect(source.commitsSince === undefined).toBe(true);
    expect(source.newestCommit === undefined).toBe(true);
    expect(source.buildGeometry === undefined).toBe(true);
  });
});

describe("restaurantLocations.listRows (the §8.1 state reader)", () => {
  it("joins the three tables into labeled Point rows keyed by the link id", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 2);
    const rows = await t.run(async (ctx) => getSource("restaurantLocations").listRows(ctx));
    expect(rows).toStrictEqual([
      {
        data: {
          address: "0 Main St",
          city: "Testville",
          cuisine: "Cafe",
          label: "L0",
          lat: 30,
          lng: -80,
          restaurantName: "Probe",
          state: "TS",
        },
        geometry: { coordinates: [-80, 30], type: "Point" },
        key: linkIds[0],
      },
      {
        data: {
          address: "1 Main St",
          city: "Testville",
          cuisine: "Cafe",
          label: "L1",
          lat: 30.01,
          lng: -80.01,
          restaurantName: "Probe",
          state: "TS",
        },
        geometry: { coordinates: [-80.01, 30.01], type: "Point" },
        key: linkIds[1],
      },
    ]);
  });

  it("filters a dangling join row whose location was deleted", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 2);
    await t.run(async (ctx) => {
      const link = await ctx.db.get(linkIds[1] ?? null);
      if (link === null) {
        throw new Error("fixture link vanished");
      }
      await ctx.db.delete(link.locationId);
    });
    const rows = await t.run(async (ctx) => getSource("restaurantLocations").listRows(ctx));
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).key).toBe(linkIds[0]);
  });
});

describe("restaurantLocations commit feed (the §8.2 reader)", () => {
  it("answers null for an empty feed and the newest entry otherwise", async () => {
    const t = signedIn();
    const newestOf = async (ctx: QueryCtx) => {
      const source = getSource("restaurantLocations");
      return source.newestCommit === undefined ? null : source.newestCommit(ctx);
    };
    expect(await t.run(newestOf)).toBeNull();
    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:1",
      ops: [],
      seq: 1,
    });
    await seedCommit(t, {
      foreignCommitId: "restaurantLocations:2",
      ops: [
        {
          entryKey: "link-1",
          fields: [{ after: "B", name: "label" }],
          geometryChanged: false,
          op: "update",
        },
      ],
      seq: 2,
    });
    const newest = await t.run(newestOf);
    expect(newest === null ? undefined : newest.foreignCommitId).toBe("restaurantLocations:2");
    expect(newest === null ? undefined : newest.seq).toBe(2);
  });

  it("returns commits after sinceSeq, ascending, without the baseline", async () => {
    const t = signedIn();
    for (const seq of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
      await seedCommit(t, { foreignCommitId: `restaurantLocations:${seq}`, ops: [], seq });
    }
    const tail = await t.run(async (ctx) => {
      const source = getSource("restaurantLocations");
      return source.commitsSince === undefined ? [] : source.commitsSince(ctx, 1);
    });
    expect(tail.map((commit) => commit.seq)).toStrictEqual([2, 3]);
    // The feed's row shape: message and at ride along with the ops.
    expect(at(tail, 0).message).toBe("commit 2");
    expect(at(tail, 0).at).toBe(1000);
  });
});

describe("restaurantLocations.buildGeometry", () => {
  it("builds a Point from [lng, lat]", () => {
    const source = getSource("restaurantLocations");
    expect(
      source.buildGeometry === undefined ? null : source.buildGeometry({ lat: 31, lng: -81 }),
    ).toStrictEqual({ coordinates: [-81, 31], type: "Point" });
  });

  it("answers null when lat or lng is missing or non-numeric", () => {
    const source = getSource("restaurantLocations");
    expect(
      source.buildGeometry === undefined ? null : source.buildGeometry({ lat: 31 }),
    ).toBeNull();
    expect(
      source.buildGeometry === undefined ? null : source.buildGeometry({ lat: "31", lng: -81 }),
    ).toBeNull();
  });
});

describe("chunkByJsonBytes (the shared transport splitter)", () => {
  function item(label: string): { data: { label: string } } {
    return { data: { label } };
  }

  it("answers [] for no items", () => {
    expect(chunkByJsonBytes([])).toStrictEqual([]);
  });

  it("keeps a single item whole even over the byte limit", () => {
    const big = item("x".repeat(1000));
    expect(chunkByJsonBytes([big], 2, 10)).toStrictEqual([[big]]);
  });

  it("splits at the row limit", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(chunkByJsonBytes(items, 2, 1_000_000).map((chunk) => chunk.length)).toStrictEqual([
      2, 1,
    ]);
  });

  it("splits when the next item would pass the byte limit", () => {
    const items = [item("aaaa"), item("bb"), item("cc")];
    // `{"data":{"label":"aaaa"}}` is 25 bytes; + 23 for the second is exactly
    // 48 (still allowed); the third would pass it → chunk before it.
    const chunks = chunkByJsonBytes(items, 100, 48);
    expect(chunks.map((chunk) => chunk.length)).toStrictEqual([2, 1]);
  });

  it("reads items back identically after a split (JSON round-trip contract)", () => {
    const items = Array.from({ length: 7 }, (_, index) => item(`row-${index}`));
    const chunks = chunkByJsonBytes(items, 3, 1_000_000);
    expect(chunks.flat()).toStrictEqual(items);
  });
});

describe("readSourceRows (the sync engine's bridge over the descriptor)", () => {
  it("serves the projection rows through the internal query", async () => {
    const t = signedIn();
    const linkIds = await seedLinks(t, 1);
    const rows = await t.run(async (ctx) =>
      ctx.runQuery(internal.sync.readSourceRows, { source: "restaurantLocations" }),
    );
    expect(rows).toHaveLength(1);
    expect(at(rows, 0).key).toBe(linkIds[0]);
  });
});
