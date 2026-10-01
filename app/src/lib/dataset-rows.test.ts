import { describe, expect, it, vi } from "vitest";

import {
  applyEntryRowSpec,
  applyEntryRowSpecs,
  applyGeometryRowSpec,
  applyGeometryRowSpecs,
  type DatasetEntryRow,
  type DatasetGeometryRow,
  ENTRIES_FETCH_PAGE_SIZE,
  ENTRIES_PAGE_SIZE,
  entryDataRecord,
  forEachDatasetEntryPage,
  forEachDatasetGeometryPage,
  fetchDatasetEntryRows,
  fetchDatasetGeometryRows,
  GEOMETRY_PAGE_ROWS,
  lookupOperationsOfSpec,
  sharedClient,
} from "./dataset-rows";

// The seam derives its client lazily from `#/env`; the tests inject a stub
// client instead, so the env module never has to load.
vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

// The shared client's auth policy (#133 item 6) is exercised against a
// recording ConvexClient stand-in and a scripted token endpoint.
const convexStands = vi.hoisted(() => ({
  constructed: [] as Array<{ setAuth: ReturnType<typeof vi.fn> }>,
  nextToken: "token-1" as string | null,
}));
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    setAuth = vi.fn<(...args: unknown[]) => void>();
    constructor() {
      convexStands.constructed.push(this);
    }
  },
}));
vi.mock("#/lib/auth-client", () => ({
  authClient: {
    convex: {
      token: async () => ({
        data: convexStands.nextToken === null ? null : { token: convexStands.nextToken },
      }),
    },
  },
}));

/** A scripted ConvexClient stand-in: hands out `pages` in call order and records each query's args. */
function stubClient(pages: Array<{ continueCursor?: string; isDone?: boolean }>) {
  const calls: Array<unknown>[] = [];
  let served = 0;
  const client = {
    query: async (
      _fn: unknown,
      args: unknown,
    ): Promise<{ continueCursor: string; isDone: boolean; page: unknown[] }> => {
      calls.push([_fn, args]);
      const page = pages[Math.min(served, pages.length - 1)];
      served += 1;
      return {
        continueCursor: `cursor-${served}`,
        isDone: false,
        page: [],
        ...page,
      };
    },
  };
  return { calls, client };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the seam only touches `.query`, which the stub implements.
const asClient = (client: object) =>
  client as Parameters<typeof fetchDatasetEntryRows>[1] extends { convex?: infer C } ? C : never;

function entryRow(id: string): DatasetEntryRow {
  return {
    _creationTime: 0,
    _id: id,
    data: { id },
    schemaId: "schema-1",
  };
}

function geometryRow(id: string): DatasetGeometryRow {
  return {
    _creationTime: 0,
    _id: id,
    entryId: "entry-1",
    geometryJson: `{"type":"Point","coordinates":[0,${id.length}]}`,
    schemaId: "schema-1",
    type: "Point",
  };
}

describe("ENTRIES_PAGE_SIZE", () => {
  it("stays at the persisted query-hash value (200) — the light-state store keys on it", () => {
    expect(ENTRIES_PAGE_SIZE).toBe(200);
  });
});

describe("ENTRIES_FETCH_PAGE_SIZE / GEOMETRY_PAGE_ROWS", () => {
  it("match the shipped one-shot page sizes (the server clamps at 500)", () => {
    expect(ENTRIES_FETCH_PAGE_SIZE).toBe(500);
    expect(GEOMETRY_PAGE_ROWS).toBe(500);
  });
});

/** One recorded query call, narrowed to the pagination args the seam sends. */
function recordedArgs(call: unknown): {
  order?: "asc" | "desc";
  paginationOpts: { cursor: string | null; numItems: number };
  schemaId: string;
} {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only narrowing of the recorded stub call.
  return call as {
    order?: "asc" | "desc";
    paginationOpts: { cursor: string | null; numItems: number };
    schemaId: string;
  };
}

describe("forEachDatasetEntryPage", () => {
  it("chains cursors from null and stops at isDone, handing pages through in order", async () => {
    const { calls, client } = stubClient([
      { continueCursor: "cursor-a", isDone: false },
      { continueCursor: "cursor-b", isDone: true },
    ]);
    const seen: DatasetEntryRow[][] = [];
    await forEachDatasetEntryPage(
      "schema-1",
      (rows) => {
        seen.push(rows);
      },
      { convex: asClient(client) },
    );
    expect(seen).toStrictEqual([[], []]);
    // Primitive (not `toHaveLength(calls)`) so a failure never prints the
    // recorded array containing an `anyApi` proxy object.
    expect(calls.length).toBe(2);
    // Which endpoint runs is pinned by the seam's source (grep-verifiable):
    // the generated `api` is `anyApi`, whose property accesses each hand back
    // a fresh proxy object, so reference identity can't be asserted here —
    // and pretty-printing one crashes the differ. The pagination ARGS are the
    // byte-identical-export contract; assert those.
    expect(recordedArgs(calls[0][1])).toStrictEqual({
      order: undefined,
      paginationOpts: { cursor: null, numItems: ENTRIES_FETCH_PAGE_SIZE },
      schemaId: "schema-1",
    });
    expect(recordedArgs(calls[1][1])).toStrictEqual({
      order: undefined,
      paginationOpts: { cursor: "cursor-a", numItems: ENTRIES_FETCH_PAGE_SIZE },
      schemaId: "schema-1",
    });
  });

  it("forwards the requested entry order (the group export's ascending byte-identity contract)", async () => {
    const { calls, client } = stubClient([{ isDone: true }]);
    await forEachDatasetEntryPage("schema-1", () => undefined, {
      convex: asClient(client),
      entryOrder: "asc",
    });
    expect(recordedArgs(calls[0][1])).toStrictEqual({
      order: "asc",
      paginationOpts: { cursor: null, numItems: ENTRIES_FETCH_PAGE_SIZE },
      schemaId: "schema-1",
    });
  });

  it("never queries past isDone", async () => {
    const { calls, client } = stubClient([{ isDone: true }]);
    await forEachDatasetEntryPage("schema-1", () => undefined, { convex: asClient(client) });
    expect(calls.length).toBe(1);
  });
});

describe("forEachDatasetGeometryPage", () => {
  it("chains cursors from the empty string and pages at GEOMETRY_PAGE_ROWS", async () => {
    const { calls, client } = stubClient([
      { continueCursor: "cursor-a", isDone: false },
      { continueCursor: "cursor-b", isDone: true },
    ]);
    const seen: DatasetGeometryRow[][] = [];
    await forEachDatasetGeometryPage(
      "schema-1",
      (rows) => {
        seen.push(rows);
      },
      { convex: asClient(client) },
    );
    expect(seen).toStrictEqual([[], []]);
    expect(recordedArgs(calls[0][1])).toStrictEqual({
      paginationOpts: { cursor: "", numItems: GEOMETRY_PAGE_ROWS },
      schemaId: "schema-1",
    });
    expect(recordedArgs(calls[1][1])).toStrictEqual({
      paginationOpts: { cursor: "cursor-a", numItems: GEOMETRY_PAGE_ROWS },
      schemaId: "schema-1",
    });
  });
});

describe("fetchDatasetEntryRows / fetchDatasetGeometryRows", () => {
  it("accumulate every entry page's rows in page order, exactly once", async () => {
    const realRows = [[entryRow("e1"), entryRow("e2")], [entryRow("e3")]];
    const scripted = stubClient(
      realRows.map((_, index) => ({ isDone: index === realRows.length - 1 })),
    );
    scripted.client.query = async () => {
      const next = realRows.shift();
      return { continueCursor: "next", isDone: realRows.length === 0, page: next ?? [] };
    };
    const rows = await fetchDatasetEntryRows("schema-1", { convex: asClient(scripted.client) });
    expect(rows.map((row) => row._id)).toStrictEqual(["e1", "e2", "e3"]);
  });

  it("accumulate geometry rows in page order", async () => {
    const realRows = [[geometryRow("g1")], [geometryRow("g2"), geometryRow("g3")]];
    const scripted = stubClient(
      realRows.map((_, index) => ({ isDone: index === realRows.length - 1 })),
    );
    scripted.client.query = async () => {
      const next = realRows.shift();
      return { continueCursor: "next", isDone: realRows.length === 0, page: next ?? [] };
    };
    const rows = await fetchDatasetGeometryRows("schema-1", { convex: asClient(scripted.client) });
    expect(rows.map((row) => row._id)).toStrictEqual(["g1", "g2", "g3"]);
  });
});

describe("spec stubs", () => {
  it("are identity — same rows, same reference — until specs are handed in", () => {
    const entries = [entryRow("e1")];
    const geometries = [geometryRow("g1")];
    expect(applyEntryRowSpecs(entries)).toBe(entries);
    expect(applyEntryRowSpec(entries[0])).toBe(entries[0]);
    expect(applyGeometryRowSpecs(geometries)).toBe(geometries);
    expect(applyGeometryRowSpec(geometries[0])).toBe(geometries[0]);
  });
});

// ---------------------------------------------------------------------------
// applyEntryRowSpec — the popup executor (issue #97, ADR 0005 addendum)
// ---------------------------------------------------------------------------

/** One stored lookup operation, in its registry shape (spec is stored as `v.any()`). */
function lookupOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "lookup",
    baseKey: "grantId",
    lookupDatasetId: "grants",
    lookupKey: "id",
    ...overrides,
  };
}

/** One stored spec: the source dataset plus its operations, exactly as `save` persists it. */
function storedSpec(operations: unknown[]): unknown {
  return { sourceDatasetId: "schema-1", operations };
}

function entryWithData(id: string, data: unknown): DatasetEntryRow {
  return { ...entryRow(id), data };
}

describe("applyEntryRowSpec — the popup executor", () => {
  it("enriches the clicked entry with namespaced fields, base keys intact, input untouched", () => {
    const row = entryWithData("e1", { grantId: "G1", site: "Dock A" }),
      specs = [storedSpec([lookupOp({ fields: ["status", "region"] })])],
      sides = new Map([["grants", [{ id: "G1", status: "open", region: "west" }]]]);
    const enriched = applyEntryRowSpec(row, specs, sides);
    expect(enriched.data).toStrictEqual({
      grantId: "G1",
      site: "Dock A",
      "grants.status": "open",
      "grants.region": "west",
    });
    // Engine purity through the seam: the clicked entry is never mutated.
    expect(row.data).toStrictEqual({ grantId: "G1", site: "Dock A" });
  });

  it("renders an unmatched key as null for every enrichment field — never an error", () => {
    const row = entryWithData("e1", { grantId: "GX" }),
      specs = [storedSpec([lookupOp({ fields: ["status"] })])],
      sides = new Map([["grants", [{ id: "G1", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "GX",
      "grants.status": null,
    });
  });

  it("joins number/string key forms per the 0.4 hygiene policy", () => {
    const row = entryWithData("e1", { grantId: 42 }),
      specs = [storedSpec([lookupOp({ fields: ["status"] })])],
      sides = new Map([["grants", [{ id: " 42 ", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: 42,
      "grants.status": "open",
    });
  });

  it("treats omitted fields as the engine's omit-means-all union (as stored, §11)", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [storedSpec([lookupOp()])],
      sides = new Map([["grants", [{ id: "G1", status: "open", region: "west" }]]]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "G1",
      "grants.status": "open",
      "grants.region": "west",
    });
  });

  it("uses the op's namespace override when the spec sets one", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [storedSpec([lookupOp({ namespace: "grant details", fields: ["status"] })])],
      sides = new Map([["grants", [{ id: "G1", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "G1",
      "grant details.status": "open",
    });
  });

  it("folds ALL matching specs in order and later enrichment wins same-named keys", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [
        storedSpec([
          lookupOp({ lookupDatasetId: "grantsA", namespace: "grant", fields: ["status"] }),
        ]),
        storedSpec([
          lookupOp({ lookupDatasetId: "grantsB", namespace: "grant", fields: ["status"] }),
        ]),
      ],
      sides = new Map([
        ["grantsA", [{ id: "G1", status: "first" }]],
        ["grantsB", [{ id: "G1", status: "second" }]],
      ]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "G1",
      "grant.status": "second",
    });
  });

  it("chains a spec onto the previous spec's output (derived-of-derived shape)", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [
        storedSpec([lookupOp({ lookupDatasetId: "grants", fields: ["status"] })]),
        storedSpec([
          lookupOp({
            baseKey: "grants.status",
            lookupDatasetId: "statuses",
            lookupKey: "code",
            namespace: "label",
            fields: ["text"],
          }),
        ]),
      ],
      sides = new Map([
        ["grants", [{ id: "G1", status: "open" }]],
        ["statuses", [{ code: "open", text: "Open" }]],
      ]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "G1",
      "grants.status": "open",
      "label.text": "Open",
    });
  });

  it("skips unknown operation kinds without dropping the lookup beside them", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [
        storedSpec([
          { kind: "rollup", groupBy: ["grantId"] }, // stage 4's kind, unreadable today
          lookupOp({ fields: ["status"] }),
        ]),
      ],
      sides = new Map([["grants", [{ id: "G1", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides).data).toStrictEqual({
      grantId: "G1",
      "grants.status": "open",
    });
  });

  it("returns the row untouched when an operation's side has not streamed", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      specs = [storedSpec([lookupOp({ fields: ["status"] })])];
    expect(applyEntryRowSpec(row, specs, new Map())).toBe(row);
  });

  it("returns the row untouched when a non-record data shape can hold no join key", () => {
    const row = entryWithData("e1", ["not", "a", "record"]),
      specs = [storedSpec([lookupOp({ fields: ["status"] })])],
      sides = new Map([["grants", [{ id: "G1", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides)).toBe(row);
  });

  it("keeps the base row on an inner-match miss — a popup is never dropped", () => {
    const row = entryWithData("e1", { grantId: "GX" }),
      specs = [storedSpec([lookupOp({ match: "inner", fields: ["status"] })])],
      sides = new Map([["grants", [{ id: "G1", status: "open" }]]]);
    expect(applyEntryRowSpec(row, specs, sides)).toBe(row);
  });

  it("skips only the conflicting operation when onDuplicateKey is error — still no dropped popup", () => {
    const row = entryWithData("e1", { grantId: "G1" }),
      conflicting = storedSpec([lookupOp({ onDuplicateKey: "error", fields: ["status"] })]),
      sides = new Map([
        [
          "grants",
          [
            { id: "G1", status: "first" },
            { id: "G1", status: "second" },
          ],
        ],
      ]);
    expect(applyEntryRowSpec(row, [conflicting], sides)).toBe(row);
  });

  it("is identity when no specs are handed in, even with a record data shape", () => {
    const row = entryWithData("e1", { grantId: "G1" });
    expect(applyEntryRowSpec(row)).toBe(row);
    expect(applyEntryRowSpec(row, [], new Map([["grants", [{ id: "G1" }]]]))).toBe(row);
  });
});

describe("entryDataRecord", () => {
  it("adapts object data as the engine's record and non-object data as keyless", () => {
    expect(entryDataRecord(entryWithData("e1", { a: 1 }))).toStrictEqual({ a: 1 });
    expect(entryDataRecord(entryWithData("e1", [1, 2]))).toStrictEqual({});
    expect(entryDataRecord(entryWithData("e1", "text"))).toStrictEqual({});
  });
});

describe("lookupOperationsOfSpec", () => {
  it("reads well-formed lookup operations structurally, defaults and all", () => {
    const operations = lookupOperationsOfSpec(
      storedSpec([lookupOp({ namespace: "grants", match: "inner", onDuplicateKey: "last" })]),
    );
    expect(operations).toStrictEqual([
      {
        kind: "lookup",
        baseKey: "grantId",
        lookupDatasetId: "grants",
        lookupKey: "id",
        fields: undefined,
        match: "inner",
        namespace: "grants",
        onDuplicateKey: "last",
      },
    ]);
  });

  it("skips shapeless specs, malformed lookups, and bad optional cells", () => {
    expect(lookupOperationsOfSpec(undefined)).toStrictEqual([]);
    expect(lookupOperationsOfSpec("nope")).toStrictEqual([]);
    expect(lookupOperationsOfSpec({ operations: "not-an-array" })).toStrictEqual([]);
    expect(lookupOperationsOfSpec(storedSpec([{ kind: "lookup", baseKey: "a" }]))).toStrictEqual(
      [],
    );
    // Every optional cell is strict when present: malformed fields, match,
    // namespace or onDuplicateKey skips the operation instead of quietly
    // falling back to the engine default.
    expect(lookupOperationsOfSpec(storedSpec([lookupOp({ fields: ["ok", 42] })]))).toStrictEqual(
      [],
    );
    expect(lookupOperationsOfSpec(storedSpec([lookupOp({ match: "outer" })]))).toStrictEqual([]);
    expect(lookupOperationsOfSpec(storedSpec([lookupOp({ namespace: "" })]))).toStrictEqual([]);
    expect(
      lookupOperationsOfSpec(storedSpec([lookupOp({ onDuplicateKey: "firstish" })])),
    ).toStrictEqual([]);
  });
});

function attachedAuthOf(): {
  fetcher: () => Promise<string | null>;
  setAuth: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
} {
  const record = convexStands.constructed[0],
    call = record === undefined ? undefined : record.setAuth.mock.calls[0];
  if (record === undefined || call === undefined) {
    throw new Error("the shared client was never constructed with auth attached");
  }
  return {
    fetcher:
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the recorded attachment is the one-argument token fetcher.
      call[0] as () => Promise<string | null>,
    setAuth: record.setAuth,
  };
}

describe("sharedClient — auth attaches once, re-arms only after a null token (#133 item 6)", () => {
  it("constructs ONE client across calls and calls setAuth exactly once", () => {
    const first = sharedClient(),
      second = sharedClient();
    expect(second).toBe(first);
    expect(convexStands.constructed).toHaveLength(1);
    expect(attachedAuthOf().setAuth).toHaveBeenCalledTimes(1);
  });

  it("re-arms the fetcher only after the token comes back null", async () => {
    const { fetcher, setAuth } = attachedAuthOf();
    // A token return leaves the single attachment alone.
    await expect(fetcher()).resolves.toBe("token-1");
    expect(setAuth).toHaveBeenCalledTimes(1);
    // A null (signed out NOW) re-arms — the sign-in-without-reload path.
    convexStands.nextToken = null;
    await expect(fetcher()).resolves.toBe(null);
    expect(setAuth).toHaveBeenCalledTimes(2);
    // The re-armed fetcher answers a fresh session without a third attach.
    convexStands.nextToken = "token-2";
    const refetched = attachedAuthOf().fetcher;
    await expect(refetched()).resolves.toBe("token-2");
    expect(setAuth).toHaveBeenCalledTimes(2);
  });
});
