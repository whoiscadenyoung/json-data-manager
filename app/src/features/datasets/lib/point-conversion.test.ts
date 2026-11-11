import { describe, expect, it } from "vitest";

import { columnsOfRows, planPointConversion, skippedSummary } from "./point-conversion";

const rows = [
  { data: { Latitude: 39.1, Longitude: -94.6, Name: "A" }, id: "a" },
  { data: { Latitude: " 38.6 ", Longitude: "-90.2", Name: "B" }, id: "b" },
  { data: { Latitude: "", Longitude: "", Name: "C" }, id: "c" },
  { data: { Name: "D" }, id: "d" },
  { data: { Latitude: "north", Longitude: "-90", Name: "E" }, id: "e" },
  { data: { Latitude: 95, Longitude: 10, Name: "F" }, id: "f" },
  { data: "not an object", id: "g" },
];

describe("planPointConversion", () => {
  it("builds lon/lat points and counts why the rest stay plain", () => {
    const plan = planPointConversion(rows, "Latitude", "Longitude");
    expect(plan.points).toStrictEqual([
      { geometry: { coordinates: [-94.6, 39.1], type: "Point" }, id: "a" },
      { geometry: { coordinates: [-90.2, 38.6], type: "Point" }, id: "b" },
    ]);
    expect(plan).toMatchObject({ missing: 3, notNumbers: 1, outOfRange: 1 });
  });
});

describe("skippedSummary", () => {
  it("describes the skipped rows", () => {
    expect(skippedSummary(planPointConversion(rows, "Latitude", "Longitude"))).toBe(
      "3 have no coordinates, 1 isn't a number, 1 is out of range",
    );
    expect(skippedSummary({ missing: 0, notNumbers: 0, outOfRange: 0, points: [] })).toBe("");
  });
});

describe("columnsOfRows", () => {
  it("lists columns in first-seen order", () => {
    expect(columnsOfRows(rows)).toStrictEqual(["Latitude", "Longitude", "Name"]);
  });
});
