import type { Geometry } from "@caden/json-cms/react";
import { describe, expect, it } from "vitest";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";

import { keyedGeometryRows, toFeatureRow } from "./map-layers";

function geometryRow(id: string, schemaId: string, entryId: string): DatasetGeometryRow {
  return {
    _creationTime: 0,
    _id: id,
    entryId,
    geometryJson: '{"type":"Point","coordinates":[0,0]}',
    schemaId,
  } as DatasetGeometryRow;
}

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

describe("keyedGeometryRows (7b, #103): a published map's layer renders its published head", () => {
  const sourceByRenderId = new globalThis.Map([["draft1", "v1row"]]);

  it("re-keys the resolved row's geometry under the anchor and never draws the anchor's live rows", () => {
    const rows = [
        geometryRow("gLive", "draft1", "eDraft"),
        geometryRow("gFrozen", "v1row", "eFrozen"),
      ],
      keyed = keyedGeometryRows(rows, sourceByRenderId);
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
