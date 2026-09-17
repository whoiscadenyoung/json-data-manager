/**
 * PMTiles v3 directory and header serialization (spec chapters 3 and 4).
 * Spec: https://github.com/protomaps/PMTiles (spec/v3/spec.md).
 */

/** Byte length of the fixed v3 header. */
export const HEADER_BYTES = 127;

/** The header plus the compressed root directory must fit the first 16384 bytes. */
export const MAX_ROOT_DIRECTORY_BYTES = 16384 - HEADER_BYTES;

/** One directory entry (spec chapter 4.1). */
export interface DirectoryEntry {
  tileId: number;
  /** Byte offset relative to the tile data section start (tile entries). */
  offset: number;
  /** Compressed byte length; must be greater than 0. */
  length: number;
  /** Consecutive tiles sharing this blob: 1 for a plain tile, 0 for a leaf pointer. */
  runLength: number;
}

/** Pushes the little-endian LEB128 encoding of `value` onto `out`. */
export function writeVarint(value: number, out: number[]): void {
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

/**
 * Serializes a directory per spec appendix A.1: five varint streams in order —
 * entry count, delta-encoded tile ids, run lengths, lengths, offsets. Entries
 * must be sorted by strictly ascending tile id. Offsets are relative to the
 * tile data section start; the first entry encodes `offset + 1` (offset 0 →
 * 1), and any entry contiguous with its predecessor encodes 0.
 */
export function serializeDirectory(entries: readonly DirectoryEntry[]): Uint8Array {
  if (entries.length === 0) {
    throw new Error("A PMTiles directory must contain at least one entry");
  }

  const counts: number[] = [];
  writeVarint(entries.length, counts);

  const ids: number[] = [];
  let previousId = 0;
  let index0Seen = false;
  for (const entry of entries) {
    const delta = entry.tileId - previousId;
    // The first entry's id may be 0 (z0/0/0); later ids must strictly ascend.
    if (delta < 0 || (index0Seen && delta <= 0)) {
      throw new Error("directory entries must be sorted by strictly ascending tile id");
    }
    writeVarint(delta, ids);
    previousId = entry.tileId;
    index0Seen = true;
  }

  const runs: number[] = [];
  const lengths: number[] = [];
  const offsets: number[] = [];
  let nextByte = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    writeVarint(entry.runLength, runs);
    writeVarint(entry.length, lengths);
    if (index > 0 && entry.offset === nextByte) {
      offsets.push(0);
    } else {
      writeVarint(entry.offset + 1, offsets);
    }
    nextByte = entry.offset + entry.length;
  }

  const streams = [counts, ids, runs, lengths, offsets];
  const total = counts.length + ids.length + runs.length + lengths.length + offsets.length;
  const out = new Uint8Array(total);
  let position = 0;
  for (const stream of streams) {
    out.set(stream, position);
    position += stream.length;
  }
  return out;
}

export interface HeaderFields {
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
  rootDirectoryLength: number;
  jsonMetadataOffset: number;
  jsonMetadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
}

const MAGIC_NUMBER = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73] as const; // "PMTiles"
const SPEC_VERSION = 3;
const COMPRESSION_GZIP = 2;

/** Tile compression: gzip (measured better than none at FY22 scale). */
const TILE_COMPRESSION_GZIP = 2;
const TILE_TYPE_MVT = 1;

/** Serializes the fixed 127-byte v3 header (spec chapter 3). */
export function serializeHeader(fields: HeaderFields): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(MAGIC_NUMBER, 0);
  view.setUint8(7, SPEC_VERSION);
  view.setBigUint64(8, BigInt(HEADER_BYTES), true); // root directory offset
  view.setBigUint64(16, BigInt(fields.rootDirectoryLength), true);
  view.setBigUint64(24, BigInt(fields.jsonMetadataOffset), true);
  view.setBigUint64(32, BigInt(fields.jsonMetadataLength), true);
  view.setBigUint64(40, BigInt(fields.leafDirectoryOffset), true);
  view.setBigUint64(48, BigInt(fields.leafDirectoryLength), true);
  view.setBigUint64(56, BigInt(fields.tileDataOffset), true);
  view.setBigUint64(64, BigInt(fields.tileDataLength), true);
  view.setBigUint64(72, BigInt(fields.numAddressedTiles), true);
  view.setBigUint64(80, BigInt(fields.numTileEntries), true);
  view.setBigUint64(88, BigInt(fields.numTileContents), true);
  view.setUint8(96, 1); // clustered: tile data is ordered by tile id
  view.setUint8(97, COMPRESSION_GZIP); // internal compression
  view.setUint8(98, TILE_COMPRESSION_GZIP); // tile compression
  view.setUint8(99, TILE_TYPE_MVT);
  view.setUint8(100, fields.minZoom);
  view.setUint8(101, fields.maxZoom);
  view.setInt32(102, Math.round(fields.minLon * 10_000_000), true);
  view.setInt32(106, Math.round(fields.minLat * 10_000_000), true);
  view.setInt32(110, Math.round(fields.maxLon * 10_000_000), true);
  view.setInt32(114, Math.round(fields.maxLat * 10_000_000), true);
  view.setUint8(118, fields.centerZoom);
  view.setInt32(119, Math.round(fields.centerLon * 10_000_000), true);
  view.setInt32(123, Math.round(fields.centerLat * 10_000_000), true);
  return out;
}
