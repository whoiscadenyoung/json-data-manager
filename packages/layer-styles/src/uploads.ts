import { ICON_GLYPH_PX } from "./compile";
import { sdfImage } from "./sdf";
import { ICON_LIMITS } from "./validators";

/**
 * Turning a picked SVG/PNG into a stored marker icon (docs/layer-styles.md
 * "Uploaded icons"). The file is rasterized in the browser: an SVG is drawn
 * through an `<img>` from a blob URL — which never runs its scripts or
 * fetches external resources — onto a canvas, and its markup is never put
 * in the DOM or stored. The result is a small PNG at pixel ratio 2, as an
 * SDF when the icon is "tintable" (single-color glyphs `icon-color` can
 * recolor) or full color otherwise.
 */

/** Uploads are stored at 2x, the same as the built-in `@2x` sprite. */
export const UPLOAD_PIXEL_RATIO = 2;

/** The stored glyph box in device pixels: the built-in glyph size at 2x. */
const GLYPH_BOX = ICON_GLYPH_PX * UPLOAD_PIXEL_RATIO;

export type UploadKind = "svg" | "png";

/** The upload's kind, or the reason it's refused, from the picked file's name, type, and size. */
export function checkUploadFile(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; kind: UploadKind } | { ok: false; error: string } {
  const lower = file.name.toLowerCase(),
    kind: UploadKind | undefined =
      file.type === "image/svg+xml" || lower.endsWith(".svg")
        ? "svg"
        : file.type === "image/png" || lower.endsWith(".png")
          ? "png"
          : undefined;
  if (kind === undefined) {
    return { error: "Upload an SVG or PNG image.", ok: false };
  }
  if (file.size === 0) {
    return { error: "That file is empty.", ok: false };
  }
  if (file.size > ICON_LIMITS.fileBytes) {
    return { error: "Icons can be 256 KB at most.", ok: false };
  }
  return { kind, ok: true };
}

/** A display name from a file name: no extension, dashes/underscores as spaces, trimmed to the limit. */
export function iconLabelFromFileName(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, "")
    .replaceAll(/[-_]+/g, " ")
    .trim();
  return (base === "" ? "Icon" : base).slice(0, ICON_LIMITS.label);
}

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value);
  return match === null ? undefined : Number(match[1]);
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match === null ? undefined : match[2];
}

/**
 * Checks SVG text before it's drawn and reads its intrinsic size (width/height,
 * else the viewBox), so the rasterizer can keep the aspect ratio. Refuses
 * anything that isn't a plain `<svg>` document, and DOCTYPE/ENTITY
 * declarations (entity expansion has no place in an icon).
 */
export function inspectSvg(
  text: string,
): { ok: true; width: number; height: number } | { ok: false; error: string } {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    return { error: "This SVG declares a DOCTYPE or entities; export it as plain SVG.", ok: false };
  }
  const tag = /<svg\b[^>]*>/i.exec(text);
  if (tag === null) {
    return { error: "This file isn't an SVG image.", ok: false };
  }
  const width = parseLength(attribute(tag[0], "width")),
    height = parseLength(attribute(tag[0], "height")),
    viewBox = attribute(tag[0], "viewBox"),
    box =
      viewBox === undefined
        ? []
        : viewBox
            .trim()
            .split(/[\s,]+/)
            .map(Number),
    boxWidth = box.length === 4 && box[2] > 0 ? box[2] : undefined,
    boxHeight = box.length === 4 && box[3] > 0 ? box[3] : undefined,
    finalWidth = width ?? boxWidth,
    finalHeight = height ?? boxHeight;
  if (
    finalWidth === undefined ||
    finalHeight === undefined ||
    finalWidth <= 0 ||
    finalHeight <= 0
  ) {
    return { error: "This SVG has no size; give it a viewBox or width and height.", ok: false };
  }
  return { height: finalHeight, ok: true, width: finalWidth };
}

/** Dimensions scaled to fit a `box × box` square, keeping the aspect ratio (at least 1px each way). */
export function fitWithin(width: number, height: number, box: number) {
  const scale = box / Math.max(width, height);
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

/** A PNG picked as an icon must be small already (it isn't resampled up). */
export function checkPngSize(width: number, height: number): string | undefined {
  if (width > ICON_LIMITS.maxPx || height > ICON_LIMITS.maxPx) {
    return `PNG icons can be ${ICON_LIMITS.maxPx}×${ICON_LIMITS.maxPx} pixels at most.`;
  }
  return undefined;
}

/** A rasterized icon, ready to upload. */
export interface RasterizedIcon {
  png: Blob;
  width: number;
  height: number;
  pixelRatio: number;
  sdf: boolean;
}

async function svgImage(text: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new Error("This SVG couldn't be drawn.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Canvas 2D isn't available.");
  }
  return { canvas, context };
}

async function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("Couldn't encode the icon."));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

/**
 * Rasterizes a picked file into the stored icon: fitted into the 48px glyph
 * box (2x), then SDF-encoded when `tintable`. Throws with a message to show
 * when the file can't be used.
 */
export async function rasterizeIcon(file: File, tintable: boolean): Promise<RasterizedIcon> {
  const checked = checkUploadFile(file);
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  let source: CanvasImageSource, width: number, height: number;
  if (checked.kind === "svg") {
    const text = await file.text(),
      inspected = inspectSvg(text);
    if (!inspected.ok) {
      throw new Error(inspected.error);
    }
    source = await svgImage(text);
    ({ width, height } = inspected);
  } else {
    const bitmap = await createImageBitmap(file);
    const problem = checkPngSize(bitmap.width, bitmap.height);
    if (problem !== undefined) {
      bitmap.close();
      throw new Error(problem);
    }
    source = bitmap;
    ({ width, height } = bitmap);
  }
  const fitted = fitWithin(width, height, GLYPH_BOX),
    glyph = canvasOf(fitted.width, fitted.height);
  glyph.context.drawImage(source, 0, 0, fitted.width, fitted.height);
  if (source instanceof ImageBitmap) {
    source.close();
  }
  if (!tintable) {
    return {
      height: fitted.height,
      pixelRatio: UPLOAD_PIXEL_RATIO,
      png: await toPng(glyph.canvas),
      sdf: false,
      width: fitted.width,
    };
  }
  const pixels = glyph.context.getImageData(0, 0, fitted.width, fitted.height),
    field = sdfImage(pixels.data, fitted.width, fitted.height, UPLOAD_PIXEL_RATIO),
    out = canvasOf(field.width, field.height);
  out.context.putImageData(new ImageData(new Uint8ClampedArray(field.data), field.width), 0, 0);
  return {
    height: field.height,
    pixelRatio: UPLOAD_PIXEL_RATIO,
    png: await toPng(out.canvas),
    sdf: true,
    width: field.width,
  };
}
