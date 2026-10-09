import { describe, expect, it } from "vitest";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";
import type { Id, TableNames } from "#convex/_generated/dataModel";

import type { LayerDetail, MapPlacement, RenderLayer, StoredStyle } from "./map-layers";
import {
  effectiveRenderLayers,
  isLayersWorkspaceComplete,
  keyedGeometryRows,
  layersMapShouldMount,
  narrowStoredStyle,
  orderedChildrenOf,
  renderIdsByDatasetIdOf,
  styleOrDefault,
  withArrivedTileSchema,
  withEmptyRows,
} from "./map-layers";

/**
 * The fixtures seed plain-string ids; the app-side Ids in the read shapes
 * are string intersections with no public constructor (only the db
 * normalizes real ids), so this file scopes the one branding assertion —
 * string → its own intersection, no `any`/`unknown` involved.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above; a test-fixture brand with no runtime form.
const asId = <T extends TableNames>(value: string): Id<T> => value as Id<T>;

// Fixtures are hand-built against the read shapes: an owned placement
// embeds the live layer projection (every projected key present, undefined
// when unset); a linked one the pinned version's frozen render fields; a
// missing one the defensive answer.

function ownedDataPlacement(overrides: {
  _id?: string;
  datasetMemberId?: string;
  lifecycle?: "draft" | "published";
  name?: string;
  style?: StoredStyle;
  visible?: boolean;
}): MapPlacement {
  return {
    _creationTime: 0,
    _id: asId<"mapLayers">(overrides._id ?? "p1"),
    kind: "owned",
    layer: {
      datasetMemberId:
        overrides.datasetMemberId === undefined
          ? undefined
          : asId<"projectArtifacts">(overrides.datasetMemberId),
      kind: "data",
      layerId: asId<"layers">("L1"),
      lifecycle: overrides.lifecycle ?? "draft",
      name: overrides.name ?? "Points layer",
      needsAttention: undefined,
      opacity: undefined,
      style: overrides.style,
    },
    layerMemberId: asId<"projectArtifacts">("mem1"),
    order: 0,
    visible: overrides.visible ?? true,
  };
}

function linkedPlacement(overrides: {
  _id?: string;
  name?: string;
  pinnedSchemaId?: string;
  style?: StoredStyle;
  visible?: boolean;
}): MapPlacement {
  return {
    _creationTime: 0,
    _id: asId<"mapLayers">(overrides._id ?? "p2"),
    kind: "linked",
    layer: {
      kind: "data",
      name: overrides.name ?? "Frozen layer",
      opacity: undefined,
      pinnedSchemaId: overrides.pinnedSchemaId,
      style: overrides.style,
      versionLabel: "v3",
    },
    layerMemberId: asId<"projectArtifacts">("mem2"),
    order: 1,
    visible: overrides.visible ?? true,
  };
}

function missingPlacement(id: string): MapPlacement {
  return {
    _creationTime: 0,
    _id: asId<"mapLayers">(id),
    kind: "missing",
    layerMemberId: asId<"projectArtifacts">("mem-gone"),
    order: 2,
    visible: true,
  };
}

function groupPlacement(layerId: string, placementId: string, visible?: boolean): MapPlacement {
  return {
    _creationTime: 0,
    _id: asId<"mapLayers">(placementId),
    kind: "owned",
    layer: {
      datasetMemberId: undefined,
      kind: "group",
      layerId: asId<"layers">(layerId),
      lifecycle: "draft",
      name: "A group",
      needsAttention: undefined,
      opacity: undefined,
      style: undefined,
    },
    layerMemberId: asId<"projectArtifacts">("mem-group"),
    order: 0,
    visible: visible ?? true,
  };
}

function groupDetail(children: LayerDetail["children"]): LayerDetail {
  return {
    _creationTime: 0,
    _id: asId<"layers">("G1"),
    children,
    datasetMemberId: undefined,
    filter: undefined,
    kind: "group",
    labels: undefined,
    lifecycle: "draft",
    membershipId: undefined,
    name: "A group",
    needsAttention: undefined,
    opacity: undefined,
    parentGroupId: undefined,
    popup: undefined,
    projectId: asId<"projects">("proj1"),
    style: undefined,
    visible: true,
  };
}

describe("styleOrDefault", () => {
  it("fills every field from the defaults when nothing is stored", () => {
    const style = styleOrDefault(undefined);
    expect(style.color).toBe("#3b82f6");
    expect(style.fillColor).toBe("#3b82f6");
    expect(style.fillOpacity).toBe(0.2);
    expect(style.radius).toBe(5);
    expect(style.weight).toBe(2);
  });

  it("lets stored values win field by field and falls the fill color back to the stroke", () => {
    const style = styleOrDefault({ color: "#ef4444", weight: 4 });
    expect(style.color).toBe("#ef4444");
    expect(style.fillColor).toBe("#ef4444");
    expect(style.weight).toBe(4);
    expect(style.fillOpacity).toBe(0.2);
  });

  it("drops junk values (wrong type, empty string) back to defaults", () => {
    const style = styleOrDefault({
      color: "",
      fillColor: "#22c55e",
      fillOpacity: Number.NaN,
      radius: 9,
    });
    expect(style.color).toBe("#3b82f6");
    expect(style.fillColor).toBe("#22c55e");
    expect(style.fillOpacity).toBe(0.2);
    expect(style.radius).toBe(9);
  });
});

describe("narrowStoredStyle", () => {
  it("answers undefined for non-records and keeps only known string/number fields", () => {
    expect(narrowStoredStyle(undefined)).toBeUndefined();
    expect(narrowStoredStyle("junk")).toBeUndefined();
    const narrowed = narrowStoredStyle({ color: "#111111", sneaky: true, weight: 3 });
    // Every known key is present (undefined when the blob lacked it).
    expect(narrowed).toStrictEqual({
      color: "#111111",
      fillColor: undefined,
      fillOpacity: undefined,
      opacity: undefined,
      radius: undefined,
      weight: 3,
    });
  });
});

describe("effectiveRenderLayers", () => {
  const membershipJoin = new globalThis.Map([
    ["m1", "ds1"],
    ["m2", "ds2"],
  ]);

  it("flattens owned data layers through the membership join", () => {
    const renderLayers = effectiveRenderLayers(
      [ownedDataPlacement({ datasetMemberId: "m1" })],
      new globalThis.Map(),
      membershipJoin,
    );
    expect(renderLayers).toHaveLength(1);
    const layer = renderLayers[0];
    expect(layer === undefined ? undefined : layer.datasetId).toBe("ds1");
    expect(layer === undefined ? undefined : layer.renderId).toBe("p1");
    expect(layer === undefined ? undefined : layer.kind).toBe("owned");
  });

  it("renders a linked placement from its frozen pin and skips missing ones", () => {
    const renderLayers = effectiveRenderLayers(
      [linkedPlacement({ pinnedSchemaId: "ds9" }), missingPlacement("p3")],
      new globalThis.Map(),
      membershipJoin,
    );
    expect(renderLayers).toHaveLength(1);
    const layer = renderLayers[0];
    expect(layer === undefined ? undefined : layer.datasetId).toBe("ds9");
    expect(layer === undefined ? undefined : layer.kind).toBe("linked");
  });

  it("flattens a placed group into its ordered children, the group's eye gating theirs", () => {
    const detail = groupDetail([
      // A deleted child row: the defensive null answer, dropped on read.
      { child: null, childKind: "owned", childLayerId: "gone", order: 0 },
      {
        child: {
          kind: "data",
          lifecycle: "draft",
          name: "Child A",
          needsAttention: undefined,
          opacity: undefined,
          style: { color: "#22c55e" },
          visible: false,
        },
        childKind: "owned",
        childLayerId: "c1",
        order: 1,
      },
      {
        child: {
          datasetPinnedSchemaId: "ds7",
          kind: "data",
          name: "Child B",
          opacity: undefined,
          style: undefined,
          versionLabel: "v1",
        },
        childKind: "linked",
        childLayerId: "v9",
        order: 2,
      },
    ]);
    const details = new globalThis.Map([["G1", detail]]);
    const renderLayers = effectiveRenderLayers(
      [groupPlacement("G1", "pg")],
      details,
      membershipJoin,
    );
    // The group flattens to its two resolved children in draw order, the
    // deleted child dropped on read.
    expect(renderLayers.map((layer) => layer.name)).toStrictEqual(["Child A", "Child B"]);
    const childA = renderLayers[0],
      childB = renderLayers[1];
    expect(childA === undefined ? undefined : childA.visible).toBe(false);
    expect(childA === undefined ? undefined : childA.datasetId).toBeUndefined();
    expect(childB === undefined ? undefined : childB.datasetId).toBe("ds7");
    expect(childB === undefined ? undefined : childB.kind).toBe("group-child");
    expect(childB === undefined ? undefined : childB.renderId).toBe("pg:v9");
  });

  it("hides every child when the group placement's eye is off", () => {
    const detail = groupDetail([
      {
        child: {
          kind: "data",
          lifecycle: "draft",
          name: "Child A",
          needsAttention: undefined,
          opacity: undefined,
          style: undefined,
          visible: true,
        },
        childKind: "owned",
        childLayerId: "c1",
        order: 0,
      },
    ]);
    const renderLayers = effectiveRenderLayers(
      [groupPlacement("G1", "pg", false)],
      new globalThis.Map([["G1", detail]]),
      new globalThis.Map([["m1", "ds1"]]),
    );
    const child = renderLayers[0];
    expect(child === undefined ? undefined : child.visible).toBe(false);
  });
});

describe("orderedChildrenOf", () => {
  it("orders children by their row order and drops nulls", () => {
    const detail = groupDetail([
      {
        child: {
          kind: "data",
          lifecycle: "draft",
          name: "B",
          needsAttention: undefined,
          opacity: undefined,
          style: undefined,
          visible: true,
        },
        childKind: "owned",
        childLayerId: "b",
        order: 5,
      },
      { child: null, childKind: "owned", childLayerId: "gone", order: 1 },
      {
        child: {
          kind: "data",
          lifecycle: "draft",
          name: "A",
          needsAttention: undefined,
          opacity: undefined,
          style: undefined,
          visible: true,
        },
        childKind: "owned",
        childLayerId: "a",
        order: 2,
      },
    ]);
    expect(orderedChildrenOf(detail).map((child) => child.name)).toStrictEqual(["A", "B"]);
  });
});

/** A minimal render-layer fixture (style merged from the defaults). */
function renderLayer(overrides: {
  datasetId: string | undefined;
  renderId: string;
  visible?: boolean;
}): RenderLayer {
  return {
    datasetId: overrides.datasetId,
    kind: "owned",
    name: overrides.renderId,
    placementId: overrides.renderId,
    renderId: overrides.renderId,
    style: styleOrDefault(undefined),
    visible: overrides.visible ?? true,
  };
}

/** A minimal point-geometry row fixture. */
function geometryRow(id: string, schemaId: string): DatasetGeometryRow {
  return {
    _creationTime: 0,
    _id: id,
    entryId: "entry-1",
    geometryJson: `{"type":"Point","coordinates":[0,${id.length}]}`,
    schemaId,
    type: "Point",
  };
}

describe("renderIdsByDatasetIdOf + keyedGeometryRows", () => {
  it("re-keys one row per VISIBLE render layer styling its dataset", () => {
    const renderLayers = [
      renderLayer({ datasetId: "ds1", renderId: "pA" }),
      renderLayer({ datasetId: "ds1", renderId: "pB" }),
      renderLayer({ datasetId: "ds1", renderId: "pC", visible: false }),
    ];
    const byDataset = renderIdsByDatasetIdOf(renderLayers);
    expect(byDataset.get("ds1")).toStrictEqual(["pA", "pB"]);
    const keyed = keyedGeometryRows(
      [geometryRow("g1", "ds1"), geometryRow("g2", "ds2")],
      byDataset,
    );
    // Two visible layers of ds1 → two keyed copies of g1; ds2 has no render
    // layer → dropped (the subscription never fetched it).
    expect(keyed.map((row) => row.schemaId)).toStrictEqual(["pA", "pB"]);
    const first = keyed[0];
    expect(first === undefined ? undefined : first.sourceSchemaId).toBe("ds1");
    expect(first === undefined ? undefined : first.entryId).toBe("entry-1");
  });
});

describe("completeness + mount helpers", () => {
  it("withArrivedTileSchema adds once and stays referentially stable on repeats", () => {
    const once = withArrivedTileSchema(new Set<string>(), "a");
    expect(once.has("a")).toBe(true);
    const twice = withArrivedTileSchema(once, "a");
    expect(twice).toBeInstanceOf(Set);
    expect(twice.size).toBe(1);
  });

  it("isLayersWorkspaceComplete demands rows, no pending decisions, and every tile idle", () => {
    expect(isLayersWorkspaceComplete(undefined, false, ["t1"], new Set(["t1"]))).toBe(false);
    expect(isLayersWorkspaceComplete([], true, ["t1"], new Set(["t1"]))).toBe(false);
    expect(isLayersWorkspaceComplete([], false, ["t1", "t2"], new Set(["t1"]))).toBe(false);
    expect(isLayersWorkspaceComplete([], false, ["t1", "t2"], new Set(["t1", "t2"]))).toBe(true);
  });

  it("layersMapShouldMount mounts on served rows or any tile source", () => {
    expect(layersMapShouldMount(undefined, 0)).toBe(false);
    expect(layersMapShouldMount(undefined, 1)).toBe(true);
    expect(layersMapShouldMount([], 0)).toBe(true);
  });

  it("withEmptyRows maps undefined to []", () => {
    expect(withEmptyRows(undefined)).toStrictEqual([]);
    expect(withEmptyRows([1])).toStrictEqual([1]);
  });
});
