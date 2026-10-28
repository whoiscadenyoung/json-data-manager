// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The manager's collaborators: the toast surface, the worker's auth token,
// and the summaries query the manager hook reads.
const mocks = vi.hoisted(() => ({
  schemas: [] as Array<Record<string, unknown>>,
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("#/lib/convex-auth-token", () => ({ fetchConvexToken: async () => null }));
vi.mock("#convex/_generated/api", () => ({
  api: { cms: { schemas: { listSummaries: "listSummaries" } } },
}));
vi.mock("convex/react", () => ({ useQuery: () => mocks.schemas }));

type TileArchiveModule = typeof import("./tile-archive");

/** Stands in for the tile-archive worker: records builds, replays replies. */
class FakeWorker {
  static instances: Array<FakeWorker> = [];
  readonly posted: Array<unknown> = [];
  readonly #listeners: Array<(event: MessageEvent<unknown>) => void> = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === "message") this.#listeners.push(listener);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  reply(data: Record<string, unknown>): void {
    for (const listener of this.#listeners) {
      listener(new MessageEvent("message", { data }));
    }
  }

  terminate(): void {
    // Nothing to tear down.
  }
}

function worker(): FakeWorker {
  const instance = FakeWorker.instances.at(-1);
  if (instance === undefined) throw new Error("no worker spawned");
  return instance;
}

/** Lets a settled build's promise chain reach the scheduler's backoff. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

const SCHEMA = "schema-1",
  STORAGE_KEY = "tile-archive-backoff";

let tiles: TileArchiveModule;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  FakeWorker.instances = [];
  mocks.schemas = [];
  mocks.toastError.mockReset();
  // The manager logs every state change in dev; keep test output readable.
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  localStorage.clear();
  // Fresh module state (failure store, scheduler, worker) per test.
  vi.resetModules();
  tiles = await import("./tile-archive");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failBuild(message = "listGeometries timed out"): Promise<void> {
  worker().reply({ message, schemaId: SCHEMA, type: "error" });
  await flush();
}

describe("tile-archive failure store (#184)", () => {
  it("records the failure before the backoff lands on it, and toasts once per streak", async () => {
    tiles.ensureMapTileArchive(SCHEMA);
    await failBuild();
    // retryAt is set only if applyBackoff found the record recordBuildFailure wrote.
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toEqual({
      failures: 1,
      message: "listGeometries timed out",
      retryAt: Date.now() + 60_000,
    });
    expect(mocks.toastError).toHaveBeenCalledTimes(1);

    tiles.ensureMapTileArchive(SCHEMA);
    await failBuild("still timing out");
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toMatchObject({
      failures: 2,
      message: "still timing out",
    });
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
  });

  it("an installed build clears the failure and its stored backoff", async () => {
    tiles.ensureMapTileArchive(SCHEMA);
    await failBuild();
    expect(localStorage.getItem(STORAGE_KEY)).toContain(SCHEMA);

    tiles.ensureMapTileArchive(SCHEMA);
    worker().reply({ builtVersion: 3, bytes: 1, maxZoom: 14, schemaId: SCHEMA, type: "done" });
    await flush();
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("a skipped build clears the failure", async () => {
    tiles.ensureMapTileArchive(SCHEMA);
    await failBuild();
    tiles.ensureMapTileArchive(SCHEMA);
    worker().reply({ reason: "below-threshold", schemaId: SCHEMA, type: "skipped", version: 3 });
    await flush();
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toBeUndefined();
  });

  it("a stale-discarded build keeps the failure: nothing installed yet", async () => {
    tiles.ensureMapTileArchive(SCHEMA);
    await failBuild();
    tiles.ensureMapTileArchive(SCHEMA);
    worker().reply({ schemaId: SCHEMA, type: "stale-discarded" });
    await flush();
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toMatchObject({
      message: "listGeometries timed out",
    });
  });

  it("the manager clears a failure once the archive is current some other way", async () => {
    const row = {
      _id: SCHEMA,
      geometryType: "Point",
      kind: "geospatial",
      mapTileArchiveBuiltVersion: 2,
      mapTileArchiveFormatCurrent: true,
      mapTileCacheVersion: 3,
    };
    mocks.schemas = [row];
    const { rerender } = renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker().posted).toHaveLength(1);
    await failBuild();
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toBeDefined();

    // Another tab installs the archive at version 3: the next summaries
    // update shows it current.
    mocks.schemas = [{ ...row, mapTileArchiveBuiltVersion: 3 }];
    rerender();
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // And the armed 1 m retry never rebuilds the fresh archive.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(worker().posted).toHaveLength(1);
  });

  it("a reload restores the failure and waits out the stored backoff", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [SCHEMA]: {
          failures: 1,
          message: "listGeometries timed out",
          retryAt: Date.now() + 60_000,
          version: 3,
        },
      }),
    );
    mocks.schemas = [
      { _id: SCHEMA, geometryType: "Point", kind: "geospatial", mapTileCacheVersion: 3 },
    ];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    expect(tiles.getTileArchiveBuildFailure(SCHEMA)).toMatchObject({ failures: 1 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(FakeWorker.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker().posted).toHaveLength(1);
  });
});
