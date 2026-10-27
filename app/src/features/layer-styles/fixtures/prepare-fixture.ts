/**
 * Assembles the plain-MapLibre interop fixture (`plain-maplibre.html`) from
 * a "Download sprite" zip, run from `app/`:
 *
 *   bun src/features/layer-styles/fixtures/prepare-fixture.ts <export.zip> <out-dir>
 *
 * `<out-dir>` gets the page (as index.html), MapLibre's own ESM dist, the zip's
 * sprite files, its layers as `style.json`, and `data.geojson` built from the
 * seeded "Example: National Parks" sample (appBuilder/exampleData.ts) — the
 * dataset the docs' verification recipe styles.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { strFromU8, unzipSync } from "fflate";

import { NATIONAL_PARKS } from "../../../../convex/appBuilder/exampleData";

const [zipPath, outDir] = process.argv.slice(2);
if (zipPath === undefined || outDir === undefined) {
  throw new Error("Usage: prepare-fixture.ts <export.zip> <out-dir>");
}

const here = dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url),
  maplibreDist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist"),
  files = unzipSync(readFileSync(zipPath));

mkdirSync(outDir, { recursive: true });
for (const [name, bytes] of Object.entries(files)) {
  if (name.startsWith("sprite")) {
    writeFileSync(join(outDir, name), bytes);
  } else if (name.endsWith("-style.json")) {
    writeFileSync(join(outDir, "style.json"), strFromU8(bytes));
  }
}
copyFileSync(join(here, "plain-maplibre.html"), join(outDir, "index.html"));
cpSync(maplibreDist, join(outDir, "maplibre"), { recursive: true });
writeFileSync(
  join(outDir, "data.geojson"),
  JSON.stringify({
    features: NATIONAL_PARKS.map(
      ([name, state, region, established, area, visitors, lng, lat]) => ({
        geometry: { coordinates: [lng, lat], type: "Point" },
        properties: {
          area_acres: area,
          established,
          name,
          region,
          state,
          visitors_millions: visitors,
        },
        type: "Feature",
      }),
    ),
    type: "FeatureCollection",
  }),
);
console.log(`Fixture ready in ${outDir}: serve it and open index.html.`);
