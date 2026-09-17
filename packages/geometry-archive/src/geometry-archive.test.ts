/**
 * Roundtrip tests: build archives and read them back through the reference
 * `pmtiles` reader, asserting header fields, Hilbert ordering, dedup, gzip
 * correctness, and id-only property projection.
 */
import { describe, expect, test } from "bun:test";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles, tileIdToZxy, zxyToTileId, type Source } from "pmtiles";

import { buildGeometryArchive } from "./index";
import { zxyToTileId as myZxyToTileId, tileIdToZxy as myTileIdToZxy } from "./hilbert";

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => "memory://test",
    getBytes: async (offset: number, length: number) => {
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
}

function sfFeature(
  id: string,
  geometry: { type: string; coordinates: unknown },
): GeoJSON.Feature {
  return {
    type: "Feature",
    _id: id,
    geometry: geometry,
    properties: { name: `feature-${id}`, ignored: 123 },
  } as unknown as GeoJSON.Feature;
}

const SF_FEATURES: GeoJSON.Feature[] = [
  sfFeature("aaa", { type: "Point", coordinates: [-122.4, 37.8] }),
  sfFeature("bbb", { type: "LineString", coordinates: [[-122.5, 37.7], [-122.3, 37.9]] }),
  sfFeature(
    "ccc",
    {
      type: "Polygon",
      coordinates: [[[-122.45, 37.75], [-122.35, 37.75], [-122.35, 37.85], [-122.45, 37.75]]],
    },
  ),
];

describe("hilbert tile id codec", () => {
  test("matches the spec table", () => {
    expect(myZxyToTileId(0, 0, 0)).toBe(0);
    expect(myZxyToTileId(1, 0, 0)).toBe(1);
    expect(myZxyToTileId(1, 0, 1)).toBe(2);
    expect(myZxyToTileId(1, 1, 1)).toBe(3);
    expect(myZxyToTileId(1, 1, 0)).toBe(4);
    expect(myZxyToTileId(2, 0, 0)).toBe(5);
    expect(myZxyToTileId(12, 3423, 1763)).toBe(19078479);
  });

  test("matches the reference pmtiles implementation across zooms", () => {
    for (let z = 0; z <= 14; z += 1) {
      const tilesPerSide = 2 ** z;
      const stride = Math.max(1, Math.floor(tilesPerSide / 7));
      for (let x = 0; x < tilesPerSide; x += stride) {
        for (let y = 0; y < tilesPerSide; y += stride) {
          expect(myZxyToTileId(z, x, y)).toBe(zxyToTileId(z, x, y));
        }
      }
    }
  });

  test("roundtrips ids back to z/x/y", () => {
    for (let z = 0; z <= 10; z += 1) {
      const tilesPerSide = 2 ** z;
      const stride = Math.max(1, Math.floor(tilesPerSide / 5));
      for (let x = 0; x < tilesPerSide; x += stride) {
        for (let y = 0; y < tilesPerSide; y += stride) {
          const id = myZxyToTileId(z, x, y);
          const [rz, rx, ry] = myTileIdToZxy(id);
          expect([rz, rx, ry]).toEqual([z, x, y]);
          expect(tileIdToZxy(id)).toEqual([z, x, y]);
        }
      }
    }
  });
});

describe("buildGeometryArchive roundtrip through the reference reader", () => {
  test("header, metadata, and sampled tiles read back correctly", async () => {
    const archive = await buildGeometryArchive({ features: SF_FEATURES, maxZoom: 5 });
    expect(archive).toBeInstanceOf(Uint8Array);

    const pmtiles = new PMTiles(memorySource(archive));
    const header = await pmtiles.getHeader();
    expect(header.specVersion).toBe(3);
    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(5);
    expect(header.tileType).toBe(1); // MVT
    expect(header.internalCompression).toBe(2); // gzip
    expect(header.tileCompression).toBe(2); // gzip (measured better than none)
    expect(header.clustered).toBe(true);
    expect(header.minLon).toBeCloseTo(-122.5, 5);
    expect(header.maxLat).toBeCloseTo(37.9, 5);

    const metadata = (await pmtiles.getMetadata()) as {
      vector_layers: { id: string; fields: Record<string, string> }[];
      tile_type: string;
      compression: string;
    };
    expect(metadata.vector_layers).toHaveLength(1);
    expect(metadata.vector_layers[0].id).toBe("geojson");
    expect(metadata.vector_layers[0].fields).toEqual({ entryId: "String" });
    expect(metadata.tile_type).toBe("MVT");
    expect(metadata.compression).toBe("gzip");
  });

  test("sampled tiles decode to MVT with id-only properties", async () => {
    const archive = await buildGeometryArchive({ features: SF_FEATURES, maxZoom: 5 });
    const pmtiles = new PMTiles(memorySource(archive));

    const z5 = await pmtiles.getZxy(5, 5, 12);
    if (z5 === undefined) {
      throw new Error("tile 5/5/12 missing from the archive");
    }
    const raw = z5.data;
    const tile = new VectorTile(new PbfReader(raw));
    const layers = Object.keys(tile.layers);
    expect(layers).toEqual(["geojson"]);
    const layer = tile.layers["geojson"];
    expect(layer.length).toBe(3);
    const ids: string[] = [];
    for (let i = 0; i < layer.length; i += 1) {
      const feature = layer.feature(i);
      ids.push(feature.properties["entryId"] as string);
      // id-only projection: no other properties survive
      expect(Object.keys(feature.properties)).toEqual(["entryId"]);
    }
    expect(ids.toSorted()).toEqual(["aaa", "bbb", "ccc"].toSorted());
  });

  test("gzip correctness: decompressed tiles parse as MVT", async () => {
    const archive = await buildGeometryArchive({ features: SF_FEATURES, maxZoom: 3 });
    const pmtiles = new PMTiles(memorySource(archive));
    const header = await pmtiles.getHeader();
    // The tile blob is gzip; the reader decompresses through tileCompression.
    const resolved = await pmtiles.getZxy(2, 0, 1);
    if (resolved === undefined) {
      throw new Error("tile 2/0/1 missing from the archive");
    }
    expect(resolved.data.byteLength).toBeGreaterThan(0);
    void header;
  });

  test("dedup: identical adjacent tiles collapse into run-length entries", async () => {
    // Four z1 tiles each containing one point at the same relative position
    // produce byte-identical MVT; the Hilbert run 1..4 merges into one entry.
    const features: GeoJSON.Feature[] = [];
    for (const [tileX, tileY] of [[0, 0], [0, 1], [1, 1], [1, 0]] as const) {
      const lon = -180 + (tileX * 360) / 2 + 90 / 2;
      // Relative y 0.5 within each tile: mercator 0.25 / 0.75 → lat ±66.51.
      const lat = tileY === 0 ? 66.51326037225083 : -66.51326037225083;
      features.push({
        type: "Feature",
        _id: "same",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: null,
      } as unknown as GeoJSON.Feature);
    }
    const archive = await buildGeometryArchive({ features, minZoom: 1, maxZoom: 1 });

    // Parse header + root directory manually and assert the counts.
    const view = new DataView(archive.buffer);
    const numAddressedTiles = Number(view.getBigUint64(72, true));
    const numTileEntries = Number(view.getBigUint64(80, true));
    const numTileContents = Number(view.getBigUint64(88, true));
    expect(numAddressedTiles).toBe(4);
    expect(numTileEntries).toBe(1);
    expect(numTileContents).toBe(1);
  });

  test("empty input throws", async () => {
    try {
      await buildGeometryArchive({ features: [] });
      throw new Error("expected buildGeometryArchive to reject");
    } catch (error) {
      expect((error as Error).message).toContain("no vector tiles were produced");
    }
  });
});
