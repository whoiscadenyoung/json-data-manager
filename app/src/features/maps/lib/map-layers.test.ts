import type { Geometry } from "@caden/json-cms/react";
import { describe, expect, it } from "vitest";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";

import {
  chainViewOf,
  expandLayerDatasets,
  keyedGeometryRows,
  toFeatureRow,
  type DatasetSummary,
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
    mapTileArchiveFormatCurrent: true,
    title: `ds-${id}`,
  };
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

describe("expandLayerDatasets", () => {
  it("keeps the dataset branch's geospatial gating and expands dataset layers", () => {
    const expanded = expandLayerDatasets(
      [layer("L1", "dataset", "s1"), layer("L2", "dataset", "s2")],
      [dataset("s1", "geospatial"), dataset("s2", "standard")],
      NO_MEMBERSHIPS,
      NO_GROUPS,
    );
    expect(expanded.get("L1")).toStrictEqual(["s1"]);
    expect(expanded.get("L2")).toStrictEqual([]);
  });
});

describe("feature click payloads (the 3b contract)", () => {
  it("points a re-keyed feature's click payload at the SOURCE dataset, and a plain feature's at itself", () => {
    const resolved: Geometry = { coordinates: [0, 0], type: "Point" };
    const plain = toFeatureRow(geometryRow("g1", "s1", "e1"), resolved),
      reKeyed = toFeatureRow(
        { ...geometryRow("g1", "s1", "e1"), schemaId: "d1", sourceSchemaId: "s1" },
        resolved,
      );

    // The exact {entryId, schemaId} shape the popups read — the re-keyed
    // feature's schemaId is where the entry LIVES, so the popup and its
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
      keyed = keyedGeometryRows(rows, chainView.sourceByRenderId);
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

  it("keeps plain rows untouched when no chain layer draws them", () => {
    const rows = [geometryRow("g1", "s1", "e1"), geometryRow("g2", "s2", "e2")],
      keyed = keyedGeometryRows(rows);
    expect(keyed).toHaveLength(2);
    expect(keyed.every((row) => row.sourceSchemaId === undefined)).toBe(true);
  });
});
