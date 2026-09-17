/**
 * Size benchmark: a dense ~450-feature fixture approximating the FY22
 * Action Plan's shape — property-dominant rows (the real dataset averages
 * ~100 KB of GeoJSON text per feature, overwhelmingly attribute columns)
 * laid out as a dense street grid — must archive to at most 10% of the
 * equivalent GeoJSON bytes. The actual ratio is printed for part 4's
 * byte-target calibration.
 */
import { describe, expect, test } from "bun:test";

import { buildGeometryArchive } from "./index";

/** SS4A-style attribute bag: many columns of varied realistic text. */
function ss4aProperties(index: number): Record<string, unknown> {
  return {
    segment_id: `FY22-${(index % 9000) + 1000}`,
    route_name: index % 2 === 0 ? "Main Street" : "El Camino Real",
    facility_type: ["Arterial", "Collector", "Local Road", "Highway"][index % 4],
    jurisdiction: "City of San Mateo",
    aadt: 4000 + (index % 25000),
    truck_pct: (index % 12) / 2,
    speed_limit_mph: 25 + (index % 6) * 5,
    lanes: (index % 3) + 1,
    surface_type: ["Asphalt", "Concrete", "Chip Seal"][index % 3],
    pavement_condition: ["Good", "Fair", "Poor"][index % 3],
    pci_score: 45 + (index % 55),
    last_resurfaced: 1995 + (index % 29),
    hsn_corridor: index % 4 === 0,
    high_injury_network: index % 7 === 0,
    equity_zone: `PUMS-${(index % 8) + 1}`,
    census_tract: `06081${(index % 1000).toString().padStart(4, "0")}`,
    crash_count_5yr: index % 6,
    fatal_crashes: index % 17 === 0 ? 1 : 0,
    ped_volume_index: (index % 9) / 2,
    bike_facility: ["None", "Class II", "Class IV"][index % 3],
    sidewalk_present: index % 3 !== 0,
    transit_routes: `Route ${10 + (index % 22)}`,
    project_phase: ["Design", "Construction", "Complete", "Planning"][index % 4],
    funding_source: index % 2 === 0 ? "SB 1 RR" : "HSIP Cycle 11",
    estimated_cost_usd: 50_000 + (index % 40) * 25_000,
    programmed_year: 2022 + (index % 5),
  };
}

/** A county-scale road linestring: ~4700 vertices meandering ~0.3 degrees. */
function countyRoad(seed: number): { type: string; coordinates: number[][] } {
  const coordinates: number[][] = [];
  const baseLon = -122.45 + (seed % 15) * 0.02;
  const baseLat = 37.45 + Math.floor(seed / 9) * 0.015;
  let lon = baseLon;
  let lat = baseLat;
  for (let step = 0; step < 4700; step += 1) {
    lon += Math.sin((seed * 7 + step) / 40) * 0.00012 + 0.00004;
    lat += Math.cos((seed * 3 + step) / 33) * 0.00009;
    coordinates.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
  }
  return { type: "LineString", coordinates };
}

function denseFixture(count: number): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (let index = 0; index < count; index += 1) {
    features.push({
      type: "Feature",
      _id: `fy22-${index.toString().padStart(4, "0")}`,
      geometry: countyRoad(index) as GeoJSON.Geometry,
      properties: ss4aProperties(index),
    } as unknown as GeoJSON.Feature);
  }
  return features;
}

describe("archive size benchmark", () => {
  test(
    "archive is at most 10% of the equivalent GeoJSON bytes",
    async () => {
      const features = denseFixture(450);
      const geojsonBytes = new TextEncoder().encode(
        JSON.stringify({ type: "FeatureCollection", features }),
      ).length;

      const archive = await buildGeometryArchive({ features, maxZoom: 14 });
      const ratio = archive.length / geojsonBytes;
      console.log(
        `[size benchmark] geojson=${geojsonBytes}B archive=${archive.length}B ratio=${(ratio * 100).toFixed(2)}%`,
      );

      expect(ratio).toBeLessThanOrEqual(0.1);
    },
    { timeout: 120_000 },
  );
});
