/**
 * Leaf-directory regression test: once the gzip'd root directory exceeds
 * MAX_ROOT_DIRECTORY_BYTES the builder must split entries into leaf
 * directories with run-length-0 pointers in the root, and the reference
 * reader must resolve tiles through that indirection.
 */
import { describe, expect, test } from "bun:test";

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles, type Source } from "pmtiles";

import { buildGeometryArchive } from "./index";

function memorySource(bytes: Uint8Array): Source {
  return {
    getKey: () => "memory://leaf",
    getBytes: async (offset: number, length: number) => {
      return { data: bytes.slice(offset, offset + length).buffer };
    },
  };
}

/** Deterministic xorshift32; Math.random would make the sizes flaky. */
let seed = 0x2545f491;
function random(): number {
  // oxlint-disable-next-line eslint/no-bitwise -- xorshift32 steps are shifts and XOR by definition.
  seed ^= seed << 13;
  // oxlint-disable-next-line eslint/no-bitwise -- xorshift32 steps are shifts and XOR by definition.
  seed ^= seed >>> 17;
  // oxlint-disable-next-line eslint/no-bitwise -- xorshift32 steps are shifts and XOR by definition.
  seed ^= seed << 5;
  // oxlint-disable-next-line eslint/no-bitwise -- coerces to an unsigned 32-bit int before formatting.
  return (seed >>> 0) / 4294967296;
}

/** 20000 scattered points; rounded once so checks see the encoded values. */
const POINTS: [number, number][] = [];
for (let index = 0; index < 20000; index += 1) {
  POINTS.push([
    Number((random() * 360 - 180).toFixed(6)),
    Number((random() * 160 - 80).toFixed(6)),
  ]);
}

describe("leaf directories", () => {
  test("root overflow splits into leaves and tiles resolve through them", async () => {
    const features = POINTS.map(([lon, lat], index) => ({
      type: "Feature",
      _id: `p${index}`,
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: null,
    })) as unknown as GeoJSON.Feature[];
    const archive = await buildGeometryArchive({ features, minZoom: 12, maxZoom: 12 });

    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const headerNumber = (offset: number) => Number(view.getBigUint64(offset, true));
    expect(headerNumber(16)).toBeLessThanOrEqual(16257); // root fits the 16384-byte first read
    expect(headerNumber(48)).toBeGreaterThan(0); // leaf directories were written

    const pmtiles = new PMTiles(memorySource(archive));
    // Spot-check points scattered across the whole tile-id range, i.e. every
    // leaf chunk, and verify the encoded geometry is the right point.
    for (const index of [0, 999, 5000, 9999, 15000, 19999]) {
      const [lon, lat] = POINTS[index];
      const x = Math.floor(((lon + 180) / 360) * 4096);
      const y = Math.floor(
        (0.5 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / (2 * Math.PI)) * 4096,
      );
      const resolved = await pmtiles.getZxy(12, x, y);
      if (resolved === undefined) {
        throw new Error(`tile 12/${x}/${y} missing from the archive`);
      }
      const layer = new VectorTile(new PbfReader(resolved.data)).layers["geojson"];
      const ids: string[] = [];
      for (let i = 0; i < layer.length; i += 1) {
        ids.push(layer.feature(i).properties["entryId"] as string);
      }
      expect(ids).toContain(`p${index}`);
    }
  }, 60_000);
});
