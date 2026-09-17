/**
 * Assembles gzip-compressed, tile-id-sorted MVT tiles into a PMTiles v3
 * container (spec chapters 2-4, appendix A.1):
 *
 *   [127-byte header][gzip root directory][gzip JSON metadata]
 *   [gzip leaf directories][gzip-compressed tile blobs]
 *
 * All header offsets are absolute; tile-data offsets stored in directory
 * entries are relative to the tile data section start, and leaf-directory
 * pointer offsets are relative to the leaf directories section.
 */
import { gzip } from "./compress";
import {
  HEADER_BYTES,
  MAX_ROOT_DIRECTORY_BYTES,
  serializeDirectory,
  serializeHeader,
} from "./directory";
import type { DirectoryEntry } from "./directory";
import type { ArchiveTile } from "./types";

/** Entries per leaf directory once the compressed root no longer fits. */
const LEAF_CHUNK_SIZE = 4096;

export interface AssembleInput {
  /** Gzip-compressed MVT tiles, in any order. */
  tiles: readonly ArchiveTile[];
  /** Serialised JSON metadata section content. */
  metadata: string;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
}

/** Directory entry plus the internal blob index used while deduplicating. */
interface ContainerEntry extends DirectoryEntry {
  blobIndex: number;
}

/** Deduplicated tiles: run-length directory entries plus their blobs. */
interface Deduplicated {
  entries: ContainerEntry[];
  blobData: Uint8Array[];
  /** Total byte length of the tile data section. */
  tileDataLength: number;
}

/** Byte-exact comparison over two byte arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

/** Cheap collision-tolerant digest: byte length plus head/tail hex. */
function digestOf(data: Uint8Array): string {
  const head = data.subarray(0, 16);
  const tail = data.subarray(Math.max(0, data.length - 16));
  let headHex = "";
  let tailHex = "";
  for (const byte of head) {
    headHex += byte.toString(16).padStart(2, "0");
  }
  for (const byte of tail) {
    tailHex += byte.toString(16).padStart(2, "0");
  }
  return `${data.length}:${headHex}:${tailHex}`;
}

/** Deduplicated tiles: run-length directory entries plus their blobs. */
interface Deduplicated {
  entries: ContainerEntry[];
  blobData: Uint8Array[];
}

/**
 * Collapses Hilbert-adjacent identical tiles into run-length entries and
 * deduplicates identical blobs globally so each unique byte string is
 * stored exactly once.
 */
function deduplicateTiles(sorted: readonly ArchiveTile[]): Deduplicated {
  const entries: ContainerEntry[] = [];
  const blobData: Uint8Array[] = [];
  const blobOffsets: number[] = [];
  const blobIndexByDigest = new Map<string, number>();
  let tileDataLength = 0;

  for (const tile of sorted) {
    const previous = entries[entries.length - 1];
    if (
      previous !== undefined &&
      previous.blobIndex >= 0 &&
      blobData[previous.blobIndex].length === tile.data.length &&
      bytesEqual(blobData[previous.blobIndex], tile.data)
    ) {
      previous.runLength += 1;
      continue;
    }
    const digest = digestOf(tile.data);
    const known = blobIndexByDigest.get(digest);
    let blobIndex: number;
    if (known !== undefined && bytesEqual(blobData[known], tile.data)) {
      blobIndex = known;
    } else {
      blobIndex = blobData.length;
      blobData.push(tile.data);
      blobOffsets.push(tileDataLength);
      tileDataLength += tile.data.length;
      blobIndexByDigest.set(digest, blobIndex);
    }
    entries.push({
      tileId: tile.tileId,
      blobIndex,
      offset: blobOffsets[blobIndex],
      length: tile.data.length,
      runLength: 1,
    });
  }

  return { entries, blobData, tileDataLength };
}

/** Chooses the root directory: tile entries directly, or leaf directories. */
function chooseRootDirectory(
  entries: readonly DirectoryEntry[],
): { rootData: Uint8Array; leafData: Uint8Array[] } {
  const directRoot = gzip(serializeDirectory(entries));
  if (directRoot.length <= MAX_ROOT_DIRECTORY_BYTES) {
    return { rootData: directRoot, leafData: [] };
  }
  let leafSize = LEAF_CHUNK_SIZE;
  for (;;) {
    const leafData: Uint8Array[] = [];
    const rootEntries: DirectoryEntry[] = [];
    let leafOffset = 0;
    for (let start = 0; start < entries.length; start += leafSize) {
      const chunk = entries.slice(start, start + leafSize);
      const chunkData = gzip(serializeDirectory(chunk));
      leafData.push(chunkData);
      rootEntries.push({
        tileId: chunk[0].tileId,
        offset: leafOffset,
        length: chunkData.length,
        runLength: 0,
      });
      leafOffset += chunkData.length;
    }
    const candidate = gzip(serializeDirectory(rootEntries));
    if (candidate.length <= MAX_ROOT_DIRECTORY_BYTES) {
      return { rootData: candidate, leafData };
    }
    leafSize *= 2;
  }
}

/**
 * Assembles sorted, gzip-compressed tiles into a finished PMTiles archive.
 */
export function assembleArchive(input: AssembleInput): Uint8Array {
  const sorted = input.tiles.toSorted((a, b) => a.tileId - b.tileId);
  const { entries, blobData, tileDataLength } = deduplicateTiles(sorted);
  const { rootData, leafData } = chooseRootDirectory(entries);

  const metadataBytes = gzip(new TextEncoder().encode(input.metadata));
  const jsonMetadataOffset = HEADER_BYTES + rootData.length;
  const leafDirectoryOffset = jsonMetadataOffset + metadataBytes.length;
  const leafSectionLength = leafData.reduce((sum, leaf) => sum + leaf.length, 0);
  const tileDataOffset = leafDirectoryOffset + leafSectionLength;

  const archive = new Uint8Array(tileDataOffset + tileDataLength);
  archive.set(rootData, HEADER_BYTES);
  archive.set(metadataBytes, jsonMetadataOffset);
  let leafPosition = leafDirectoryOffset;
  for (const leaf of leafData) {
    archive.set(leaf, leafPosition);
    leafPosition += leaf.length;
  }
  let blobPosition = tileDataOffset;
  for (const blob of blobData) {
    archive.set(blob, blobPosition);
    blobPosition += blob.length;
  }

  archive.set(
    serializeHeader({
      minZoom: input.minZoom,
      maxZoom: input.maxZoom,
      minLon: input.minLon,
      minLat: input.minLat,
      maxLon: input.maxLon,
      maxLat: input.maxLat,
      centerZoom: input.centerZoom,
      centerLon: (input.minLon + input.maxLon) / 2,
      centerLat: (input.minLat + input.maxLat) / 2,
      rootDirectoryLength: rootData.length,
      jsonMetadataOffset,
      jsonMetadataLength: metadataBytes.length,
      leafDirectoryOffset,
      leafDirectoryLength: leafSectionLength,
      tileDataOffset,
      tileDataLength,
      numAddressedTiles: sorted.length,
      numTileEntries: entries.length,
      numTileContents: blobData.length,
    }),
    0,
  );

  return archive;
}
