import { describe, expect, it } from "vitest";

import { applyLookup, LookupKeyConflictError } from "./lookup.js";
import type { LookupOperation } from "./spec.js";

const grants = [
  { grantId: 42, status: "awarded", name: "Ready" },
  { grantId: " 43 ", status: "pending", name: "Mixed" },
  { grantId: "44", status: "declined", name: "Typed" },
];

function grantsOp(overrides?: Partial<LookupOperation>): LookupOperation {
  return {
    kind: "lookup",
    lookupDatasetId: "grants",
    baseKey: "grantId",
    lookupKey: "grantId",
    ...overrides,
  };
}

describe("applyLookup — key coercion via 0.4's normalizeKey", () => {
  it("joins number and differently-typed string forms of one key", () => {
    const source = [{ id: "a", grantId: 42 }],
      lookup = [{ grantId: " 42 ", status: "awarded" }],
      { rows } = applyLookup(grantsOp(), source, lookup);
    expect(rows[0]).toStrictEqual({ id: "a", grantId: 42, "grants.status": "awarded" });
  });

  it("trims and case-folds string keys", () => {
    const source = [{ id: "a", code: "ABC-123" }],
      lookup = [{ code: "  abc-123 ", label: "ok" }],
      { rows, diagnostics } = applyLookup(
        grantsOp({ baseKey: "code", lookupKey: "code", fields: ["label"] }),
        source,
        lookup,
      );
    expect(rows[0]).toStrictEqual({ id: "a", code: "ABC-123", "grants.label": "ok" });
    expect(diagnostics.matchedRows).toBe(1);
  });

  it('never numeric-normalizes a string, so "007" does not join number 7', () => {
    const source = [{ id: "a", grantId: "007" }],
      lookup = [{ grantId: 7, status: "seven" }],
      { rows, diagnostics } = applyLookup(grantsOp(), source, lookup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toStrictEqual({ id: "a", grantId: "007", "grants.status": null });
    expect(diagnostics.matchedRows).toBe(0);
    expect(diagnostics.unmatchedKeys).toStrictEqual(["007"]);
  });

  it("leaves float-notation splits unmatched rather than mis-joining", () => {
    const source = [{ id: "a", grantId: "1e21" }],
      lookup = [{ grantId: 1e21, status: "huge" }],
      { diagnostics } = applyLookup(grantsOp({ fields: ["status"] }), source, lookup);
    expect(diagnostics.matchedRows).toBe(0);
    expect(diagnostics.unmatchedKeys).toStrictEqual(["1e21"]);
  });

  it('treats keyless base rows as unmatched — never a crash, never a match against "null"', () => {
    const source: Array<Record<string, unknown>> = [
        { id: "a", grantId: null },
        { id: "b", grantId: "   " },
        { id: "c", grantId: Number.NaN },
        { id: "d", grantId: { nested: true } },
        { id: "e" },
      ],
      lookup = [{ grantId: "null", status: "literal-null" }],
      { rows, diagnostics } = applyLookup(grantsOp({ fields: ["status"] }), source, lookup);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row["grants.status"]).toBeNull();
    }
    expect(diagnostics.matchedRows).toBe(0);
    expect(diagnostics.unmatchedRows).toBe(5);
    // Strings list raw even when whitespace-only; cells with no string or
    // number form (null, NaN, objects, absent) list nothing. No crash.
    expect(diagnostics.unmatchedKeys).toStrictEqual(["   "]);
  });

  it("never indexes a keyless lookup row", () => {
    const source = [{ id: "a", grantId: "44" }],
      lookup = [
        { status: "keyless", name: "ignored" },
        { grantId: "44", status: "real", name: "kept" },
      ],
      { rows, diagnostics } = applyLookup(grantsOp(), source, lookup);
    expect(diagnostics.matchedRows).toBe(1);
    expect(rows[0]).toStrictEqual({
      id: "a",
      grantId: "44",
      "grants.status": "real",
      "grants.name": "kept",
    });
  });
});

describe("applyLookup — left join (default)", () => {
  const source = [
      { rowId: "r1", grantId: 42 },
      { rowId: "r2", grantId: "43" },
      { rowId: "r3", grantId: " 88 " },
      { rowId: "r4", grantId: null },
      { rowId: "r5" },
    ],
    expected = [
      { rowId: "r1", grantId: 42, "grants.status": "awarded", "grants.name": "Ready" },
      { rowId: "r2", grantId: "43", "grants.status": "pending", "grants.name": "Mixed" },
      { rowId: "r3", grantId: " 88 ", "grants.status": null, "grants.name": null },
      { rowId: "r4", grantId: null, "grants.status": null, "grants.name": null },
      { rowId: "r5", "grants.status": null, "grants.name": null },
    ];

  it("keeps unmatched rows with null enriched fields, row count unchanged (omitted match defaults to left)", () => {
    const { rows, diagnostics } = applyLookup(grantsOp(), source, grants);
    expect(rows).toStrictEqual(expected);
    expect(rows).toHaveLength(source.length);
    expect(diagnostics.droppedRows).toBe(0);
  });

  it('behaves identically with match explicitly "left"', () => {
    const { rows } = applyLookup(grantsOp({ match: "left" }), source, grants);
    expect(rows).toStrictEqual(expected);
  });

  it("gives unmatched rows null for every enrichment field, not absent keys", () => {
    const { rows } = applyLookup(grantsOp({ fields: ["status", "name"] }), source, grants);
    for (const row of rows) {
      expect("grants.status" in row).toBe(true);
      expect("grants.name" in row).toBe(true);
    }
    expect(rows[2]).toStrictEqual({
      rowId: "r3",
      grantId: " 88 ",
      "grants.status": null,
      "grants.name": null,
    });
  });
});

describe("applyLookup — inner join", () => {
  const source = [
      { rowId: "r1", grantId: 42 },
      { rowId: "r2", grantId: " 88 " },
      { rowId: "r3", grantId: null },
    ],
    lookup = [{ grantId: 42, status: "awarded", name: "Ready" }];

  it("drops unmatched rows only as an explicit spec choice", () => {
    const { rows, diagnostics } = applyLookup(grantsOp({ match: "inner" }), source, lookup);
    expect(rows).toStrictEqual([
      { rowId: "r1", grantId: 42, "grants.status": "awarded", "grants.name": "Ready" },
    ]);
    expect(diagnostics).toStrictEqual({
      totalSourceRows: 3,
      matchedRows: 1,
      unmatchedRows: 2,
      unmatchedKeys: [" 88 "],
      droppedRows: 2,
    });
  });

  it("keeps matched + unmatched = total under inner, so the match rate stays unambiguous", () => {
    const { diagnostics } = applyLookup(grantsOp({ match: "inner" }), source, lookup);
    expect(diagnostics.matchedRows + diagnostics.unmatchedRows).toBe(diagnostics.totalSourceRows);
    expect(diagnostics.droppedRows).toBe(diagnostics.unmatchedRows);
  });
});

describe("applyLookup — duplicate-key policy", () => {
  const source = [{ rowId: "r1", grantId: "44" }],
    duplicates = [
      { grantId: "44", status: "first", name: "First" },
      { grantId: " 44 ", status: "second", name: "Second" },
    ];

  it('defaults to "first" when onDuplicateKey is omitted', () => {
    const { rows } = applyLookup(grantsOp(), source, duplicates);
    expect(rows[0]).toStrictEqual({
      rowId: "r1",
      grantId: "44",
      "grants.status": "first",
      "grants.name": "First",
    });
  });

  it('keeps the first match under "first"', () => {
    const { rows } = applyLookup(grantsOp({ onDuplicateKey: "first" }), source, duplicates);
    expect(rows[0]).toStrictEqual({
      rowId: "r1",
      grantId: "44",
      "grants.status": "first",
      "grants.name": "First",
    });
  });

  it('keeps the last match under "last"', () => {
    const { rows } = applyLookup(grantsOp({ onDuplicateKey: "last" }), source, duplicates);
    expect(rows[0]).toStrictEqual({
      rowId: "r1",
      grantId: "44",
      "grants.status": "second",
      "grants.name": "Second",
    });
  });

  it('rejects the whole lookup under "error", even when only normalization makes the keys collide', () => {
    expect(() => applyLookup(grantsOp({ onDuplicateKey: "error" }), source, duplicates)).toThrow(
      LookupKeyConflictError,
    );
  });

  it("names the offending raw key and dataset in the conflict error", () => {
    // The second duplicate's raw (pre-normalization) key, " 44 ", is what
    // the message names — normalization "44" is what made them collide.
    expect(() => applyLookup(grantsOp({ onDuplicateKey: "error" }), source, duplicates)).toThrow(
      /Duplicate key " 44 " in lookup dataset "grants" \(onDuplicateKey: "error"\)\./,
    );
  });
});

describe("applyLookup — namespacing", () => {
  it("defaults the namespace to the lookup dataset id", () => {
    const { rows } = applyLookup(
      grantsOp({ fields: ["status"] }),
      [{ id: "a", grantId: 42 }],
      grants,
    );
    expect("grants.status" in rows[0]).toBe(true);
  });

  it("uses the explicit namespace when given", () => {
    const { rows } = applyLookup(
      grantsOp({ namespace: "grant", fields: ["status"] }),
      [{ id: "a", grantId: 42 }],
      grants,
    );
    expect("grant.status" in rows[0]).toBe(true);
    expect("grants.status" in rows[0]).toBe(false);
  });

  it("lets the namespaced enrichment win when the base row already carries the key", () => {
    const source = [{ id: "a", grantId: 42, "grants.status": "base-value" }],
      { rows } = applyLookup(grantsOp({ fields: ["status"] }), source, grants);
    expect(rows[0]).toStrictEqual({ id: "a", grantId: 42, "grants.status": "awarded" });
  });
});

describe("applyLookup — enrichment fields", () => {
  it("brings in only the picked fields, in spec order, when fields are picked", () => {
    const { rows } = applyLookup(
      grantsOp({ fields: ["name"] }),
      [{ id: "a", grantId: 42 }],
      grants,
    );
    expect(rows[0]).toStrictEqual({ id: "a", grantId: 42, "grants.name": "Ready" });
  });

  it("lands a picked-but-missing field as null on matched rows", () => {
    const { rows } = applyLookup(
      grantsOp({ fields: ["status", "missing"] }),
      [{ id: "a", grantId: 42 }],
      grants,
    );
    expect(rows[0]).toStrictEqual({
      id: "a",
      grantId: 42,
      "grants.status": "awarded",
      "grants.missing": null,
    });
  });

  it("defaults to every lookup field except the join key, first-seen across the table", () => {
    const lookup = [
      { grantId: 1, alpha: "a", beta: "b" },
      { grantId: 2, gamma: "g", alpha: "a2" },
    ];
    const { rows } = applyLookup(grantsOp(), [{ id: "a", grantId: 1 }], lookup);
    expect(Object.keys(rows[0])).toStrictEqual([
      "id",
      "grantId",
      "grants.alpha",
      "grants.beta",
      "grants.gamma",
    ]);
  });

  it("adds no enrichment with an empty picked list, but still returns fresh rows and diagnostics", () => {
    const source = [{ id: "a", grantId: 42 }],
      { rows, diagnostics } = applyLookup(grantsOp({ fields: [] }), source, grants);
    expect(rows[0]).toStrictEqual({ id: "a", grantId: 42 });
    expect(rows[0]).not.toBe(source[0]);
    expect(diagnostics.matchedRows).toBe(1);
  });
});

describe("applyLookup — diagnostics", () => {
  it("reports exact matched/orphan counts on a known-orphan fixture", () => {
    const source = [
        { rowId: "r1", grantId: 42 },
        { rowId: "r2", grantId: "43" },
        { rowId: "r3", grantId: " 88 " },
        { rowId: "r4", grantId: "88" },
        { rowId: "r5", grantId: null },
        { rowId: "r6" },
      ],
      { diagnostics } = applyLookup(grantsOp(), source, grants);
    expect(diagnostics).toStrictEqual({
      totalSourceRows: 6,
      matchedRows: 2,
      unmatchedRows: 4,
      // Raw, pre-normalization, distinct, first-seen: " 88 " and "88" are
      // two listings of one orphan key 88; keyless cells list nothing.
      unmatchedKeys: [" 88 ", "88"],
      droppedRows: 0,
    });
  });

  it("reports zeros for empty source rows", () => {
    const { rows, diagnostics } = applyLookup(grantsOp(), [], grants);
    expect(rows).toStrictEqual([]);
    expect(diagnostics).toStrictEqual({
      totalSourceRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      unmatchedKeys: [],
      droppedRows: 0,
    });
  });

  it("unmatches everything when the lookup table is empty (left keeps all, inner drops all)", () => {
    const source = [{ rowId: "r1", grantId: 42 }],
      left = applyLookup(grantsOp({ fields: ["status"] }), source, []),
      inner = applyLookup(grantsOp({ match: "inner", fields: ["status"] }), source, []);
    expect(left.rows).toHaveLength(1);
    expect(left.diagnostics).toStrictEqual({
      totalSourceRows: 1,
      matchedRows: 0,
      unmatchedRows: 1,
      unmatchedKeys: ["42"],
      droppedRows: 0,
    });
    expect(inner.rows).toHaveLength(0);
    expect(inner.diagnostics.droppedRows).toBe(1);
  });
});

describe("applyLookup — purity and composition", () => {
  it("never mutates frozen inputs — output rows are fresh objects", () => {
    const source: Array<Record<string, unknown>> = [
        Object.freeze({ rowId: "r1", grantId: 42 }),
        Object.freeze({ rowId: "r2", grantId: " 88 " }),
      ],
      lookup: Array<Record<string, unknown>> = [
        Object.freeze({ grantId: 42, status: "awarded", name: "Ready" }),
      ],
      sourceBefore = JSON.parse(JSON.stringify(source)) as Array<Record<string, unknown>>,
      lookupBefore = JSON.parse(JSON.stringify(lookup)) as Array<Record<string, unknown>>;
    Object.freeze(source);
    Object.freeze(lookup);
    const { rows } = applyLookup(grantsOp(), source, lookup);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toBe(source[0]);
    expect(rows[1]).not.toBe(source[1]);
    expect(source).toStrictEqual(sourceBefore);
    expect(lookup).toStrictEqual(lookupBefore);
  });

  it("accepts its own output as the next call's input — derived-of-derived chains", () => {
    const orgs = [{ orgId: "o1", orgName: "Parks" }],
      base = [
        { rowId: "r1", grantId: 42, orgId: "o1" },
        { rowId: "r2", grantId: " 88 ", orgId: "o1" },
      ],
      step1 = applyLookup(grantsOp(), base, grants),
      step2 = applyLookup(
        grantsOp({
          lookupDatasetId: "orgs",
          baseKey: "orgId",
          lookupKey: "orgId",
          fields: ["orgName"],
        }),
        step1.rows,
        orgs,
      );
    expect(step2.rows[0]).toStrictEqual({
      rowId: "r1",
      grantId: 42,
      orgId: "o1",
      "grants.status": "awarded",
      "grants.name": "Ready",
      "orgs.orgName": "Parks",
    });
    expect(step2.diagnostics.totalSourceRows).toBe(2);
    expect(step2.diagnostics.matchedRows).toBe(2);
  });
});
