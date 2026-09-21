import { describe, expect, it, vi } from "vitest";

import {
  OpfsArchiveCache,
  planEviction,
  supersededVersions,
  type ArchiveBlobStore,
  type CachedArchiveKey,
} from "./tile-archive-cache";

function key(schemaId: string, version: number): CachedArchiveKey {
  return { schemaId, version };
}

function bytes(length: number, fill: number): ArrayBuffer {
  return new Uint8Array(length).fill(fill).buffer;
}

/** In-memory stand-in for the OPFS store; counts writes/removes for asserts. */
class MemoryArchiveStore implements ArchiveBlobStore {
  readonly files = new Map<string, ArrayBuffer>();
  writes = 0;
  removes = 0;

  #name(k: CachedArchiveKey): string {
    return `${k.schemaId}/${k.version}`;
  }

  async list() {
    return [...this.files.entries()].map(([name, data]) => {
      const [schemaId, version] = name.split("/");
      return {
        bytes: data.byteLength,
        lastModified: 0,
        schemaId,
        version: Number(version),
      };
    });
  }

  async read(k: CachedArchiveKey, offset: number, length: number) {
    const data = this.files.get(this.#name(k));
    if (data === undefined || data.byteLength < offset + length) return undefined;
    return data.slice(offset, offset + length);
  }

  async remove(k: CachedArchiveKey) {
    this.removes += 1;
    this.files.delete(this.#name(k));
  }

  async write(k: CachedArchiveKey, data: ArrayBuffer) {
    this.writes += 1;
    this.files.set(this.#name(k), data);
  }
}

/** Fetch whose calls settle only when the test releases them. */
function deferredFetchArchive() {
  const pending: Array<{ release: (data: ArrayBuffer) => void; url: string }> = [];
  const fetchArchive = async (url: string) =>
    await new Promise<ArrayBuffer>((resolve) => {
      pending.push({ release: resolve, url });
    });
  return { fetchArchive, pending };
}

/** Releases the deferred fetch at `index`, if it has been called. */
function release(
  pending: Array<{ release: (data: ArrayBuffer) => void; url: string }>,
  index: number,
  data: ArrayBuffer,
): void {
  const call = pending[index];
  if (call !== undefined) call.release(data);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- flushing the microtask queue N levels deep; the awaits are the point.
    await Promise.resolve();
  }
}

describe("supersededVersions", () => {
  it("keeps only the current version", () => {
    expect(supersededVersions([1, 2, 3], 3)).toEqual([1, 2]);
  });

  it("treats any non-current version as superseded (pruning is version-exact, not order-based)", () => {
    expect(supersededVersions([1, 2, 3], 2)).toEqual([1, 3]);
  });
});

const entry = (schemaId: string, bytesValue: number, lastUsed: number) => ({
  bytes: bytesValue,
  lastUsed,
  schemaId,
  version: 1,
});

describe("planEviction", () => {
  it("returns nothing while under budget", () => {
    const entries = [entry("a", 10, 1), entry("b", 10, 2)];
    expect(planEviction(entries, 20)).toEqual([]);
  });

  it("evicts least-recently-used first until under budget", () => {
    const entries = [entry("a", 10, 3), entry("b", 10, 1), entry("c", 10, 2)];
    expect(planEviction(entries, 25)).toEqual([{ schemaId: "b", version: 1 }]);
    expect(planEviction(entries, 15)).toEqual([
      { schemaId: "b", version: 1 },
      { schemaId: "c", version: 1 },
    ]);
  });
});

describe("OpfsArchiveCache", () => {
  it("discovers pinned archives from the initial scan", async () => {
    const store = new MemoryArchiveStore();
    await store.write(key("s1", 4), bytes(10, 1));
    const cache = new OpfsArchiveCache(store, async () => bytes(1, 0));
    await cache.init();
    expect(cache.hasLocal("s1", 4)).toBe(true);
    expect(cache.allEntries()).toEqual([{ bytes: 10, lastUsed: 0, schemaId: "s1", version: 4 }]);
  });

  it("backfills a missing archive on observation, once per archive", async () => {
    const store = new MemoryArchiveStore();
    const fetchArchive = vi.fn<() => Promise<ArrayBuffer>>(async () => bytes(7, 9));
    const cache = new OpfsArchiveCache(store, fetchArchive);
    const first = cache.observeMeta("s1", { url: "https://x/blob", version: 2 });
    const second = cache.observeMeta("s1", { url: "https://x/blob", version: 2 });
    await Promise.all([first, second]);
    expect(fetchArchive).toHaveBeenCalledTimes(1);
    expect(store.writes).toBe(1);
    expect(cache.hasLocal("s1", 2)).toBe(true);
    const stored = [...store.files.values()].at(0);
    expect(stored === undefined ? undefined : stored.byteLength).toBe(7);
  });

  it("prunes a superseded version only after the new version is local", async () => {
    const store = new MemoryArchiveStore();
    const { fetchArchive, pending } = deferredFetchArchive();
    const cache = new OpfsArchiveCache(store, fetchArchive);
    // Establish the local v1 pin first (its own backfill must be released).
    const v1 = cache.observeMeta("s1", { url: "https://x/v1", version: 1 });
    await flushMicrotasks();
    release(pending, 0, bytes(4, 1));
    await v1;
    expect(store.files.has("s1/1")).toBe(true);

    const observation = cache.observeMeta("s1", { url: "https://x/v2", version: 2 });
    await flushMicrotasks();
    // While the v2 backfill is in flight, v1 stays readable — a live map on
    // the old version must not lose its local copy mid-render.
    expect(store.files.has("s1/1")).toBe(true);

    release(pending, 1, bytes(5, 2));
    await observation;
    expect(store.files.has("s1/2")).toBe(true);
    expect(store.files.has("s1/1")).toBe(false);
  });

  it("prunes every local copy when the archive pointer is gone, and discards an in-flight backfill for it", async () => {
    const store = new MemoryArchiveStore();
    const { fetchArchive, pending } = deferredFetchArchive();
    const cache = new OpfsArchiveCache(store, fetchArchive);
    const v1 = cache.observeMeta("s1", { url: "https://x/v1", version: 1 });
    await flushMicrotasks();
    release(pending, 0, bytes(4, 1));
    await v1;

    const stale = cache.observeMeta("s1", { url: "https://x/v2", version: 2 });
    await flushMicrotasks();
    await cache.observeMeta("s1", null);
    release(pending, 1, bytes(5, 2));
    await stale;

    expect(store.files.size).toBe(0);
    expect(cache.hasLocal("s1", 1)).toBe(false);
    expect(cache.hasLocal("s1", 2)).toBe(false);
  });

  it("enforces the LRU budget after a backfill, evicting oldest-use first", async () => {
    const store = new MemoryArchiveStore();
    let clock = 100;
    const cache = new OpfsArchiveCache(store, async (url) => bytes(10, url.length), {
      budgetBytes: 25,
      now: () => clock,
    });
    await cache.observeMeta("old", { url: "https://x/old", version: 1 }); // lastUsed 100
    clock = 200;
    await cache.observeMeta("mid", { url: "https://x/mid", version: 1 }); // lastUsed 200
    clock = 300;
    await cache.observeMeta("new", { url: "https://x/new", version: 1 }); // 30 total → evict until ≤ 25
    await flushMicrotasks();

    expect(cache.hasLocal("old", 1)).toBe(false);
    expect(cache.hasLocal("mid", 1)).toBe(true);
    expect(cache.hasLocal("new", 1)).toBe(true);
  });

  it("serves local reads and drops an entry whose file came up short", async () => {
    const store = new MemoryArchiveStore();
    await store.write(key("s1", 1), bytes(8, 3));
    const cache = new OpfsArchiveCache(store, async () => bytes(1, 0));
    await cache.init();

    const data = await cache.read(key("s1", 1), 2, 4);
    expect(data === undefined ? undefined : data.byteLength).toBe(4);
    expect(cache.hasLocal("s1", 1)).toBe(true);

    const store2 = new MemoryArchiveStore();
    await store2.write(key("s1", 1), bytes(2, 3)); // shorter than the entry believes
    const cache2 = new OpfsArchiveCache(store2, async () => bytes(1, 0));
    await cache2.init();
    expect(await cache2.read(key("s1", 1), 0, 8)).toBeUndefined();
    expect(cache2.hasLocal("s1", 1)).toBe(false);
  });

  it("re-arms a backfill from a read miss only for the observed current version", async () => {
    const store = new MemoryArchiveStore();
    const fetchArchive = vi.fn<() => Promise<ArrayBuffer>>(async () => bytes(4, 1));
    const cache = new OpfsArchiveCache(store, fetchArchive);
    await cache.observeMeta("s1", { url: "https://x/v2", version: 2 });
    fetchArchive.mockClear();

    // The local copy vanished (e.g. LRU-evicted by another schema's growth):
    // a read miss re-downloads the current version…
    const versions = store.files;
    versions.clear();
    cache.rearmBackfill(key("s1", 2), "https://x/v2");
    await flushMicrotasks();
    expect(fetchArchive).toHaveBeenCalledTimes(1);

    // …but never a just-pruned old version.
    fetchArchive.mockClear();
    cache.rearmBackfill(key("s1", 1), "https://x/v1");
    await flushMicrotasks();
    expect(fetchArchive).not.toHaveBeenCalled();
  });
});
