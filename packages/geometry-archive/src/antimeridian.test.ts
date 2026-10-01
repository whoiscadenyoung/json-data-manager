/**
 * Antimeridian tiling (issue #134): every feature of a dateline-crossing
 * island chain has a ~360° lon bbox, which the old per-feature bbox sweep
 * enumerated as the full tile range at every zoom — millions of empty-tile
 * probes per build that grow linearly with feature count. The archive must
 * tile such data in bounded time and carry tiles on both sides of the
 * dateline.
 */
import { describe, expect, test } from "bun:test";

import { PMTiles, type Source } from "pmtiles";

import { buildGeometryArchive } from "./index";
import type { GeoJSONFeature } from "./types";

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => "memory://antimeridian",
    getBytes: async (offset: number, length: number) => {
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
}

/**
 * A small island straddling the dateline at `lat`: one MultiPolygon part east
 * of 180°, one west of it. No ring edge crosses the map — the parts are
 * genuinely local — but the feature's lon bbox still spans ~359.9°, which is
 * what made the old sweep walk the full tile row at every zoom.
 */
function straddlingIsland(id: string, lat: number): GeoJSONFeature {
  return {
    type: "Feature",
    _id: id,
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [179.8, lat],
            [179.95, lat],
            [179.95, lat + 0.1],
            [179.8, lat + 0.1],
            [179.8, lat],
          ],
        ],
        [
          [
            [-179.95, lat],
            [-179.8, lat],
            [-179.8, lat + 0.1],
            [-179.95, lat + 0.1],
            [-179.95, lat],
          ],
        ],
      ],
    },
    properties: null,
  };
}

/** Web-mercator tile indexes for one lon/lat position (test-local math). */
function tileAt(z: number, lon: number, lat: number): { x: number; y: number } {
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const radians = (lat * Math.PI) / 180;
  const y = Math.floor((0.5 - Math.asinh(Math.tan(radians)) / (2 * Math.PI)) * 2 ** z);
  return { x, y };
}

describe("antimeridian tiling", () => {
  test("a dateline-crossing island chain tiles in bounded time", async () => {
    // 40 islands across 12° of latitude (Aleutian-chain shape). The old
    // per-feature sweep measured ~7.5 s on exactly this fixture and grows
    // linearly with feature count; the tree walk costs one getTile per
    // populated tile plus its immediate empty neighbors.
    const features = Array.from({ length: 40 }, (_, i) =>
      straddlingIsland(`island-${i}`, 60 + i * 0.3),
    );

    const start = performance.now();
    const archive = await buildGeometryArchive({ features, minZoom: 0, maxZoom: 14 });
    const elapsedMs = performance.now() - start;

    expect(archive.byteLength).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  test("tiles exist on both sides of the dateline", async () => {
    const features = [straddlingIsland("island", 64)];
    const archive = await buildGeometryArchive({ features, minZoom: 0, maxZoom: 8 });
    const pmtiles = new PMTiles(memorySource(archive));

    // The east part (179.8–179.95°E) lives in the last tile column, the west
    // part (−179.95–−179.8°E) in column 0 — the same tile row.
    const east = tileAt(8, 179.9, 64.05);
    const west = tileAt(8, -179.9, 64.05);
    expect(east.x).toBe(255);
    expect(west.x).toBe(0);
    expect(await pmtiles.getZxy(8, east.x, east.y)).toBeDefined();
    expect(await pmtiles.getZxy(8, west.x, west.y)).toBeDefined();
  }, 60_000);
});
