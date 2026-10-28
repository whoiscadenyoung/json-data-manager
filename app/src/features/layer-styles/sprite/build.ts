/**
 * Builds the layer-styles SDF sprite (docs/layer-styles.md "Point markers"):
 *
 *   bun src/features/layer-styles/sprite/build.ts   (from app/)
 *
 * Writes `public/sprites/layer-styles/`: a standard MapLibre sprite
 * (`sprite.json` + `sprite.png`, and `@2x`) with every image marked
 * `"sdf": true` so `icon-color` and `icon-halo-*` tint it, plus
 * `catalog.json` (family, label and search keywords per icon) for the
 * Marker picker. The outputs are committed; rerun after changing
 * `sources.ts` or bumping lucide-static / @mapbox/maki.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sdfImage, sdfParams } from "@caden/layer-styles/sdf";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import potpack from "potpack";

import { LUCIDE_ICONS, SHAPES } from "./sources";

/** Glyph size at 1x, in pixels — `icon-size: 1` draws a glyph this big. Keep in sync with `ICON_GLYPH_PX`. */
const GLYPH_PX = 24;

const here = dirname(fileURLToPath(import.meta.url)),
  outDir = join(here, "../../../../public/sprites/layer-styles"),
  require = createRequire(import.meta.url),
  lucideDir = dirname(require.resolve("lucide-static/package.json")),
  makiDir = dirname(require.resolve("@mapbox/maki/package.json"));

interface SourceIcon {
  name: string;
  family: "shape" | "lucide" | "maki";
  label: string;
  keywords: string[];
  svg: string;
}

function labelOf(slug: string): string {
  const words = slug.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sources(): SourceIcon[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- lucide-static's tags.json is a name → keywords map.
  const lucideTags = JSON.parse(readFileSync(join(lucideDir, "tags.json"), "utf8")) as Record<
      string,
      string[]
    >,
    makiNames =
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- @mapbox/maki's layouts/all.json is its icon-name list.
      (JSON.parse(readFileSync(join(makiDir, "layouts/all.json"), "utf8")) as string[]).toSorted();
  return [
    ...SHAPES.map((shape) => ({
      family: "shape" as const,
      keywords: ["shape"],
      label: shape.label,
      name: `shape-${shape.name}`,
      svg: shape.svg,
    })),
    ...LUCIDE_ICONS.map((name) => ({
      family: "lucide" as const,
      keywords: lucideTags[name] ?? [],
      label: labelOf(name),
      name: `lucide-${name}`,
      svg: readFileSync(join(lucideDir, "icons", `${name}.svg`), "utf8").replaceAll(
        "currentColor",
        "#000",
      ),
    })),
    ...makiNames.map((name) => ({
      family: "maki" as const,
      keywords: [],
      label: labelOf(name),
      name: `maki-${name.toLowerCase()}`,
      svg: readFileSync(join(makiDir, "icons", `${name}.svg`), "utf8"),
    })),
  ];
}

function rasterize(svg: string, pixelRatio: number) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: GLYPH_PX * pixelRatio },
  }).render();
  return sdfImage(rendered.pixels, rendered.width, rendered.height, pixelRatio);
}

function writeSprite(icons: SourceIcon[], pixelRatio: number, suffix: string) {
  const images = icons.map((icon) => ({ icon, image: rasterize(icon.svg, pixelRatio) })),
    gap = pixelRatio,
    boxes = images.map((entry, index) => ({
      h: entry.image.height + gap,
      index,
      w: entry.image.width + gap,
      x: 0,
      y: 0,
    })),
    packed = potpack(boxes),
    sheet = new PNG({ height: packed.h, width: packed.w }),
    manifest: Record<string, object> = {};
  for (const box of boxes) {
    const { icon, image } = images[box.index];
    for (let y = 0; y < image.height; y += 1) {
      const from = y * image.width * 4,
        to = ((box.y + y) * packed.w + box.x) * 4;
      sheet.data.set(image.data.subarray(from, from + image.width * 4), to);
    }
    manifest[icon.name] = {
      height: image.height,
      pixelRatio,
      sdf: true,
      width: image.width,
      x: box.x,
      y: box.y,
    };
  }
  // Grey + alpha at maximum deflate: an SDF carries only alpha, so RGB costs bytes for nothing.
  writeFileSync(
    join(outDir, `sprite${suffix}.png`),
    PNG.sync.write(sheet, { colorType: 4, deflateLevel: 9 }),
  );
  writeFileSync(join(outDir, `sprite${suffix}.json`), `${JSON.stringify(manifest)}\n`);
  return { height: packed.h, width: packed.w };
}

const icons = sources();
mkdirSync(outDir, { recursive: true });
const oneX = writeSprite(icons, 1, ""),
  twoX = writeSprite(icons, 2, "@2x");
writeFileSync(
  join(outDir, "catalog.json"),
  `${JSON.stringify({
    glyphPx: GLYPH_PX,
    icons: icons.map(({ family, keywords, label, name }) => ({ family, keywords, label, name })),
    sdf: sdfParams(1),
  })}\n`,
);
console.log(
  `layer-styles sprite: ${icons.length} icons, ${oneX.width}×${oneX.height} @1x, ${twoX.width}×${twoX.height} @2x → ${outDir}`,
);
