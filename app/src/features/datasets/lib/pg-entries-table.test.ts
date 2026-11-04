// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The table-state helpers import the store's searchEntries chain, which
// reaches `#/env` through the integrations client — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import type { PgColumnFilter, PgPropertyType, PgTableState } from "./pg-entries-table";
import {
  filtersToSearchFilters,
  pgTableParamsFromState,
  pgTableStateFromParams,
  resolveUpdater,
  sanitizePgTableState,
  searchArgsOf,
  servedVariantOf,
  sortingToSearchSort,
  SERVED_FILTER_OPERATORS,
} from "./pg-entries-table";

/** The first filter row's column id, or a loud failure (the no-optional-chaining test style). */
function firstFilterId(filters: ReadonlyArray<PgColumnFilter>): string {
  const first = filters[0];
  if (first === undefined) {
    throw new Error("No filter rows.");
  }
  return first.id;
}

/** The first sorting row's column id, or a loud failure. */
function firstSortId(sorting: ReadonlyArray<{ id: string }>): string {
  const first = sorting[0];
  if (first === undefined) {
    throw new Error("No sorting rows.");
  }
  return first.id;
}

function columnFilter(overrides: Partial<PgColumnFilter>): PgColumnFilter {
  return {
    filterId: "f1",
    id: "name",
    operator: "ilike",
    value: "grant",
    variant: "text",
    ...overrides,
  };
}

describe("pgTableStateFromParams / pgTableParamsFromState — the URL round trip", () => {
  it("round-trips query, sort, and filters through the three params", () => {
    const filters = [
        columnFilter({}),
        columnFilter({ filterId: "f2", id: "status", value: "open" }),
      ],
      state = {
        filters,
        query: "park",
        sorting: [{ desc: true, id: "name" }],
      };
    const params = pgTableParamsFromState(state);
    expect(params.q).toBe("park");
    expect(JSON.parse(params.sort ?? "[]")).toStrictEqual([{ desc: true, id: "name" }]);
    expect(JSON.parse(params.filters ?? "[]")).toStrictEqual(filters);
    expect(pgTableStateFromParams(params)).toStrictEqual(state);
  });

  it("drops the params entirely for the default state (defaults never appear in the URL)", () => {
    const params = pgTableParamsFromState({ filters: [], query: "", sorting: [] });
    expect(params).toStrictEqual({});
  });

  it("degrades malformed params to absent values instead of throwing", () => {
    const state = pgTableStateFromParams({
      filters: "{not json",
      q: "still parses",
      sort: "not json either",
    });
    expect(state.query).toBe("still parses");
    expect(state.sorting).toStrictEqual([]);
    expect(state.filters).toStrictEqual([]);
  });

  it("drops malformed filter and sorting rows from a hand-edited URL", () => {
    const state = pgTableStateFromParams({
      filters: JSON.stringify([
        { filterId: "f1", id: "name", operator: "ilike", value: "x", variant: "text" },
        { id: "no-operator" },
        "garbage",
        { filterId: "f2", id: 42, operator: "eq", value: "y", variant: "text" },
      ]),
      sort: JSON.stringify([{ desc: true, id: "name" }, { id: "no-desc" }]),
    });
    expect(state.filters.length).toBe(1);
    expect(firstFilterId(state.filters)).toBe("name");
    expect(state.sorting.length).toBe(1);
    expect(firstSortId(state.sorting)).toBe("name");
  });
});

describe("sanitizePgTableState — the undeclared-key degrade (the not-found-boundary defect)", () => {
  const DECLARED = new Set(["name", "grant"]);

  it("drops sort/filter rows whose key the dataset does not declare (default state for that concern)", () => {
    const state: PgTableState = {
      filters: [
        columnFilter({}),
        columnFilter({ filterId: "f2", id: "rogue_column", operator: "eq", value: "x" }),
      ],
      query: "park",
      sorting: [
        { desc: true, id: "rogue_column" },
        { desc: false, id: "grant" },
      ],
    };
    const sanitized = sanitizePgTableState(state, DECLARED);
    expect(sanitized.sorting).toStrictEqual([{ desc: false, id: "grant" }]);
    expect(sanitized.filters.length).toBe(1);
    expect(firstFilterId(sanitized.filters)).toBe("name");
    // Websearch TEXT passes through — the RPC parses it safely.
    expect(sanitized.query).toBe("park");
  });

  it("degrades to the full default state when no keys are declared yet (the pre-load tick)", () => {
    const state: PgTableState = {
      filters: [columnFilter({})],
      query: "park",
      sorting: [{ desc: true, id: "name" }],
    };
    const sanitized = sanitizePgTableState(state, new Set<string>());
    expect(sanitized.sorting).toStrictEqual([]);
    expect(sanitized.filters).toStrictEqual([]);
    expect(sanitized.query).toBe("park");
  });

  it("keeps declared rows byte-identical (a legit URL state round-trips untouched)", () => {
    const state: PgTableState = {
      filters: [columnFilter({ id: "grant" })],
      query: "",
      sorting: [{ desc: false, id: "name" }],
    };
    expect(sanitizePgTableState(state, DECLARED)).toStrictEqual(state);
  });
});

describe("filtersToSearchFilters — the menu ops → search_entries §5.1 ops", () => {
  it("maps contains/eq/neq and the four range ops 1:1", () => {
    const filters = [
      columnFilter({ operator: "ilike", value: "grant" }),
      columnFilter({ filterId: "f2", id: "status", operator: "eq", value: "open" }),
      columnFilter({ filterId: "f3", id: "status", operator: "neq", value: "closed" }),
      columnFilter({ filterId: "f4", id: "count", operator: "gte", value: "10" }),
    ];
    expect(filtersToSearchFilters(filters)).toStrictEqual([
      { key: "name", op: "contains", value: "grant" },
      { key: "status", op: "eq", value: "open" },
      { key: "status", op: "neq", value: "closed" },
      { key: "count", op: "gte", value: "10" },
    ]);
  });

  it("maps the in operator's array value, and drops operators the RPC has no counterpart for", () => {
    const filters = [
      columnFilter({ filterId: "f1", id: "kind", operator: "in", value: ["a", "b"] }),
      // not.ilike / empty / not.empty / between have no §5.1 op — dropped,
      // never silently translated into a different predicate.
      columnFilter({ filterId: "f2", id: "name", operator: "not.ilike", value: "x" }),
      columnFilter({ filterId: "f3", id: "name", operator: "empty", value: "" }),
      columnFilter({ filterId: "f4", id: "count", operator: "between", value: "1-9" }),
    ];
    expect(filtersToSearchFilters(filters)).toStrictEqual([
      { key: "kind", op: "in", value: ["a", "b"] },
    ]);
  });

  it("skips empty values (an empty contains matches everything — the filter means nothing)", () => {
    expect(filtersToSearchFilters([columnFilter({ operator: "ilike", value: "" })])).toStrictEqual(
      [],
    );
  });

  it("coerces eq/neq values to the declared column type (§5.1 eq is jsonb containment)", () => {
    const types = new Map<string, PgPropertyType>([
      ["active", "boolean"],
      ["count", "number"],
    ]);
    expect(
      filtersToSearchFilters(
        [
          // "5" the string never matches a numeric cell (5 ≠ "5").
          columnFilter({ id: "count", operator: "eq", value: "5" }),
          columnFilter({ filterId: "f2", id: "active", operator: "eq", value: "true" }),
          columnFilter({ filterId: "f3", id: "count", operator: "neq", value: "10" }),
        ],
        types,
      ),
    ).toStrictEqual([
      { key: "count", op: "eq", value: 5 },
      { key: "active", op: "eq", value: true },
      { key: "count", op: "neq", value: 10 },
    ]);
  });

  it("drops rows whose value cannot be the column's type (the NaN-guard semantics)", () => {
    const types = new Map<string, PgPropertyType>([["count", "number"]]);
    expect(
      filtersToSearchFilters(
        [
          columnFilter({ id: "count", operator: "eq", value: "abc" }),
          columnFilter({ filterId: "f2", id: "count", operator: "gte", value: "7" }),
          columnFilter({ filterId: "f3", id: "count", operator: "lt", value: "nope" }),
        ],
        types,
      ),
    ).toStrictEqual([{ key: "count", op: "gte", value: 7 }]);
  });

  it("passes the in array through as the menu produced it (the RPC text-ifies members)", () => {
    const types = new Map<string, PgPropertyType>([["count", "number"]]);
    expect(
      filtersToSearchFilters(
        [columnFilter({ id: "count", operator: "in", value: ["5", "7"] })],
        types,
      ),
    ).toStrictEqual([{ key: "count", op: "in", value: ["5", "7"] }]);
  });

  it("leaves values untouched without schema info (string columns, the menu's own form)", () => {
    expect(
      filtersToSearchFilters([columnFilter({ operator: "eq", value: "5" })], new Map()),
    ).toStrictEqual([{ key: "name", op: "eq", value: "5" }]);
  });
});

describe("servedVariantOf / SERVED_FILTER_OPERATORS — the menu offers only served ops", () => {
  it("maps declared types to typed variants", () => {
    expect(servedVariantOf("number")).toBe("number");
    expect(servedVariantOf("boolean")).toBe("boolean");
    expect(servedVariantOf("string")).toBe("text");
  });

  it("offers exactly the §5.1 op set per variant (contains/ilike, eq, neq, numeric ranges)", () => {
    expect(SERVED_FILTER_OPERATORS.get("text")).toStrictEqual(["ilike", "eq", "neq"]);
    expect(SERVED_FILTER_OPERATORS.get("number")).toStrictEqual([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
    ]);
    expect(SERVED_FILTER_OPERATORS.get("boolean")).toStrictEqual(["eq", "neq"]);
  });
});

describe("sortingToSearchSort — one key, one direction (§5.1 sorts by ONE key)", () => {
  it("takes the first sorting entry only", () => {
    expect(
      sortingToSearchSort([
        { desc: true, id: "name" },
        { desc: false, id: "age" },
      ]),
    ).toStrictEqual({ dir: "desc", key: "name" });
    expect(sortingToSearchSort([{ desc: false, id: "age" }])).toStrictEqual({
      dir: "asc",
      key: "age",
    });
  });

  it("answers undefined for no sort (the RPC's created_at-desc default)", () => {
    expect(sortingToSearchSort([])).toBe(undefined);
  });
});

describe("searchArgsOf — the RPC args one table state produces", () => {
  it("carries the dataset, the translated concerns, and the RPC-default limit", () => {
    const state = {
        filters: [columnFilter({})],
        query: "park",
        sorting: [{ desc: false, id: "name" }],
      },
      args = searchArgsOf("d1", state, "cursor-9");
    expect(args).toStrictEqual({
      cursor: "cursor-9",
      datasetId: "d1",
      filters: [{ key: "name", op: "contains", value: "grant" }],
      limit: 200,
      query: "park",
      sort: { dir: "asc", key: "name" },
    });
  });

  it("threads the declared column types into the filter translation", () => {
    const state = {
        filters: [columnFilter({ id: "count", operator: "eq", value: "5" })],
        query: "",
        sorting: [],
      },
      args = searchArgsOf("d1", state, null, new Map([["count", "number" as PgPropertyType]]));
    expect(args.filters).toStrictEqual([{ key: "count", op: "eq", value: 5 }]);
  });

  it("leaves the search and sort unset for the default state", () => {
    const args = searchArgsOf("d1", { filters: [], query: "", sorting: [] }, null);
    expect(args.query).toBe(undefined);
    expect(args.sort).toBe(undefined);
    expect(args.filters).toStrictEqual([]);
  });
});

describe("resolveUpdater — the controlled-state handler contract", () => {
  it("resolves the function form and passes values through", () => {
    expect(resolveUpdater((old: number[]) => [...old, 3], [1, 2])).toStrictEqual([1, 2, 3]);
    expect(resolveUpdater([4], [1])).toStrictEqual([4]);
  });
});
