import { describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));
vi.mock("#/lib/store/layers", () => ({}));
vi.mock("#/lib/store/maps", () => ({}));

import type { ArtifactRefRow, LayerRow } from "#/lib/store/layers";
import type { MapPlacementRow } from "#/lib/store/maps";
import type { DatasetRelationRow } from "#/lib/store/relations";

import { mapDatasetIdsOf, relatedLayerNodesOf, relationNotesOf } from "./layer-grouping";

function placement(id: string, layerMemberId: string): MapPlacementRow {
  return { id, layerMemberId, mapId: "map", order: 0, visible: true };
}

function layer(id: string, name: string, datasetMemberId: string | null): LayerRow {
  return {
    createdAt: "",
    createdBy: "u1",
    datasetMemberId,
    filter: null,
    id,
    kind: datasetMemberId === null ? "group" : "data",
    labels: null,
    lifecycle: "draft",
    name,
    needsAttention: null,
    opacity: null,
    popup: null,
    projectId: "p1",
    style: {},
    updatedAt: "",
    visibility: "members",
    visible: true,
  };
}

// Three placements: two owned data layers (states, deployments), one linked layer.
const PLACEMENTS = [
    placement("pl-1", "m-l1"),
    placement("pl-2", "m-l2"),
    placement("pl-3", "m-l3"),
  ],
  MEMBERSHIPS = new Map<string, ArtifactRefRow>([
    ["m-l1", { artifactId: "l1", artifactKind: "layer", id: "m-l1", role: "owned" }],
    ["m-l2", { artifactId: "l2", artifactKind: "layer", id: "m-l2", role: "owned" }],
    ["m-l3", { artifactId: "v9", artifactKind: "layer", id: "m-l3", role: "linked" }],
    ["m-d1", { artifactId: "d-states", artifactKind: "dataset", id: "m-d1", role: "owned" }],
    ["m-d2", { artifactId: "d-deploy", artifactKind: "dataset", id: "m-d2", role: "owned" }],
  ]),
  LAYERS = new Map<string, LayerRow>([
    ["l1", layer("l1", "States", "m-d1")],
    ["l2", layer("l2", "Deployments", "m-d2")],
  ]),
  RELATION: DatasetRelationRow = {
    cardinality: "1-N",
    config: { fromKey: "id", toKey: "stateId" },
    createdAt: "",
    createdBy: "u1",
    fromDataset: "d-states",
    id: "r1",
    kind: "key",
    toDataset: "d-deploy",
    updatedAt: "",
  };

describe("mapDatasetIdsOf", () => {
  it("names the datasets the map's own data layers draw, skipping linked layers", () => {
    expect(mapDatasetIdsOf(PLACEMENTS, MEMBERSHIPS, LAYERS)).toEqual(["d-deploy", "d-states"]);
  });
});

describe("relatedLayerNodesOf", () => {
  it("returns the placed layers of the wanted datasets", () => {
    expect(relatedLayerNodesOf(PLACEMENTS, MEMBERSHIPS, LAYERS, ["d-states", "d-deploy"])).toEqual([
      { layerId: "l1", name: "States", placementId: "pl-1" },
      { layerId: "l2", name: "Deployments", placementId: "pl-2" },
    ]);
  });

  it("proposes nothing when fewer than two layers qualify", () => {
    expect(relatedLayerNodesOf(PLACEMENTS, MEMBERSHIPS, LAYERS, ["d-states"])).toBeUndefined();
    expect(
      relatedLayerNodesOf(PLACEMENTS, MEMBERSHIPS, LAYERS, ["d-states", "d-missing"]),
    ).toBeUndefined();
  });
});

describe("relationNotesOf", () => {
  it("gives each related dataset a line naming the other one", () => {
    const titles: Record<string, string> = { "d-deploy": "Deployments", "d-states": "States" },
      notes = relationNotesOf([RELATION], ["d-states", "d-deploy"], (id) => titles[id] ?? id);
    expect(notes.get("d-states")).toHaveLength(1);
    expect((notes.get("d-states") ?? [])[0]).toContain("Related to Deployments");
    expect((notes.get("d-deploy") ?? [])[0]).toContain("Related to States");
  });

  it("leaves out datasets with no relation on this map", () => {
    expect(relationNotesOf([RELATION], ["d-states"], (id) => id).size).toBe(0);
  });
});
