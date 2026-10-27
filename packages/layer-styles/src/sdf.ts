/**
 * Signed distance fields for MapLibre SDF icons (`addImage(..., { sdf: true })`
 * or `"sdf": true` in a sprite manifest). An SDF image stores, in its alpha
 * channel, how far each pixel is from the glyph's edge, so MapLibre can tint
 * it (`icon-color`) and draw a halo (`icon-halo-*`) at any size.
 *
 * The encoding matches MapLibre's SDF shader: the edge sits at alpha 192
 * (`cutoff` 0.25) and alpha falls by `255 / radius` per pixel outward. A
 * radius of 8 per device pixel is MapLibre's own `SDF_PX`, so a 1px halo is
 * one CSS pixel wide at any pixel ratio when `radius = 8 * pixelRatio`.
 *
 * The distance transform is Felzenszwalb & Huttenlocher's, as in Mapbox's
 * tiny-sdf (BSD-2-Clause). It runs in the sprite build script (bun) and in
 * the browser for "tintable" uploads, so it uses no DOM or Node APIs.
 */

const INF = 1e20;

/** SDF settings for one pixel ratio: distance scale and the transparent margin around the glyph. */
export function sdfParams(pixelRatio: number): { radius: number; buffer: number } {
  return { buffer: 3 * pixelRatio, radius: 8 * pixelRatio };
}

/** One-dimensional squared distance transform over `grid[offset + i * stride]`. */
function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint16Array,
  z: Float64Array,
) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q += 1) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    for (;;) {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      if (s > z[k]) {
        break;
      }
      k -= 1;
      if (k < 0) {
        break;
      }
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q += 1) {
    while (z[k + 1] < q) {
      k += 1;
    }
    const r = v[k],
      qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

/** Two-dimensional squared distance transform, in place. */
function edt(grid: Float64Array, width: number, height: number) {
  const size = Math.max(width, height),
    f = new Float64Array(size),
    v = new Uint16Array(size),
    z = new Float64Array(size + 1);
  for (let x = 0; x < width; x += 1) {
    edt1d(grid, x, width, height, f, v, z);
  }
  for (let y = 0; y < height; y += 1) {
    edt1d(grid, y * width, 1, width, f, v, z);
  }
}

/**
 * The SDF of a coverage mask (`alpha[i]` 0–255, row-major, `width × height`),
 * as alpha values of the same dimensions. Pad the mask by `sdfParams().buffer`
 * first so the field has room to fall off around the glyph.
 */
export function sdfFromAlpha(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  radius: number,
  cutoff = 0.25,
): Uint8ClampedArray {
  const size = width * height,
    outer = new Float64Array(size),
    inner = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const a = alpha[index] / 255;
    if (a >= 1) {
      outer[index] = 0;
      inner[index] = INF;
    } else if (a <= 0) {
      outer[index] = INF;
      inner[index] = 0;
    } else {
      // Anti-aliased edge pixels: place the edge inside the pixel by coverage.
      const d = 0.5 - a;
      outer[index] = d > 0 ? d * d : 0;
      inner[index] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, width, height);
  edt(inner, width, height);
  const out = new Uint8ClampedArray(size);
  for (let index = 0; index < size; index += 1) {
    const distance = Math.sqrt(outer[index]) - Math.sqrt(inner[index]);
    out[index] = Math.round(255 - 255 * (distance / radius + cutoff));
  }
  return out;
}

/** An RGBA image's alpha channel, padded by `buffer` transparent pixels on every side. */
export function paddedAlpha(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  buffer: number,
): { alpha: Uint8ClampedArray; width: number; height: number } {
  const paddedWidth = width + 2 * buffer,
    paddedHeight = height + 2 * buffer,
    alpha = new Uint8ClampedArray(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      alpha[(y + buffer) * paddedWidth + x + buffer] = rgba[(y * width + x) * 4 + 3];
    }
  }
  return { alpha, height: paddedHeight, width: paddedWidth };
}

/**
 * An RGBA SDF image from an RGBA glyph raster: the glyph's coverage, padded
 * and distance-transformed into alpha (color channels black — MapLibre reads
 * only alpha from SDF images).
 */
export function sdfImage(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  pixelRatio: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { buffer, radius } = sdfParams(pixelRatio),
    padded = paddedAlpha(rgba, width, height, buffer),
    field = sdfFromAlpha(padded.alpha, padded.width, padded.height, radius),
    data = new Uint8ClampedArray(padded.width * padded.height * 4);
  for (let index = 0; index < field.length; index += 1) {
    data[index * 4 + 3] = field[index];
  }
  return { data, height: padded.height, width: padded.width };
}

/** SDF alpha at the glyph edge — at or above it is "inside" (for drawing an SDF as a flat swatch). */
export const SDF_EDGE = 192;
