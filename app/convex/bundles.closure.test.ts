import { describe, expect, it } from "vitest";

import { bundleClosure, type BundleClosureInput } from "./bundles";

/**
 * The bundle closure's pure decisions (roadmap 7b, #103) — unit-tested with
 * plain objects, the derivedSpec.test.ts pattern. The function-level
 * behavior (a real press on a test backend) lives in bundles.test.ts.
 */

const DRAFT = "draft:new-schema-1" as const;
const DRAFT2 = "draft:new-schema-2" as const;
const PUBLISHED = "schema:published-1" as const;
const MAP = "map:1" as const;
const MAP2 = "map:2" as const;
const REGISTRY = "registry:1" as const;

function input(overrides: Partial<BundleClosureInput> = {}): BundleClosureInput {
  return {
    collectionMembers: [],
    groupIdByDataset: new Map(),
    groupsByCollection: [],
    layersByMap: [],
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
  it("publishes a dataset referenced three ways exactly once", () => {
    const result = bundleClosure(
      input({
        collectionMembers: [{ collectionId: "col:1", schemaId: DRAFT }],
        layersByMap: [
          {
            layers: [
              { targetId: "col:1", targetType: "collection" },
              { targetId: DRAFT, targetType: "dataset" },
            ],
            mapId: MAP,
          },
        ],
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: MAP, artifactKind: "map" as const },
        ],
      }),
    );
    const members = byKey(result);
    expect(result.members.filter((member) => member.kind === "dataset")).toHaveLength(1);
    expect(members.get(DRAFT)).toStrictEqual({ kind: "dataset", publish: true });
    expect(members.get(MAP)).toStrictEqual({ kind: "map", publish: false });
    expect(result.dropped).toStrictEqual([]);
  });

  it("expands a collection layer through memberships AND member groups, deduped", () => {
    const result = bundleClosure(
      input({
        collectionMembers: [
          { collectionId: "col:1", schemaId: DRAFT },
          { collectionId: "col:1", schemaId: DRAFT2 },
        ],
        groupIdByDataset: new Map([
          [DRAFT, "group:1"],
          [DRAFT2, "group:1"],
        ]),
        groupsByCollection: [{ collectionId: "col:1", groupId: "group:1" }],
        layersByMap: [{ layers: [{ targetId: "col:1", targetType: "collection" }], mapId: MAP }],
        lifecycleByDataset: new Map([
          [DRAFT, "draft" as const],
          [DRAFT2, "draft" as const],
        ]),
        memberships: [
          // Both drafts are the project's own (memberships) — the collection
          // layer's expansion re-discovers them, deduped.
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: DRAFT2, artifactKind: "dataset" as const },
          { artifactId: MAP, artifactKind: "map" as const },
        ],
      }),
    );
    expect(byKey(result).has(DRAFT)).toBe(true);
    expect(byKey(result).has(DRAFT2)).toBe(true);
    expect(result.members.filter((member) => member.kind === "dataset")).toHaveLength(2);
  });

  it("auto-publishes a dataset only the map's layers reach", () => {
    const result = bundleClosure(
      input({
        layersByMap: [{ layers: [{ targetId: DRAFT, targetType: "dataset" }], mapId: MAP }],
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [{ artifactId: MAP, artifactKind: "map" as const }],
      }),
    );
    expect(byKey(result).get(DRAFT)).toStrictEqual({ kind: "dataset", publish: true });
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

  it("publishes a saved transform a map's derived layer forces", () => {
    const result = bundleClosure(
      input({
        layersByMap: [{ layers: [{ targetId: REGISTRY, targetType: "derived" }], mapId: MAP }],
        memberships: [{ artifactId: MAP, artifactKind: "map" as const }],
        savedRegistryIds: new Set([REGISTRY]),
      }),
    );
    expect(byKey(result).get(REGISTRY)).toStrictEqual({ kind: "derived", publish: true });
  });

  it("drops builder autosaves and deleted artifacts with reasons", () => {
    const result = bundleClosure(
      input({
        layersByMap: [], // MAP2's membership has no live map behind it.
        lifecycleByDataset: new Map(),
        memberships: [
          { artifactId: REGISTRY, artifactKind: "derived" as const },
          { artifactId: MAP2, artifactKind: "map" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
        ],
      }),
    );
    expect(result.members).toStrictEqual([]);
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { id: REGISTRY, reason: expect.stringContaining("saved transform") },
        { id: MAP2, reason: expect.stringContaining("map") },
        { id: DRAFT, reason: expect.stringContaining("no longer exists") },
      ]),
    );
  });
});

describe("bundleClosure: order and cycle safety", () => {
  it("emits the canonical write order: datasets, then derived, then maps", () => {
    const result = bundleClosure(
      input({
        layersByMap: [
          { layers: [{ targetId: DRAFT, targetType: "dataset" }], mapId: MAP },
          { layers: [], mapId: MAP2 },
        ],
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [
          { artifactId: MAP, artifactKind: "map" as const },
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: REGISTRY, artifactKind: "derived" as const },
          { artifactId: MAP2, artifactKind: "map" as const },
        ],
        savedRegistryIds: new Set([REGISTRY]),
      }),
    );
    expect(result.members.map((member) => member.kind)).toStrictEqual([
      "dataset",
      "derived",
      "map",
      "map",
    ]);
  });

  it("walks a diamond of collections and groups without duplicating (visited-set guard)", () => {
    // DRAFT sits in both collections; both collections are layered; one also
    // through a group DRAFT belongs to. Every path lands on one member.
    const result = bundleClosure(
      input({
        collectionMembers: [
          { collectionId: "col:1", schemaId: DRAFT },
          { collectionId: "col:2", schemaId: DRAFT },
        ],
        groupIdByDataset: new Map([[DRAFT, "group:1"]]),
        groupsByCollection: [{ collectionId: "col:1", groupId: "group:1" }],
        layersByMap: [
          {
            layers: [
              { targetId: "col:1", targetType: "collection" },
              { targetId: "col:2", targetType: "collection" },
            ],
            mapId: MAP,
          },
        ],
        lifecycleByDataset: new Map([[DRAFT, "draft" as const]]),
        memberships: [
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: MAP, artifactKind: "map" as const },
        ],
      }),
    );
    expect(result.members.filter((member) => member.kind === "dataset")).toHaveLength(1);
    expect(result.dropped).toStrictEqual([]);
  });

  it("records map members' dataset-layer targets for the reference leg, collection layers included", () => {
    const result = bundleClosure(
      input({
        collectionMembers: [{ collectionId: "col:1", schemaId: PUBLISHED }],
        layersByMap: [
          {
            layers: [
              { targetId: "col:1", targetType: "collection" },
              { targetId: PUBLISHED, targetType: "dataset" },
              { targetId: "group:5", targetType: "group" },
            ],
            mapId: MAP,
          },
        ],
        lifecycleByDataset: new Map([[PUBLISHED, "published" as const]]),
        memberships: [{ artifactId: MAP, artifactKind: "map" as const }],
      }),
    );
    const mapMember = result.members.find((member) => member.kind === "map");
    expect(mapMember === undefined ? undefined : mapMember.layerTargets).toStrictEqual([PUBLISHED]);
  });

  it("drops a foreign draft discovered only through live expansion — never frozen by someone else's press", () => {
    const FOREIGN = "draft:foreign-wip" as const;
    const result = bundleClosure(
      input({
        collectionMembers: [
          { collectionId: "col:1", schemaId: DRAFT },
          { collectionId: "col:1", schemaId: FOREIGN },
        ],
        layersByMap: [{ layers: [{ targetId: "col:1", targetType: "collection" }], mapId: MAP }],
        lifecycleByDataset: new Map([
          [DRAFT, "draft" as const],
          [FOREIGN, "draft" as const],
        ]),
        memberships: [
          // DRAFT is the project's own (a membership); FOREIGN merely shares
          // the layered collection.
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: MAP, artifactKind: "map" as const },
        ],
      }),
    );
    // The project's own draft is captured; the foreign one is not.
    expect(byKey(result).has(DRAFT)).toBe(true);
    expect(byKey(result).has(FOREIGN)).toBe(false);
    expect(result.dropped).toEqual([
      { id: FOREIGN, reason: expect.stringContaining("doesn't hold") },
    ]);
  });

  it("captures a layer-targeted draft the project holds only through its map", () => {
    // DRAFT2 has no membership row but is a direct dataset-layer target —
    // the map forces it (auto-publish), so "layer" captures it.
    const result = bundleClosure(
      input({
        collectionMembers: [{ collectionId: "col:1", schemaId: DRAFT }],
        layersByMap: [
          {
            layers: [
              { targetId: "col:1", targetType: "collection" },
              { targetId: DRAFT2, targetType: "dataset" },
            ],
            mapId: MAP,
          },
        ],
        lifecycleByDataset: new Map([
          [DRAFT, "draft" as const],
          [DRAFT2, "draft" as const],
        ]),
        memberships: [
          { artifactId: DRAFT, artifactKind: "dataset" as const },
          { artifactId: MAP, artifactKind: "map" as const },
        ],
      }),
    );
    expect(byKey(result).has(DRAFT)).toBe(true);
    expect(byKey(result).has(DRAFT2)).toBe(true);
    expect(result.dropped).toStrictEqual([]);
  });
});

describe("bundleClosure: derived order and bound honesty", () => {
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

  it("reports maps past the read bound distinctly, never as deleted", () => {
    const result = bundleClosure(
      input({
        layersByMap: [],
        memberships: [
          { artifactId: MAP, artifactKind: "map" as const },
          { artifactId: MAP2, artifactKind: "map" as const },
        ],
        unexaminedMapIds: new Set([MAP2]),
      }),
    );
    const mapDrop = result.dropped.find((entry) => entry.id === MAP2);
    expect(mapDrop === undefined ? undefined : mapDrop.reason).toContain("200-map");
    const goneDrop = result.dropped.find((entry) => entry.id === MAP);
    expect(goneDrop === undefined ? undefined : goneDrop.reason).toContain("no longer exists");
  });
});
