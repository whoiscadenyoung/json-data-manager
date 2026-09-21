/**
 * OPFS pin for tile archives (issue #58 part 5) — the persistent layer of the
 * client cache. After part 3 installs an archive server-side, this module
 * fetches the blob once and writes it to the browser's Origin Private File
 * System; the pmtiles protocol then serves byte ranges from that local copy,
 * so a repeat open of an unchanged dataset fetches **zero** archive bytes
 * from the network.
 *
 * Layout: OPFS root → `tile-archives/{schemaId}/{version}.pmtiles`.
 * Version-keyed paths make invalidation exact (a new version is a new file)
 * and keep a still-rendering old version readable until its replacement is
 * local — superseded versions are pruned only after the current version's
 * backfill lands, so a rebuild never blinds a live map mid-render. When the
 * archive pointer disappears server-side (`metas` → `null`, e.g. dataset
 * deletion), local copies go immediately.
 *
 * Reads plug into `pmtilesProtocol` (see `./pmtiles-protocol.ts`): the tile
 * URL stays `pmtiles://{storageUrl}` exactly as part 4 rendered it, but a
 * pre-added `PMTiles` instance whose source is `OpfsBackfillSource` wins the
 * protocol's lookup and serves ranges from disk, falling back to network
 * fetch (which re-arms the backfill) whenever the local copy is missing or
 * pruned mid-read.
 *
 * Budget: 256 MB LRU across schemas (tunable constant), enforced after every
 * write/prune on our own byte accounting; `navigator.storage.persist()` is
 * requested opportunistically so eviction pressure doesn't silently drop the
 * pin. All storage access uses the async OPFS API on the main thread — sync
 * access handles are worker-only, and MapLibre's protocol handler resolves
 * on the main thread anyway.
 */
import { useQuery } from "convex/react";
import { FetchSource, PMTiles } from "pmtiles";
import type { RangeResponse, Source } from "pmtiles";
import { useEffect, useMemo } from "react";

import { api } from "#convex/_generated/api";

import { pmtilesProtocol } from "./pmtiles-protocol";

/** OPFS directory (under the origin root) holding every pinned archive. */
export const TILE_ARCHIVE_CACHE_DIR = "tile-archives";

/** LRU budget across all schemas. Large polygon datasets pin at ~22 MB. */
export const TILE_ARCHIVE_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** One pinned archive on disk. `lastUsed` starts at the file's mtime (scan)
 * and is bumped on every local read — the LRU signal. */
export interface CachedArchiveEntry {
  bytes: number;
  lastUsed: number;
  schemaId: string;
  version: number;
}

/** A scan result from the store: what's on disk before any metadata arrives. */
export interface CachedArchiveScan {
  bytes: number;
  lastModified: number;
  schemaId: string;
  version: number;
}

/** Version-keyed storage address of one pinned archive. */
export interface CachedArchiveKey {
  schemaId: string;
  version: number;
}

/**
 * The storage surface the cache state machine needs. The production
 * implementation talks to OPFS; tests substitute an in-memory store.
 */
export interface ArchiveBlobStore {
  list(): Promise<Array<CachedArchiveScan>>;
  read(key: CachedArchiveKey, offset: number, length: number): Promise<ArrayBuffer | undefined>;
  remove(key: CachedArchiveKey): Promise<void>;
  write(key: CachedArchiveKey, data: ArrayBuffer): Promise<void>;
}

/** Archive metadata as `api.tile_archives.metas` returns it (when non-null). */
export interface ObservedArchiveMeta {
  url: string;
  version: number;
}

/**
 * Versions to drop once `currentVersion` is locally present: every other
 * version of the schema. Exported for tests — the class applies it only when
 * the current version is actually on disk, so the transition window keeps
 * rendering from the old copy.
 */
export function supersededVersions(versions: Array<number>, currentVersion: number): Array<number> {
  return versions.filter((version) => version !== currentVersion);
}

/**
 * LRU eviction plan: the entries to delete, oldest-use first, until the total
 * is back under budget. Pure so tests can pin the ordering; the class applies
 * the plan through the store.
 */
export function planEviction(
  entries: Array<CachedArchiveEntry>,
  budgetBytes: number,
): Array<{ schemaId: string; version: number }> {
  let total = 0;
  for (const entry of entries) {
    total += entry.bytes;
  }
  if (total <= budgetBytes) return [];
  const ordered = entries.toSorted((a, b) => a.lastUsed - b.lastUsed);
  const plan: Array<{ schemaId: string; version: number }> = [];
  let remaining = total;
  for (const entry of ordered) {
    if (remaining <= budgetBytes) break;
    plan.push({ schemaId: entry.schemaId, version: entry.version });
    remaining -= entry.bytes;
  }
  return plan;
}

/**
 * The cache state machine, storage-agnostic (see {@link ArchiveBlobStore}).
 * All methods tolerate store failures — the pin is an optimization, and every
 * miss degrades to network reads at the source layer.
 */
export class OpfsArchiveCache {
  readonly #store: ArchiveBlobStore;
  readonly #fetchArchive: (url: string) => Promise<ArrayBuffer>;
  readonly #budgetBytes: number;
  readonly #now: () => number;
  /** schemaId → (version → entry). Mirrors exactly what's on disk. */
  readonly #entries = new Map<string, Map<number, CachedArchiveEntry>>();
  /** schemaId → live meta observation (`version` is the current archive). */
  readonly #observedCurrent = new Map<string, number>();
  /** schemaId → generation, bumped whenever the schema is pruned wholesale;
   * in-flight backfills from an older generation discard their write. */
  readonly #generations = new Map<string, number>();
  /** schemaId:version → in-flight backfill (single-flight per archive). */
  readonly #backfills = new Map<string, Promise<void>>();
  #initialized: Promise<void> | undefined;

  constructor(
    store: ArchiveBlobStore,
    fetchArchive: (url: string) => Promise<ArrayBuffer>,
    options: { budgetBytes?: number; now?: () => number } = {},
  ) {
    this.#store = store;
    this.#fetchArchive = fetchArchive;
    this.#budgetBytes = options.budgetBytes ?? TILE_ARCHIVE_CACHE_BUDGET_BYTES;
    this.#now = options.now ?? Date.now;
  }

  /** Scans the store once; later calls (and concurrent callers) share the
   * first scan. Failures leave the cache empty — reads fall back to network. */
  async init(): Promise<void> {
    this.#initialized ??= this.#scan();
    await this.#initialized;
  }

  async #scan(): Promise<void> {
    try {
      for (const scan of await this.#store.list()) {
        const versions = this.#entries.get(scan.schemaId) ?? new Map<number, CachedArchiveEntry>();
        versions.set(scan.version, {
          bytes: scan.bytes,
          lastUsed: scan.lastModified,
          schemaId: scan.schemaId,
          version: scan.version,
        });
        this.#entries.set(scan.schemaId, versions);
      }
    } catch (error) {
      console.warn("[tile-archive-cache] scan failed; starting empty", error);
    }
  }

  /**
   * Applies one `metas` observation for a schema. `null` prunes every local
   * copy (the archive pointer is gone server-side). Otherwise the current
   * version is backfilled if missing, and superseded versions are pruned only
   * once the current version is local. Resolves when the observation's work
   * (including a triggered backfill) settles.
   */
  async observeMeta(schemaId: string, meta: ObservedArchiveMeta | null): Promise<void> {
    await this.init();
    if (meta === null) {
      this.#generations.set(schemaId, (this.#generations.get(schemaId) ?? 0) + 1);
      this.#observedCurrent.delete(schemaId);
      await this.#pruneSchema(schemaId);
      this.#enforceBudget();
      return;
    }
    this.#observedCurrent.set(schemaId, meta.version);
    const versions = this.#entries.get(schemaId);
    const entry = versions === undefined ? undefined : versions.get(meta.version);
    if (entry === undefined) {
      await this.#backfill(schemaId, meta.version, meta.url);
      return;
    }
    entry.lastUsed = this.#now();
    await this.#pruneSuperseded(schemaId, meta.version);
    this.#enforceBudget();
  }

  /**
   * Reads a byte range from the local copy, or `undefined` when absent (the
   * caller falls back to network). Successful reads bump the LRU clock; a
   * failed or short read evicts the local entry so the next backfill re-fetches
   * a fresh copy.
   */
  async read(
    key: CachedArchiveKey,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer | undefined> {
    const versions = this.#entries.get(key.schemaId);
    const entry = versions === undefined ? undefined : versions.get(key.version);
    if (entry === undefined) return undefined;
    let data: ArrayBuffer | undefined;
    try {
      data = await this.#store.read(key, offset, length);
    } catch (error) {
      console.debug(`[tile-archive-cache] read failed for ${key.schemaId}/${key.version}`, error);
    }
    if (data === undefined) {
      if (versions !== undefined) versions.delete(key.version);
      return undefined;
    }
    entry.lastUsed = this.#now();
    return data;
  }

  /** True when the archive is pinned locally right now. */
  hasLocal(schemaId: string, version: number): boolean {
    const versions = this.#entries.get(schemaId);
    return versions !== undefined && versions.get(version) !== undefined;
  }

  /** Every known local entry (for tests and the eviction plan). */
  allEntries(): Array<CachedArchiveEntry> {
    const flat: Array<CachedArchiveEntry> = [];
    for (const versions of this.#entries.values()) {
      for (const entry of versions.values()) {
        flat.push(entry);
      }
    }
    return flat;
  }

  /** True while a backfill for this exact archive is in flight. */
  isBackfilling(schemaId: string, version: number): boolean {
    return this.#backfills.has(`${schemaId}:${version}`);
  }

  /**
   * Re-arms a backfill after a local read miss (called from the source layer).
   * Confined to the currently-observed version, so a mid-render miss on a
   * just-pruned old version never triggers a zombie download.
   */
  rearmBackfill(key: CachedArchiveKey, url: string): void {
    if (this.#observedCurrent.get(key.schemaId) !== key.version) return;
    void this.#backfill(key.schemaId, key.version, url);
  }

  async #backfill(schemaId: string, version: number, url: string): Promise<void> {
    const key = `${schemaId}:${version}`;
    const existing = this.#backfills.get(key);
    if (existing !== undefined) return existing;
    const generation = this.#generations.get(schemaId) ?? 0;
    const run = (async () => {
      try {
        const data = await this.#fetchArchive(url);
        if ((this.#generations.get(schemaId) ?? 0) !== generation) return; // pruned mid-flight
        await this.#store.write({ schemaId, version }, data);
        const versions = this.#entries.get(schemaId) ?? new Map<number, CachedArchiveEntry>();
        versions.set(version, {
          bytes: data.byteLength,
          lastUsed: this.#now(),
          schemaId,
          version,
        });
        this.#entries.set(schemaId, versions);
        await this.#pruneSuperseded(schemaId, version);
        this.#enforceBudget();
      } catch (error) {
        console.warn(`[tile-archive-cache] backfill failed for ${key}`, error);
      } finally {
        this.#backfills.delete(key);
      }
    })();
    this.#backfills.set(key, run);
    return run;
  }

  /** Drops every local version except `currentVersion`. Only meaningful once
   * that version is local (callers guarantee it). */
  async #pruneSuperseded(schemaId: string, currentVersion: number): Promise<void> {
    const versions = this.#entries.get(schemaId);
    if (versions === undefined) return;
    for (const version of supersededVersions([...versions.keys()], currentVersion)) {
      // oxlint-disable-next-line no-await-in-loop -- sequential OPFS removals; pruning order keeps the pin set consistent.
      await this.#remove(schemaId, version);
    }
  }

  /** Drops every local version of a schema and invalidates its in-flight
   * backfills (via the generation counter). */
  async #pruneSchema(schemaId: string): Promise<void> {
    const versions = this.#entries.get(schemaId);
    if (versions === undefined) return;
    // Deleting from a Map during key iteration is safe — each removed key is
    // visited at most once and removed keys are never revisited.
    for (const version of versions.keys()) {
      // oxlint-disable-next-line no-await-in-loop -- sequential OPFS removals, see #pruneSuperseded.
      await this.#remove(schemaId, version);
    }
  }

  async #remove(schemaId: string, version: number): Promise<void> {
    try {
      await this.#store.remove({ schemaId, version });
    } catch (error) {
      console.debug(`[tile-archive-cache] remove failed for ${schemaId}/${version}`, error);
    }
    const versions = this.#entries.get(schemaId);
    if (versions !== undefined) versions.delete(version);
  }

  #enforceBudget(): void {
    for (const plan of planEviction(this.allEntries(), this.#budgetBytes)) {
      void this.#remove(plan.schemaId, plan.version);
    }
  }
}

// --- OPFS store (production {@link ArchiveBlobStore}) ---

function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.storage !== undefined &&
    typeof navigator.storage.getDirectory === "function"
  );
}

async function cacheRoot(): Promise<FileSystemDirectoryHandle> {
  const storageRoot = await navigator.storage.getDirectory();
  return await storageRoot.getDirectoryHandle(TILE_ARCHIVE_CACHE_DIR, { create: true });
}

function archiveFileName(version: number): string {
  return `${version}.pmtiles`;
}

function opfsArchiveBlobStore(): ArchiveBlobStore {
  return {
    async list() {
      const scans: Array<CachedArchiveScan> = [];
      let root: FileSystemDirectoryHandle;
      try {
        root = await cacheRoot();
      } catch {
        return scans; // no cache directory yet
      }
      for await (const [schemaId, schemaDir] of root.entries()) {
        if (schemaDir.kind !== "directory") continue;
        for await (const [name, handle] of schemaDir.entries()) {
          if (handle.kind !== "file") continue;
          const match = /^(\d+)\.pmtiles$/.exec(name);
          if (match === null) continue;
          const file = await handle.getFile();
          scans.push({
            bytes: file.size,
            lastModified: file.lastModified,
            schemaId,
            version: Number(match[1]),
          });
        }
      }
      return scans;
    },
    async read(key, offset, length) {
      const root = await cacheRoot();
      const schemaDir = await root.getDirectoryHandle(key.schemaId, { create: false });
      const handle = await schemaDir.getFileHandle(archiveFileName(key.version), { create: false });
      const file = await handle.getFile();
      if (file.size < offset + length) return undefined;
      return await file.slice(offset, offset + length).arrayBuffer();
    },
    async remove(key) {
      const root = await cacheRoot();
      const schemaDir = await root.getDirectoryHandle(key.schemaId, { create: false });
      await schemaDir.removeEntry(archiveFileName(key.version));
    },
    async write(key, data) {
      const root = await cacheRoot();
      const schemaDir = await root.getDirectoryHandle(key.schemaId, { create: true });
      const handle = await schemaDir.getFileHandle(archiveFileName(key.version), { create: true });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
    },
  };
}

async function fetchArchiveBlob(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Archive fetch failed: ${String(response.status)}`);
  }
  return await response.arrayBuffer();
}

// --- singleton + protocol wiring ---

let cacheSingleton: OpfsArchiveCache | undefined;

/** The process-wide cache (or `undefined` where OPFS is unavailable — SSR,
 * unsupported browsers). Construction is cheap; the scan happens in `init`. */
export function getTileArchiveCache(): OpfsArchiveCache | undefined {
  if (!isOpfsAvailable()) return undefined;
  cacheSingleton ??= new OpfsArchiveCache(opfsArchiveBlobStore(), fetchArchiveBlob);
  return cacheSingleton;
}

/**
 * A pmtiles `Source` that serves ranges from the OPFS pin and falls back to
 * network fetch (re-arming the backfill) on every miss — the read side of the
 * pin. Its `getKey()` is the bare storage URL, which is what part 4's
 * `pmtiles://{meta.url}` tile URLs carry, so the protocol's lookup finds this
 * instance without any URL rewriting.
 */
class OpfsBackfillSource implements Source {
  readonly #url: string;
  readonly #key: CachedArchiveKey;
  readonly #network: FetchSource;

  constructor(url: string, key: CachedArchiveKey) {
    this.#url = url;
    this.#key = key;
    this.#network = new FetchSource(url);
  }

  getKey(): string {
    return this.#url;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const cache = getTileArchiveCache();
    if (cache !== undefined) {
      const local = await cache.read(this.#key, offset, length);
      if (local !== undefined) return { data: local };
      cache.rearmBackfill(this.#key, this.#url);
    }
    return await this.#network.getBytes(offset, length, signal, etag);
  }
}

/** schemaId → (version → storage URL) for every protocol instance we added. */
const wiredUrls = new Map<string, Map<number, string>>();

/**
 * Adds a protocol instance for `pmtiles://{url}` backed by the OPFS pin.
 * Idempotent per URL; the tile URLs themselves never change.
 */
export function wireProtocolSource(schemaId: string, version: number, url: string): void {
  let versions = wiredUrls.get(schemaId);
  if (versions === undefined) {
    versions = new Map<number, string>();
    wiredUrls.set(schemaId, versions);
  }
  const existing = versions.get(version);
  if (existing === url) return;
  if (getTileArchiveCache() === undefined) return; // no pin → default network source is fine
  pmtilesProtocol.add(new PMTiles(new OpfsBackfillSource(url, { schemaId, version })));
  versions.set(version, url);
}

/** Drops protocol instances for every version of a schema except `keep` (or
 * all of them when `keep` is `undefined`). Already-loaded maps keep their
 * instance objects; only future URL lookups stop resolving to them. */
export function unwireProtocolSources(schemaId: string, keep?: number): void {
  const versions = wiredUrls.get(schemaId);
  if (versions === undefined) return;
  for (const [version, url] of versions.entries()) {
    if (version === keep) continue;
    pmtilesProtocol.tiles.delete(url);
    versions.delete(version);
  }
}

// --- root manager ---

/**
 * Mounted once at the app root (next to the rebuild manager): observes every
 * geospatial dataset's archive metadata and drives the pin — backfill new
 * versions, prune superseded/gone ones, enforce the LRU budget. Purely a
 * cache keeper: rendering decisions stay in `layer-source.ts`, builds in
 * `tile-archive.ts`.
 */
export function TileArchiveCacheManager(): null {
  const schemas = useQuery(api.schemas.listSummaries);
  const geospatialIds = useMemo(
    () =>
      (schemas ?? [])
        .filter((schema) => schema.kind === "geospatial" && schema.geometryType !== undefined)
        .map((schema) => schema._id),
    [schemas],
  );
  const metas = useQuery(
    api.tile_archives.metas,
    geospatialIds.length > 0 ? { schemaIds: geospatialIds } : "skip",
  );
  useEffect(() => {
    if (metas === undefined) return; // wait for the first observation
    const cache = getTileArchiveCache();
    if (cache === undefined) return;
    void (async () => {
      await cache.init();
      // Datasets that left the geospatial set (deleted, or converted away)
      // have no archive pointer anymore — drop their pins.
      if (schemas !== undefined) {
        const geospatial = new Set(geospatialIds);
        for (const schemaId of new Set(wiredUrls.keys())) {
          if (!geospatial.has(schemaId)) {
            // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
            await cache.observeMeta(schemaId, null);
            unwireProtocolSources(schemaId);
          }
        }
      }
      for (const [index, schemaId] of geospatialIds.entries()) {
        const meta = metas[index];
        if (meta === undefined) continue;
        if (meta === null) {
          // oxlint-disable-next-line no-await-in-loop -- sequential pin drops; each observes then unwires.
          await cache.observeMeta(schemaId, null);
          unwireProtocolSources(schemaId);
          continue;
        }
        wireProtocolSource(schemaId, meta.version, meta.url);
        // oxlint-disable-next-line no-await-in-loop -- sequential pin updates; ordering keeps the backfill generation sane.
        await cache.observeMeta(schemaId, { url: meta.url, version: meta.version });
      }
    })();
  }, [schemas, metas, geospatialIds]);
  return null;
}
