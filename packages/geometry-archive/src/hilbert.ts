// oxlint-disable eslint/no-bitwise -- the PMTiles v3 Hilbert tile-id math is bitwise by definition.
/**
 * PMTiles v3 Hilbert tile-id codec, matching the spec's tile-id table:
 * z0(0,0)=0, z1(0,0)=1, z1(0,1)=2, z1(1,1)=3, z1(1,0)=4, z2(0,0)=5, ...
 */

/** Zoom level encoded by a tile id's bit length (protomaps `tileIdToZ`). */
function tileIdToZ(id: number): number {
  const t = 3 * id + 1;
  if (t < 4294967296) {
    return 31 - Math.clz32(t);
  }
  return 63 - Math.clz32(Math.floor(t / 4294967296));
}

export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) {
    throw new Error("Tile zoom level exceeds max safe number limit (26)");
  }
  if (z < 0 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw new Error("tile x/y outside zoom level bounds");
  }
  if (z === 0) {
    return 0;
  }
  let acc = (2 ** z * 2 ** z - 1) / 3;
  let n = z - 1;
  let tx = x;
  let ty = y;
  for (let s = 2 ** n; s > 0; s = Math.floor(s / 2)) {
    const rx = tx & s;
    const ry = ty & s;
    acc += ((3 * rx) ^ ry) * s;
    const rotated = rotate(s, tx, ty, rx, ry);
    tx = rotated[0];
    ty = rotated[1];
    n -= 1;
  }
  return acc;
}

export function tileIdToZxy(id: number): [number, number, number] {
  if (id > 9007199254740991) {
    throw new Error("tile ID exceeds MAX_SAFE_INTEGER");
  }
  const z = Math.floor(tileIdToZ(id) / 2);
  const base = (2 ** z * 2 ** z - 1) / 3;
  let t = id - base;
  let x = 0;
  let y = 0;
  for (let s = 1; s < 2 ** z; s *= 2) {
    const rx = s & Math.floor(t / 2);
    const ry = s & (t ^ rx);
    const rotated = rotate(s, x, y, rx, ry);
    x = rotated[0];
    y = rotated[1];
    t = Math.floor(t / 2);
    x += rx;
    y += ry;
  }
  return [z, x, y];
}

/** Rotate/flip a Hilbert quadrant at the given level size (protomaps `rotate`). */
function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry !== 0) {
    return [x, y];
  }
  if (rx !== 0) {
    return [n - 1 - y, n - 1 - x];
  }
  return [y, x];
}
