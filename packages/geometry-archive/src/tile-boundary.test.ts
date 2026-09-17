/**
 * Tile-boundary tests: features crossing tile boundaries must appear in
 * every tile they geometrically intersect (buffer handling).
 */
import { describe, expect, test } from "bun:test";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles, type Source } from "pmtiles";

import { buildGeometryArchive } from "./index";

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => "memory://boundary",
    getBytes: async (offset: number, length: number) => {
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
}

function feature(
  id: string,
  geometry: { type: string; coordinates: unknown },
): GeoJSON.Feature {
  return {
    type: "Feature",
    _id: id,
    geometry: geometry,
    properties: null,
  } as unknown as GeoJSON.Feature;
}

describe("tile boundaries", () => {
  test("a line crossing a tile boundary appears in every intersecting tile", async () => {
    // At z4 each tile spans 22.5 degrees of longitude; the boundary between
    // tiles x=8 and x=9 is at lon 22.5. The line crosses it at lat 2.
    const features = [
      feature("crossing", {
        type: "LineString",
        coordinates: [[21.5, 2.0], [23.5, 2.0]],
      }),
    ];
    const archive = await buildGeometryArchive({ features, minZoom: 4, maxZoom: 4 });
    const pmtiles = new PMTiles(memorySource(archive));

    const leftTile = await pmtiles.getZxy(4, 8, 7);
    const rightTile = await pmtiles.getZxy(4, 9, 7);
    if (leftTile === undefined || rightTile === undefined) {
      throw new Error("tiles 4/8/7 or 4/9/7 missing from the archive");
    }
    for (const resolved of [leftTile, rightTile]) {
      const layer = new VectorTile(new PbfReader(resolved.data)).layers["geojson"];
      const ids: string[] = [];
      for (let i = 0; i < layer.length; i += 1) {
        ids.push(layer.feature(i).properties["entryId"] as string);
      }
      expect(ids).toContain("crossing");
    }
  });

  test("a polygon spanning the boundary appears in both tiles", async () => {
    const features = [
      feature("span", {
        type: "Polygon",
        coordinates: [[[22.0, 1.5], [23.0, 1.5], [23.0, 2.5], [22.0, 2.5], [22.0, 1.5]]],
      }),
    ];
    const archive = await buildGeometryArchive({ features, minZoom: 4, maxZoom: 4 });
    const pmtiles = new PMTiles(memorySource(archive));

    const leftTile = await pmtiles.getZxy(4, 8, 7);
    const rightTile = await pmtiles.getZxy(4, 9, 7);
    if (leftTile === undefined || rightTile === undefined) {
      throw new Error("tiles 4/8/7 or 4/9/7 missing from the archive");
    }
    for (const resolved of [leftTile, rightTile]) {
      const layer = new VectorTile(new PbfReader(resolved.data)).layers["geojson"];
      expect(layer.length).toBe(1);
      expect(layer.feature(0).properties["entryId"]).toBe("span");
    }
  });

  test("a buffered point near the boundary repeats into the neighbouring tile", async () => {
    // 0.1 degrees left of the z4 boundary at lon 22.5 sits inside tile x=8
    // strictly; the 64-unit buffer pulls it into tile x=9 as well.
    const features = [
      feature("near", { type: "Point", coordinates: [22.4, 0.0] }),
    ];
    const archive = await buildGeometryArchive({ features, minZoom: 4, maxZoom: 4 });
    const pmtiles = new PMTiles(memorySource(archive));

    const leftTile = await pmtiles.getZxy(4, 8, 7);
    const rightTile = await pmtiles.getZxy(4, 9, 7);
    if (leftTile === undefined || rightTile === undefined) {
      throw new Error("tiles 4/8/7 or 4/9/7 missing from the archive");
    }
    for (const resolved of [leftTile, rightTile]) {
      const layer = new VectorTile(new PbfReader(resolved.data)).layers["geojson"];
      const ids: string[] = [];
      for (let i = 0; i < layer.length; i += 1) {
        ids.push(layer.feature(i).properties["entryId"] as string);
      }
      expect(ids).toContain("near");
    }

    // Two tiles further west the buffer does not reach.
    const farAway = await pmtiles.getZxy(4, 7, 7);
    if (farAway !== undefined) {
      const layer = new VectorTile(new PbfReader(farAway.data)).layers["geojson"];
      const ids: string[] = [];
      for (let i = 0; i < layer.length; i += 1) {
        ids.push(layer.feature(i).properties["entryId"] as string);
      }
      expect(ids).not.toContain("near");
    }
  });

  test("includeProperties carries the allow-listed keys", async () => {
    const features = [
      {
        type: "Feature",
        _id: "withprops",
        geometry: { type: "Point", coordinates: [10.0, 10.0] },
        properties: { name: "hello", count: 3 },
      },
    ] as unknown as GeoJSON.Feature[];
    const archive = await buildGeometryArchive({
      features,
      minZoom: 3,
      maxZoom: 3,
      includeProperties: ["name"],
    });
    const pmtiles = new PMTiles(memorySource(archive));
    const resolved = await pmtiles.getZxy(3, 4, 3);
    if (resolved === undefined) {
      throw new Error("tile 3/4/3 missing from the archive");
    }
    const layer = new VectorTile(new PbfReader(resolved.data)).layers["geojson"];
    const props = layer.feature(0).properties;
    expect(props["entryId"]).toBe("withprops");
    expect(props["name"]).toBe("hello");
    expect(props["count"]).toBeUndefined();
  });
});
