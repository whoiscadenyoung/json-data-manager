import type { Geometry } from "@caden/json-cms/react";
import { describe, expect, it } from "vitest";

import type { DatasetGeometryRow } from "./dataset-rows";
import {
  chainViewOf,
  expandLayerDatasets,
  keyedGeometryRows,
  renderTargetsForDerivedLayers,
  toFeatureRow,
  type DatasetSummary,
  type DerivedDatasetSummary,
  type GroupSummary,
  type MapLayerDoc,
  type MembershipRow,
} from "./map-layers";

// Test fixtures over the generated projections — ids stay plain strings
// (tests are exempt from the unsafe-assertion ban).

function dataset(id: string, kind: "geospatial" | "standard", groupId?: string): DatasetSummary {
  return {
    _creationTime: 0,
    _id: id,
    entryCount: 0,
    featureCount: 0,
    fieldCount: 0,
    groupId,
    kind,
    title: `ds-${id}`,
  };
}

function derived(
  id: string,
  sourceDatasetId: string,
  health: "orphaned" | "ready" | "stale",
): DerivedDatasetSummary {
  return {
    _creationTime: 0,
    _id: id,
    createdBy: "user",
    health,
    sourceDatasetId,
    status: "saved",
    title: `derived-${id}`,
  } as DerivedDatasetSummary;
}

function layer(
  id: string,
  targetType: MapLayerDoc["targetType"],
  targetId: string,
  visible = true,
): MapLayerDoc {
  return { _creationTime: 0, _id: id, mapId: "m1", order: 0, targetId, targetType, visible };
}

function geometryRow(id: string, schemaId: string, entryId: string): DatasetGeometryRow {
  return {
    _creationTime: 0,
    _id: id,
    entryId,
    geometryJson: '{"type":"Point","coordinates":[0,0]}',
    schemaId,
  } as DatasetGeometryRow;
}

const NO_MEMBERSHIPS: MembershipRow[] = [],
  NO_GROUPS: GroupSummary[] = [];

describe("renderTargetsForDerivedLayers", () => {
  it("maps a ready derived dataset to a geospatial bottom source", () => {
    const targets = renderTargetsForDerivedLayers(
      [derived("d1", "s1", "ready")],
      [dataset("s1", "geospatial")],
    );
    expect(targets.get("d1")).toBe("s1");
  });

  it("skips rows whose read-time health is not ready", () => {
    const targets = renderTargetsForDerivedLayers(
      [derived("d1", "s1", "ready"), derived("d2", "s1", "stale"), derived("d3", "s1", "orphaned")],
      [dataset("s1", "geospatial")],
    );
    expect(targets.has("d1")).toBe(true);
    expect(targets.has("d2")).toBe(false);
    expect(targets.has("d3")).toBe(false);
  });

  it("skips chains whose bottom source is not a geospatial dataset", () => {
    const targets = renderTargetsForDerivedLayers(
      [derived("d1", "s1", "ready")],
      [dataset("s1", "standard")],
    );
    expect(targets.has("d1")).toBe(false);
  });

  it("skips a bottom source that resolves to nothing (deleted or unknown id)", () => {
    const targets = renderTargetsForDerivedLayers([derived("d1", "gone", "ready")], []);
    expect(targets.has("d1")).toBe(false);
  });

  it("walks derived-of-derived chains to the bottom component source", () => {
    const targets = renderTargetsForDerivedLayers(
      [derived("d2", "d1", "ready"), derived("d1", "s1", "ready")],
      [dataset("s1", "geospatial")],
    );
    expect(targets.get("d2")).toBe("s1");
    // The intermediate derived id is itself renderable too (it names a real chain).
    expect(targets.get("d1")).toBe("s1");
  });

  it("survives a (defensively) cyclic chain without looping", () => {
    const targets = renderTargetsForDerivedLayers(
      [derived("d1", "d2", "ready"), derived("d2", "d1", "ready")],
      [dataset("s1", "geospatial")],
    );
    expect(targets.size).toBe(0);
  });
});

describe("expandLayerDatasets with derived layers", () => {
  it("expands a derived layer to its own id when renderable — never dropping it in the geospatial filter", () => {
    const expanded = expandLayerDatasets(
      [layer("L1", "derived", "d1")],
      [dataset("s1", "geospatial")],
      NO_MEMBERSHIPS,
      NO_GROUPS,
      new Map([["d1", "s1"]]),
    );
    // The derived id has no schemas row — the pre-3a filter would have
    // silently dropped it; the render gate happens before the filter now.
    expect(expanded.get("L1")).toStrictEqual(["d1"]);
  });

  it("expands a non-renderable derived layer to an empty list", () => {
    const expanded = expandLayerDatasets(
      [layer("L1", "derived", "dX")],
      [dataset("s1", "geospatial")],
      NO_MEMBERSHIPS,
      NO_GROUPS,
      new Map([["d1", "s1"]]),
    );
    expect(expanded.get("L1")).toStrictEqual([]);
  });

  it("keeps the dataset branch's geospatial gating and expands dataset layers as before", () => {
    const expanded = expandLayerDatasets(
      [layer("L1", "dataset", "s1"), layer("L2", "dataset", "s2")],
      [dataset("s1", "geospatial"), dataset("s2", "standard")],
      NO_MEMBERSHIPS,
      NO_GROUPS,
      new Map(),
    );
    expect(expanded.get("L1")).toStrictEqual(["s1"]);
    expect(expanded.get("L2")).toStrictEqual([]);
  });
});

describe("derived geometry re-keying (the 3b click-payload contract)", () => {
  it("keeps every plain row and adds one copy per derived layer over its source", () => {
    const rows = [geometryRow("g1", "s1", "e1"), geometryRow("g2", "s2", "e2")],
      keyed = keyedGeometryRows(rows, new Map([["s1", ["d1", "d2"]]]));

    // The plain rows stay (a source that is ALSO a layer keeps drawing as
    // itself), plus one re-keyed copy per derived layer: g1 as itself, once
    // as d1, once as d2, and untouched g2.
    expect(keyed).toHaveLength(4);
    expect(keyed.filter((row) => row.schemaId === "s1")).toHaveLength(1);
    expect(keyed.filter((row) => row.schemaId === "d1")).toHaveLength(1);
    expect(keyed.filter((row) => row.schemaId === "d2")).toHaveLength(1);
    const derivedCopy = keyed.find((row) => row.schemaId === "d2");
    if (derivedCopy === undefined) {
      throw new Error("no d2 copy was keyed");
    }
    expect(derivedCopy.sourceSchemaId).toBe("s1");
    // Rows of datasets no derived layer draws are untouched.
    expect(keyed.filter((row) => row.schemaId === "s2")).toHaveLength(1);
  });

  it("points a re-keyed feature's click payload at the SOURCE dataset, and a plain feature's at itself", () => {
    const resolved: Geometry = { coordinates: [0, 0], type: "Point" };
    const plain = toFeatureRow(geometryRow("g1", "s1", "e1"), resolved),
      reKeyed = toFeatureRow(
        { ...geometryRow("g1", "s1", "e1"), schemaId: "d1", sourceSchemaId: "s1" },
        resolved,
      );

    // The exact {entryId, schemaId} shape 3b reads — the derived feature's
    // schemaId is where the entry LIVES, so the popup and its
    // "View details" link keep working.
    expect(plain.properties).toStrictEqual({ entryId: "e1", schemaId: "s1" });
    expect(reKeyed.properties).toStrictEqual({ entryId: "e1", schemaId: "s1" });
    expect(reKeyed.id).toBe("e1");
  });
});

describe("chain resolution (7b, #103): a published map's layer renders its published head", () => {
  const chainView = chainViewOf(
    [
      { anchorId: "draft1", mode: "float", resolvedSchemaId: "v1row" },
      { anchorId: "live1", mode: "float", resolvedSchemaId: undefined },
      { anchorId: "draft2", mode: "pin", resolvedSchemaId: "pinnedRow" },
    ],
    [
      dataset("v1row", "geospatial"),
      dataset("live1", "geospatial"),
      dataset("draft2", "geospatial"),
    ],
  );

  it("maps render anchors to their resolved rows and skips targets with no chain", () => {
    expect(chainView.sourceByRenderId.get("draft1")).toBe("v1row");
    expect(chainView.sourceByRenderId.get("draft2")).toBe("pinnedRow");
    expect(chainView.sourceByRenderId.has("live1")).toBe(false);
  });

  it("suppresses a retired pin — never a fallback to the anchor's live rows", () => {
    const view = chainViewOf(
      [
        // The pinned row was retired: the resolution comes back with no row.
        { anchorId: "pinnedGone", mode: "pin", resolvedSchemaId: undefined },
        // A float with no chain is NOT suppressed — the layer renders itself.
        { anchorId: "neverChained", mode: "float", resolvedSchemaId: undefined },
      ],
      [dataset("pinnedGone", "geospatial")],
    );
    expect(view.suppressedAnchors.has("pinnedGone")).toBe(true);
    expect(view.suppressedAnchors.has("neverChained")).toBe(false);
    expect(view.sourceByRenderId.has("pinnedGone")).toBe(false);
  });

  it("aliases a resolved row under its draft anchor, archive fields stripped (row path by rule)", () => {
    const alias = chainView.aliases.find((row) => row._id === "draft1");
    if (alias === undefined) {
      throw new Error("no alias for draft1");
    }
    expect(alias.title).toBe("ds-v1row");
    expect(alias.kind).toBe("geospatial");
    expect(alias.mapTileArchiveBuiltVersion).toBeUndefined();
    expect(alias.mapTileCacheVersion).toBeUndefined();
    // A target that already has its own summary (live datasets) gets none.
    expect(chainView.aliases.some((row) => row._id === "live1")).toBe(false);
  });

  it("re-keys the resolved row's geometry under the anchor and never draws the anchor's live rows", () => {
    const rows = [
        geometryRow("gLive", "draft1", "eDraft"),
        geometryRow("gFrozen", "v1row", "eFrozen"),
      ],
      keyed = keyedGeometryRows(rows, new Map(), chainView.sourceByRenderId);
    // The draft's live row draws NOTHING through the anchor; the frozen row
    // draws once as itself (if layered directly) and once as the anchor.
    expect(
      keyed.filter((row) => row.schemaId === "draft1" && row.sourceSchemaId === undefined),
    ).toHaveLength(0);
    const anchorCopy = keyed.find((row) => row.schemaId === "draft1");
    if (anchorCopy === undefined) {
      throw new Error("no anchor copy was keyed");
    }
    expect(anchorCopy.sourceSchemaId).toBe("v1row");
    expect(keyed.filter((row) => row.schemaId === "v1row")).toHaveLength(1);
  });

  it("still feeds derived copies when a resolved anchor is also a derived bottom source", () => {
    const rows = [
        geometryRow("gLive", "draft1", "eDraft"),
        geometryRow("gFrozen", "v1row", "eFrozen"),
      ],
      keyed = keyedGeometryRows(
        rows,
        new Map([["draft1", ["d1"]]]),
        new Map([["draft1", "v1row"]]),
      );
    // The derived layer draws its (live) source's rows under d1, the dataset
    // layer draws the frozen rows under draft1, and the draft's plain rows
    // draw nothing.
    expect(keyed.filter((row) => row.schemaId === "d1")).toHaveLength(1);
    expect(
      keyed.filter((row) => row.schemaId === "draft1" && row.sourceSchemaId === undefined),
    ).toHaveLength(0);
    expect(
      keyed.filter((row) => row.schemaId === "draft1" && row.sourceSchemaId === "v1row"),
    ).toHaveLength(1);
  });
});
