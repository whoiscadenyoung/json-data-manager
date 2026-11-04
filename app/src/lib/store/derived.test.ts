// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { randomUUID } from "node:crypto";

import {
  findCycleToOrigin,
  getQueryOptions,
  listBySourceQueryOptions,
  LIST_BY_SOURCE_MAX,
  remove,
  save,
  sourceIdOf,
  specCarriesSql,
  specDependencies,
  specStatus,
  SUMMARIES_READ_LIMIT,
  summariesQueryOptions,
  validateSpecShape,
  type DerivedDatasetRow,
  type RegistryRowLike,
} from "./derived";
import {
  argsOf,
  firstArg,
  queryAt,
  runQueryOptions,
  stubSupabase,
  type RecordedQuery,
} from "./test-support";

/** The element at the index, or a loud failure (the no-optional-chaining test style). */
function at<T>(rows: ReadonlyArray<T>, index: number): T {
  const item = rows[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index} (have ${rows.length}).`);
  }
  return item;
}

/** The value, or a loud failure when null/undefined. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

/** The method list of one recorded query ("select, eq, limit"), for failure messages. */
function methodsOf(query: RecordedQuery): string {
  return query.operations.map((operation) => operation.method).join(", ");
}

/** One registry wire row (camelCase aliases over the DDL — DERIVED_FULL_SELECT's shape). Overrides replace whole fields. */
function wireRow(id: string, overrides: Partial<DerivedDatasetRow> = {}): DerivedDatasetRow {
  return {
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    dependsOn: [],
    description: null,
    id,
    sourceDatasetId: "11111111-1111-4111-8111-111111111111",
    sourceDerivedId: null,
    spec: { operations: [], sourceDatasetId: "11111111-1111-4111-8111-111111111111" },
    status: "saved",
    title: "spec",
    updatedAt: "2026-11-04T00:00:00+00:00",
    ...overrides,
  };
}

/** True when the recorded query is a plain SELECT on `table` whose select string contains `fragment`. */
function selectsFrom(query: RecordedQuery, table: string, fragment: string): boolean {
  if (query.table !== table) {
    return false;
  }
  const writes = ["delete", "insert", "update"].some((method) =>
    query.operations.some((operation) => operation.method === method),
  );
  if (writes) {
    return false;
  }
  return query.operations.some(
    (operation) =>
      operation.method === "select" &&
      typeof operation.args[0] === "string" &&
      operation.args[0].includes(fragment),
  );
}

/** True when the recorded query is a write of the given kind on `derived_datasets`. */
function writesDerived(query: RecordedQuery, method: string): boolean {
  return query.table === "derived_datasets" && methodsOf(query).includes(method);
}

/** The save/remove edge sync's consumer_references queries (the stage-7 parity fix). */
function consumerRef(query: RecordedQuery, method: string): boolean {
  return query.table === "consumer_references" && methodsOf(query).includes(method);
}

/** The payload of the first `method` operation as a record (insert/update args). */
function payloadOf(query: RecordedQuery, method: string): Record<string, unknown> {
  const payload = firstArg(query, method);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Expected the ${method} payload to be a record.`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guards above narrow the recorded arg to `object`; the record view is the tested contract (the test-support stub's own posture toward `unknown` wire shapes).
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The pinned spec helpers (the derivedSpec.ts copies)
// ---------------------------------------------------------------------------

describe("pinned validateSpecShape — structural sanity at save time", () => {
  it("rejects non-objects, missing sources, and missing operations arrays", () => {
    expect(validateSpecShape("nope").ok).toBe(false);
    expect(validateSpecShape({ operations: [] }).ok).toBe(false);
    expect(validateSpecShape({ sourceDatasetId: "d1" }).ok).toBe(false);
    const empty = validateSpecShape({ operations: [], sourceDatasetId: "" });
    expect(empty.ok).toBe(false);
  });

  it("rejects operations without a kind and lookup ops missing a required column", () => {
    const kindless = validateSpecShape({
      operations: [{ baseKey: "id" }],
      sourceDatasetId: "d1",
    });
    expect(kindless.ok).toBe(false);
    const missingBaseKey = validateSpecShape({
      operations: [{ kind: "lookup", lookupDatasetId: "d2", lookupKey: "id" }],
      sourceDatasetId: "d1",
    });
    expect(missingBaseKey.ok).toBe(false);
  });

  it("rejects malformed optional cells (match policy, fields)", () => {
    const badMatch = validateSpecShape({
      operations: [
        { baseKey: "id", kind: "lookup", lookupDatasetId: "d2", lookupKey: "id", match: "outer" },
      ],
      sourceDatasetId: "d1",
    });
    const badFields = validateSpecShape({
      operations: [
        { baseKey: "id", fields: [42], kind: "lookup", lookupDatasetId: "d2", lookupKey: "id" },
      ],
      sourceDatasetId: "d1",
    });
    expect(badMatch.ok).toBe(false);
    expect(badFields.ok).toBe(false);
  });

  it("rejects sql ops without a query or without their table refs", () => {
    const noSql = validateSpecShape({
      operations: [{ kind: "sql", tables: [] }],
      sourceDatasetId: "d1",
    });
    const noTables = validateSpecShape({
      operations: [{ kind: "sql", sql: "select 1" }],
      sourceDatasetId: "d1",
    });
    const badTableRef = validateSpecShape({
      operations: [{ kind: "sql", sql: "select 1", tables: [{ as: "t" }] }],
      sourceDatasetId: "d1",
    });
    expect(noSql.ok).toBe(false);
    expect(noTables.ok).toBe(false);
    expect(badTableRef.ok).toBe(false);
  });

  it("passes unknown operation kinds untouched and answers the narrowed spec", () => {
    const result = validateSpecShape({
      operations: [{ kind: "rollup" }, { kind: "stage-7-future" }],
      sourceDatasetId: "d1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected a valid spec");
    }
    expect(result.spec.sourceDatasetId).toBe("d1");
    expect(result.spec.operations.length).toBe(2);
  });
});

describe("pinned specDependencies — the persisted edges' content", () => {
  it("lists the source, then lookup datasets, then sql tables — distinct, first-seen", () => {
    const deps = specDependencies({
      operations: [
        { kind: "lookup", lookupDatasetId: "b" },
        { kind: "lookup", lookupDatasetId: "b" },
        {
          kind: "sql",
          sql: "select 1",
          tables: [
            { as: "x", datasetId: "c" },
            { as: "y", datasetId: "a" },
          ],
        },
      ],
      sourceDatasetId: "a",
    });
    expect(deps).toEqual(["a", "b", "c"]);
  });

  it("ignores non-string cells and rollup operations (they name no dataset)", () => {
    const deps = specDependencies({
      operations: [
        { kind: "rollup" },
        { kind: "lookup", lookupDatasetId: 42 },
        { kind: "sql", tables: [{ as: "x" }] },
      ],
      sourceDatasetId: "a",
    });
    expect(deps).toEqual(["a"]);
  });
});

/** A stand-in registry (the derivedSpec.test.ts pattern): id → its persisted edges. */
function registryOf(
  edges: Record<string, string[]>,
): (id: string) => Promise<RegistryRowLike | null> {
  return async (id) => {
    const dependsOn = edges[id];
    return dependsOn === undefined ? null : { dependsOn };
  };
}

describe("pinned findCycleToOrigin — the save-time cycle walk", () => {
  it("refuses A→B→A", async () => {
    const cycle = await findCycleToOrigin("a", ["b"], registryOf({ b: ["a"] }));
    expect(cycle).toBe("a");
  });

  it("refuses a self-reference", async () => {
    const cycle = await findCycleToOrigin("a", ["a"], registryOf({}));
    expect(cycle).toBe("a");
  });

  it("walks through registry rows only and visits shared branches once", async () => {
    let bReads = 0;
    const lookup = async (id: string): Promise<RegistryRowLike | null> => {
      if (id === "b") {
        bReads += 1;
        return { dependsOn: ["c", "a"] };
      }
      if (id === "c") {
        return { dependsOn: ["b"] };
      }
      return null; // component dataset ids are opaque — the walk stops
    };
    const cycle = await findCycleToOrigin("a", ["b"], lookup);
    expect(cycle).toBe("a");
    expect(bReads).toBe(1);
  });

  it("answers undefined when no chain reaches the origin", async () => {
    const cycle = await findCycleToOrigin("origin", ["b"], registryOf({ b: ["c"], c: [] }));
    expect(cycle).toBeUndefined();
  });
});

describe("pinned specStatus — compute-on-read health", () => {
  it("answers ready when every reference resolves with its columns intact", async () => {
    const report = await specStatus(
      {
        operations: [{ kind: "lookup", lookupDatasetId: "b", lookupKey: "id" }],
        sourceDatasetId: "a",
      },
      async (id) =>
        id === "a"
          ? { kind: "component", properties: ["id", "name"], title: "base" }
          : { kind: "component", properties: ["id"], title: "side" },
    );
    expect(report.health).toBe("ready");
  });

  it("answers orphaned when a referenced dataset is gone", async () => {
    const report = await specStatus({ operations: [], sourceDatasetId: "vanished" }, async () => ({
      kind: "missing",
    }));
    expect(report.health).toBe("orphaned");
  });

  it("answers stale when a picked field no longer exists on the source", async () => {
    const report = await specStatus(
      {
        operations: [{ kind: "lookup", fields: ["name"], lookupDatasetId: "b", lookupKey: "id" }],
        sourceDatasetId: "a",
      },
      async (id) => {
        if (id === "a") {
          return { kind: "component", properties: ["id"], title: "base" };
        }
        return { kind: "component", properties: ["id"], title: "side" };
      },
    );
    expect(report.health).toBe("stale");
    expect(present(report.reason)).toContain("name");
  });

  it("inherits a derived source's health transitively", async () => {
    const report = await specStatus(
      { operations: [], sourceDatasetId: "derived-1" },
      async (id) => {
        if (id === "derived-1") {
          return {
            kind: "registry",
            spec: { operations: [], sourceDatasetId: "vanished" },
            title: "upstream",
          };
        }
        return { kind: "missing" };
      },
    );
    expect(report.health).toBe("orphaned");
    expect(present(report.reason)).toContain("upstream");
  });
});

// ---------------------------------------------------------------------------
// save — the builder upsert
// ---------------------------------------------------------------------------

describe("derived.save — insert path", () => {
  it("classifies a dataset source into source_dataset_id and inserts the denormalized edges", async () => {
    const datasetSource = randomUUID();
    const stub = stubSupabase((query) => {
      // The cycle lookup branch is never hit on the insert path (inserts
      // cannot close a cycle), but the dispatcher stays exhaustive.
      if (selectsFrom(query, "derived_datasets", "dependsOn:depends_on")) {
        return { data: null };
      }
      if (selectsFrom(query, "derived_datasets", "id")) {
        return { data: null }; // source leg 1: not a registry row
      }
      if (selectsFrom(query, "datasets", "id")) {
        return { data: { id: datasetSource } }; // source leg 2: a dataset
      }
      if (writesDerived(query, "insert")) {
        return { data: { id: "new-row-id" } };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    const id = await save(
      {
        description: "kept",
        spec: { operations: [], sourceDatasetId: datasetSource },
        status: "draft",
        title: "  trimmed  ",
      },
      { supabase: stub.client },
    );

    expect(id).toBe("new-row-id");
    // Three queries: the registry probe, the datasets probe, the insert.
    expect(stub.queries.length).toBe(3);
    expect(selectsFrom(queryAt(stub.queries, 0), "derived_datasets", "id")).toBe(true);
    expect(selectsFrom(queryAt(stub.queries, 1), "datasets", "id")).toBe(true);
    const insert = payloadOf(queryAt(stub.queries, 2), "insert");
    expect(insert.title).toBe("trimmed");
    expect(insert.status).toBe("draft");
    expect(insert.description).toBe("kept");
    expect(insert.source_dataset_id).toBe(datasetSource);
    expect(insert.source_derived_id).toBeNull();
    expect(insert.depends_on).toEqual([datasetSource]);
    expect(insert.spec).toEqual({ operations: [], sourceDatasetId: datasetSource });
  });

  it("stores a null description when none was given (the only-required-field rule)", async () => {
    const datasetSource = randomUUID();
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "id")) {
        return { data: null }; // registry probe misses
      }
      if (selectsFrom(query, "datasets", "id")) {
        return { data: { id: datasetSource } }; // datasets probe hits
      }
      if (writesDerived(query, "insert")) {
        return { data: { id: "new-row-id" } };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    await save(
      { spec: { operations: [], sourceDatasetId: datasetSource }, status: "draft", title: "t" },
      { supabase: stub.client },
    );
    const insert = payloadOf(queryAt(stub.queries, 2), "insert");
    expect(insert.description).toBeNull();
  });

  it("classifies a registry source into source_derived_id (derived-of-derived)", async () => {
    const derivedId = randomUUID();
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "id")) {
        return { data: { id: derivedId } }; // the source IS a registry row
      }
      if (writesDerived(query, "insert")) {
        return { data: { id: "new-row-id" } };
      }
      // The SAVED save's edge sync probes the datasets leg for the dep (a
      // registry row is no DATASET — the FK makes derived-of-derived edges
      // unrepresentable — so no edge insert follows).
      if (selectsFrom(query, "consumer_references", "id")) {
        return { data: [] };
      }
      if (selectsFrom(query, "datasets", "id")) {
        return { data: null };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    await save(
      { spec: { operations: [], sourceDatasetId: derivedId }, status: "saved", title: "stacked" },
      { supabase: stub.client },
    );

    // Four queries: the registry probe (hit), the insert, then the edge
    // sync's consumer_references select + datasets probe (which answers
    // null — no edge). The source classification NEVER probed datasets.
    const insert = payloadOf(queryAt(stub.queries, 1), "insert");
    expect(insert.source_derived_id).toBe(derivedId);
    expect(insert.source_dataset_id).toBeNull();
    expect(insert.depends_on).toEqual([derivedId]);
    expect(stub.queries.slice(0, 2).some((query) => query.table === "datasets")).toBe(false);
    expect(stub.queries.slice(3).some((query) => consumerRef(query, "insert"))).toBe(false);
  });

  it("refuses a source that resolves to neither a visible registry row nor a dataset", async () => {
    const stub = stubSupabase((query) => {
      if (query.table === "derived_datasets" || query.table === "datasets") {
        return { data: null };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    await expect(
      save(
        { spec: { operations: [], sourceDatasetId: randomUUID() }, status: "draft", title: "x" },
        { supabase: stub.client },
      ),
    ).rejects.toThrow(
      // Stage 7 (tranche-3 refusal-copy fix): the RLS-scoped store cannot
      // tell WHICH table hides an invisible id, so the message names both.
      "That dataset or transform doesn't exist or you don't have access to it.",
    );
  });

  it("enforces the Convex title/description/spec gates before any query", async () => {
    const stub = stubSupabase();
    await expect(
      save({ spec: {}, status: "draft", title: "   " }, { supabase: stub.client }),
    ).rejects.toThrow("Give the transform a title.");
    await expect(
      save(
        { description: "   ", spec: {}, status: "draft", title: "t" },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("Leave the description empty instead of blank.");
    await expect(
      save(
        {
          spec: { operations: [{ kind: "lookup", lookupKey: "k" }], sourceDatasetId: "d1" },
          status: "draft",
          title: "t",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("A lookup operation is missing its baseKey.");
    expect(stub.queries.length).toBe(0);
  });
});

describe("derived.save — update path (cycle rejection + lockstep source)", () => {
  const rowId = randomUUID();
  const otherId = randomUUID();

  it("walks depends_on and refuses A→B→A before any write", async () => {
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: wireRow(rowId, { dependsOn: [otherId] }) }; // the existing row A
      }
      if (selectsFrom(query, "derived_datasets", "dependsOn:depends_on")) {
        return { data: { dependsOn: [rowId] } }; // row B reads back to A
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    await expect(
      save(
        {
          id: rowId,
          spec: { operations: [], sourceDatasetId: otherId },
          status: "draft",
          title: "cycled",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow(
      "Saving this transform would create a circular dependency — it reads from a dataset that (through other derived datasets) reads from this one.",
    );
    // No write left the client.
    expect(stub.queries.some((query) => methodsOf(query).includes("update"))).toBe(false);
  });

  it("refuses a self-referencing update", async () => {
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: wireRow(rowId) };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    await expect(
      save(
        {
          id: rowId,
          spec: { operations: [], sourceDatasetId: rowId },
          status: "draft",
          title: "self",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("circular dependency");
    expect(stub.queries.some((query) => methodsOf(query).includes("update"))).toBe(false);
  });

  it("updates the source columns in lockstep with the retargeted spec", async () => {
    const newSourceId = randomUUID();
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: wireRow(rowId) }; // [0] the existing row
      }
      if (selectsFrom(query, "derived_datasets", "dependsOn:depends_on")) {
        return { data: null }; // [1] the cycle lookup on the new source
      }
      if (selectsFrom(query, "derived_datasets", "id")) {
        return { data: null }; // [2] source leg 1: not a registry row
      }
      if (selectsFrom(query, "datasets", "id")) {
        return { data: { id: newSourceId } }; // [3] source leg 2: a dataset — also the edge sync's dataset probe
      }
      if (writesDerived(query, "update")) {
        return { data: [{ id: rowId }] }; // [4] the write lands
      }
      if (selectsFrom(query, "consumer_references", "id")) {
        return { data: [] }; // [5] the edge sync: no surviving edges
      }
      if (consumerRef(query, "insert")) {
        return { data: [{ id: "edge-1" }] }; // [7] the float edge lands (after the datasets probe)
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    const saved = await save(
      {
        description: "retargeted",
        id: rowId,
        spec: { operations: [], sourceDatasetId: newSourceId },
        status: "saved",
        title: "moved",
      },
      { supabase: stub.client },
    );
    expect(saved).toBe(rowId);

    // Stage 7: the SAVED save now also syncs the spec's consumer_references
    // float edges (the tranche-3 parity fix) — select, datasets probe, and
    // one insert follow the update.
    expect(stub.queries.length).toBe(8);
    const update = payloadOf(queryAt(stub.queries, 4), "update");
    expect(update.source_dataset_id).toBe(newSourceId);
    expect(update.source_derived_id).toBeNull();
    expect(update.depends_on).toEqual([newSourceId]);
    expect(update.status).toBe("saved");
    expect(update.title).toBe("moved");
    expect(update.description).toBe("retargeted");
    const edge = payloadOf(queryAt(stub.queries, 7), "insert");
    expect(edge).toEqual({
      consumer_id: rowId,
      consumer_kind: "derived",
      mode: "float",
      source_dataset_id: newSourceId,
    });
  });

  it("answers the missing-row message when the id reads as gone", async () => {
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: null }; // invisible: gone, or a foreign draft
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    await expect(
      save(
        {
          id: rowId,
          spec: { operations: [], sourceDatasetId: randomUUID() },
          status: "draft",
          title: "x",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("This transform no longer exists — it may have been deleted.");
    expect(stub.queries.length).toBe(1);
  });

  it("answers the access message when a visible row denies the update (0 rows — the foreign SAVED row)", async () => {
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: wireRow(rowId) }; // RLS-VISIBLE (a foreign SAVED row)
      }
      if (selectsFrom(query, "derived_datasets", "dependsOn:depends_on")) {
        return { data: null };
      }
      if (selectsFrom(query, "derived_datasets", "id")) {
        return { data: null };
      }
      if (selectsFrom(query, "datasets", "id")) {
        return { data: { id: randomUUID() } };
      }
      if (writesDerived(query, "update")) {
        return { data: [] }; // the creator-only policy filtered the write
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    await expect(
      save(
        {
          id: rowId,
          spec: { operations: [], sourceDatasetId: randomUUID() },
          status: "draft",
          title: "x",
        },
        { supabase: stub.client },
      ),
    ).rejects.toThrow("That transform doesn't exist or you don't have access to it.");
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("derived.listBySourceQueryOptions", () => {
  it("reads one RLS-scoped or() query over both source legs, newest first, capped", async () => {
    const sourceId = randomUUID();
    const savedRow = wireRow(randomUUID(), {
      sourceDatasetId: sourceId,
      spec: {
        operations: [{ kind: "sql", sql: "select 1", tables: [] }],
        sourceDatasetId: sourceId,
      },
    });
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return {
          data: [
            savedRow,
            wireRow(randomUUID(), {
              sourceDatasetId: null,
              sourceDerivedId: sourceId,
              status: "draft",
            }),
          ],
        };
      }
      if (selectsFrom(query, "derived_datasets", "spec,title")) {
        return { data: null };
      }
      if (selectsFrom(query, "datasets", "properties,title")) {
        return { data: { properties: ["name"], title: "base" } };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });

    const rows = await runQueryOptions(
      listBySourceQueryOptions({ sourceDatasetId: sourceId }, { supabase: stub.client }),
    );

    const read = queryAt(stub.queries, 0);
    expect(String(firstArg(read, "or"))).toBe(
      `source_dataset_id.eq.${sourceId},source_derived_id.eq.${sourceId}`,
    );
    expect(argsOf(read, "order")).toEqual(["created_at", { ascending: false }]);
    expect(argsOf(read, "limit")).toEqual([LIST_BY_SOURCE_MAX]);

    expect(rows.length).toBe(2);
    const first = at(rows, 0);
    expect(first.sourceDatasetId).toBe(sourceId);
    expect(first.carriesSql).toBe(true);
    expect(first.health).toBe("ready");
    const second = at(rows, 1);
    expect(second.sourceDatasetId).toBe(sourceId);
    expect(second.status).toBe("draft");
    expect(second.carriesSql).toBe(false);
  });

  it("answers empty for a non-uuid source id without issuing a query (the filter-injection guard)", async () => {
    const stub = stubSupabase();
    const rows = await runQueryOptions(
      listBySourceQueryOptions({ sourceDatasetId: "junk'); drop" }, { supabase: stub.client }),
    );
    expect(rows).toEqual([]);
    expect(stub.queries.length).toBe(0);
  });

  it("surfaces orphaned health when a source vanished", async () => {
    const sourceId = randomUUID();
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: [wireRow(randomUUID())] };
      }
      if (selectsFrom(query, "derived_datasets", "spec,title")) {
        return { data: null };
      }
      if (selectsFrom(query, "datasets", "properties,title")) {
        return { data: null };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    const rows = await runQueryOptions(
      listBySourceQueryOptions({ sourceDatasetId: sourceId }, { supabase: stub.client }),
    );
    expect(rows.length).toBe(1);
    expect(at(rows, 0).health).toBe("orphaned");
  });
});

describe("derived.summariesQueryOptions", () => {
  it("reads SAVED rows only (the draft filter is load-bearing), bounded at 500", async () => {
    const stub = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: [] };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    const rows = await runQueryOptions(summariesQueryOptions({ supabase: stub.client }));
    expect(rows).toEqual([]);
    const read = queryAt(stub.queries, 0);
    expect(argsOf(read, "eq")).toEqual(["status", "saved"]);
    expect(argsOf(read, "limit")).toEqual([SUMMARIES_READ_LIMIT]);
    expect(argsOf(read, "order")).toEqual(["created_at", { ascending: false }]);
  });
});

describe("derived.getQueryOptions", () => {
  it("returns the full row with computed health, and null when RLS hides it", async () => {
    const id = randomUUID();
    const hidden = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: null };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    const nothing = await runQueryOptions(getQueryOptions({ id }, { supabase: hidden.client }));
    expect(nothing).toBeNull();

    const visible = stubSupabase((query) => {
      if (selectsFrom(query, "derived_datasets", "sourceDerivedId")) {
        return { data: wireRow(id) };
      }
      if (selectsFrom(query, "derived_datasets", "spec,title")) {
        return { data: null };
      }
      if (selectsFrom(query, "datasets", "properties,title")) {
        return { data: { properties: ["name"], title: "base" } };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    const row = present(
      await runQueryOptions(getQueryOptions({ id }, { supabase: visible.client })),
    );
    expect(row.id).toBe(id);
    expect(row.status).toBe("saved");
    expect(row.health).toBe("ready");
    expect(row.healthReason).toBeUndefined();
  });
});

describe("derived.remove", () => {
  it("returns the affected row count (0 = denied or gone), edges first", async () => {
    const id = randomUUID();
    // Stage 7 (tranche-3 parity fix): the row's consumer_references edges go
    // FIRST — consumer_id is text with no FK, so the row cascade cannot
    // reach them — then the row itself.
    const stub = stubSupabase((query) => {
      if (consumerRef(query, "delete")) {
        return { data: [{ id: "edge-1" }, { id: "edge-2" }] }; // [0] the edges go
      }
      if (writesDerived(query, "delete")) {
        return { data: [{ id }] }; // [1] the row lands
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    const affected = await remove({ id }, { supabase: stub.client });
    expect(affected).toBe(1);
    const edges = queryAt(stub.queries, 0);
    expect(edges.table).toBe("consumer_references");
    expect(argsOf(edges, "eq")).toEqual(["consumer_id", id]);
    const del = queryAt(stub.queries, 1);
    expect(argsOf(del, "eq")).toEqual(["id", id]);
    expect(firstArg(del, "select")).toBe("id");

    const deniedStub = stubSupabase((query) => {
      if (consumerRef(query, "delete") || writesDerived(query, "delete")) {
        return { data: [] };
      }
      throw new Error(`unexpected query: ${query.table ?? query.rpc} (${methodsOf(query)})`);
    });
    expect(await remove({ id }, { supabase: deniedStub.client })).toBe(0);
  });
});

describe("derived row helpers", () => {
  it("sourceIdOf answers whichever source column is set", () => {
    const datasetSource = randomUUID();
    const derivedSource = randomUUID();
    expect(sourceIdOf(wireRow(randomUUID(), { sourceDatasetId: datasetSource }))).toBe(
      datasetSource,
    );
    expect(
      sourceIdOf(wireRow(randomUUID(), { sourceDatasetId: null, sourceDerivedId: derivedSource })),
    ).toBe(derivedSource);
    expect(() =>
      sourceIdOf(wireRow(randomUUID(), { sourceDatasetId: null, sourceDerivedId: null })),
    ).toThrow(/no source/);
  });

  it("specCarriesSql reads the sql kind structurally", () => {
    expect(specCarriesSql({ operations: [{ kind: "sql", sql: "select 1", tables: [] }] })).toBe(
      true,
    );
    expect(specCarriesSql({ operations: [{ kind: "lookup" }] })).toBe(false);
    expect(specCarriesSql({ operations: "not-an-array" })).toBe(false);
    expect(specCarriesSql(null)).toBe(false);
  });
});
