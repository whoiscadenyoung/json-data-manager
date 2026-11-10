// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The manager's collaborators: the toast surface, the worker's auth token,
// and the summaries query the manager hook reads.
const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn<(args: { queryKey: string[] }) => void>(),
  pgSummaries: undefined as Array<Record<string, unknown>> | undefined,
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("#/env", () => ({
  env: {
    VITE_SUPABASE_ANON_KEY: "test-anon-key",
    VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  },
}));
// The dormant Convex token branch stays mocked (the module still imports it
// for the archived worker path); nothing live reaches it.
vi.mock("#/integrations/tanstack-query/root-provider", () => ({
  getContext: () => ({ queryClient: { invalidateQueries: mocks.invalidateQueries } }),
}));
// The PG feed: summaries scripted per test, metas irrelevant to the manager.
vi.mock("./pg-tile-archives-react", () => ({
  usePgTileDatasetSummaries: () => mocks.pgSummaries,
  usePgTileArchiveMetas: () => new globalThis.Map(),
}));

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
  mocks.pgSummaries = undefined;
  mocks.invalidateQueries.mockReset();
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
    // The pre-disconnect Convex watch drove this scenario off
    // `api.cms.schemas.listSummaries`; the PG summaries feed drives the same
    // staleness/clear cycle since stage 2 (issue #201) and is the only feed
    // since the stage-7 disconnect (issue #206).
    mocks.pgSummaries = [pgSummaryRow({ mapTileArchiveBuiltVersion: 2, mapTileCacheVersion: 3 })];
    const { rerender } = renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker().posted).toHaveLength(1);
    // failBuild replies with the legacy SCHEMA id; this build's id is the PG
    // one the scheduler keyed.
    worker().reply({
      message: "listGeometries timed out",
      schemaId: PG_ID,
      type: "error",
    });
    await flush();
    expect(tiles.getTileArchiveBuildFailure(PG_ID)).toBeDefined();

    // Another tab installs the archive at version 3: the next summaries
    // update shows it current.
    mocks.pgSummaries = [pgSummaryRow({ mapTileArchiveBuiltVersion: 3, mapTileCacheVersion: 3 })];
    rerender();
    expect(tiles.getTileArchiveBuildFailure(PG_ID)).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // And the armed 1 m retry never rebuilds the fresh archive.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(worker().posted).toHaveLength(1);
  });

  it("a reload restores the failure and waits out the stored backoff", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [PG_ID]: {
          failures: 1,
          message: "listGeometries timed out",
          retryAt: Date.now() + 60_000,
          version: 3,
        },
      }),
    );
    mocks.pgSummaries = [pgSummaryRow()];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    expect(tiles.getTileArchiveBuildFailure(PG_ID)).toMatchObject({ failures: 1 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(FakeWorker.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker().posted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The Postgres loop (stage 2, issue #201): same scheduler, uuid ids, the
// store summaries feed, and the post-install cache invalidation that stands
// in for Convex's push until realtime lands (stage 6).
// ---------------------------------------------------------------------------

const PG_ID = "a4882d70-0000-4000-8000-000000000001";

function pgSummaryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    featureCount: 10,
    geometryType: "Point",
    id: PG_ID,
    isGeospatial: true,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: 2,
    mapTileCacheVersion: 3,
    ...overrides,
  };
}

describe("the manager's PG summaries loop", () => {
  it("schedules a build for a stale PG dataset and posts it to the shared worker", async () => {
    mocks.pgSummaries = [pgSummaryRow()];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(5000);
    const posted = worker().posted.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "build",
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toStrictEqual({ schemaId: PG_ID, type: "build" });
  });

  it("a current PG dataset never schedules, and clears a prior failure", async () => {
    // Seed a failure first (ensure spawns the worker; a current summaries
    // loop never would — that is the point).
    tiles.ensureMapTileArchive(PG_ID);
    worker().reply({ message: "pg rows failed", schemaId: PG_ID, type: "error" });
    await flush();
    expect(tiles.getTileArchiveBuildFailure(PG_ID)).toBeDefined();
    const buildsBefore = worker().posted.length;

    // The next (fresh-array) summaries show it current: the failure and its
    // armed retry are dropped (#184 review), and NO new build is scheduled.
    mocks.pgSummaries = [pgSummaryRow({ mapTileArchiveBuiltVersion: 3, mapTileCacheVersion: 3 })];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tiles.getTileArchiveBuildFailure(PG_ID)).toBeUndefined();
    // The armed 30 m backoff retry never rebuilds the fresh archive.
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(worker().posted.length).toBe(buildsBefore);
  });

  it("a PG done message invalidates the pg:datasets queries (no push for Postgres)", async () => {
    mocks.pgSummaries = [pgSummaryRow()];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(5000);
    worker().reply({ builtVersion: 3, bytes: 1, maxZoom: 14, schemaId: PG_ID, type: "done" });
    await flush();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pg:datasets"] });
    // The signed-archive-URL metas feed goes stale with the install: its key
    // (["pg:tile-archives","metas",datasetIds]) is structurally unchanged, so
    // without the prefix invalidation the feed would keep reporting "no
    // servable archive" and the OPFS pin would drop until an unrelated
    // refetch.
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pg:tile-archives"] });
  });

  it("a PG stale-discarded message also invalidates; a Convex one does not", async () => {
    mocks.pgSummaries = [pgSummaryRow()];
    renderHook(() => {
      tiles.useMapTileArchiveManager();
    });
    await vi.advanceTimersByTimeAsync(5000);
    worker().reply({ schemaId: PG_ID, type: "stale-discarded" });
    await flush();
    // Both PG feeds per settlement: summaries + the metas prefix.
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["pg:tile-archives"] });

    worker().reply({ builtVersion: 1, bytes: 1, maxZoom: 14, schemaId: SCHEMA, type: "done" });
    await flush();
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
  });
});
