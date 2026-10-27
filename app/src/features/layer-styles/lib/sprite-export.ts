import { strToU8, zipSync } from "fflate";
import potpack from "potpack";

import type { LayerStyle } from "#convex/layerStyles/validators";

import { exportStyleJson, slugify } from "./exchange";
import { iconImage, type IconImage, type UploadedIcon } from "./icon-images";
import { iconNamesOfStyle } from "./icons";

/**
 * "Download sprite": a standard MapLibre sprite (`sprite.json`/`.png` and
 * `@2x`) holding only the icons a style uses — built-ins and uploads alike —
 * zipped with the style's layers, so the pair renders the same in any
 * MapLibre app (docs/layer-styles.md "Using an exported style elsewhere").
 */

/** One sprite manifest entry (the MapLibre sprite JSON format). */
export interface SpriteManifestEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
  sdf?: boolean;
}

/**
 * Packs images into one sheet: positions (with a `pixelRatio`-pixel gap so
 * neighbors never bleed when sampled) and the manifest MapLibre reads.
 */
export function packSprite(
  images: ReadonlyArray<{ name: string; width: number; height: number; sdf: boolean }>,
  pixelRatio: number,
): { width: number; height: number; manifest: Record<string, SpriteManifestEntry> } {
  const gap = pixelRatio,
    boxes = images.map((image, index) => ({
      h: image.height + gap,
      index,
      w: image.width + gap,
      x: 0,
      y: 0,
    })),
    packed = potpack(boxes),
    manifest: Record<string, SpriteManifestEntry> = {};
  for (const box of boxes.toSorted((left, right) => left.index - right.index)) {
    const image = images[box.index];
    manifest[image.name] = {
      height: image.height,
      pixelRatio,
      ...(image.sdf ? { sdf: true } : {}),
      width: image.width,
      x: box.x,
      y: box.y,
    };
  }
  return {
    height: Math.max(1, Math.ceil(packed.h)),
    manifest,
    width: Math.max(1, Math.ceil(packed.w)),
  };
}

/** The README dropped into the zip: how to use the pair outside this app. */
export function spriteReadme(styleFile: string, iconCount: number): string {
  return [
    "MapLibre style + sprite exported from the map's Style panel.",
    "",
    `${styleFile}  MapLibre layers. Each uses "source": "dataset";`,
    "                add your data as a source named `dataset` (or rename it).",
    `sprite.json/.png, sprite@2x.json/.png  the ${iconCount} icon${iconCount === 1 ? "" : "s"} the layers use.`,
    "",
    'In your style.json, set "sprite" to the URL of this folder plus /sprite',
    '(for example "https://example.com/my-style/sprite") and add the layers.',
    'Icons marked "sdf": true are tinted by icon-color.',
    "",
  ].join("\n");
}

/** An image resampled to another pixel ratio (uploads exist at 2x only). */
function resample(image: IconImage, pixelRatio: number): IconImage {
  if (image.pixelRatio === pixelRatio) {
    return image;
  }
  const scale = pixelRatio / image.pixelRatio,
    width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale)),
    from = document.createElement("canvas"),
    to = document.createElement("canvas");
  from.width = image.width;
  from.height = image.height;
  to.width = width;
  to.height = height;
  const fromContext = from.getContext("2d"),
    toContext = to.getContext("2d", { willReadFrequently: true });
  if (fromContext === null || toContext === null) {
    return image;
  }
  fromContext.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width), 0, 0);
  toContext.drawImage(from, 0, 0, width, height);
  return {
    data: toContext.getImageData(0, 0, width, height).data,
    height,
    pixelRatio,
    sdf: image.sdf,
    width,
  };
}

async function sheet(
  entries: ReadonlyArray<{ name: string; image: IconImage }>,
  pixelRatio: 1 | 2,
): Promise<{ json: string; png: Uint8Array }> {
  const scaled = entries.map((entry) => ({
      image: resample(entry.image, pixelRatio),
      name: entry.name,
    })),
    packed = packSprite(
      scaled.map(({ name, image }) => ({
        height: image.height,
        name,
        sdf: image.sdf,
        width: image.width,
      })),
      pixelRatio,
    ),
    canvas = document.createElement("canvas");
  canvas.width = packed.width;
  canvas.height = packed.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2D isn't available.");
  }
  for (const { name, image } of scaled) {
    const at = packed.manifest[name];
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width), at.x, at.y);
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) {
        reject(new Error("Couldn't encode the sprite."));
      } else {
        resolve(result);
      }
    }, "image/png");
  });
  return {
    json: `${JSON.stringify(packed.manifest, null, 2)}\n`,
    png: new Uint8Array(await blob.arrayBuffer()),
  };
}

/**
 * The zip for "Download sprite": the style's layers, its used icons as a
 * MapLibre sprite at 1x and 2x, and a README. Throws when an icon the style
 * uses can't be loaded (a deleted upload), naming it.
 */
export async function buildSpriteZip(
  style: LayerStyle,
  title: string,
  uploads: ReadonlyMap<string, UploadedIcon>,
): Promise<{ filename: string; blob: Blob; iconCount: number }> {
  const names = iconNamesOfStyle(style),
    files: Record<string, Uint8Array> = {},
    styleFile = `${slugify(title)}-style.json`;
  for (const pixelRatio of [1, 2] as const) {
    const entries = await Promise.all(
      names.map(async (name) => {
        const image = await iconImage(name, uploads, pixelRatio);
        if (image === undefined) {
          throw new Error(`The icon "${name}" isn't available any more; pick another one first.`);
        }
        return { image, name };
      }),
    );
    const suffix = pixelRatio === 2 ? "@2x" : "",
      built = await sheet(entries, pixelRatio);
    files[`sprite${suffix}.json`] = strToU8(built.json);
    files[`sprite${suffix}.png`] = built.png;
  }
  files[styleFile] = strToU8(`${exportStyleJson(style, title)}\n`);
  files["README.txt"] = strToU8(spriteReadme(styleFile, names.length));
  const zipped = zipSync(files);
  return {
    blob: new Blob([new Uint8Array(zipped)], { type: "application/zip" }),
    filename: `${slugify(title)}-sprite.zip`,
    iconCount: names.length,
  };
}
