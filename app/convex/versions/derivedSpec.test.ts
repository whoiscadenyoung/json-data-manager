import { describe, expect, it } from "vitest";

import {
  findCycleToOrigin,
  schemaProperties,
  specDependencies,
  specStatus,
  validateSpecShape,
  type DatasetResolver,
  type ReferencedDataset,
  type RegistryRowLike,
  type TransformSpecLike,
} from "./derivedSpec";

/** A lookup op with only the fields the walks read (the rest default in the engine). */
function lookup(lookupDatasetId: string, baseKey = "GrantId", lookupKey = "GrantId") {
  return { baseKey, kind: "lookup", lookupDatasetId, lookupKey };
}

function spec(sourceDatasetId: string, operations: unknown[] = []): TransformSpecLike {
  return { operations, sourceDatasetId };
}

/** Resolver stand-in: component datasets by id, registry rows by `reg:` prefix ids. */
function resolverServing(
  components: Record<string, { properties: string[]; title?: string }>,
  registry: Record<string, TransformSpecLike>,
): DatasetResolver {
  return async (id) => {
    const component = components[id];
    if (component !== undefined) {
      const referenced: ReferencedDataset = {
        kind: "component",
        properties: component.properties,
        title: component.title ?? id,
      };
      return referenced;
    }
    const row = registry[id];
    if (row !== undefined) {
      const referenced: ReferencedDataset = { kind: "registry", spec: row, title: id };
      return referenced;
    }
    return { kind: "missing" };
  };
}

/** Registry stand-in for the cycle walk: rows keyed by id, carrying their persisted dependsOn edges. */
function registryServing(edges: Record<string, string[]>) {
  return async (id: string): Promise<RegistryRowLike | null> => {
    const dependsOn = edges[id];
    return dependsOn === undefined ? null : { dependsOn };
  };
}

describe("schemaProperties", () => {
  it("reads the declared top-level properties", () => {
    expect(
      schemaProperties({ properties: { GrantId: { type: "string" }, Name: {} } }),
    ).toStrictEqual(["GrantId", "Name"]);
  });

  it("tolerates everything that is not an object with a properties map", () => {
    expect(schemaProperties(undefined)).toStrictEqual([]);
    expect(schemaProperties(null)).toStrictEqual([]);
    expect(schemaProperties("nope")).toStrictEqual([]);
    expect(schemaProperties([1, 2])).toStrictEqual([]);
    expect(schemaProperties({})).toStrictEqual([]);
    expect(schemaProperties({ properties: "nope" })).toStrictEqual([]);
  });
});

describe("specDependencies", () => {
  it("lists the source first, then each operation's dataset, distinct, first-seen", () => {
    const deps = specDependencies(spec("s1", [lookup("l1"), lookup("l2"), lookup("l1")]));

    expect(deps).toStrictEqual(["s1", "l1", "l2"]);
  });

  it("ignores shapeless ids and non-records", () => {
    const deps = specDependencies({
      operations: [null, "text", { kind: "lookup" }, lookup("l1")],
      sourceDatasetId: 42,
    });

    expect(deps).toStrictEqual(["l1"]);
  });

  it("tolerates operation kinds it does not know (stage 4 adds kinds without a migration)", () => {
    const deps = specDependencies(
      spec("s1", [lookup("l1"), { datasetId: "mystery", kind: "rollup" }]),
    );

    expect(deps).toStrictEqual(["s1", "l1"]);
  });

  it("answers the source alone for an empty or shapeless spec", () => {
    expect(specDependencies(spec("s1"))).toStrictEqual(["s1"]);
    expect(specDependencies({})).toStrictEqual([]);
  });

  it("adds a sql operation's table refs as edges, distinct, first-seen (stage 9 #105 — the cycle walk, visibility gate, and press order read these)", () => {
    const deps = specDependencies(
      spec("s1", [
        {
          kind: "sql",
          sql: "SELECT count(*) FROM source JOIN r1 ON source.id = r1.id",
          sourceAs: "source",
          tables: [
            { as: "r1", datasetId: "reg1" },
            { as: "r2", datasetId: "reg2" },
            { as: "again", datasetId: "reg1" },
          ],
        },
      ]),
    );

    expect(deps).toStrictEqual(["s1", "reg1", "reg2"]);
  });

  it("ignores shapeless sql table refs instead of breaking the walk", () => {
    const deps = specDependencies(
      spec("s1", [
        {
          kind: "sql",
          sql: "SELECT 1",
          tables: [null, "text", { as: "r1" }, { as: "r2", datasetId: "reg2" }],
        },
      ]),
    );

    expect(deps).toStrictEqual(["s1", "reg2"]);
  });
});

describe("validateSpecShape", () => {
  it("accepts a lookup spec and returns its narrowed fields", () => {
    const validated = validateSpecShape(
      spec("s1", [{ ...lookup("l1"), fields: ["Status"], match: "inner", onDuplicateKey: "last" }]),
    );

    expect(validated).toStrictEqual({
      ok: true,
      spec: {
        operations: [
          { ...lookup("l1"), fields: ["Status"], match: "inner", onDuplicateKey: "last" },
        ],
        sourceDatasetId: "s1",
      },
    });
  });

  it("accepts an operation kind it does not know (additive tolerance)", () => {
    const validated = validateSpecShape(spec("s1", [{ datasetId: "x", kind: "rollup" }]));

    expect(validated.ok).toBe(true);
  });

  it("rejects the shapes the persisted edges and the engine cannot run", () => {
    expect(validateSpecShape("nope").ok).toBe(false);
    expect(validateSpecShape({ operations: [] }).ok).toBe(false);
    expect(validateSpecShape({ operations: [], sourceDatasetId: "" }).ok).toBe(false);
    expect(validateSpecShape({ sourceDatasetId: "s1" }).ok).toBe(false);
    expect(validateSpecShape({ operations: ["nope"], sourceDatasetId: "s1" }).ok).toBe(false);
    expect(validateSpecShape({ operations: [{}], sourceDatasetId: "s1" }).ok).toBe(false);
    expect(
      validateSpecShape({ operations: [{ kind: "not-lookup" }], sourceDatasetId: "s1" }).ok,
    ).toBe(true);
    const incompleteCases = [
      {
        missing: "baseKey",
        op: { kind: "lookup", lookupDatasetId: "l1", lookupKey: "GrantId" },
      },
      {
        missing: "lookupDatasetId",
        op: { baseKey: "GrantId", kind: "lookup", lookupKey: "GrantId" },
      },
      {
        missing: "lookupKey",
        op: { baseKey: "GrantId", kind: "lookup", lookupDatasetId: "l1" },
      },
    ];
    expect(
      incompleteCases.map((testCase) => validateSpecShape(spec("s1", [testCase.op])).ok),
    ).toStrictEqual([false, false, false]);
    expect(
      incompleteCases.map((testCase) => {
        const validated = validateSpecShape(spec("s1", [testCase.op]));
        return !validated.ok ? validated.reason : validated;
      }),
    ).toStrictEqual([
      "A lookup operation is missing its baseKey.",
      "A lookup operation is missing its lookupDatasetId.",
      "A lookup operation is missing its lookupKey.",
    ]);
    expect(validateSpecShape(spec("s1", [{ ...lookup("l1"), fields: ["ok", 7] }])).ok).toBe(false);
    expect(validateSpecShape(spec("s1", [{ ...lookup("l1"), match: "outer" }])).ok).toBe(false);
    expect(validateSpecShape(spec("s1", [{ ...lookup("l1"), onDuplicateKey: "both" }])).ok).toBe(
      false,
    );
  });

  it("accepts a well-formed sql operation and rejects the shapes its persisted edges need (stage 9 #105)", () => {
    const valid = {
      kind: "sql",
      sql: "SELECT count(*) FROM source",
      sourceAs: "source",
      tables: [{ as: "r1", datasetId: "reg1" }],
    };
    expect(validateSpecShape(spec("s1", [valid])).ok).toBe(true);
    expect(validateSpecShape(spec("s1", [{ kind: "sql", sql: "", tables: [] }])).ok).toBe(false);
    // REQUIRED since the reviewers' pass: the field carries the walk's
    // edges — an omitted tables list would save edges-blind.
    expect(validateSpecShape(spec("s1", [{ kind: "sql", sql: "SELECT 1" }])).ok).toBe(false);
    expect(
      validateSpecShape(spec("s1", [{ kind: "sql", sql: "SELECT 1", tables: "nope" }])).ok,
    ).toBe(false);
    expect(
      validateSpecShape(spec("s1", [{ kind: "sql", sql: "SELECT 1", tables: [{ as: "r1" }] }])).ok,
    ).toBe(false);
    expect(
      validateSpecShape(
        spec("s1", [{ kind: "sql", sql: "SELECT 1", tables: [{ datasetId: "reg1" }] }]),
      ).ok,
    ).toBe(false);
    const rejected = validateSpecShape(
      spec("s1", [{ kind: "sql", sql: "SELECT 1", tables: [{ as: "r1" }] }]),
    );
    expect(!rejected.ok ? rejected.reason : "").toContain("datasetId");
  });
});

describe("findCycleToOrigin", () => {
  it("closes the loop when the saved spec's chain reaches the row being saved", async () => {
    // Existing rows: B reads A, C reads B. Saving A with a lookup on C
    // would make A → C → B → A (the issue's A→B→C→A, anchored at the edit).
    const registry = registryServing({
      B: ["A"],
      C: ["B"],
    });

    const cycle = await findCycleToOrigin("A", ["C"], registry);

    expect(cycle).toBe("A");
  });

  it("catches a direct self-reference", async () => {
    const cycle = await findCycleToOrigin("A", ["A"], registryServing({}));

    expect(cycle).toBe("A");
  });

  it("walks nothing when the dependencies are component datasets (ids that cannot point back)", async () => {
    const cycle = await findCycleToOrigin(
      "A",
      ["component-1", "component-2"],
      registryServing({
        A: ["component-1"],
      }),
    );

    expect(cycle).toBeUndefined();
  });

  it("accepts diamonds — shared registry branches are visited once — and stops at missing rows", async () => {
    // B and C both read derived D, which reads a component dataset. Saving
    // A with lookups on B and C re-walks D twice without looping.
    const registry = registryServing({
      B: ["D"],
      C: ["D"],
      D: ["component-s1"],
    });

    const cycle = await findCycleToOrigin("A", ["B", "C"], registry);

    expect(cycle).toBeUndefined();
  });
});

describe("specStatus", () => {
  const resolve = resolverServing(
    {
      grants: { properties: ["GrantId", "Status", "Name"], title: "Grants" },
      lean: { properties: [], title: "Lean" },
    },
    {},
  );

  it("is ready when every referenced dataset exists and carries the declared columns", async () => {
    const report = await specStatus(
      spec("grants", [{ ...lookup("grants"), fields: ["Status", "Name"] }]),
      resolve,
    );

    expect(report).toStrictEqual({ health: "ready" });
  });

  it("is orphaned when the source or a lookup dataset no longer exists", async () => {
    const sourceGone = await specStatus(spec("gone", [lookup("grants")]), resolve);
    const lookupGone = await specStatus(spec("grants", [lookup("gone")]), resolve);

    expect(sourceGone.health).toBe("orphaned");
    expect(lookupGone.health).toBe("orphaned");
  });

  it("checks a sql operation's table refs for existence — the query text is opaque, a vanished dataset is not (stage 9 #105)", async () => {
    const goneTable = await specStatus(
      spec("grants", [
        {
          kind: "sql",
          sql: "SELECT count(*) FROM source JOIN r ON source.id = r.id",
          sourceAs: "source",
          tables: [{ as: "r", datasetId: "gone" }],
        },
      ]),
      resolve,
    );
    const presentTable = await specStatus(
      spec("grants", [
        {
          kind: "sql",
          sql: "SELECT count(*) FROM source JOIN r ON source.id = r.id",
          sourceAs: "source",
          tables: [{ as: "r", datasetId: "lean" }],
        },
      ]),
      resolve,
    );

    expect(goneTable.health).toBe("orphaned");
    expect(presentTable.health).toBe("ready");
  });

  it("is stale when a key or picked field no longer exists on the referenced dataset", async () => {
    const keyGone = await specStatus(
      spec("grants", [lookup("grants", "OldKey", "GrantId")]),
      resolve,
    );
    const fieldGone = await specStatus(
      spec("grants", [{ ...lookup("grants"), fields: ["Status", "Vanished"] }]),
      resolve,
    );

    expect(keyGone.health).toBe("stale");
    expect(keyGone.reason).toBeDefined();
    expect(keyGone.reason).toContain("OldKey");
    expect(keyGone.reason).toContain("Grants");
    expect(fieldGone.health).toBe("stale");
  });

  it("checks only key existence when fields are omitted", async () => {
    const allFields = await specStatus(spec("grants", [lookup("grants")]), resolve);

    expect(allFields).toStrictEqual({ health: "ready" });
  });

  it("cannot pass a key check against a dataset with no declared properties", async () => {
    const report = await specStatus(spec("lean", [lookup("lean", "AnyKey", "AnyKey")]), resolve);

    expect(report.health).toBe("stale");
  });

  it("inherits health transitively through derived-of-derived references", async () => {
    const resolveDerived = resolverServing(
      { grants: { properties: ["GrantId"], title: "Grants" } },
      {
        // A derived dataset whose own lookup key has vanished.
        "reg:staleChild": spec("grants", [lookup("grants", "Gone", "GrantId")]),
        // A derived dataset whose own source is gone.
        "reg:orphanChild": spec("gone"),
        // A healthy derived dataset: existence is checkable, columns are not.
        "reg:healthy": spec("grants"),
      },
    );

    const stale = await specStatus(spec("reg:staleChild"), resolveDerived);
    const orphaned = await specStatus(spec("reg:orphanChild"), resolveDerived);
    const derivedColumnsUnchecked = await specStatus(
      spec("reg:healthy", [lookup("reg:healthy", "Whatever", "Whatever")]),
      resolveDerived,
    );

    expect(stale.health).toBe("stale");
    expect(stale.reason).toBeDefined();
    expect(stale.reason).toContain("reg:staleChild");
    expect(orphaned.health).toBe("orphaned");
    expect(derivedColumnsUnchecked).toStrictEqual({ health: "ready" });
  });

  it("reports the first problem across operations", async () => {
    const report = await specStatus(spec("grants", [lookup("grants"), lookup("gone")]), resolve);

    expect(report.health).toBe("orphaned");
  });
});
