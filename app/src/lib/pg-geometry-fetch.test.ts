import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEOMETRY_PAGE_ROWS,
  GEOMETRY_PAGE_PAYLOAD_BYTES,
  geometryTakeRowsFor,
} from "./pg-geometry-fetch";

describe("geometryTakeRowsFor — the build fetch's take sizing (#183)", () => {
  it("keeps the default width for pre-backfill datasets (null/zero)", () => {
    expect(geometryTakeRowsFor(null)).toBe(DEFAULT_GEOMETRY_PAGE_ROWS);
    expect(geometryTakeRowsFor(0)).toBe(DEFAULT_GEOMETRY_PAGE_ROWS);
  });

  it("sizes the take to the payload budget for big rows", () => {
    // A 3.3 MB-per-row dataset pages 4 rows at a time (the FY22 shape).
    expect(geometryTakeRowsFor(3_319_870)).toBe(
      Math.floor(GEOMETRY_PAGE_PAYLOAD_BYTES / 3_319_870),
    );
    // A giant single row still pages ONE row per read.
    expect(geometryTakeRowsFor(GEOMETRY_PAGE_PAYLOAD_BYTES * 4)).toBe(1);
  });

  it("caps the take at the feed's default width for small rows", () => {
    expect(geometryTakeRowsFor(59)).toBe(DEFAULT_GEOMETRY_PAGE_ROWS);
  });
});
