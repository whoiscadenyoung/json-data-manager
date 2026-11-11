import type { Step } from "@caden/data-core/views";
import { describe, expect, it } from "vitest";

import { liveRowsToEntries, searchLiveEntries } from "./live-rows";
import { assertLiveAllowed, isSpatialStep, LiveRefusedError, spatialSteps } from "./spatial";

const filterStep: Step = { kind: "filter", where: { op: "isNotEmpty", field: "name" } as never };

describe("isSpatialStep", () => {
  it("is false for every current step kind", () => {
    const kinds: Step[] = [
      filterStep,
      { kind: "groupBy", by: [], measures: [] },
      { kind: "select", fields: [] },
      { kind: "sql", query: "select 1" },
    ];
    for (const step of kinds) {
      expect(isSpatialStep(step)).toBe(false);
    }
  });

  it("refuses live when a (stub) spatial kind is present", () => {
    const stub = (step: Step): boolean => (step.kind as string) === "stub-spatial";
    const spatial = { kind: "stub-spatial" } as unknown as Step;
    expect(spatialSteps({ steps: [filterStep, spatial] }, stub)).toStrictEqual([spatial]);
    expect(() => {
      assertLiveAllowed({ steps: [filterStep, spatial] }, stub);
    }).toThrow(LiveRefusedError);
    expect(() => {
      assertLiveAllowed({ steps: [filterStep] }, stub);
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
});
