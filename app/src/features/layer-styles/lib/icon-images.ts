import type * as MapLibreGL from "maplibre-gl";

import type { Id } from "#convex/_generated/dataModel";

/**
 * Point-marker images in the browser (docs/layer-styles.md "Point markers"):
 * the built-in SDF sprite served from our own origin
 * (`public/sprites/layer-styles/`, built by `sprite/build.ts`), the icon
 * catalog the picker searches, and uploaded icons from Convex storage. All
 * of it loads lazily, on the first style or picker that needs an icon.
 */

export type IconFamily = "shape" | "lucide" | "maki";

export interface IconCatalogEntry {
  name: string;
  family: IconFamily;
  label: string;
  keywords: string[];
}

/** An uploaded icon as `api.layerStyles.icons.list` returns it. */
export interface UploadedIcon {
  iconId: Id<"layerStyleIcons">;
  name: string;
  label: string;
  url: string | null;
  sdf: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  uploadedBy: string;
}

/** One decoded image, ready for `map.addImage` or a canvas. */
export interface IconImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  pixelRatio: number;
  sdf: boolean;
}

interface SpriteEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
  sdf?: boolean;
}

interface Atlas {
  manifest: Record<string, SpriteEntry>;
  pixels: ImageData;
}

const SPRITE_BASE = `${import.meta.env.BASE_URL}sprites/layer-styles/`;

let catalogPromise: Promise<IconCatalogEntry[]> | undefined;
const atlasPromises = new Map<number, Promise<Atlas>>(),
  uploadPromises = new Map<string, Promise<IconImage | undefined>>();

/** The sprite resolution this screen wants (`@2x` on HiDPI screens). */
export function screenPixelRatio(): 1 | 2 {
  return typeof window !== "undefined" && window.devicePixelRatio >= 1.5 ? 2 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Couldn't load ${url} (${response.status}).`);
  }
  return response.json();
}

/** Decodes an image blob to RGBA pixels without color-managing or premultiplying alpha (SDF alpha must survive). */
async function decode(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    }),
    { width, height } = bitmap,
    canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error("Canvas 2D isn't available.");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

/** The built-in icon catalog (shapes, Lucide, Maki), in picker order. */
export async function loadCatalog(): Promise<IconCatalogEntry[]> {
  catalogPromise ??= fetchJson(`${SPRITE_BASE}catalog.json`).then((raw) => {
    const icons = isRecord(raw) && Array.isArray(raw["icons"]) ? raw["icons"] : [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- catalog.json is written by sprite/build.ts in exactly this shape.
    return icons as IconCatalogEntry[];
  });
  catalogPromise.catch(() => {
    catalogPromise = undefined;
  });
  return catalogPromise;
}

async function loadAtlas(pixelRatio: 1 | 2): Promise<Atlas> {
  const existing = atlasPromises.get(pixelRatio);
  if (existing !== undefined) {
    return existing;
  }
  const suffix = pixelRatio === 2 ? "@2x" : "",
    promise = Promise.all([
      fetchJson(`${SPRITE_BASE}sprite${suffix}.json`),
      fetch(`${SPRITE_BASE}sprite${suffix}.png`).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Couldn't load the icon sprite (${response.status}).`);
        }
        return decode(await response.blob());
      }),
    ]).then(([manifest, pixels]) => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sprite.json is a standard MapLibre sprite manifest written by sprite/build.ts.
      manifest: manifest as Record<string, SpriteEntry>,
      pixels,
    }));
  atlasPromises.set(pixelRatio, promise);
  promise.catch(() => {
    atlasPromises.delete(pixelRatio);
  });
  return promise;
}

function slice(atlas: Atlas, name: string): IconImage | undefined {
  const entry = Object.hasOwn(atlas.manifest, name) ? atlas.manifest[name] : undefined;
  if (entry === undefined) {
    return undefined;
  }
  const { pixels } = atlas,
    data = new Uint8ClampedArray(entry.width * entry.height * 4);
  for (let y = 0; y < entry.height; y += 1) {
    const from = ((entry.y + y) * pixels.width + entry.x) * 4;
    data.set(pixels.data.subarray(from, from + entry.width * 4), y * entry.width * 4);
  }
  return {
    data,
    height: entry.height,
    pixelRatio: entry.pixelRatio,
    sdf: entry.sdf === true,
    width: entry.width,
  };
}

async function loadUpload(icon: UploadedIcon): Promise<IconImage | undefined> {
  const key = `${icon.name}:${icon.url ?? ""}`,
    existing = uploadPromises.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const { url } = icon;
  const promise =
    url === null
      ? Promise.resolve(undefined)
      : fetch(url)
          .then(async (response) => {
            if (!response.ok) {
              return undefined;
            }
            const pixels = await decode(await response.blob());
            return {
              data: pixels.data,
              height: pixels.height,
              pixelRatio: icon.pixelRatio,
              sdf: icon.sdf,
              width: pixels.width,
            };
          })
          .catch(() => undefined);
  uploadPromises.set(key, promise);
  return promise;
}

/**
 * One icon's pixels: a built-in sprite image at `pixelRatio`, or an upload
 * (at its stored ratio). `undefined` when the name is unknown or its file
 * is gone.
 */
export async function iconImage(
  name: string,
  uploads: ReadonlyMap<string, UploadedIcon>,
  pixelRatio: 1 | 2 = screenPixelRatio(),
): Promise<IconImage | undefined> {
  if (name.startsWith("user-")) {
    const upload = uploads.get(name);
    return upload === undefined ? undefined : loadUpload(upload);
  }
  return slice(await loadAtlas(pixelRatio), name);
}

/**
 * Adds the named images the map doesn't have yet (`map.addImage`, SDF where
 * the image is one), so icon layers draw them. Unknown names are skipped —
 * the caller has already swapped deleted uploads for circles.
 */
export async function ensureMapImages(
  map: MapLibreGL.Map,
  names: readonly string[],
  uploads: ReadonlyMap<string, UploadedIcon>,
): Promise<void> {
  const wanted = names.filter((name) => !map.hasImage(name));
  if (wanted.length === 0) {
    return;
  }
  const images = await Promise.all(
    wanted.map(async (name) => {
      try {
        return { image: await iconImage(name, uploads), name };
      } catch {
        return { image: undefined, name };
      }
    }),
  );
  for (const { name, image } of images) {
    if (image !== undefined && !map.hasImage(name)) {
      map.addImage(
        name,
        { data: image.data, height: image.height, width: image.width },
        { pixelRatio: image.pixelRatio, sdf: image.sdf },
      );
    }
  }
}
