import { describe, expect, it, vi } from "vitest";

import {
  applyEntryRowSpec,
  applyEntryRowSpecs,
  applyGeometryRowSpec,
  applyGeometryRowSpecs,
  ENTRIES_FETCH_PAGE_SIZE,
  ENTRIES_PAGE_SIZE,
  forEachDatasetEntryPage,
  forEachDatasetGeometryPage,
  fetchDatasetEntryRows,
  fetchDatasetGeometryRows,
  GEOMETRY_PAGE_ROWS,
  type DatasetEntryRow,
  type DatasetGeometryRow,
} from "./dataset-rows";

// The seam derives its client lazily from `#/env`; the tests inject a stub
// client instead, so the env module never has to load.
vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

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
  paginationOpts: { cursor: string | null; numItems: number };
  schemaId: string;
} {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only narrowing of the recorded stub call.
  return call as { paginationOpts: { cursor: string | null; numItems: number }; schemaId: string };
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
      paginationOpts: { cursor: null, numItems: ENTRIES_FETCH_PAGE_SIZE },
      schemaId: "schema-1",
    });
    expect(recordedArgs(calls[1][1])).toStrictEqual({
      paginationOpts: { cursor: "cursor-a", numItems: ENTRIES_FETCH_PAGE_SIZE },
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
  it("are identity — same rows, same reference — until stage 1+ replaces them", () => {
    const entries = [entryRow("e1")];
    const geometries = [geometryRow("g1")];
    expect(applyEntryRowSpecs(entries)).toBe(entries);
    expect(applyEntryRowSpec(entries[0])).toBe(entries[0]);
    expect(applyGeometryRowSpecs(geometries)).toBe(geometries);
    expect(applyGeometryRowSpec(geometries[0])).toBe(geometries[0]);
  });
});
