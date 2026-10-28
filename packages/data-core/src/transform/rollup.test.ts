import { describe, expect, it } from "vitest";

import { applyRollup } from "./rollup.js";
import type { RollupOperation } from "./spec.js";

// The PoC join table (app/convex/schema.ts restaurantLocations:
// locationId / openedYear / restaurantId) — the issue's demo domain.
const restaurantLocations = [
  { restaurantId: "rest-1", locationId: "loc-1", openedYear: 2019 },
  { restaurantId: "rest-1", locationId: "loc-2", openedYear: 2021 },
  { restaurantId: "rest-2", locationId: "loc-3", openedYear: 2020 },
  { restaurantId: "rest-2", locationId: "loc-4", openedYear: 2019 },
];

function rollupOp(overrides?: Partial<RollupOperation>): RollupOperation {
  return {
    kind: "rollup",
    groupBy: ["restaurantId"],
    measures: [{ alias: "locationCount", fn: "count" }],
    ...overrides,
  };
}

describe("applyRollup — grouping keys via 0.4's normalizeKey", () => {
  it("groups by ONE OR MORE key columns (issue decision 1)", () => {
    const { rows } = applyRollup(
      rollupOp({
        groupBy: ["restaurantId", "openedYear"],
        measures: [{ alias: "n", fn: "count" }],
      }),
      restaurantLocations,
    );
    expect(rows).toStrictEqual([
      { restaurantId: "rest-1", openedYear: 2019, "rollup.n": 1 },
      { restaurantId: "rest-1", openedYear: 2021, "rollup.n": 1 },
      { restaurantId: "rest-2", openedYear: 2020, "rollup.n": 1 },
      { restaurantId: "rest-2", openedYear: 2019, "rollup.n": 1 },
    ]);
  });

  it("joins number and differently-typed string forms of one key into one group", () => {
    const rowsIn = [
        { restaurantId: 1, locationId: "loc-1" },
        { restaurantId: "1", locationId: "loc-2" },
        { restaurantId: " 1 ", locationId: "loc-3" },
      ],
      { rows, diagnostics } = applyRollup(rollupOp(), rowsIn);
    expect(diagnostics.groups).toBe(1);
    expect(rows).toStrictEqual([{ restaurantId: 1, "rollup.locationCount": 3 }]);
  });

  it('never numeric-normalizes a string key: "007" and number 7 stay distinct groups', () => {
    const rowsIn = [
        { restaurantId: "007", locationId: "loc-1" },
        { restaurantId: 7, locationId: "loc-2" },
      ],
      { rows } = applyRollup(rollupOp(), rowsIn);
    expect(rows).toHaveLength(2);
  });

  it("case-folds string keys, so Aldine and aldine form one group — pinned because it is surprising", () => {
    const rowsIn = [
        { restaurantId: "Aldine", locationId: "loc-1" },
        { restaurantId: "aldine", locationId: "loc-2" },
      ],
      { rows, diagnostics } = applyRollup(rollupOp(), rowsIn);
    expect(diagnostics.groups).toBe(1);
    // The output key column carries the group's RAW first-seen value.
    expect(rows).toStrictEqual([{ restaurantId: "Aldine", "rollup.locationCount": 2 }]);
  });
});

describe("applyRollup — the six measures (null semantics pinned, issue open item (b))", () => {
  const rowsIn = [
      // Mixed-typed numeric column: number, numeric string, null, absent,
      // non-numeric string — coerceNumber admits exactly the first two.
      { restaurantId: "rest-1", locationId: "loc-1", seats: 40 },
      { restaurantId: "rest-1", locationId: "loc-2", seats: "60" },
      { restaurantId: "rest-1", locationId: "loc-3", seats: null },
      { restaurantId: "rest-1", locationId: "loc-4" },
      { restaurantId: "rest-1", locationId: "loc-5", seats: "no seats" },
    ],
    measures: RollupOperation["measures"] = [
      { alias: "locations", fn: "count" },
      { alias: "seatsSum", fn: "sum", column: "seats" },
      { alias: "seatsAvg", fn: "avg", column: "seats" },
      { alias: "seatsMin", fn: "min", column: "seats" },
      { alias: "seatsMax", fn: "max", column: "seats" },
      { alias: "distinctSeats", fn: "distinctCount", column: "seats" },
    ];

  it("computes count as the group's ROW count — every grouped row counts, whatever its cells hold", () => {
    const { rows } = applyRollup(rollupOp({ measures: [{ alias: "n", fn: "count" }] }), rowsIn);
    expect(rows[0]).toStrictEqual({ restaurantId: "rest-1", "rollup.n": 5 });
  });

  it("excludes cells with no numeric value from sum/avg/min/max — never an error", () => {
    const { rows } = applyRollup(
      rollupOp({
        measures: [
          { alias: "sum", fn: "sum", column: "seats" },
          { alias: "min", fn: "min", column: "seats" },
          { alias: "max", fn: "max", column: "seats" },
        ],
      }),
      rowsIn,
    );
    // Numeric cells: 40 and "60" (coerced) only.
    expect(rows[0]).toStrictEqual({
      restaurantId: "rest-1",
      "rollup.sum": 100,
      "rollup.min": 40,
      "rollup.max": 60,
    });
  });

  it("averages over the cells WITH a numeric value — the recorded denominator", () => {
    const { rows } = applyRollup(
      rollupOp({ measures: [{ alias: "avg", fn: "avg", column: "seats" }] }),
      rowsIn,
    );
    expect(rows[0]).toStrictEqual({ restaurantId: "rest-1", "rollup.avg": 50 });
  });

  it("yields null — not 0 — for sum/avg/min/max when the group has no numeric cells", () => {
    const noNumerics = [
        { restaurantId: "rest-1", locationId: "loc-1", seats: null },
        { restaurantId: "rest-1", locationId: "loc-2", seats: "n/a" },
        { restaurantId: "rest-1", locationId: "loc-3" },
      ],
      { rows } = applyRollup(
        rollupOp({
          measures: [
            { alias: "sum", fn: "sum", column: "seats" },
            { alias: "avg", fn: "avg", column: "seats" },
            { alias: "min", fn: "min", column: "seats" },
            { alias: "max", fn: "max", column: "seats" },
          ],
        }),
        noNumerics,
      );
    expect(rows[0]).toStrictEqual({
      restaurantId: "rest-1",
      "rollup.sum": null,
      "rollup.avg": null,
      "rollup.min": null,
      "rollup.max": null,
    });
  });

  it('counts distinct values on their NORMALIZED KEYS — Aldine/aldine once, 42 and "42" once', () => {
    const rowsInDistinct = [
        { restaurantId: "rest-1", locationId: "loc-1", city: "Aldine" },
        { restaurantId: "rest-1", locationId: "loc-2", city: "aldine" },
        { restaurantId: "rest-1", locationId: "loc-3", city: "  Aldine " },
        { restaurantId: "rest-1", locationId: "loc-4", city: 42 },
        { restaurantId: "rest-1", locationId: "loc-5", city: "42" },
        { restaurantId: "rest-1", locationId: "loc-6" },
        { restaurantId: "rest-1", locationId: "loc-7", city: "Shelbyville" },
      ],
      { rows } = applyRollup(
        rollupOp({ measures: [{ alias: "cities", fn: "distinctCount", column: "city" }] }),
        rowsInDistinct,
      );
    // Aldine ≡ aldine ≡ "  Aldine ", 42 ≡ "42", keyless cells (absent)
    // contribute nothing, Shelbyville distinct → 3.
    expect(rows[0]).toStrictEqual({ restaurantId: "rest-1", "rollup.cities": 3 });
  });

  it("yields 0 for distinctCount when no cell has a key — COUNT(DISTINCT) skips NULL", () => {
    const keyless = [
        { restaurantId: "rest-1", locationId: "loc-1", city: null },
        { restaurantId: "rest-1", locationId: "loc-2" },
      ],
      { rows } = applyRollup(
        rollupOp({ measures: [{ alias: "cities", fn: "distinctCount", column: "city" }] }),
        keyless,
      );
    expect(rows[0]).toStrictEqual({ restaurantId: "rest-1", "rollup.cities": 0 });
  });

  it("writes two measures of the same fn+column side by side under their own aliases", () => {
    const { rows } = applyRollup(
      rollupOp({
        measures: [
          { alias: "seatsSum", fn: "sum", column: "seats" },
          { alias: "seatsAvg", fn: "avg", column: "seats" },
        ],
      }),
      rowsIn.slice(0, 2),
    );
    expect(rows[0]).toStrictEqual({
      restaurantId: "rest-1",
      "rollup.seatsSum": 100,
      "rollup.seatsAvg": 50,
    });
  });

  it("lands every measure — all six at once — with count first per spec order", () => {
    const { rows } = applyRollup(rollupOp({ measures }), rowsIn);
    expect(Object.keys(rows[0])).toStrictEqual([
      "restaurantId",
      "rollup.locations",
      "rollup.seatsSum",
      "rollup.seatsAvg",
      "rollup.seatsMin",
      "rollup.seatsMax",
      "rollup.distinctSeats",
    ]);
    expect(rows[0]).toStrictEqual({
      restaurantId: "rest-1",
      "rollup.locations": 5,
      "rollup.seatsSum": 100,
      "rollup.seatsAvg": 50,
      "rollup.seatsMin": 40,
      "rollup.seatsMax": 60,
      // "40", "60" and "no seats" are three distinct normalized keys; the
      // null and absent cells contribute nothing.
      "rollup.distinctSeats": 3,
    });
  });
});

describe("applyRollup — keyless rows are dropped and counted (the recorded decision)", () => {
  it("drops rows lacking a key in ANY groupBy column, never crashing", () => {
    const rowsIn: Array<Record<string, unknown>> = [
        { restaurantId: "rest-1", locationId: "loc-1" },
        { restaurantId: null, locationId: "loc-2" },
        { restaurantId: "   ", locationId: "loc-3" },
        { locationId: "loc-4" },
        { restaurantId: Number.NaN, locationId: "loc-5" },
        { restaurantId: { nested: true }, locationId: "loc-6" },
      ],
      { rows, diagnostics } = applyRollup(rollupOp(), rowsIn);
    expect(rows).toStrictEqual([{ restaurantId: "rest-1", "rollup.locationCount": 1 }]);
    expect(diagnostics).toStrictEqual({ totalSourceRows: 6, groups: 1, keylessRows: 5 });
  });

  it("multi-key: one keyed column and one keyless column drops the row", () => {
    const rowsIn = [
        { restaurantId: "rest-1", openedYear: 2019, locationId: "loc-1" },
        { restaurantId: "rest-1", openedYear: null, locationId: "loc-2" },
      ],
      { rows, diagnostics } = applyRollup(
        rollupOp({
          groupBy: ["restaurantId", "openedYear"],
          measures: [{ alias: "n", fn: "count" }],
        }),
        rowsIn,
      );
    expect(rows).toStrictEqual([{ restaurantId: "rest-1", openedYear: 2019, "rollup.n": 1 }]);
    expect(diagnostics.keylessRows).toBe(1);
  });
});

describe("applyRollup — output shape, naming, order (issue decision 6)", () => {
  it("emits one row per group in first-seen order — input-derived, run-stable", () => {
    const rowsIn = [
        { restaurantId: "rest-2", locationId: "loc-3" },
        { restaurantId: "rest-1", locationId: "loc-1" },
        { restaurantId: "rest-2", locationId: "loc-4" },
        { restaurantId: "rest-1", locationId: "loc-2" },
      ],
      { rows, diagnostics } = applyRollup(rollupOp(), rowsIn);
    expect(rows.map((row) => row.restaurantId)).toStrictEqual(["rest-2", "rest-1"]);
    expect(diagnostics.groups).toBe(2);
  });

  it('namespaces measures under the default "rollup" namespace', () => {
    const { rows } = applyRollup(
      rollupOp({ measures: [{ alias: "n", fn: "count" }] }),
      restaurantLocations,
    );
    expect("rollup.n" in rows[0]).toBe(true);
  });

  it("uses the explicit namespace when given", () => {
    const { rows } = applyRollup(
      rollupOp({ measures: [{ alias: "n", fn: "count" }], namespace: "perRestaurant" }),
      restaurantLocations,
    );
    expect("perRestaurant.n" in rows[0]).toBe(true);
    expect("rollup.n" in rows[0]).toBe(false);
  });

  it("keeps key columns under their source names with raw first-seen values — the join-back key resolves unambiguously", () => {
    const rowsIn = [
        { restaurantId: "  Rest-1 ", locationId: "loc-1" },
        { restaurantId: "rest-1", locationId: "loc-2" },
      ],
      { rows } = applyRollup(rollupOp(), rowsIn);
    expect(rows[0]).toStrictEqual({ restaurantId: "  Rest-1 ", "rollup.locationCount": 2 });
  });

  it("writes coinciding <namespace>.<alias> columns last-wins (recorded)", () => {
    const { rows } = applyRollup(
      rollupOp({
        measures: [
          { alias: "same", fn: "count" },
          { alias: "same", fn: "distinctCount", column: "locationId" },
        ],
      }),
      [
        { restaurantId: "rest-1", locationId: "loc-1" },
        { restaurantId: "rest-1", locationId: "loc-1" },
      ],
    );
    // count computes 2, distinctCount 1 — the column reads 1: last written.
    expect(rows[0]).toStrictEqual({ restaurantId: "rest-1", "rollup.same": 1 });
  });
});

describe("applyRollup — degenerate shapes are pinned, not accidental", () => {
  it("returns zero groups for an empty dataset — the only reading of one-row-per-group", () => {
    const { rows, diagnostics } = applyRollup(rollupOp(), []);
    expect(rows).toStrictEqual([]);
    expect(diagnostics).toStrictEqual({ totalSourceRows: 0, groups: 0, keylessRows: 0 });
  });

  it("reads an empty groupBy as the total aggregate: one group of every keyed row", () => {
    const { rows, diagnostics } = applyRollup(
      rollupOp({ groupBy: [], measures: [{ alias: "total", fn: "count" }] }),
      restaurantLocations,
    );
    expect(rows).toStrictEqual([{ "rollup.total": 4 }]);
    expect(diagnostics).toStrictEqual({ totalSourceRows: 4, groups: 1, keylessRows: 0 });
  });

  it("reads empty measures as the distinct-group projection: key columns only", () => {
    const { rows } = applyRollup(rollupOp({ measures: [] }), [
      { restaurantId: "rest-1", locationId: "loc-1" },
      { restaurantId: "rest-1", locationId: "loc-2" },
      { restaurantId: "rest-2", locationId: "loc-3" },
    ]);
    expect(rows).toStrictEqual([{ restaurantId: "rest-1" }, { restaurantId: "rest-2" }]);
  });
});

describe("applyRollup — purity and composition", () => {
  it("never mutates frozen inputs — output rows are fresh objects", () => {
    const rowsIn: Array<Record<string, unknown>> = [
        Object.freeze({ restaurantId: "rest-1", locationId: "loc-1" }),
        Object.freeze({ restaurantId: "rest-1", locationId: "loc-2" }),
      ],
      rowsBefore = JSON.parse(JSON.stringify(rowsIn)) as Array<Record<string, unknown>>;
    Object.freeze(rowsIn);
    const { rows } = applyRollup(rollupOp(), rowsIn);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toBe(rowsIn[0]);
    expect(rowsIn).toStrictEqual(rowsBefore);
  });

  it("accepts its own output as the next call's input — chained rollups", () => {
    const perRestaurantYear = applyRollup(
        rollupOp({
          groupBy: ["restaurantId", "openedYear"],
          measures: [{ alias: "n", fn: "count" }],
        }),
        restaurantLocations,
      ),
      perRestaurant = applyRollup(
        rollupOp({
          groupBy: ["restaurantId"],
          measures: [{ alias: "yearsSum", fn: "sum", column: "rollup.n" }],
        }),
        perRestaurantYear.rows,
      );
    expect(perRestaurant.rows).toStrictEqual([
      { restaurantId: "rest-1", "rollup.yearsSum": 2 },
      { restaurantId: "rest-2", "rollup.yearsSum": 2 },
    ]);
  });
});
