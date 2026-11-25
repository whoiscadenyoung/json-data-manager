import type { Geometry } from "@caden/json-cms/react";
import { describe, expect, it } from "vitest";

import type { GeometryRow } from "#/lib/store/geometries";

import { extentBounds, keyedGeometryRows, toFeatureRow } from "./map-layers";

function geometryRow(datasetId: string, entryId: string): GeometryRow {
  return {
    bbox: null,
    data: {},
    datasetId,
    entryId,
    geometry: { coordinates: [0, 0], type: "Point" },
    sourcePath: null,
    type: "Point",
  };
}

describe("feature click payloads (the 3b contract)", () => {
  it("points a re-keyed feature's click payload at the SOURCE dataset, and a plain feature's at itself", () => {
    const resolved: Geometry = { coordinates: [0, 0], type: "Point" };
    const plain = toFeatureRow(geometryRow("s1", "e1"), resolved),
      reKeyed = toFeatureRow(
        { ...geometryRow("s1", "e1"), datasetId: "d1", sourceDatasetId: "s1" },
        resolved,
      );

    // The exact {entryId, datasetId} shape the popups read — the re-keyed
    // feature's datasetId is where the entry LIVES, so the popup and its
    // "View details" link keep working.
    expect(plain.properties).toStrictEqual({ entryId: "e1", datasetId: "s1" });
    expect(reKeyed.properties).toStrictEqual({ entryId: "e1", datasetId: "s1" });
    expect(reKeyed.id).toBe("e1");
  });
});

describe("keyedGeometryRows (7b, #103): a published map's layer renders its published head", () => {
  const sourceByRenderId = new globalThis.Map([["draft1", "v1row"]]);

  it("re-keys the resolved row's geometry under the anchor and never draws the anchor's live rows", () => {
    const rows = [geometryRow("draft1", "eDraft"), geometryRow("v1row", "eFrozen")],
      keyed = keyedGeometryRows(rows, sourceByRenderId);
    // The draft's live row draws NOTHING through the anchor; the frozen row
    // draws once as itself (if layered directly) and once as the anchor.
    expect(
      keyed.filter((row) => row.datasetId === "draft1" && row.sourceDatasetId === undefined),
    ).toHaveLength(0);
    const anchorCopy = keyed.find((row) => row.datasetId === "draft1");
    if (anchorCopy === undefined) {
      throw new Error("no anchor copy was keyed");
    }
    expect(anchorCopy.sourceDatasetId).toBe("v1row");
    expect(keyed.filter((row) => row.datasetId === "v1row")).toHaveLength(1);
  });

  it("keeps plain rows untouched when no chain layer draws them", () => {
    const rows = [geometryRow("s1", "e1"), geometryRow("s2", "e2")],
      keyed = keyedGeometryRows(rows);
    expect(keyed).toHaveLength(2);
    expect(keyed.every((row) => row.sourceDatasetId === undefined)).toBe(true);
  });
});

describe("extentBounds — the envelope unfold", () => {
  it("folds a closed ring to its coordinate extremes", () => {
    expect(
      extentBounds({
        coordinates: [
          [
            [-5, 0],
            [5, 0],
            [5, 10],
            [-5, 10],
            [-5, 0],
          ],
        ],
        type: "Polygon",
      }),
    ).toStrictEqual([-5, 0, 5, 10]);
  });

  it("answers nothing for a null or non-polygon envelope", () => {
    expect(extentBounds(null)).toBeUndefined();
    expect(extentBounds({ coordinates: [], type: "Point" as never })).toBeUndefined();
  });
});
