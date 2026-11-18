import type { ViewNode } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { liveRowByEntryId, liveRowsToEntries, searchLiveEntries } from "./live-rows";
import { assertLiveAllowed, isSpatialStep, LiveRefusedError, spatialSteps } from "./spatial";

const filterNode: ViewNode = {
  kind: "filter",
  from: "a",
  where: { op: "isNotEmpty", field: "name" } as never,
};

describe("isSpatialStep", () => {
  it("is false for every current node kind", () => {
    const kinds: ViewNode[] = [
      filterNode,
      { kind: "groupBy", from: "a", by: [], measures: [] },
      { kind: "columns", from: "a", edits: [] },
      { kind: "sql", from: "a", query: "select 1" },
    ];
    for (const node of kinds) {
      expect(isSpatialStep(node)).toBe(false);
    }
  });

  it("refuses live when a (stub) spatial kind is present", () => {
    const stub = (node: ViewNode): boolean => (node.kind as string) === "stub-spatial";
    const spatial = { kind: "stub-spatial" } as unknown as ViewNode;
    expect(spatialSteps({ nodes: { a: filterNode, b: spatial } }, stub)).toStrictEqual([spatial]);
    expect(() => {
      assertLiveAllowed({ nodes: { a: filterNode, b: spatial } }, stub);
    }).toThrow(LiveRefusedError);
    expect(() => {
      assertLiveAllowed({ nodes: { a: filterNode } }, stub);
    }).not.toThrow();
  });
});

describe("live rows on the client", () => {
  const wire = [
    { row_id: "a", d: { name: "Kansas", n: 3 }, geom: { type: "Point", coordinates: [1, 2] } },
    { row_id: "a", d: { name: "Kansas", n: 1 }, geom: null },
    { row_id: "b", d: { name: "Ohio", n: 10 }, geom: null },
  ];

  it("derives stable, unique entry ids (fan-out repeats a row id)", () => {
    const entries = liveRowsToEntries("v1", wire);
    expect(entries.map((e) => e.id)).toStrictEqual(["live:a", "live:a:2", "live:b"]);
    expect(entries.map((e) => e.geometryType)).toStrictEqual(["Point", null, null]);
  });

  it("searches, filters and sorts the capped result", () => {
    const entries = liveRowsToEntries("v1", wire);
    expect(searchLiveEntries(entries, { query: "ohio" }).rows).toHaveLength(1);
    expect(
      searchLiveEntries(entries, { filters: [{ key: "n", op: "gte", value: 3 }] }).rows.map(
        (e) => (e.data as { n: number }).n,
      ),
    ).toStrictEqual([3, 10]);
    expect(
      searchLiveEntries(entries, { sort: { key: "n", dir: "desc" } }).rows.map(
        (e) => (e.data as { n: number }).n,
      ),
    ).toStrictEqual([10, 3, 1]);
    expect(searchLiveEntries(entries, {}).nextCursor).toBeNull();
  });

  it("resolves a derived live id back to its row (#331)", () => {
    const wire = [
      { row_id: "r1", d: { n: 1 } },
      { row_id: "r2", d: { n: 2 } },
      { row_id: "r1", d: { n: 3 } },
    ];
    expect(liveRowByEntryId(wire, "live:r1")).toStrictEqual({ data: { n: 1 } });
    expect(liveRowByEntryId(wire, "live:r1:2")).toStrictEqual({ data: { n: 3 } });
    expect(liveRowByEntryId(wire, "live:r2")).toStrictEqual({ data: { n: 2 } });
    expect(liveRowByEntryId(wire, "live:gone")).toBeUndefined();
    expect(liveRowByEntryId(wire, "entry-3")).toBeUndefined();
  });
});
