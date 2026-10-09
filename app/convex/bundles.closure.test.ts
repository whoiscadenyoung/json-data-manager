import { describe, expect, it } from "vitest";

import { bundleClosure, type BundleClosureInput } from "./bundles";

/**
 * The bundle closure's pure decisions (roadmap 7b, #103) — unit-tested with
 * plain objects, the derivedSpec.test.ts pattern. The function-level
 * behavior (a real press on a test backend) lives in bundles.test.ts.
 * Phase 3 of the project-workspace design (ADR 0012) retired the map walk
 * with the standalone maps: the closure is exactly the project's
 * memberships, ordered datasets-then-derived.
 */

const DRAFT = "draft:new-schema-1" as const;
const DRAFT2 = "draft:new-schema-2" as const;
const PUBLISHED = "schema:published-1" as const;
const REGISTRY = "registry:1" as const;

function input(overrides: Partial<BundleClosureInput> = {}): BundleClosureInput {
  return {
    dependsOnByRegistry: new Map(),
    groupIdByDataset: new Map(),
    lifecycleByDataset: new Map(),
    memberships: [],
    savedRegistryIds: new Set(),
    ...overrides,
  };
}

/** The plan's members, keyed for assertion ergonomics. */
function byKey(
  result: ReturnType<typeof bundleClosure>,
): Map<string, { publish: boolean; kind: string }> {
  return new Map(
    result.members.map((member) => [
      member.datasetKey,
      { kind: member.kind, publish: member.publish },
    ]),
  );
}

describe("bundleClosure: contents and dedup (the bundle rule)", () => {
  it("publishes a dataset referenced twice (membership + a second row) exactly once", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
        ],
      }),
    );
    const members = byKey(result);
    expect(result.members.filter((member) => member.kind === "dataset")).toHaveLength(1);
    expect(members.get(DRAFT)).toStrictEqual({ kind: "dataset", publish: true });
    expect(result.dropped).toStrictEqual([]);
  });

  it("captures every held dataset membership, deduped by id", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map([
          [DRAFT, "draft" as const],
          [DRAFT2, "draft" as const],
        ]),
        memberships: [
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: DRAFT2, artifactKind: "dataset" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
        ],
      }),
    );
    expect(byKey(result).has(DRAFT)).toBe(true);
    expect(byKey(result).has(DRAFT2)).toBe(true);
    expect(result.members.filter((member) => member.kind === "dataset")).toHaveLength(2);
  });

  it("keeps layer members out of the press (their publish story is phase 5)", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [{ artifactId: DRAFT, artifactKind: "dataset" as const }],
      }),
    );
    expect(result.members).toHaveLength(1);
    expect(result.dropped).toStrictEqual([]);
  });
});

describe("bundleClosure: per-kind publish decisions", () => {
  it("already-published datasets are members only — never a new version", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map([[PUBLISHED, "published" as const]]),
        memberships: [{ artifactId: PUBLISHED, artifactKind: "dataset" as const }],
      }),
    );
    expect(byKey(result).get(PUBLISHED)).toStrictEqual({ kind: "dataset", publish: false });
  });

  it("carries a draft's group so the frozen row can re-join it", () => {
    const result = bundleClosure(
      input({
        groupIdByDataset: new Map([[DRAFT, "group:9"]]),
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [{ artifactId: DRAFT, artifactKind: "dataset" as const }],
      }),
    );
    expect(result.members[0]).toMatchObject({ datasetKey: DRAFT, groupId: "group:9" });
  });

  it("keeps derived sources OUT of the closure (exposure decoupled)", () => {
    const result = bundleClosure(
      input({
        // The registry spec reads DRAFT2 — the closure sees only the registry
        // row itself; the walk never follows specs.
        lifecycleByDataset: new Map([
          [DRAFT2, "draft" as const],
          [PUBLISHED, "published" as const],
        ]),
        memberships: [
          { artifactId: REGISTRY, artifactKind: "derived" as const },
          { artifactId: PUBLISHED, artifactKind: "dataset" as const },
        ],
        savedRegistryIds: new Set([REGISTRY]),
      }),
    );
    expect(byKey(result).has(REGISTRY)).toBe(true);
    expect(byKey(result).has(DRAFT2)).toBe(false);
  });

  it("drops builder autosaves and deleted artifacts with reasons", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map(),
        memberships: [
          { artifactId: REGISTRY, artifactKind: "derived" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
        ],
      }),
    );
    expect(result.members).toStrictEqual([]);
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { id: REGISTRY, reason: expect.stringContaining("saved transform") },
        { id: DRAFT, reason: expect.stringContaining("no longer exists") },
      ]),
    );
  });
});

describe("bundleClosure: order", () => {
  it("emits the canonical write order: datasets, then derived", () => {
    const result = bundleClosure(
      input({
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [
          { artifactId: REGISTRY, artifactKind: "derived" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
        ],
        savedRegistryIds: new Set([REGISTRY]),
      }),
    );
    expect(result.members.map((member) => member.kind)).toStrictEqual(["dataset", "derived"]);
  });

  it("orders derived members sources-before-forks (topological, discovery order be damned)", () => {
    const result = bundleClosure(
      input({
        // B (over A) is discovered FIRST via its membership.
        dependsOnByRegistry: new Map([
          ["fork:a", ["source:1"]],
          ["fork:b", ["fork:a"]],
        ]),
        memberships: [
          { artifactId: "fork:b", artifactKind: "derived" as const },
          { artifactId: "fork:a", artifactKind: "derived" as const },
        ],
        savedRegistryIds: new Set(["fork:a", "fork:b"]),
      }),
    );
    const derivedKeys = result.members
      .filter((member) => member.kind === "derived")
      .map((member) => member.datasetKey);
    expect(derivedKeys).toStrictEqual(["fork:a", "fork:b"]);
  });
});
