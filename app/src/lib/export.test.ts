import { describe, expect, it, vi } from "vitest";

import {
  enrichExportEntries,
  lookupDatasetIdsOf,
  readyRowsOf,
  type ExportTransformSpec,
  type ExportableEntry,
  type TransformSummaryLike,
} from "./export";

// The export helpers derive their row loading from `#/lib/dataset-rows`,
// which reads `#/env` at import time; the tests exercise pure logic against
// injected stub rows, so the env module never has to load.
vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

function spec(operations: unknown[]): ExportTransformSpec {
  return { operations };
}

function lookupOperation(overrides: Record<string, unknown> = {}) {
  return {
    baseKey: "GrantId",
    kind: "lookup",
    lookupDatasetId: "grants",
    lookupKey: "GrantId",
    namespace: "Grants",
    ...overrides,
  };
}

function entry(id: string, data: unknown, geometryId?: string): ExportableEntry {
  return geometryId === undefined ? { _id: id, data } : { _id: id, data, geometryId };
}

function summary(overrides: Partial<TransformSummaryLike>): TransformSummaryLike {
  return {
    _id: "d1",
    health: "ready",
    sourceDatasetId: "s1",
    status: "saved",
    ...overrides,
  };
}

describe("enrichExportEntries", () => {
  it("lands namespaced fields on matched rows and nulls on unmatched ones (left join)", () => {
    const entries = [entry("a", { GrantId: "g1", name: "A" }), entry("b", { GrantId: "nope" })],
      grants = [{ GrantId: "g1", status: "active" }],
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation()])],
        new Map([["grants", grants]]),
      );

    expect(out).toHaveLength(2);
    expect(out[0].data).toStrictEqual({ GrantId: "g1", "Grants.status": "active", name: "A" });
    // Unmatched rows survive with null enriched fields — the left-join default.
    expect(out[1].data).toStrictEqual({ GrantId: "nope", "Grants.status": null });
  });

  it("brings exactly the picked fields, in order, when the op sets fields", () => {
    const entries = [entry("a", { GrantId: 42 })],
      grants = [
        { GrantId: "42", score: 1, status: "active" },
        { extra: "ignored", GrantId: "7", score: 2, status: "pending" },
      ],
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation({ fields: ["status"] })])],
        new Map([["grants", grants]]),
      );

    // Number 42 joins string "42" (key hygiene is 0.4's) and only the picked column appears.
    expect(out[0].data).toStrictEqual({ GrantId: 42, "Grants.status": "active" });
  });

  it("brings the omit-means-all union (every field but the join key) when fields are omitted", () => {
    const entries = [entry("a", { GrantId: "g1" })],
      grants = [{ GrantId: "g1", score: 1, status: "active" }],
      out = enrichExportEntries(
        entries,
        // The builder saves "all" as an OMITTED fields list — the engine's union is what exports.
        [spec([lookupOperation({ fields: undefined })])],
        new Map([["grants", grants]]),
      );

    expect(out[0].data).toStrictEqual({
      GrantId: "g1",
      "Grants.score": 1,
      "Grants.status": "active",
    });
  });

  it("lets enrichment win over a pre-existing namespaced key", () => {
    const entries = [entry("a", { GrantId: "g1", "Grants.status": "stale-copy" })],
      grants = [{ GrantId: "g1", status: "fresh" }],
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation()])],
        new Map([["grants", grants]]),
      );

    expect(out[0].data).toStrictEqual({ GrantId: "g1", "Grants.status": "fresh" });
  });

  it("passes entries with non-object data through untouched", () => {
    const entries = [entry("a", "plain string"), entry("b", ["array"])],
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation()])],
        new Map([["grants", [{ GrantId: "g1", status: "active" }]]]),
      );

    expect(out[0]).toBe(entries[0]);
    expect(out[1]).toBe(entries[1]);
  });

  it("keeps _id and geometryId on enriched entries and never mutates the inputs", () => {
    const entries = [entry("a", { GrantId: "g1" }, "geom-1")],
      frozen = JSON.parse(JSON.stringify(entries)),
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation()])],
        new Map([["grants", [{ GrantId: "g1", status: "active" }]]]),
      );

    expect(out[0]._id).toBe("a");
    expect(out[0].geometryId).toBe("geom-1");
    // The input rows are untouched (purity is the engine's contract; the wrapper keeps it).
    expect(entries).toStrictEqual(frozen);
  });

  it("drops unmatched entries only when a spec stored match: inner", () => {
    const entries = [entry("a", { GrantId: "g1" }), entry("b", { GrantId: "orphan" })],
      grants = [{ GrantId: "g1", status: "active" }],
      inner = enrichExportEntries(
        entries,
        [spec([lookupOperation({ match: "inner" })])],
        new Map([["grants", grants]]),
      ),
      left = enrichExportEntries(
        entries,
        [spec([lookupOperation()])],
        new Map([["grants", grants]]),
      );

    expect(inner.map((row) => row._id)).toStrictEqual(["a"]);
    expect(left).toHaveLength(2);
  });

  it("keeps enrichment on entries that SURVIVE an inner drop ahead of them", () => {
    // The regression case for positional bookkeeping: the first entry is
    // dropped by the inner join (a non-object entry has no key), so any
    // flag indexed by pre-fold position would misread every later row.
    const entries = [entry("a", "plain string"), entry("b", { GrantId: "g1" })],
      out = enrichExportEntries(
        entries,
        [spec([lookupOperation({ match: "inner" })])],
        new Map([["grants", [{ GrantId: "g1", status: "active" }]]]),
      );

    expect(out).toHaveLength(1);
    expect(out[0]._id).toBe("b");
    expect(out[0].data).toStrictEqual({ GrantId: "g1", "Grants.status": "active" });
  });

  it("folds several specs in order; a shared namespace resolves later-wins", () => {
    const entries = [entry("a", { GrantId: "g1" })],
      specs = [
        spec([lookupOperation({ namespace: "Grants" })]),
        spec([lookupOperation({ lookupDatasetId: "grants2", namespace: "Grants" })]),
      ],
      out = enrichExportEntries(
        entries,
        specs,
        new Map([
          ["grants", [{ GrantId: "g1", status: "first" }]],
          ["grants2", [{ GrantId: "g1", status: "second", tier: 3 }]],
        ]),
      );

    // The second fold's enrichment beats the first's same-named column; the
    // first fold's other columns survive.
    expect(out[0].data).toStrictEqual({
      GrantId: "g1",
      "Grants.status": "second",
      "Grants.tier": 3,
    });
  });

  it("skips operations it cannot run (stage-4 kinds, malformed lookup cells)", () => {
    const entries = [entry("a", { GrantId: "g1" })],
      out = enrichExportEntries(
        entries,
        [
          spec([
            { kind: "rollup" },
            { baseKey: "", kind: "lookup", lookupDatasetId: "grants", lookupKey: "GrantId" },
            {
              baseKey: "GrantId",
              kind: "lookup",
              lookupDatasetId: "grants",
              lookupKey: "k",
              match: "bogus",
            },
            lookupOperation(),
          ]),
        ],
        new Map([["grants", [{ GrantId: "g1", status: "active" }]]]),
      );

    // Only the well-formed lookup applied.
    expect(out[0].data).toStrictEqual({ GrantId: "g1", "Grants.status": "active" });
  });
});

describe("lookupDatasetIdsOf", () => {
  it("collects each operation's lookup dataset, distinct, first-seen", () => {
    expect(
      lookupDatasetIdsOf([
        spec([lookupOperation(), lookupOperation({ lookupDatasetId: "other" })]),
        spec([lookupOperation({ lookupDatasetId: "grants" })]),
      ]),
    ).toStrictEqual(["grants", "other"]);
  });

  it("ignores operations that never name a dataset", () => {
    expect(lookupDatasetIdsOf([spec([{ kind: "rollup" }]), spec([{}])])).toStrictEqual([]);
  });
});

describe("readyRowsOf", () => {
  it("keeps explicitly saved, ready rows", () => {
    expect(readyRowsOf([summary({})])).toStrictEqual([summary({})]);
  });

  it("never lets an autosaved DRAFT enrich an export, however healthy", () => {
    expect(readyRowsOf([summary({ status: "draft" })])).toStrictEqual([]);
  });

  it("drops stale and orphaned rows", () => {
    expect(
      readyRowsOf([summary({ health: "stale" }), summary({ health: "orphaned" })]),
    ).toStrictEqual([]);
  });

  it("answers an empty list for undefined input (the still-loading projection)", () => {
    expect(readyRowsOf(undefined)).toStrictEqual([]);
  });
});
