import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEEP_VERSIONS,
  diffVersionRows,
  naturalKeyOf,
  previousVersionOf,
  versionRows,
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