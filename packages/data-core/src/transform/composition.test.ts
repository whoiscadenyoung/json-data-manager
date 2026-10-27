import { describe, expect, it } from "vitest";

import { applyLookup } from "./lookup.js";
import { applyRollup } from "./rollup.js";
import type {
  GeometrySource,
  LookupOperation,
  RollupOperation,
  TransformOperation,
  TransformSpec,
} from "./spec.js";
import { geometrySourceOperationOf, transformSpecDependencies } from "./spec.js";

// The PoC domain (app/convex/schema.ts): restaurants {cuisine, name},
// locations {address, city, label, lat, lng, state}, and the
// restaurantLocations join table {locationId, openedYear, restaurantId}.
// location rows carry a geometryId stand-in for the entry geometry
// reference lifecycle §5.2 pairs into published entries.
const restaurants = [
    { restaurantId: "rest-1", name: "Aldine", cuisine: "thai" },
    { restaurantId: "rest-2", name: "Leaf & Ladle", cuisine: "vegetarian" },
    // Number-keyed: proves the join-back reuses 0.4 coercion end to end.
    { restaurantId: 3, name: "Tortas", cuisine: "mexican" },
  ],
  locations = [
    { locationId: "loc-1", label: "Downtown", city: "Springfield", geometryId: "geo-1" },
    { locationId: "loc-2", label: "Riverside", city: "Springfield", geometryId: "geo-2" },
    { locationId: "loc-3", label: "Airport", city: "Shelbyville", geometryId: "geo-3" },
  ],
  restaurantLocations = [
    { restaurantId: "rest-1", locationId: "loc-1", openedYear: 2019 },
    { restaurantId: "rest-1", locationId: "loc-2", openedYear: 2021 },
    { restaurantId: "rest-2", locationId: "loc-3", openedYear: 2020 },
    // An orphan location no location row matches — the left join keeps it.
    { restaurantId: 3, locationId: "loc-404", openedYear: 2024 },
  ];

describe("engine-level composition — locations per restaurant joins back into restaurants (§3:87-90, AC 2)", () => {
  const rollupOp: RollupOperation = {
    kind: "rollup",
    groupBy: ["restaurantId"],
    measures: [{ alias: "locationCount", fn: "count" }],
  };

  it("runs the canonical chain as two pure calls: applyRollup, then applyLookup over the rollup output", () => {
    const rolled = applyRollup(rollupOp, restaurantLocations);
    expect(rolled.rows).toStrictEqual([
      { restaurantId: "rest-1", "rollup.locationCount": 2 },
      { restaurantId: "rest-2", "rollup.locationCount": 1 },
      { restaurantId: 3, "rollup.locationCount": 1 },
    ]);
    const joinBack = applyLookup(
      {
        kind: "lookup",
        lookupDatasetId: "locationsPerRestaurant",
        baseKey: "restaurantId",
        lookupKey: "restaurantId",
        namespace: "locationsPerRestaurant",
        fields: ["rollup.locationCount"],
      },
      restaurants,
      rolled.rows,
    );
    // The rollup output is an ordinary lookup table: the group-key column
    // (source name, raw value) is what lookupKey names, measures ride the
    // downstream namespace, and 0.4 coercion joins number key 3 to group
    // "3". Unmatched parents keep nulls (left, the default).
    expect(joinBack.rows).toStrictEqual([
      {
        restaurantId: "rest-1",
        name: "Aldine",
        cuisine: "thai",
        "locationsPerRestaurant.rollup.locationCount": 2,
      },
      {
        restaurantId: "rest-2",
        name: "Leaf & Ladle",
        cuisine: "vegetarian",
        "locationsPerRestaurant.rollup.locationCount": 1,
      },
      {
        restaurantId: 3,
        name: "Tortas",
        cuisine: "mexican",
        "locationsPerRestaurant.rollup.locationCount": 1,
      },
    ]);
    expect(joinBack.diagnostics.matchedRows).toBe(3);
    expect(joinBack.diagnostics.unmatchedRows).toBe(0);
  });

  it("runs a rollup mid-chain: lookup first, then a measure over the namespaced enrichment", () => {
    const enriched = applyLookup(
        {
          kind: "lookup",
          lookupDatasetId: "locations",
          baseKey: "locationId",
          lookupKey: "locationId",
          namespace: "locations",
        },
        restaurantLocations,
        locations,
      ),
      citiesPerRestaurant = applyRollup(
        {
          kind: "rollup",
          groupBy: ["restaurantId"],
          measures: [{ alias: "cityCount", fn: "distinctCount", column: "locations.city" }],
        },
        enriched.rows,
      );
    expect(citiesPerRestaurant.rows).toStrictEqual([
      { restaurantId: "rest-1", "rollup.cityCount": 1 },
      { restaurantId: "rest-2", "rollup.cityCount": 1 },
      { restaurantId: 3, "rollup.cityCount": 0 },
    ]);
  });
});

describe("transformSpecDependencies — the cycle-check helper's spec-union edges (AC 2)", () => {
  // AC 2's "cycle-check helper" is delivered as the engine's union-aware
  // edge-computer (this describe + spec.ts's transformSpecDependencies) PLUS
  // the registry-side walk (app/convex/derivedSpec.ts findCycleToOrigin,
  // :216-239) — deliberately NOT a walk in this package: only registry rows
  // can close a cycle (component ids are opaque strings; spec.ts's
  // dependency doc), and the engine stays cycle-free by design (lookup.ts
  // module doc). The test's closesCycle below replicates the registry
  // walk's exact shape because a package test cannot import app code — the
  // replica and findCycleToOrigin must stay shape-identical.
  it("derives a rollup spec's edge set: the source only — a rollup names no dataset", () => {
    const spec: TransformSpec = {
      sourceDatasetId: "restaurantLocations",
      operations: [
        { kind: "rollup", groupBy: ["restaurantId"], measures: [{ alias: "n", fn: "count" }] },
      ],
    };
    expect(transformSpecDependencies(spec)).toStrictEqual(["restaurantLocations"]);
  });

  it("derives a mixed spec's edges: source first, then lookup datasets, distinct first-seen", () => {
    const spec: TransformSpec = {
      sourceDatasetId: "restaurantLocations",
      operations: [
        {
          kind: "lookup",
          lookupDatasetId: "locations",
          baseKey: "locationId",
          lookupKey: "locationId",
        },
        { kind: "rollup", groupBy: ["restaurantId"], measures: [{ alias: "n", fn: "count" }] },
        {
          kind: "lookup",
          lookupDatasetId: "restaurants",
          baseKey: "restaurantId",
          lookupKey: "restaurantId",
        },
        {
          kind: "lookup",
          lookupDatasetId: "locations",
          baseKey: "locationId",
          lookupKey: "locationId",
        },
      ],
    };
    expect(transformSpecDependencies(spec)).toStrictEqual([
      "restaurantLocations",
      "locations",
      "restaurants",
    ]);
  });

  it("adds no edge for a geometrySource rule — it addresses a side the spec already carries", () => {
    const geometrySource: GeometrySource = {
      lookupDatasetId: "locations",
      side: "lookup",
      column: "geometryId",
    };
    const spec: TransformSpec = {
      sourceDatasetId: "restaurantLocations",
      operations: [
        {
          kind: "lookup",
          lookupDatasetId: "locations",
          baseKey: "locationId",
          lookupKey: "locationId",
        },
      ],
      geometrySource,
    };
    expect(transformSpecDependencies(spec)).toStrictEqual(["restaurantLocations", "locations"]);
  });

  it("feeds the save-time cycle walk over derived-of-derived: the join-back chain closes no cycle", () => {
    // The registry picture of §3:87-90 — the rollup spec saved as registry
    // row "derivedCounts", a join-back row "joinBack" referencing it as its
    // lookup side. Edges come from transformSpecDependencies denormalized at
    // save (the findCycleToOrigin input shape); the walk's origin is the ROW
    // being saved, and only registry rows can close a chain back to it.
    const rollupSpec: TransformSpec = {
        sourceDatasetId: "restaurantLocations",
        operations: [
          { kind: "rollup", groupBy: ["restaurantId"], measures: [{ alias: "n", fn: "count" }] },
        ],
      },
      joinBackSpec: TransformSpec = {
        sourceDatasetId: "restaurants",
        operations: [
          {
            kind: "lookup",
            lookupDatasetId: "derivedCounts",
            baseKey: "restaurantId",
            lookupKey: "restaurantId",
          },
        ],
      },
      registry = new globalThis.Map<string, TransformSpec>([["derivedCounts", rollupSpec]]),
      edgesOf = (id: string): string[] => {
        const spec = registry.get(id);
        return spec === undefined ? [] : transformSpecDependencies(spec);
      },
      // findCycleToOrigin's walk (app/convex/derivedSpec.ts:216-239): DFS
      // over persisted edges with a visited set, diamonds visited once.
      closesCycle = (originId: string, startIds: string[]): boolean => {
        const visited = new Set<string>(),
          stack = [...startIds];
        while (stack.length > 0) {
          const id = stack.pop();
          if (id === undefined || visited.has(id)) {
            continue;
          }
          if (id === originId) {
            return true;
          }
          visited.add(id);
          stack.push(...edgesOf(id));
        }
        return false;
      };
    // Saving the join-back row: its edges reach the join table, never back
    // to "joinBack" — accepted.
    expect(closesCycle("joinBack", transformSpecDependencies(joinBackSpec))).toBe(false);
    // A genuinely cyclic update — the rollup row grows a lookup side reading
    // the join-back row, closing the chain onto itself — is detected.
    registry.set("joinBack", joinBackSpec);
    const cyclicSpec: TransformSpec = {
      sourceDatasetId: "restaurantLocations",
      operations: [
        { kind: "rollup", groupBy: ["restaurantId"], measures: [{ alias: "n", fn: "count" }] },
        {
          kind: "lookup",
          lookupDatasetId: "joinBack",
          baseKey: "restaurantId",
          lookupKey: "restaurantId",
        },
      ],
    };
    registry.set("derivedCounts", cyclicSpec);
    expect(closesCycle("derivedCounts", transformSpecDependencies(cyclicSpec))).toBe(true);
  });
});

describe("geometrySource emission — per output row, from the specified side (AC 3)", () => {
  const locationsLookup: LookupOperation = {
    kind: "lookup",
    lookupDatasetId: "locations",
    baseKey: "locationId",
    lookupKey: "locationId",
  };

  it("emits one geometry reference per output row, index-paired, from the lookup side", () => {
    const { rows, geometryReferences } = applyLookup(
      locationsLookup,
      restaurantLocations,
      locations,
      { lookupDatasetId: "locations", side: "lookup", column: "geometryId" },
    );
    expect(geometryReferences).toStrictEqual(["geo-1", "geo-2", "geo-3", null]);
    // The rule was passed, so the result carries references — the cast makes
    // the optional field's presence explicit for the pairing check.
    expect(rows).toHaveLength((geometryReferences as unknown[]).length);
  });

  it("resolves from the side's own row even when fields did not pick the geometry column", () => {
    const { geometryReferences } = applyLookup(
      { ...locationsLookup, fields: ["label"] },
      restaurantLocations.slice(0, 1),
      locations,
      { lookupDatasetId: "locations", side: "lookup", column: "geometryId" },
    );
    expect(geometryReferences).toStrictEqual(["geo-1"]);
  });

  it("reads the BASE side from the source rows themselves", () => {
    const { geometryReferences } = applyLookup(locationsLookup, restaurantLocations, locations, {
      lookupDatasetId: "locations",
      side: "base",
      column: "openedYear",
    });
    expect(geometryReferences).toStrictEqual([2019, 2021, 2020, 2024]);
  });

  it("carries no geometryReferences when no rule is passed — results stay clean for existing callers", () => {
    const result = applyLookup(locationsLookup, restaurantLocations, locations);
    expect("geometryReferences" in result).toBe(false);
  });

  it("pairs references with the SURVIVING rows under an inner match", () => {
    const { rows, geometryReferences } = applyLookup(
      { ...locationsLookup, match: "inner" },
      restaurantLocations,
      locations,
      { lookupDatasetId: "locations", side: "lookup", column: "geometryId" },
    );
    expect(rows).toHaveLength(3);
    expect(geometryReferences).toStrictEqual(["geo-1", "geo-2", "geo-3"]);
  });

  it("pairs references with THIS call's rows only — a later row-count-changing op must re-resolve at its own position", () => {
    // The canonical lifecycle §5.2 join chains a SECOND lookup (restaurants
    // fields) after the geometry op — and under match "inner" that op drops
    // rows. The references the geometry call emitted stay correct for ITS
    // rows; the contract (lookup.ts's geometry bullet, spec.ts's
    // GeometrySource doc) requires consumers to resolve the rule at the
    // geometry op's position and consume THAT call's rows, because no
    // previously emitted array adjusts when a later op changes row count.
    const withOrphan = [
        ...restaurantLocations,
        // Same location as another row — a distinct geometry reference —
        // carried by a restaurant no restaurants row matches.
        { restaurantId: "rest-404", locationId: "loc-3", openedYear: 2020 },
      ],
      geometryCall = applyLookup(locationsLookup, withOrphan, locations, {
        lookupDatasetId: "locations",
        side: "lookup",
        column: "geometryId",
      }),
      restaurantsCall = applyLookup(
        {
          kind: "lookup",
          lookupDatasetId: "restaurants",
          baseKey: "restaurantId",
          lookupKey: "restaurantId",
          match: "inner",
        },
        geometryCall.rows,
        restaurants,
      ),
      references = geometryCall.geometryReferences as unknown[];
    expect(references).toStrictEqual(["geo-1", "geo-2", "geo-3", null, "geo-3"]);
    // op 2's inner match drops the rest-404 row: pairing call 1's array
    // against call 2's rows would shift every index after the drop — the
    // desync the recorded constraint forbids.
    expect(geometryCall.rows).toHaveLength(5);
    expect(restaurantsCall.rows).toHaveLength(4);
  });
});

describe("geometrySourceOperationOf — the addressing rule as code (spec.ts)", () => {
  const rule: GeometrySource = {
    lookupDatasetId: "locations",
    side: "lookup",
    column: "geometryId",
  };

  it("resolves the first lookup operation whose dataset id matches, skipping rollups", () => {
    const operations: TransformOperation[] = [
      { kind: "rollup", groupBy: ["restaurantId"], measures: [{ alias: "n", fn: "count" }] },
      {
        kind: "lookup",
        lookupDatasetId: "locations",
        baseKey: "locationId",
        lookupKey: "locationId",
      },
    ];
    expect(geometrySourceOperationOf(operations, rule)).toStrictEqual(operations[1]);
  });

  it("answers undefined for an id no operation names — a typo'd rule is detectable, never silently inert", () => {
    const operations: TransformOperation[] = [
      {
        kind: "lookup",
        lookupDatasetId: "locations",
        baseKey: "locationId",
        lookupKey: "locationId",
      },
    ];
    expect(
      geometrySourceOperationOf(operations, { ...rule, lookupDatasetId: "locationz" }),
    ).toBeUndefined();
  });

  it("first-in-order wins when two lookup operations share one dataset id (the recorded tiebreak)", () => {
    const first: LookupOperation = {
        kind: "lookup",
        lookupDatasetId: "locations",
        baseKey: "locationId",
        lookupKey: "locationId",
        namespace: "first",
      },
      second: LookupOperation = {
        kind: "lookup",
        lookupDatasetId: "locations",
        baseKey: "otherLocationId",
        lookupKey: "locationId",
        namespace: "second",
      };
    expect(geometrySourceOperationOf([first, second], rule)).toBe(first);
  });
});
