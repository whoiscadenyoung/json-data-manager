/**
 * Assembly-level regression tests for issue #125: run-length dedupe must
 * only merge tiles with CONTIGUOUS Hilbert ids (a PMTiles run covers
 * `[tileId, tileId + runLength)`), while byte-level blob dedupe stays
 * intact — multiple entries may point at one stored blob.
 *
 * Both tests read back through the reference `pmtiles` reader.
 */
import { describe, expect, test } from "bun:test";

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles, tileIdToZxy, type Source } from "pmtiles";

import { assembleArchive } from "./assemble";
import { zxyToTileId } from "./hilbert";
import { buildGeometryArchive } from "./index";
import { SOURCE_LAYER_NAME, tileFeatures } from "./tiles";

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => "memory://assemble",
    getBytes: async (offset: number, length: number) => {
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
}

function pointFeature(id: string, lon: number, lat: number): GeoJSON.Feature {
  return {
    type: "Feature",
    _id: id,
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: null,
  } as unknown as GeoJSON.Feature;
}

describe("assembleArchive run-length dedupe", () => {
  test("identical tiles across a tile-id gap get separate entries, one shared blob", async () => {
    // One real z0 tile, installed twice under z1 ids 1 and 3. The z1
    // Hilbert order is (0,0)=1, (0,1)=2, (1,1)=3, (1,0)=4, so id 2
    // (tile 1/0/1) is a GAP: no tile was emitted for it. Merging ids 1
    // and 3 into one run would make the gap id resolve to tile 1's blob
    // and leave tile 3 unreachable.
    const [tile] = tileFeatures([pointFeature("same", 0, 0)], 0, 0, []);
    const firstId = zxyToTileId(1, 0, 0);
    const secondId = zxyToTileId(1, 1, 1);
    expect(secondId).toBeGreaterThan(firstId + 1); // the ids really do skip a gap

    const archive = assembleArchive({
      tiles: [
        { tileId: firstId, data: tile.data },
        { tileId: secondId, data: tile.data },
      ],
      metadata: JSON.stringify({ vector_layers: [] }),
      minZoom: 1,
      maxZoom: 1,
      minLon: -1,
      minLat: -1,
      maxLon: 1,
      maxLat: 1,
      centerZoom: 1,
    });

    // Byte dedupe preserved: two directory entries over one stored blob.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(Number(view.getBigUint64(72, true))).toBe(2); // numAddressedTiles
    expect(Number(view.getBigUint64(80, true))).toBe(2); // numTileEntries
    expect(Number(view.getBigUint64(88, true))).toBe(1); // numTileContents

    const pmtiles = new PMTiles(memorySource(archive));

    // The gap id resolves to NOTHING — it never had a tile.
    expect(await pmtiles.getZxy(1, 0, 1)).toBeUndefined();

    // Both real tiles resolve through the reference reader and decode to
    // the projected feature.
    for (const [x, y] of [
      [0, 0],
      [1, 1],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two independent tile reads; sequential keeps the failure message precise.
      const resolved = await pmtiles.getZxy(1, x, y);
      if (resolved === undefined) {
        throw new Error(
          `tile 1/${x}/${y} missing from the archive (run-length merge crossed the gap)`,
        );
      }
      const layer = new VectorTile(new PbfReader(resolved.data)).layers[SOURCE_LAYER_NAME];
      expect(layer).toBeDefined();
      expect(layer.feature(0).properties["entryId"]).toBe("same");
    }
  }, 60_000);
});

describe("concave multi-part polygon round-trip", () => {
  test("every tile emitted by tileFeatures resolves through the reference reader", async () => {
    // A U-shaped polygon (concave: the notch splits the interior, so the
    // fully-covered interior tiles are byte-identical but their Hilbert
    // ids are not contiguous) plus a disjoint two-part MultiPolygon.
    const uShaped: GeoJSON.Feature = {
      type: "Feature",
      _id: "u",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-30, -30],
            [-30, 30],
            [30, 30],
            [30, -30],
            [10, -30],
            [10, -10],
            [-10, -10],
            [-10, -30],
            [-30, -30],
          ],
        ],
      },
      properties: null,
    } as unknown as GeoJSON.Feature;
    const multiPart: GeoJSON.Feature = {
      type: "Feature",
      _id: "multi",
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [40, 40],
              [43, 40],
              [40, 43],
              [40, 40],
            ],
          ],
          [
            [
              [-50, -40],
              [-47, -40],
              [-50, -37],
              [-50, -40],
            ],
          ],
        ],
      },
      properties: null,
    } as unknown as GeoJSON.Feature;
    const features = [uShaped, multiPart];

    const tiles = tileFeatures(features, 0, 7, []);
    // Sanity: the fixture really spans a wide slice of the id space, so
    // the check below means something.
    expect(tiles.length).toBeGreaterThan(32);

    const archive = await buildGeometryArchive({ features, minZoom: 0, maxZoom: 7 });

    const pmtiles = new PMTiles(memorySource(archive));
    for (const tile of tiles) {
      const [z, x, y] = tileIdToZxy(tile.tileId);
      // oxlint-disable-next-line no-await-in-loop -- every emitted tile must resolve; sequential reads keep the failing id precise.
      const resolved = await pmtiles.getZxy(z, x, y);
      if (resolved === undefined) {
        throw new Error(`tile ${z}/${x}/${y} (id ${tile.tileId}) missing from the archive`);
      }
      const layer = new VectorTile(new PbfReader(resolved.data)).layers[SOURCE_LAYER_NAME];
      expect(layer).toBeDefined();
      for (let index = 0; index < layer.length; index += 1) {
        const entryId = layer.feature(index).properties["entryId"];
        expect(entryId === "u" || entryId === "multi").toBe(true);
      }
    }
  }, 60_000);
});
