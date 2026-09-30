// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import schema from "./schema";
import {
  DEFAULT_KEEP_VERSIONS,
  VERSION_DIFF_LIMIT,
  diffVersionRows,
  naturalKeyOf,
  previousVersionOf,
  versionRows,
  versionRowsBounded,
  versionsToRetire,
} from "./versioning";
import type { FrozenVersion, VersionRow } from "./versioning";

/** A frozen version doc with only what the selection cores read. */
function version(id: string, frozenAt: number, ref?: string): FrozenVersion {
  return ref === undefined
    ? { _id: id, lineage: { frozenAt } }
    : { _id: id, lineage: { frozenAt, snapshotRef: ref } };
}

function row(key: string, data: Record<string, unknown>): VersionRow {
  return { data, key };
}

/** A runQuery stand-in: ignores the component reference and serves the given entries. */
function ctxServing(entries: Array<{ _id: string; data: unknown }>): {
  runQuery: () => Promise<Array<{ _id: string; data: unknown }>>;
} {
  return { runQuery: async () => entries };
}

/** `count` labeled rows for the bounded-read fixture. */
function rowsOf(count: number): Array<{ _id: string; data: { label: string } }> {
  return Array.from({ length: count }, (_, index) => ({
    _id: `e${index}`,
    data: { label: `L${index}` },
  }));
}

describe("DEFAULT_KEEP_VERSIONS", () => {
  it("is 10 — the default the tag path shipped", () => {
    expect(DEFAULT_KEEP_VERSIONS).toBe(10);
  });
});

describe("versionsToRetire", () => {
  it("keeps the newest keep unpinned versions and retires the surplus", () => {
    const versions = [version("v1", 1, "r1"), version("v2", 2, "r2"), version("v3", 3, "r3")];

    const retired = versionsToRetire(versions, 1, []);

    expect(retired).toStrictEqual([
      { frozenAt: 2, id: "v2" },
      { frozenAt: 1, id: "v1" },
    ]);
  });

  it("never retires a pinned ref, even the oldest", () => {
    const versions = [
      version("v1", 1, "r1"),
      version("v2", 2, "r2"),
      version("v3", 3, "r3"),
      version("v4", 4, "r4"),
    ];

    const retired = versionsToRetire(versions, 2, ["r1"]);

    expect(retired).toStrictEqual([{ frozenAt: 2, id: "v2" }]);
  });

  it("treats a version without a snapshot ref as unpinned", () => {
    const versions = [version("v1", 1), version("v2", 2, "r2"), version("v3", 3, "r3")];

    const retired = versionsToRetire(versions, 1, ["r2"]);

    expect(retired).toStrictEqual([{ frozenAt: 1, id: "v1" }]);
  });

  it("treats a version without lineage as unpinned and oldest", () => {
    const bare: FrozenVersion = { _id: "vBare" };
    const versions = [bare, version("v2", 2, "r2"), version("v3", 3, "r3")];

    const retired = versionsToRetire(versions, 2, []);

    expect(retired).toStrictEqual([{ frozenAt: 0, id: "vBare" }]);
  });

  it("retires nothing while under the keep count", () => {
    const versions = [version("v1", 1, "r1"), version("v2", 2, "r2"), version("v3", 3, "r3")];

    const retired = versionsToRetire(versions, DEFAULT_KEEP_VERSIONS, []);

    expect(retired).toStrictEqual([]);
  });

  it("reads newest by frozenAt, not by list order", () => {
    const versions = [version("v1", 10, "r1"), version("v2", 30, "r2"), version("v3", 20, "r3")];

    const retired = versionsToRetire(versions, 1, []);

    expect(retired).toStrictEqual([
      { frozenAt: 20, id: "v3" },
      { frozenAt: 10, id: "v1" },
    ]);
  });
});

describe("previousVersionOf", () => {
  it("returns undefined for a source's first version", () => {
    const versions = [version("v1", 5, "r1")];

    const previous = previousVersionOf(versions, "v1", 5);

    expect(previous).toBeUndefined();
  });

  it("returns the newest version frozen at or before the target", () => {
    const versions = [version("v1", 10, "r1"), version("v2", 20, "r2"), version("v3", 30, "r3")];

    const previous = previousVersionOf(versions, "v3", 30);

    expect(previous).toStrictEqual({ frozenAt: 20, id: "v2", ref: "r2" });
  });

  it("excludes versions frozen after the target", () => {
    const versions = [version("v1", 10, "r1"), version("v2", 20, "r2")];

    const previous = previousVersionOf(versions, "v1", 10);

    expect(previous).toBeUndefined();
  });

  it("excludes the target itself even against equal freeze times", () => {
    const versions = [version("v1", 5, "r1"), version("v2", 5, "r2")];

    const previous = previousVersionOf(versions, "v2", 5);

    expect(previous).toStrictEqual({ frozenAt: 5, id: "v1", ref: "r1" });
  });
});

describe("diffVersionRows", () => {
  it("adds carry the full after-state", () => {
    const ops = diffVersionRows([], [row("A", { label: "A", lat: 1 })]);

    expect(ops).toStrictEqual([
      {
        entryKey: "A",
        fields: [
          { name: "label", after: "A" },
          { name: "lat", after: 1 },
        ],
        geometryChanged: true,
        op: "add",
      },
    ]);
  });

  it("updates carry only the changed fields with before and after values", () => {
    const ops = diffVersionRows(
      [row("A", { label: "A", lat: 1 })],
      [row("A", { label: "A", lat: 2 })],
    );

    expect(ops).toStrictEqual([
      {
        entryKey: "A",
        fields: [{ name: "lat", before: 1, after: 2 }],
        geometryChanged: true,
        op: "update",
      },
    ]);
  });

  it("rows unchanged between versions produce no ops", () => {
    const ops = diffVersionRows(
      [row("A", { label: "A", lat: 1 })],
      [row("A", { label: "A", lat: 1 })],
    );

    expect(ops).toStrictEqual([]);
  });

  it("only lat/lng updates mark geometry changed", () => {
    const ops = diffVersionRows(
      [row("A", { label: "A", lat: 1 })],
      [row("A", { label: "B", lat: 1 })],
    );

    expect(ops).toStrictEqual([
      {
        entryKey: "A",
        fields: [{ name: "label", before: "A", after: "B" }],
        geometryChanged: false,
        op: "update",
      },
    ]);
  });

  it("deletes carry the before-state's fields", () => {
    const ops = diffVersionRows([row("A", { label: "A" })], []);

    expect(ops).toStrictEqual([
      {
        entryKey: "A",
        fields: [{ name: "label", before: "A" }],
        geometryChanged: false,
        op: "delete",
      },
    ]);
  });

  it("every changed row lands in exactly one op, adds/updates by key order and deletes last", () => {
    const before = [
      row("A", { label: "A" }),
      row("B", { label: "B", lat: 1 }),
      row("C", { label: "C" }),
      row("D", { label: "D" }),
    ];
    const after = [
      row("A", { label: "A" }),
      row("B", { label: "B", lat: 2 }),
      row("E", { label: "E" }),
    ];

    const ops = diffVersionRows(before, after);

    expect(ops.map((op) => [op.op, op.entryKey])).toStrictEqual([
      ["update", "B"],
      ["add", "E"],
      ["delete", "C"],
      ["delete", "D"],
    ]);
  });
});

describe("versionRows", () => {
  it("drops rows whose data is null or not an object", async () => {
    const entries = [
      { _id: "e1", data: null },
      { _id: "e2", data: "text" },
      { _id: "e3", data: { label: "L" } },
    ];

    const rows = await versionRows(ctxServing(entries), "s1");

    expect(rows).toStrictEqual([{ data: { label: "L" }, key: "L" }]);
  });

  it("keys rows by their label", async () => {
    const entries = [{ _id: "e1", data: { label: "Red Lobster", lat: 36.9 } }];

    const rows = await versionRows(ctxServing(entries), "s1");

    expect(rows).toStrictEqual([{ data: { label: "Red Lobster", lat: 36.9 }, key: "Red Lobster" }]);
  });

  it("falls back to the entry id without a string label or name", async () => {
    const entries = [{ _id: "e9", data: { count: 2 } }];

    const rows = await versionRows(ctxServing(entries), "s1");

    expect(rows).toStrictEqual([{ data: { count: 2 }, key: "e9" }]);
  });

  it("falls back to the name field, ignoring non-string labels", async () => {
    const entries = [{ _id: "e8", data: { label: 7, name: "N" } }];

    const rows = await versionRows(ctxServing(entries), "s1");

    expect(rows).toStrictEqual([{ data: { label: 7, name: "N" }, key: "N" }]);
  });
});

describe("versionRowsBounded", () => {
  it("flags truncated only past the diff limit, and caps the rows at the limit (#126)", async () => {
    // Exactly at the limit is NOT truncated — the extra read makes the flag exact.
    const atLimit = await versionRowsBounded(ctxServing(rowsOf(VERSION_DIFF_LIMIT)), "s1");
    expect(atLimit.truncated).toBe(false);
    expect(atLimit.rows).toHaveLength(VERSION_DIFF_LIMIT);

    // One row past it is.
    const overLimit = await versionRowsBounded(ctxServing(rowsOf(VERSION_DIFF_LIMIT + 1)), "s1");
    expect(overLimit.truncated).toBe(true);
    expect(overLimit.rows).toHaveLength(VERSION_DIFF_LIMIT);

    // Well under, the plain shape the projections know.
    const small = await versionRowsBounded(ctxServing(rowsOf(3)), "s1");
    expect(small.truncated).toBe(false);
    expect(small.rows.map((entry) => entry.key)).toStrictEqual(["L0", "L1", "L2"]);
  });
});

describe("naturalKeyOf", () => {
  it("prefers the label field", () => {
    expect(naturalKeyOf({ label: "L", name: "N" })).toBe("L");
  });

  it("falls back to the name field, ignoring non-string labels", () => {
    expect(naturalKeyOf({ label: 3, name: "N" })).toBe("N");
  });

  it("returns undefined without a string label or name", () => {
    expect(naturalKeyOf({ label: 3, other: "x" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// freezeVersion and the shared Convex cores, on a real (test) backend —
// characterization coverage for issue #138 (also the "freezeVersion
// convex-test" line of #126's acceptance criteria). The tag path (tags.ts)
// and the materialized publish both drive these; here the cores are driven
// directly, with chunk blobs planted in the component's storage exactly
// where the transports (snapshot file ingest, publish registerChunk) leave
// them. The pure selection cores above pin the decisions; these pin the
// reads, writes, and gate interactions around them.
// ---------------------------------------------------------------------------

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app (the consumption.test.ts setup). */
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

/** Runs the frozen row's import workflow (and every other scheduled function) to completion. */
async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** A geospatial live dataset with the given labeled Point rows (the freeze fixture's source). */
async function liveSource(
  t: TestConvex,
  rows: Array<{ label: string; lat: number; lng: number }>,
): Promise<string> {
  const schemaId = await t.mutation(api.schemas.create, {
    geometryType: "Point",
    kind: "geospatial",
    schema: {
      properties: {
        label: { title: "Label", type: "string" },
        lat: { title: "Latitude", type: "number" },
        lng: { title: "Longitude", type: "number" },
      },
      required: ["label"],
      title: "Live locations",
      type: "object",
    },
  });
  for (const point of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one write per row keeps ordering visible in assertions.
    await t.mutation(api.entries.create, {
      data: { label: point.label, lat: point.lat, lng: point.lng },
      geometry: JSON.stringify({ coordinates: [point.lng, point.lat], type: "Point" }),
      schemaId,
    });
  }
  return schemaId;
}

/** One chunk blob holding `rows` as {data, geometry} projection rows, planted in the COMPONENT's storage (the publish.test.ts helper). */
async function chunkFor(
  t: TestConvex,
  rows: Array<{ data: Record<string, unknown>; geometry?: unknown }>,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  return t.action(components.jsonCms.host_support.storeTestBlob, { bytes: bytes.buffer });
}

/** Freezes one ref of `sourceSchemaId` from the given rows (the tag-ingest call shape). */
async function freeze(
  t: TestConvex,
  options: {
    label: string;
    ref: string;
    rows: Array<{ data: Record<string, unknown>; geometry?: unknown }>;
    sourceSchemaId: string;
  },
): Promise<{ alreadyFrozen: boolean; importId?: string; schemaId: string }> {
  const storageId = await chunkFor(t, options.rows);
  return t.run(async (ctx) =>
    ctx.runMutation(internal.versioning.freezeVersion, {
      boundWrite: "tag-ingest",
      chunkStorageIds: [storageId],
      label: options.label,
      ref: options.ref,
      sourceSchemaId: options.sourceSchemaId,
      total: options.rows.length,
    }),
  );
}

/** The frozen versions of one source, newest first (the tag path's light projection). */
async function versionsOf(t: TestConvex, sourceSchemaId: string) {
  return t.query(api.tags.listVersions, { sourceSchemaId });
}

/** The stored sequential deltas for one source (raw table read — no public projection exists). */
async function deltasFor(t: TestConvex, sourceSchemaId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("tagDeltas")
      .withIndex("by_source", (q) => q.eq("sourceSchemaId", sourceSchemaId))
      .collect(),
  );
}

/** The house lint bans optional chaining — narrow the light projection's optional lineage ref. */
/** Lexicographic string compare (the app's lib target lacks es2023's `toSorted`). */
function byString(a: string, b: string): number {
  return a < b ? -1 : b < a ? 1 : 0;
}

/** A sorted copy — the lib target lacks `toSorted`. */
function sorted<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- a throwaway copy; the lib target lacks toSorted.
  return [...items].sort(compare);
}

function refOf(frozen: { lineage?: { snapshotRef?: string } }): string | undefined {
  return frozen.lineage === undefined ? undefined : frozen.lineage.snapshotRef;
}

describe("freezeVersion (Convex core, #126 AC / #138)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("freezes a point-in-time copy: lineage, its own rows, the source's filing, and an import that lands", async () => {
    const t = signedIn();
    const sourceSchemaId = await liveSource(t, [
      { label: "A", lat: 30, lng: -80 },
      { label: "B", lat: 31, lng: -81 },
    ]);
    const collectionId = await t.mutation(api.collections.create, {
      description: "Filing",
      name: "Field sites",
    });
    await t.mutation(api.collections.addSchemaToCollection, {
      collectionId,
      schemaId: sourceSchemaId,
    });

    const frozen = await freeze(t, {
      label: "v1",
      ref: "snap_v1",
      rows: [
        {
          data: { label: "A", lat: 30, lng: -80 },
          geometry: { coordinates: [-80, 30], type: "Point" },
        },
        {
          data: { label: "B", lat: 31, lng: -81 },
          geometry: { coordinates: [-81, 31], type: "Point" },
        },
      ],
      sourceSchemaId,
    });
    expect(frozen.alreadyFrozen).toBe(false);
    await drainScheduled(t);

    const versions = await versionsOf(t, sourceSchemaId);
    expect(versions).toHaveLength(1);
    const frozenRow = versions[0];
    expect(frozenRow === undefined ? undefined : frozenRow.schemaId).toBe(frozen.schemaId);
    expect(frozenRow === undefined ? undefined : frozenRow.title).toBe("Live locations");
    expect(frozenRow === undefined ? undefined : frozenRow.entryCount).toBe(2);
    const lineage = frozenRow === undefined ? undefined : frozenRow.lineage;
    expect(lineage === undefined ? undefined : lineage.versionLabel).toBe("v1");
    expect(lineage === undefined ? undefined : lineage.snapshotRef).toBe("snap_v1");
    expect(lineage === undefined ? undefined : lineage.sourceSchemaId).toBe(sourceSchemaId);
    expect(typeof (lineage === undefined ? undefined : lineage.frozenAt)).toBe("number");

    // The copy's rows are the chunk's point-in-time state, keyed by label.
    expect(await t.query(api.tags.versionEntries, { schemaId: frozen.schemaId })).toStrictEqual([
      { data: { label: "A", lat: 30, lng: -80 }, key: "A" },
      { data: { label: "B", lat: 31, lng: -81 }, key: "B" },
    ]);

    // The frozen row rides the source's collections.
    const collections = await t.query(api.collections.listCollectionsBySchema, {
      schemaId: frozen.schemaId,
    });
    expect(collections.map((collection) => collection._id)).toContain(collectionId);
  });

  it("never freezes a ref twice — including against a different source (the global by-ref lookup)", async () => {
    const t = signedIn();
    const sourceA = await liveSource(t, [{ label: "A", lat: 30, lng: -80 }]);
    const sourceB = await liveSource(t, [{ label: "B", lat: 31, lng: -81 }]);

    const first = await freeze(t, {
      label: "v1",
      ref: "snap_shared",
      rows: [{ data: { label: "A" }, geometry: { coordinates: [-80, 30], type: "Point" } }],
      sourceSchemaId: sourceA,
    });
    await drainScheduled(t);

    // The same ref naming a DIFFERENT live dataset resolves to the existing
    // frozen row — a re-bind to a recreated dataset cannot fork versions.
    const second = await freeze(t, {
      label: "v1",
      ref: "snap_shared",
      rows: [{ data: { label: "B" }, geometry: { coordinates: [-81, 31], type: "Point" } }],
      sourceSchemaId: sourceB,
    });
    expect(second.alreadyFrozen).toBe(true);
    expect(second.schemaId).toBe(first.schemaId);
    expect(second.importId).toBeUndefined();
    expect(await versionsOf(t, sourceA)).toHaveLength(1);
    // The second source never gained a version of its own.
    expect(await versionsOf(t, sourceB)).toStrictEqual([]);
  });

  it("refuses honestly when the live source no longer exists", async () => {
    const t = signedIn();
    const sourceSchemaId = await liveSource(t, []);
    // Retire nothing — point the freeze at a well-formed id of a dataset
    // that was never created by deleting the fixture through the component
    // with the host's retirement attestation.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId: sourceSchemaId,
      });
    });
    await expect(
      freeze(t, { label: "v1", ref: "snap_gone", rows: [], sourceSchemaId }),
    ).rejects.toThrow(/no longer exists/);
  });

  it("the frozen copy is read-only through the app's write gate", async () => {
    const t = signedIn();
    const sourceSchemaId = await liveSource(t, [{ label: "A", lat: 30, lng: -80 }]);
    const frozen = await freeze(t, {
      label: "v1",
      ref: "snap_v1",
      rows: [
        {
          data: { label: "A", lat: 30, lng: -80 },
          geometry: { coordinates: [-80, 30], type: "Point" },
        },
      ],
      sourceSchemaId,
    });
    await drainScheduled(t);
    await expect(
      t.mutation(api.entries.create, { data: { label: "X" }, schemaId: frozen.schemaId }),
    ).rejects.toThrow(/read-only/);
  });

  it("recordVersionDelta stores the sequential delta from the second version on, and nothing for the first", async () => {
    const t = signedIn();
    const sourceSchemaId = await liveSource(t, [{ label: "A", lat: 30, lng: -80 }]);
    const v1 = await freeze(t, {
      label: "v1",
      ref: "snap_v1",
      rows: [
        {
          data: { label: "A", lat: 30, lng: -80 },
          geometry: { coordinates: [-80, 30], type: "Point" },
        },
      ],
      sourceSchemaId,
    });
    await drainScheduled(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.versioning.recordVersionDelta, {
        sourceSchemaId,
        toRef: "snap_v1",
        toSchemaId: v1.schemaId,
      }),
    );
    // The source's first version has nothing to diff against.
    expect(await deltasFor(t, sourceSchemaId)).toStrictEqual([]);

    const v2 = await freeze(t, {
      label: "v2",
      ref: "snap_v2",
      rows: [
        {
          data: { label: "A", lat: 32, lng: -80 },
          geometry: { coordinates: [-80, 32], type: "Point" },
        },
        {
          data: { label: "C", lat: 33, lng: -83 },
          geometry: { coordinates: [-83, 33], type: "Point" },
        },
      ],
      sourceSchemaId,
    });
    await drainScheduled(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.versioning.recordVersionDelta, {
        sourceSchemaId,
        toRef: "snap_v2",
        toSchemaId: v2.schemaId,
      }),
    );
    const deltas = await deltasFor(t, sourceSchemaId);
    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    expect(delta === undefined ? undefined : delta.fromRef).toBe("snap_v1");
    expect(delta === undefined ? undefined : delta.toRef).toBe("snap_v2");
    const ops = delta === undefined ? [] : delta.ops;
    expect(ops.map((op) => [op.op, op.entryKey])).toStrictEqual([
      ["update", "A"],
      ["add", "C"],
    ]);
    const updateOp = ops.find((op) => op.op === "update");
    expect(updateOp === undefined ? undefined : updateOp.fields).toStrictEqual([
      { after: 32, before: 30, name: "lat" },
    ]);
  });

  it("enforceRetention keeps the newest keep and never retires a pinned ref", async () => {
    const t = signedIn();
    const sourceSchemaId = await liveSource(t, [{ label: "A", lat: 30, lng: -80 }]);
    const refs = ["snap_v1", "snap_v2", "snap_v3"];
    const frozenIds: string[] = [];
    for (const ref of refs) {
      // oxlint-disable-next-line no-await-in-loop -- ordered freezes; each version's identity feeds the next assertion.
      const frozen = await freeze(t, {
        label: ref,
        ref,
        rows: [
          {
            data: { label: "A", lat: 30, lng: -80 },
            geometry: { coordinates: [-80, 30], type: "Point" },
          },
        ],
        sourceSchemaId,
      });
      // oxlint-disable-next-line no-await-in-loop
      frozenIds.push(frozen.schemaId);
    }
    expect(await versionsOf(t, sourceSchemaId)).toHaveLength(3);

    // keep 2: the oldest retires.
    let retired = await t.run(async (ctx) =>
      ctx.runMutation(internal.versioning.enforceRetention, {
        keep: 2,
        pinnedRefs: [],
        sourceSchemaId,
      }),
    );
    expect(retired).toBe(1);
    const afterFirst = await versionsOf(t, sourceSchemaId);
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst.map((row) => row.schemaId)).not.toContain(frozenIds[0]);

    // A pinned ref is exempt even when it is the oldest survivor.
    retired = await t.run(async (ctx) =>
      ctx.runMutation(internal.versioning.enforceRetention, {
        keep: 1,
        pinnedRefs: ["snap_v2"],
        sourceSchemaId,
      }),
    );
    expect(retired).toBe(0);
    const survivors = await versionsOf(t, sourceSchemaId);
    // Sorted: under fake timers every freeze shares one frozenAt, so the
    // listing's order among equals is not part of the contract.
    expect(
      sorted(
        survivors.map((row) => refOf(row) ?? ""),
        byString,
      ),
    ).toStrictEqual(["snap_v2", "snap_v3"]);
    expect(frozenIds).toHaveLength(3);
    expect(DEFAULT_KEEP_VERSIONS).toBe(10);
  });
});
