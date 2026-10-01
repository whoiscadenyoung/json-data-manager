import { describe, expect, it } from "vitest";

import { MAX_ANALYSIS_SOURCE_ROWS } from "./analysis-caps";
import {
  PUBLISH_GEOMETRY_COLUMN,
  PUBLISH_GEOMETRY_PLUMBING_COLUMN,
  PublishSpecError,
  executeSpecForPublish,
  needsGeometryPlumbing,
  plumbingColumnOf,
  publishRecordOf,
} from "./publish-spec";
import type { PublishSourceTables } from "./publish-spec";

// The §5.2 restaurant-join shape: restaurantLocations rows join locations on
// locationId→label; locations entries carry Points whose ids ride the
// injected plumbing column.
const locationsRows: Array<Record<string, unknown>> = [
  { [PUBLISH_GEOMETRY_COLUMN]: "geo-1", label: "Downtown" },
  { [PUBLISH_GEOMETRY_COLUMN]: "geo-2", label: "Riverside" },
  { [PUBLISH_GEOMETRY_COLUMN]: "geo-3", label: "Airport" },
];
const rlRows: Array<Record<string, unknown>> = [
  { label: "RL-1", locationId: "Downtown" },
  { label: "RL-2", locationId: "Riverside" },
  { label: "RL-404", locationId: "Nowhere" },
];
const geometryById = new globalThis.Map<string, unknown>([
  ["geo-1", { coordinates: [1, 2], type: "Point" }],
  ["geo-2", { coordinates: [3, 4], type: "Point" }],
  ["geo-3", { coordinates: [5, 6], type: "Point" }],
]);

function tablesOf(
  rows: Record<string, unknown>,
  extra: Partial<PublishSourceTables> = {},
): PublishSourceTables {
  return {
    geometryById,
    rowsByDatasetId: new globalThis.Map([["rl", [rows]]]),
    specByDatasetId: new globalThis.Map(),
    ...extra,
  };
}

/** Both sides of the §5.2 join, pre-loaded (plus optional extras). */
function joinedTablesOf(
  extraRows: Array<[string, Array<Record<string, unknown>>]> = [],
  overrides: Partial<PublishSourceTables> = {},
): PublishSourceTables {
  return {
    geometryById,
    rowsByDatasetId: new globalThis.Map([
      ["rl", rlRows],
      ["locations", locationsRows],
      ...extraRows,
    ]),
    specByDatasetId: new globalThis.Map(),
    ...overrides,
  };
}

const lookupLocations = (match?: "inner") => ({
  baseKey: "locationId",
  fields: ["label"],
  kind: "lookup" as const,
  lookupDatasetId: "locations",
  lookupKey: "label",
  match,
  namespace: "locations",
});

describe("needsGeometryPlumbing / publishRecordOf", () => {
  it("injects only when the rule resolves to an operation naming a plumbing column", async () => {
    const withRule = {
        geometrySource: {
          column: PUBLISH_GEOMETRY_COLUMN,
          lookupDatasetId: "locations",
          side: "lookup",
        },
        operations: [lookupLocations()],
        sourceDatasetId: "rl",
      },
      typoRule = {
        geometrySource: {
          column: PUBLISH_GEOMETRY_COLUMN,
          lookupDatasetId: "locationz",
          side: "lookup",
        },
        operations: [lookupLocations()],
        sourceDatasetId: "rl",
      },
      dataColumnRule = {
        geometrySource: { column: "geoRef", lookupDatasetId: "locations", side: "lookup" },
        operations: [lookupLocations()],
        sourceDatasetId: "rl",
      };
    expect(needsGeometryPlumbing(withRule)).toBe(true);
    // A typo'd rule reads as "no geometry rule" — detectable, never a crash.
    expect(needsGeometryPlumbing(typoRule)).toBe(false);
    // A genuine data column passes through untouched.
    expect(needsGeometryPlumbing(dataColumnRule)).toBe(false);
    expect(needsGeometryPlumbing({ operations: [], sourceDatasetId: "rl" })).toBe(false);

    expect(
      publishRecordOf({ data: { a: 1 }, geometryId: "geo-9" }, PUBLISH_GEOMETRY_COLUMN),
    ).toStrictEqual({
      a: 1,
      [PUBLISH_GEOMETRY_COLUMN]: "geo-9",
    });
    // No injection → real data named geometryId survives untouched.
    expect(publishRecordOf({ data: { geometryId: "kept" } }, undefined)).toStrictEqual({
      geometryId: "kept",
    });
    expect(
      publishRecordOf({ data: null, geometryId: undefined }, PUBLISH_GEOMETRY_PLUMBING_COLUMN),
    ).toStrictEqual({});
  });

  it("recognizes the collision-proof plumbing spelling for new specs (#133 item 13)", () => {
    const newRule = {
        geometrySource: {
          column: PUBLISH_GEOMETRY_PLUMBING_COLUMN,
          lookupDatasetId: "locations",
          side: "lookup",
        },
        operations: [lookupLocations()],
        sourceDatasetId: "rl",
      },
      legacyRule = {
        geometrySource: {
          column: PUBLISH_GEOMETRY_COLUMN,
          lookupDatasetId: "locations",
          side: "lookup",
        },
        operations: [lookupLocations()],
        sourceDatasetId: "rl",
      };
    expect(needsGeometryPlumbing(newRule)).toBe(true);
    expect(plumbingColumnOf(newRule)).toBe(PUBLISH_GEOMETRY_PLUMBING_COLUMN);
    // The legacy spelling still resolves — shipped specs keep publishing.
    expect(plumbingColumnOf(legacyRule)).toBe(PUBLISH_GEOMETRY_COLUMN);
    // The injected key rides under the RULE's spelling, not a fixed one —
    // so a user column named geometryId only ever loses to a LEGACY rule.
    expect(
      publishRecordOf(
        { data: { geometryId: "user-data" }, geometryId: "geo-9" },
        plumbingColumnOf(newRule),
      ),
    ).toStrictEqual({
      geometryId: "user-data",
      [PUBLISH_GEOMETRY_PLUMBING_COLUMN]: "geo-9",
    });
  });
});

describe("executeSpecForPublish — pairing at the geometry op's position (AC 5)", () => {
  it("pairs references with the geometry call's rows and resolves payloads by id", async () => {
    const spec = {
      geometrySource: {
        column: PUBLISH_GEOMETRY_COLUMN,
        lookupDatasetId: "locations",
        side: "lookup",
      },
      operations: [lookupLocations()],
      sourceDatasetId: "rl",
    };
    const execution = await executeSpecForPublish(spec, joinedTablesOf());
    // Left match: all three rows survive; the orphan carries null geometry.
    expect(execution.geometryPayloads).toStrictEqual([
      { coordinates: [1, 2], type: "Point" },
      { coordinates: [3, 4], type: "Point" },
      null,
    ]);
    // The plumbing column is stripped; the enrichment rides namespaced.
    expect(execution.rows[0]).toStrictEqual({
      "locations.label": "Downtown",
      label: "RL-1",
      locationId: "Downtown",
    });
    expect(Object.hasOwn(execution.rows[0], PUBLISH_GEOMETRY_COLUMN)).toBe(false);
  });

  it("keeps the pairing aligned through a LATER inner-match lookup (the desync constraint)", async () => {
    // The canonical §5.2 join: geometry lookup first, restaurants fields
    // second under match "inner" — which drops the orphan row AFTER the
    // geometry references were emitted.
    const restaurants = [
      { cuisine: "thai", name: "Aldine", rlLabel: "RL-1" },
      { cuisine: "veg", name: "Leaf & Ladle", rlLabel: "RL-2" },
    ];
    const spec = {
      geometrySource: {
        column: PUBLISH_GEOMETRY_COLUMN,
        lookupDatasetId: "locations",
        side: "lookup",
      },
      operations: [
        lookupLocations(),
        {
          baseKey: "label",
          kind: "lookup",
          lookupDatasetId: "restaurants",
          lookupKey: "rlLabel",
          match: "inner",
        },
      ],
      sourceDatasetId: "rl",
    };
    const execution = await executeSpecForPublish(
      spec,
      joinedTablesOf([["restaurants", restaurants]]),
    );
    // The orphan (no restaurant match) is dropped — and its geometry slot
    // with it. The two survivors keep THEIR geometry payloads.
    expect(execution.rows).toHaveLength(2);
    expect(execution.geometryPayloads).toStrictEqual([
      { coordinates: [1, 2], type: "Point" },
      { coordinates: [3, 4], type: "Point" },
    ]);
    expect(
      execution.rows[0] === undefined ? undefined : execution.rows[0]["restaurants.cuisine"],
    ).toBe("thai");
  });

  it("reads BASE-side references from the source rows themselves", async () => {
    const spec = {
      geometrySource: { column: "label", lookupDatasetId: "locations", side: "base" },
      operations: [lookupLocations()],
      sourceDatasetId: "rl",
    };
    const execution = await executeSpecForPublish(
      spec,
      joinedTablesOf([], {
        geometryById: new globalThis.Map([["Downtown", { coordinates: [9, 9], type: "Point" }]]),
        rowsByDatasetId: new globalThis.Map([
          ["rl", rlRows.slice(0, 1)],
          ["locations", locationsRows],
        ]),
      }),
    );
    // Base-side reads are raw data (no injection happened): "RL-1" names no
    // geometry here, so the row carries null.
    expect(execution.geometryPayloads).toStrictEqual([null]);
    // With the value present in the geometry map it resolves.
    const resolved = await executeSpecForPublish(
      spec,
      joinedTablesOf([], {
        geometryById: new globalThis.Map([["RL-1", { coordinates: [7, 7], type: "Point" }]]),
        rowsByDatasetId: new globalThis.Map([
          ["rl", rlRows.slice(0, 1)],
          ["locations", locationsRows],
        ]),
      }),
    );
    expect(resolved.geometryPayloads).toStrictEqual([{ coordinates: [7, 7], type: "Point" }]);
    // No injection → no stripping of a same-named data column.
    expect(Object.hasOwn(resolved.rows[0], "label")).toBe(true);
  });

  it("carries no geometry and strips nothing without a rule", async () => {
    const execution = await executeSpecForPublish(
      { operations: [lookupLocations()], sourceDatasetId: "rl" },
      joinedTablesOf(),
    );
    expect(execution.geometryPayloads).toStrictEqual([null, null, null]);
  });

  it("resolves derived-of-derived sources by executing the nested spec first", async () => {
    // rl → per-location rollup chain: the nested spec runs, its rows feed the
    // outer lookup.
    const nestedSpec = {
      operations: [
        {
          groupBy: ["locationId"],
          kind: "rollup",
          measures: [{ alias: "n", fn: "count" }],
        },
      ],
      sourceDatasetId: "rl",
    };
    const spec = {
      operations: [
        {
          baseKey: "locationId",
          kind: "lookup",
          lookupDatasetId: "counts",
          lookupKey: "locationId",
        },
      ],
      sourceDatasetId: "locations",
    };
    // The locations rows carry the join-back key the rolled groups answer.
    const keyedReaderLocations: Array<Record<string, unknown>> = locationsRows.map((row, index) => {
      const keyed: Record<string, unknown> = { locationId: `L-${index + 1}` };
      for (const [key, value] of Object.entries(row)) {
        keyed[key] = value;
      }
      return keyed;
    });
    const keyedRlRows = [
      { label: "RL-1a", locationId: "L-1" },
      { label: "RL-1b", locationId: "L-1" },
      { label: "RL-2", locationId: "L-2" },
      { label: "RL-3", locationId: "L-3" },
    ];
    const execution = await executeSpecForPublish(
      spec,
      joinedTablesOf([], {
        rowsByDatasetId: new globalThis.Map([
          ["rl", keyedRlRows],
          ["locations", keyedReaderLocations],
        ]),
        specByDatasetId: new globalThis.Map([["counts", nestedSpec]]),
      }),
    );
    expect(execution.rows).toStrictEqual([
      {
        "counts.rollup.n": 2,
        [PUBLISH_GEOMETRY_COLUMN]: "geo-1",
        label: "Downtown",
        locationId: "L-1",
      },
      {
        "counts.rollup.n": 1,
        [PUBLISH_GEOMETRY_COLUMN]: "geo-2",
        label: "Riverside",
        locationId: "L-2",
      },
      {
        "counts.rollup.n": 1,
        [PUBLISH_GEOMETRY_COLUMN]: "geo-3",
        label: "Airport",
        locationId: "L-3",
      },
    ]);
  });

  it("rejects a rollup after the geometry operation instead of dropping the geometry silently", async () => {
    const spec = {
      geometrySource: {
        column: PUBLISH_GEOMETRY_COLUMN,
        lookupDatasetId: "locations",
        side: "lookup",
      },
      operations: [lookupLocations(), { groupBy: ["locationId"], kind: "rollup", measures: [] }],
      sourceDatasetId: "rl",
    };
    await expect(executeSpecForPublish(spec, joinedTablesOf())).rejects.toThrow(PublishSpecError);
  });

  it("rejects an unloaded dataset reference and a sql operation without an engine", async () => {
    await expect(
      executeSpecForPublish({ operations: [], sourceDatasetId: "unknown" }, tablesOf({})),
    ).rejects.toThrow(PublishSpecError);
    // A sql op with no PublishSqlExecution is a load error, never a silent
    // skip — materializing without the query's rows would fabricate a dataset.
    await expect(
      executeSpecForPublish(
        { operations: [{ kind: "sql" }], sourceDatasetId: "rl" },
        tablesOf({ a: 1 }),
      ),
    ).rejects.toThrow("no SQL engine");
  });

  it("rejects a dependency cycle defensively (the save gate should have caught it)", async () => {
    const spec = { operations: [], sourceDatasetId: "self" };
    await expect(
      executeSpecForPublish(spec, {
        geometryById: new globalThis.Map(),
        rowsByDatasetId: new globalThis.Map(),
        specByDatasetId: new globalThis.Map([["self", spec]]),
      }),
    ).rejects.toThrow(/cycle/);
  });

  it("executes a diamond DAG — a spec reached again from a SIBLING branch is not a cycle (#133 item 10)", async () => {
    // base (component) ← leaf (registry) ← left / right (registry) ← top,
    // whose two lookups read left and right: the old shared `visited` set
    // flagged leaf's second entry (via right) as a cycle.
    const baseRows = [{ k: "v", n: 1 }],
      leaf = { operations: [], sourceDatasetId: "base" },
      left = { operations: [], sourceDatasetId: "leaf" },
      right = { operations: [], sourceDatasetId: "leaf" },
      top = {
        operations: [
          { baseKey: "k", kind: "lookup", lookupDatasetId: "left", lookupKey: "k" },
          { baseKey: "k", kind: "lookup", lookupDatasetId: "right", lookupKey: "k" },
        ],
        sourceDatasetId: "base",
      };
    const execution = await executeSpecForPublish(top, {
      geometryById: new globalThis.Map(),
      rowsByDatasetId: new globalThis.Map([["base", baseRows]]),
      specByDatasetId: new globalThis.Map([
        ["leaf", leaf],
        ["left", left],
        ["right", right],
      ]),
    });
    // Both folds ran over the same leaf rows — each branch's enrichment
    // landed (the strongest proof the second entry executed, not cycled).
    expect(execution.rows).toStrictEqual([{ k: "v", n: 1, "left.n": 1, "right.n": 1 }]);
  });

  it("still rejects a cycle that runs through a SIBLING'S subtree (path-scoped, not permissive)", async () => {
    const aToB = { operations: [], sourceDatasetId: "b" },
      bToA = { operations: [], sourceDatasetId: "a" };
    await expect(
      executeSpecForPublish(aToB, {
        geometryById: new globalThis.Map(),
        rowsByDatasetId: new globalThis.Map(),
        specByDatasetId: new globalThis.Map([
          ["a", aToB],
          ["b", bToA],
        ]),
      }),
    ).rejects.toThrow(/cycle/);
  });
});

/** A stand-in engine answering fixed rows (the sql.test.ts pattern). */
const fakeEngine = (result: Array<Record<string, unknown>>) => ({
  async query() {
    return result;
  },
  async register() {
    return undefined;
  },
});

describe("executeSpecForPublish — sql operations (stage 9, #105)", () => {
  const sqlOp = {
    kind: "sql",
    sourceAs: "source",
    sql: "SELECT label, count(*) AS n FROM source GROUP BY label",
    tables: [{ as: "locations", datasetId: "locations" }],
  };

  it("executes through the same applySql the analysis worker runs, and strips nothing that is not plumbing", async () => {
    const execution = await executeSpecForPublish(
      { operations: [sqlOp], sourceDatasetId: "rl" },
      joinedTablesOf([["locations", locationsRows]]),
      { engine: fakeEngine([{ label: "RL-1", n: 1 }]) },
    );
    expect(execution.rows).toStrictEqual([{ label: "RL-1", n: 1 }]);
    expect(execution.geometryPayloads).toStrictEqual([null]);
  });

  it("feeds the sql side tables from the pre-loaded rows, keyed by the op's as-name", async () => {
    let seen: Array<Record<string, unknown>> | undefined;
    const engine = {
      async query() {
        return [];
      },
      async register(table: { name: string; rows: Array<Record<string, unknown>> }) {
        if (table.name === "locations") {
          seen = table.rows;
        }
      },
    };
    await executeSpecForPublish({ operations: [sqlOp], sourceDatasetId: "rl" }, joinedTablesOf(), {
      engine,
    });
    if (seen === undefined) {
      throw new Error("The locations side table was never registered.");
    }
    // Registration runs materializeSqlTable: display text is PRESERVED
    // (#133 item 9) and the canonical form rides the hidden __key twin —
    // the "mixed-type keys coerce" contract, visible right here.
    expect(seen.map((row) => row.label)).toStrictEqual(["Downtown", "Riverside", "Airport"]);
    expect(seen.map((row) => row.label__key)).toStrictEqual(["downtown", "riverside", "airport"]);
  });

  it("refuses a sql operation after the geometry operation (rows carry no per-source-row geometry)", async () => {
    const spec = {
      geometrySource: {
        column: PUBLISH_GEOMETRY_COLUMN,
        lookupDatasetId: "locations",
        side: "lookup",
      },
      operations: [lookupLocations(), sqlOp],
      sourceDatasetId: "rl",
    };
    await expect(
      executeSpecForPublish(spec, joinedTablesOf(), { engine: fakeEngine([]) }),
    ).rejects.toThrow("SQL operation follows the geometry operation");
  });

  it("reports a failed query as a load error, never an empty publish", async () => {
    const engine = {
      async query(): Promise<Array<Record<string, unknown>>> {
        throw new Error("Catalog Error: table does not exist");
      },
      async register(): Promise<void> {
        return undefined;
      },
    };
    await expect(
      executeSpecForPublish({ operations: [sqlOp], sourceDatasetId: "rl" }, joinedTablesOf(), {
        engine,
      }),
    ).rejects.toThrow("The SQL operation failed");
  });

  it("refuses a TRUNCATED result instead of materializing the first N rows as the dataset", async () => {
    // 3 rows returned against a limit of 2 — the interactive preview badges
    // this; the publish leg must refuse it outright.
    await expect(
      executeSpecForPublish({ operations: [sqlOp], sourceDatasetId: "rl" }, joinedTablesOf(), {
        engine: fakeEngine([{ n: 1 }, { n: 2 }, { n: 3 }]),
        limit: 2,
      }),
    ).rejects.toThrow("materialization cap");
    // At-or-under the cap materializes normally.
    const execution = await executeSpecForPublish(
      { operations: [sqlOp], sourceDatasetId: "rl" },
      joinedTablesOf(),
      { engine: fakeEngine([{ n: 1 }, { n: 2 }]), limit: 2 },
    );
    expect(execution.rows).toStrictEqual([{ n: 1 }, { n: 2 }]);
  });

  it("refuses source rows over the analysis cap, same as the interactive run (#133 item 7)", async () => {
    const tooMany = Array.from({ length: MAX_ANALYSIS_SOURCE_ROWS + 1 }, () => ({ a: 1 }));
    await expect(
      executeSpecForPublish(
        { operations: [sqlOp], sourceDatasetId: "big" },
        {
          geometryById: new globalThis.Map(),
          rowsByDatasetId: new globalThis.Map([["big", tooMany]]),
          specByDatasetId: new globalThis.Map(),
        },
        { engine: fakeEngine([]) },
      ),
    ).rejects.toThrow(/source rows/);
    // The cap counts side tables too.
    await expect(
      executeSpecForPublish(
        { operations: [sqlOp], sourceDatasetId: "rl" },
        joinedTablesOf([["locations", tooMany]]),
        { engine: fakeEngine([]) },
      ),
    ).rejects.toThrow(/source rows/);
  });

  it("types tables from the DECLARED structures (columnsByDatasetId) — publish coercion matches the preview", async () => {
    const registered: Array<{
      columns: Array<{ name: string; type: string }>;
      name: string;
      rows: Array<Record<string, unknown>>;
    }> = [];
    const engine = {
      async query(): Promise<Array<Record<string, unknown>>> {
        return [];
      },
      async register(table: {
        columns: Array<{ name: string; type: string }>;
        name: string;
        rows: Array<Record<string, unknown>>;
      }) {
        registered.push(table);
      },
    };
    // "locationId" is a DECLARED string column whose cells look numeric —
    // row inference would fold "007" into 7 on the publish leg alone.
    await executeSpecForPublish(
      {
        operations: [
          {
            kind: "sql",
            sourceAs: "source",
            sql: "SELECT locationId FROM source",
            tables: [{ as: "locations", datasetId: "locations" }],
          },
        ],
        sourceDatasetId: "rl",
      },
      joinedTablesOf([], {
        columnsByDatasetId: new globalThis.Map([
          ["rl", [{ name: "locationId", type: "string" }]],
          ["locations", [{ name: "label", type: "string" }]],
        ]),
      }),
      { engine },
    );
    expect(registered.map((table) => table.name)).toStrictEqual(["source", "locations"]);
    // The DECLARED type leads each table (extras — label on source, the
    // fixture's geometryId plumbing key — infer after it, per
    // materializeSqlTable).
    expect(registered[0].columns[0]).toStrictEqual({ name: "locationId", type: "string" });
    expect(registered[1].columns[0]).toStrictEqual({ name: "label", type: "string" });
    expect(registered[0].rows.length).toBeGreaterThan(0);
  });
});
