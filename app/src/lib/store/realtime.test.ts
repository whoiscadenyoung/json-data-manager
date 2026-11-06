import type { SupabaseClient } from "@supabase/supabase-js";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

// The drift-guard imports below reach `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  getQueryOptions as collectionsGetOptions,
  listCollectionsByDatasetQueryOptions,
  listDatasetsQueryOptions,
  listMembershipsQueryOptions,
  listQueryOptions as collectionsListOptions,
} from "./collections";
import type { DatasetGeometryType, DatasetRow, DatasetSummaryRow } from "./datasets";
import {
  getQueryOptions as datasetsGetOptions,
  getSourceFileUrlQueryOptions,
  listByCreatorQueryOptions,
  listDraftSummariesQueryOptions,
  listQueryOptions as datasetsListOptions,
  listSummariesQueryOptions,
  maxTileCacheVersionQueryOptions,
} from "./datasets";
import {
  getQueryOptions as entriesGetOptions,
  listForIdsQueryOptions,
  listPageQueryOptions,
  searchEntriesQueryOptions,
  type EntryRow,
} from "./entries";
import {
  getByEntryQueryOptions,
  rowsForTilesQueryOptions,
  type GeometryRow,
  type GeometryRowsPage,
} from "./geometries";
import {
  getQueryOptions as mapsGetOptions,
  listAllPlacementsQueryOptions,
  listPlacementsQueryOptions,
} from "./maps";
import { attachDatasetRealtime, DATASET_CHANNEL_TABLES, datasetChannelTopic } from "./realtime";
import { getQueryOptions as tagsGetOptions, listQueryOptions as tagsListOptions } from "./tags";
import {
  consumedByQueryOptions,
  getVersionQueryOptions as versionsGetOptions,
  headOfChainQueryOptions,
  listConsumerReferencesQueryOptions,
  listVersionsQueryOptions,
  retentionPolicyQueryOptions,
  versionEntriesQueryOptions,
} from "./versions";

// ---------------------------------------------------------------------------
// The supabase-js stand-in: channels record their postgres_changes
// subscriptions and deliver scripted payloads; removeChannel retires them the
// way the real client does (a later `channel(topic)` builds a FRESH channel).
// ---------------------------------------------------------------------------

interface RecordedPostgresFilter {
  event: string;
  filter: string;
  schema: string;
  table: string;
}

interface ScriptedChange {
  eventType: string;
  new?: unknown;
  old?: unknown;
}

class StubRealtimeChannel {
  readonly filters: RecordedPostgresFilter[] = [];
  subscribed = false;
  private readonly handlers: Array<(payload: unknown) => void> = [];

  constructor(readonly topic: string) {}

  on(
    _type: "postgres_changes",
    filter: RecordedPostgresFilter,
    handler: (payload: unknown) => void,
  ): StubRealtimeChannel {
    this.filters.push(filter);
    this.handlers.push(handler);
    return this;
  }

  subscribe(): StubRealtimeChannel {
    this.subscribed = true;
    return this;
  }

  /** Delivers one postgres_changes payload to the handler subscribed for `table`. */
  deliver(table: string, change: ScriptedChange): void {
    for (let index = 0; index < this.filters.length; index += 1) {
      const filter = this.filters[index];
      if (filter === undefined || filter.table !== table) {
        continue;
      }
      const handler = this.handlers[index];
      if (handler === undefined) {
        throw new Error(`No handler recorded for ${table} on ${this.topic}.`);
      }
      handler({
        commitTimestamp: "2026-11-04T00:00:00Z",
        errors: [],
        eventType: change.eventType,
        new: change.new === undefined ? {} : change.new,
        old: change.old === undefined ? {} : change.old,
        schema: "public",
        table,
      });
      return;
    }
    throw new Error(`No postgres_changes subscription for ${table} on ${this.topic}.`);
  }
}

function stubRealtimeClient() {
  const channels: StubRealtimeChannel[] = [];
  const removedTopics: string[] = [];
  const authListeners: Array<(event: string) => void> = [];
  let authUnsubscribes = 0;
  const client = {
    auth: {
      onAuthStateChange(listener: (event: string) => void) {
        authListeners.push(listener);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authUnsubscribes += 1;
              },
            },
          },
        };
      },
    },
    channel(topic: string): StubRealtimeChannel {
      const existing = channels.find((candidate) => candidate.topic === topic);
      if (existing !== undefined) {
        return existing;
      }
      const channel = new StubRealtimeChannel(topic);
      channels.push(channel);
      return channel;
    },
    async removeChannel(channel: StubRealtimeChannel) {
      removedTopics.push(channel.topic);
      const index = channels.indexOf(channel);
      if (index >= 0) {
        channels.splice(index, 1);
      }
      return "ok";
    },
  };
  return {
    authListeners,
    authUnsubscribeCount: () => authUnsubscribes,
    channels,
    client: client as unknown as SupabaseClient,
    removedTopics,
  };
}

/** The one channel the tests open (loud failure when the count is not exactly one). */
function onlyChannel(channels: ReadonlyArray<StubRealtimeChannel>): StubRealtimeChannel {
  if (channels.length !== 1) {
    throw new Error(`Expected exactly one open channel, found ${channels.length}.`);
  }
  const channel = channels[0];
  if (channel === undefined) {
    throw new Error("Channel list is empty.");
  }
  return channel;
}

/** Mounts a query observer (an observer count of 1, no fetch) — the "surface" in these tests. */
function observe(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  data?: unknown,
): { unsubscribe: () => void } {
  const observer = new QueryObserver(queryClient, {
    enabled: false,
    queryFn: async () => (data === undefined ? null : data),
    queryKey,
  });
  const unsubscribe = observer.subscribe(vi.fn());
  return { unsubscribe };
}

/** The invalidation queue flushes on a macrotask tick. */
const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** The query keys the spy's invalidateQueries was called with, in call order. */
function invalidatedKeys(invalidate: MockInstance): Array<readonly unknown[] | undefined> {
  return invalidate.mock.calls.map((call) => {
    const filters: unknown = call[0];
    if (typeof filters !== "object" || filters === null || !("queryKey" in filters)) {
      return undefined;
    }
    // Test files allow the assertion (the override in .oxlintrc.json); the
    // `queryKey`-in check above is the runtime guard.
    const record = filters as { queryKey: readonly unknown[] };
    return record.queryKey;
  });
}

/** Reads a query's status/fetchStatus without optional chaining. */
function stateIs(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  status: "error" | "pending" | "success",
  fetchStatus?: "fetching" | "idle" | "paused",
): boolean {
  const state = queryClient.getQueryState(queryKey);
  if (state === undefined) {
    return false;
  }
  if (state.status !== status) {
    return false;
  }
  return fetchStatus === undefined ? true : state.fetchStatus === fetchStatus;
}

// ---------------------------------------------------------------------------
// Row fixtures — raw realtime payload columns and the store shapes they map to.
// ---------------------------------------------------------------------------

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const D3 = "33333333-3333-4333-8333-333333333333";
const CREATOR = "99999999-9999-4999-8999-999999999999";
const CREATED_AT = "2026-11-04T00:00:00.000Z";

/**
 * The realtime payload of an `entries` row: the TABLE's own columns verbatim
 * (verified against the live broker in pg-realtime.int.test.ts) — including
 * the `search` tsvector and `updated_at`.
 */
function rawEntry(
  id: string,
  datasetId: string,
  geometryType: string | null,
): Record<string, unknown> {
  return {
    created_at: CREATED_AT,
    created_by: CREATOR,
    data: { kind: id },
    dataset_id: datasetId,
    geometry_type: geometryType,
    id,
    search: "'kind'",
    updated_at: CREATED_AT,
  };
}

function entryRow(
  id: string,
  datasetId: string,
  geometryType: DatasetGeometryType | null = null,
): EntryRow {
  return { createdAt: CREATED_AT, data: { kind: id }, datasetId, geometryType, id };
}

/**
 * The realtime payload of a `geometries` row: the TABLE's own columns
 * verbatim, captured live in pg-realtime.int.test.ts — including the
 * generated `geom` (WKB hex on the wire) and `updated_at`. Notably NO
 * `data`: that is `entries.data`, joined in by the §5.5 tiles RPC only,
 * which is why the tiles feed reconciles by invalidation, never a patch.
 */
function rawGeometry(entryId: string, datasetId: string): Record<string, unknown> {
  return {
    bbox: [0, 0, 1, 1],
    created_at: CREATED_AT,
    created_by: CREATOR,
    dataset_id: datasetId,
    entry_id: entryId,
    geom: "0101000020E610000000000000000000000000000000000000",
    id: `geom-${entryId}`,
    source: { coordinates: [0, 0], type: "Point" },
    source_bytes: 57,
    source_path: null,
    type: "Point",
    updated_at: CREATED_AT,
  };
}

/** The point-read cached shape (`getByEntry` — the queryFn selects no `data`). */
type GeometryGetRow = Omit<GeometryRow, "data">;

/** The cached shape `getByEntry` holds (inline Point with/without a bbox). */
function geometryGetRow(entryId: string, overrides: Partial<GeometryGetRow> = {}): GeometryGetRow {
  return {
    bbox: null,
    datasetId: D1,
    entryId,
    geometry: null,
    sourcePath: null,
    type: "Point",
    ...overrides,
  };
}

/** The cached shape the §5.5 tiles RPC holds (`GeometryRow` — `data` rides its JOIN). */
function geometryTilesRow(entryId: string, overrides: Partial<GeometryRow> = {}): GeometryRow {
  return {
    bbox: null,
    data: { kind: entryId },
    datasetId: D1,
    entryId,
    geometry: null,
    sourcePath: null,
    type: "Point",
    ...overrides,
  };
}

/** The point-read row a patched geometry UPDATE must produce (no `data`). */
const PATCHED_GET_ROW: GeometryGetRow = geometryGetRow("e1", {
  bbox: [0, 0, 1, 1],
  geometry: { coordinates: [0, 0], type: "Point" },
});

function rawDatasetRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    bbox: null,
    created_at: CREATED_AT,
    created_by: CREATOR,
    description: null,
    edit_policy: "open",
    entry_count: 3,
    feature_count: 3,
    geometry_type: null,
    group_id: null,
    id,
    is_geospatial: false,
    json_schema: { properties: { title: { type: "string" } }, title: "T" },
    lifecycle: "published",
    lineage: null,
    map_tile_archive_built_version: null,
    map_tile_archive_bytes: null,
    map_tile_archive_format: null,
    map_tile_archive_max_zoom: null,
    map_tile_archive_path: null,
    map_tile_cache_version: 7,
    max_geometry_row_bytes: null,
    properties: ["title"],
    published_visibility: "everyone",
    simplify_geometry: false,
    source: null,
    source_file_name: null,
    source_file_path: null,
    source_file_size: null,
    title: "T",
    updated_at: CREATED_AT,
    ...overrides,
  };
}

/** The full store row a patched datasets UPDATE must produce. */
function expectedDatasetRow(id: string, entryCount: number, cacheVersion: number): DatasetRow {
  return {
    bbox: null,
    createdAt: CREATED_AT,
    createdBy: CREATOR,
    description: null,
    editPolicy: "open",
    entryCount,
    featureCount: 3,
    geometryType: null,
    groupId: null,
    id,
    isGeospatial: false,
    jsonSchema: { properties: { title: { type: "string" } }, title: "T" },
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBytes: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileArchivePath: null,
    mapTileCacheVersion: cacheVersion,
    maxGeometryRowBytes: null,
    properties: ["title"],
    publishedVisibility: "everyone",
    simplifyGeometry: false,
    source: null,
    sourceFileName: null,
    sourceFilePath: null,
    sourceFileSize: null,
    title: "T",
    updatedAt: CREATED_AT,
  };
}

/** The summary projection of the same patched row (fieldCount from properties). */
function expectedDatasetSummary(
  id: string,
  entryCount: number,
  cacheVersion: number,
): DatasetSummaryRow {
  return {
    bbox: null,
    createdBy: CREATOR,
    createdAt: CREATED_AT,
    description: null,
    editPolicy: "open",
    entryCount,
    featureCount: 3,
    fieldCount: 1,
    geometryType: null,
    groupId: null,
    id,
    isGeospatial: false,
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileCacheVersion: cacheVersion,
    publishedVisibility: "everyone",
    source: null,
    title: "T",
  };
}

/** A page fixture matching the store's `{rows, nextCursor}` cache shape. */
function page<T>(
  rows: T[],
  nextCursor: string | null = null,
): { nextCursor: string | null; rows: T[] } {
  return { nextCursor, rows };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel lifecycle (one per active dataset, open on observe, closed on unmount)", () => {
  it("opens no channel until a pg query gains an observer", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    queryClient.setQueryData(entriesGetOptions({ entryId: "e1" }).queryKey, entryRow("e1", D1));
    expect(stub.channels.length).toBe(0);
    detach();
  });

  it("subscribes the full matrix with per-table dataset filters", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const { unsubscribe } = observe(queryClient, [
      "pg:entries",
      "listPage",
      { cursor: null, datasetId: D1, numItems: 50 },
    ]);
    const channel = onlyChannel(stub.channels);
    expect(channel.topic).toBe(datasetChannelTopic(D1));
    expect(channel.subscribed).toBe(true);
    expect(channel.filters.map((filter) => filter.table)).toStrictEqual(
      DATASET_CHANNEL_TABLES.map((entry) => entry.table),
    );
    for (let index = 0; index < DATASET_CHANNEL_TABLES.length; index += 1) {
      const entry = DATASET_CHANNEL_TABLES[index];
      const filter = channel.filters[index];
      if (entry === undefined || filter === undefined) {
        throw new Error(`Missing matrix entry/filter at index ${index}.`);
      }
      expect(filter.schema).toBe("public");
      expect(filter.event).toBe("*");
      expect(filter.filter).toBe(`${entry.filterColumn}=eq.${D1}`);
    }
    unsubscribe();
    detach();
  });

  it("shares one channel across observers of the same dataset and closes it on the last unmount", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const first = observe(queryClient, ["pg:entries", "searchEntries", { datasetId: D1 }]);
    const second = observe(queryClient, [
      "pg:geometries",
      "rowsForTiles",
      { cursor: null, datasetId: D1 },
    ]);
    expect(stub.channels.length).toBe(1);
    first.unsubscribe();
    expect(stub.channels.length).toBe(1);
    second.unsubscribe();
    expect(stub.channels.length).toBe(0);
    expect(stub.removedTopics).toStrictEqual([datasetChannelTopic(D1)]);
    detach();
  });

  it("activates from an entry-details row's cached datasetId (no dataset-scoped key needed)", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const key = entriesGetOptions({ entryId: "e7" }).queryKey;
    queryClient.setQueryData(key, entryRow("e7", D2));
    const { unsubscribe } = observe(queryClient, key);
    const channel = onlyChannel(stub.channels);
    expect(channel.topic).toBe(datasetChannelTopic(D2));
    unsubscribe();
    expect(stub.channels.length).toBe(0);
    detach();
  });

  it("activates from listForIds' cached rows", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const key = listForIdsQueryOptions({ entryIds: ["e1", "e2"] }).queryKey;
    queryClient.setQueryData(key, [entryRow("e1", D3)]);
    const { unsubscribe } = observe(queryClient, key);
    onlyChannel(stub.channels);
    expect(stub.removedTopics.length).toBe(0);
    unsubscribe();
    expect(stub.removedTopics).toStrictEqual([datasetChannelTopic(D3)]);
    detach();
  });

  it("never activates from the catalog summary projections (no app-wide subscription)", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const summaries = [
      { createdBy: "u1", entryCount: 1, fieldCount: 1, id: D1, mapTileCacheVersion: 1, title: "T" },
    ];
    const { unsubscribe } = observe(queryClient, listSummariesQueryOptions().queryKey, summaries);
    expect(stub.channels.length).toBe(0);
    unsubscribe();
    detach();
  });

  it("activates from version-chain and import queries (their keys name the dataset)", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const first = observe(queryClient, listVersionsQueryOptions({ datasetId: D1 }).queryKey);
    expect(stub.channels.length).toBe(1);
    first.unsubscribe();
    const second = observe(queryClient, headOfChainQueryOptions({ datasetId: D1 }).queryKey);
    expect(stub.channels.length).toBe(1);
    second.unsubscribe();
    const third = observe(queryClient, ["pg:imports", "listForDataset", { datasetId: D1 }]);
    expect(stub.channels.length).toBe(1);
    third.unsubscribe();
    expect(stub.channels.length).toBe(0);
    detach();
  });

  it("ignores queries outside the pg namespaces", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const { unsubscribe } = observe(queryClient, ["convexQuery", "cms/entries:list", "{}"]);
    expect(stub.channels.length).toBe(0);
    unsubscribe();
    detach();
  });

  it("re-joins every open channel after a sign-in (the pre-auth join rode the anon identity)", () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const { unsubscribe } = observe(queryClient, [
      "pg:entries",
      "searchEntries",
      { datasetId: D1 },
    ]);
    expect(stub.channels.length).toBe(1);
    const listener = stub.authListeners[stub.authListeners.length - 1];
    if (listener === undefined) {
      throw new Error("No auth listener registered.");
    }
    listener("TOKEN_REFRESHED");
    expect(stub.channels.length).toBe(1);
    expect(stub.removedTopics.length).toBe(0);
    listener("SIGNED_IN");
    expect(stub.removedTopics).toStrictEqual([datasetChannelTopic(D1)]);
    const rejoined = onlyChannel(stub.channels);
    expect(rejoined.topic).toBe(datasetChannelTopic(D1));
    expect(rejoined.subscribed).toBe(true);
    unsubscribe();
    detach();
  });

  it("detach closes channels, unsubscribes auth, flushes pending invalidations, and stops reconciling", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const { unsubscribe } = observe(queryClient, [
      "pg:entries",
      "searchEntries",
      { datasetId: D1 },
    ]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    onlyChannel(stub.channels).deliver("entries", {
      eventType: "INSERT",
      new: rawEntry("e9", D1, null),
    });
    expect(invalidate).not.toHaveBeenCalled();
    unsubscribe();
    detach();
    expect(stub.removedTopics).toStrictEqual([datasetChannelTopic(D1)]);
    expect(stub.authUnsubscribeCount()).toBe(1);
    expect(invalidate).toHaveBeenCalled();
    observe(queryClient, ["pg:entries", "listPage", { cursor: null, datasetId: D1, numItems: 50 }]);
    expect(stub.channels.length).toBe(0);
  });
});

describe("entries events (dataset table rows + entry details)", () => {
  it("patches an UPDATE in place across get/listPage/searchEntries/listForIds caches", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const get = entriesGetOptions({ entryId: "e1" }).queryKey;
    const search = searchEntriesQueryOptions({ datasetId: D1 }).queryKey;
    const listPage = listPageQueryOptions({ datasetId: D1, cursor: null, numItems: 50 }).queryKey;
    const forIds = listForIdsQueryOptions({ entryIds: ["e1", "e2"] }).queryKey;
    queryClient.setQueryData(get, entryRow("e1", D1));
    queryClient.setQueryData(search, page([entryRow("e2", D1), entryRow("e1", D1)]));
    queryClient.setQueryData(listPage, page([entryRow("e1", D1)], "cursor-1"));
    queryClient.setQueryData(forIds, [entryRow("e1", D1), entryRow("e2", D1)]);
    observe(queryClient, search);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("entries", {
      eventType: "UPDATE",
      new: rawEntry("e1", D1, "Point"),
      old: { id: "e1" },
    });

    expect(queryClient.getQueryData(get)).toStrictEqual(entryRow("e1", D1, "Point"));
    expect(queryClient.getQueryData(search)).toStrictEqual(
      page([entryRow("e2", D1), entryRow("e1", D1, "Point")]),
    );
    expect(queryClient.getQueryData(listPage)).toStrictEqual(
      page([entryRow("e1", D1, "Point")], "cursor-1"),
    );
    expect(queryClient.getQueryData(forIds)).toStrictEqual([
      entryRow("e1", D1, "Point"),
      entryRow("e2", D1),
    ]);
    await tick();
    // The update also reconciles the sorted/filtered table (the patch pinned
    // the row's VALUE; its position under the active sort is the RPC's answer).
    expect(invalidatedKeys(invalidate)).toStrictEqual([
      ["pg:entries", "searchEntries", { datasetId: D1 }],
    ]);
    detach();
  });

  it("coalesces an INSERT burst into one invalidation per owning key and patches nothing", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const search = searchEntriesQueryOptions({ datasetId: D1 }).queryKey;
    queryClient.setQueryData(search, page([entryRow("e2", D1)]));
    observe(queryClient, search);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const channel = onlyChannel(stub.channels);
    channel.deliver("entries", { eventType: "INSERT", new: rawEntry("e3", D1, null), old: {} });
    channel.deliver("entries", { eventType: "INSERT", new: rawEntry("e4", D1, null), old: {} });
    channel.deliver("entries", { eventType: "INSERT", new: rawEntry("e5", D1, null), old: {} });
    // Before the tick nothing has fired; after it, one refetch per key (the
    // three inserts collapsed), and the cached page was never hand-edited.
    expect(queryClient.getQueryData(search)).toStrictEqual(page([entryRow("e2", D1)]));
    expect(invalidate).not.toHaveBeenCalled();
    await tick();
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidatedKeys(invalidate)).toContainEqual([
      "pg:entries",
      "listPage",
      { datasetId: D1 },
    ]);
    expect(invalidatedKeys(invalidate)).toContainEqual([
      "pg:entries",
      "searchEntries",
      { datasetId: D1 },
    ]);
    expect(invalidatedKeys(invalidate)).toContainEqual(["pg:entries", "listForIds"]);
    await tick();
    detach();
  });

  it("patches a DELETE out of the caches and repairs the page via invalidation", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const get = entriesGetOptions({ entryId: "e1" }).queryKey;
    const listPage = listPageQueryOptions({ datasetId: D1, cursor: null, numItems: 50 }).queryKey;
    queryClient.setQueryData(get, entryRow("e1", D1));
    queryClient.setQueryData(listPage, page([entryRow("e2", D1), entryRow("e1", D1)]));
    observe(queryClient, listPage);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("entries", {
      eventType: "DELETE",
      new: {},
      old: { id: "e1" },
    });

    expect(queryClient.getQueryData(get)).toBe(null);
    expect(queryClient.getQueryData(listPage)).toStrictEqual(page([entryRow("e2", D1)]));
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:entries", "listPage", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:entries", "searchEntries", { datasetId: D1 }]);
    detach();
  });

  it("ignores malformed payloads (unknown event kind, non-object row)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const get = entriesGetOptions({ entryId: "e1" }).queryKey;
    queryClient.setQueryData(get, entryRow("e1", D1));
    observe(queryClient, get);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);
    channel.deliver("entries", { eventType: "TRUNCATE" });
    channel.deliver("entries", { eventType: "UPDATE", new: "not-a-row", old: { id: "e1" } });
    expect(queryClient.getQueryData(get)).toStrictEqual(entryRow("e1", D1));
    await tick();
    expect(invalidate).not.toHaveBeenCalled();
    detach();
  });
});

describe("geometries events (entry geometry + maps layer data)", () => {
  it("patches an UPDATE into getByEntry only (shape the queryFn caches), leaving the tiles pages to the invalidation", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const getByEntry = getByEntryQueryOptions({ entryId: "e1" }).queryKey;
    const tiles = rowsForTilesQueryOptions({ cursor: null, datasetId: D1 }).queryKey;
    // See the INSERT/DELETE test's seed note: the runtime cached shape omits `data`.
    queryClient.setQueryData(
      getByEntry,
      geometryGetRow("e1", { sourcePath: "d1/row-1.json" }) as unknown as GeometryRow,
    );
    queryClient.setQueryData<GeometryRowsPage>(tiles, page([geometryTilesRow("e1")]));
    observe(queryClient, tiles);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("geometries", {
      eventType: "UPDATE",
      new: rawGeometry("e1", D1),
      old: { id: "geom-e1" },
    });

    // The point read patched in place — and BYTE-IDENTICAL to the queryFn's
    // cached shape: no `data` prop (the payload cannot carry it, and the
    // queryFn never selects it).
    expect(queryClient.getQueryData(getByEntry)).toStrictEqual(PATCHED_GET_ROW);
    // The tiles pages were NOT hand-patched: their rows carry `data` (the
    // §5.5 RPC's JOIN column), which no `geometries` payload can supply — a
    // patch would have zeroed it (the corrupt window the review caught).
    // Byte-identical before the coalesced invalidation fires.
    expect(queryClient.getQueryData(tiles)).toStrictEqual(page([geometryTilesRow("e1")]));
    await tick();
    expect(invalidatedKeys(invalidate)).toStrictEqual([
      ["pg:geometries", "rowsForTiles", { datasetId: D1 }],
    ]);
    detach();
  });

  it("invalidates on INSERT (exact getByEntry) and on DELETE (broad — the payload names no entry)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const getByEntry = getByEntryQueryOptions({ entryId: "e1" }).queryKey;
    const tiles = rowsForTilesQueryOptions({ cursor: null, datasetId: D1 }).queryKey;
    // Test files allow the assertion (the override in .oxlintrc.json): the
    // runtime cached shape omits `data` although the store's getByEntry
    // return TYPE still claims a full GeometryRow — this seed mirrors the
    // runtime shape, which is the one realtime must patch byte-identically.
    queryClient.setQueryData(getByEntry, geometryGetRow("e1") as unknown as GeometryRow);
    observe(queryClient, tiles);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("geometries", { eventType: "INSERT", new: rawGeometry("e1", D1), old: {} });
    await tick();
    let keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:geometries", "getByEntry", { entryId: "e1" }]);
    expect(keys).toContainEqual(["pg:geometries", "rowsForTiles", { datasetId: D1 }]);

    channel.deliver("geometries", { eventType: "DELETE", new: {}, old: { id: "geom-uuid" } });
    await tick();
    keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:geometries", "getByEntry"]);
    expect(keys).toContainEqual(["pg:geometries", "rowsForTiles", { datasetId: D1 }]);
    detach();
  });
});

describe("datasets events (catalog summaries + the tile live signal)", () => {
  it("patches an UPDATE into get and the summary projections, then invalidates for summaries", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const get = datasetsGetOptions({ datasetId: D1 }).queryKey;
    const summaries = listSummariesQueryOptions().queryKey;
    const drafts = listDraftSummariesQueryOptions().queryKey;
    const all = datasetsListOptions().queryKey;
    queryClient.setQueryData(get, expectedDatasetRow(D1, 3, 7));
    queryClient.setQueryData(summaries, [expectedDatasetSummary(D1, 3, 7)]);
    // The draft list holds the dataset too (a lifecycle flip moves it BETWEEN
    // lists — the invalidate side handles that); `drafts` starts empty to
    // prove the patch introduces nothing.
    queryClient.setQueryData(drafts, page([]).rows);
    queryClient.setQueryData(all, [expectedDatasetRow(D1, 3, 7)]);
    // The channel comes from the dataset page's own get query (the catalog
    // summaries never activate anything — see the app-wide-subscription ban).
    observe(queryClient, get);
    observe(queryClient, summaries);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("datasets", {
      eventType: "UPDATE",
      new: rawDatasetRow(D1, { entry_count: 12, map_tile_cache_version: 9 }),
      old: { id: D1 },
    });

    // The full row patched in place …
    expect(queryClient.getQueryData(get)).toStrictEqual(expectedDatasetRow(D1, 12, 9));
    expect(queryClient.getQueryData(all)).toStrictEqual([expectedDatasetRow(D1, 12, 9)]);
    // … the summary projections patched in place (fieldCount derived from
    // properties, per the store's projection rule) …
    expect(queryClient.getQueryData(summaries)).toStrictEqual([expectedDatasetSummary(D1, 12, 9)]);
    // … and the empty draft list was NOT handed a row (patches never introduce).
    expect(queryClient.getQueryData(drafts)).toStrictEqual([]);
    // … and the design doc's "invalidate for summaries" reconciles the lists
    // plus the tile live signal (a lifecycle flip moves rows BETWEEN lists —
    // a patch can't express that).
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:datasets", "list"]);
    expect(keys).toContainEqual(["pg:datasets", "listSummaries"]);
    expect(keys).toContainEqual(["pg:datasets", "listDraftSummaries"]);
    expect(keys).toContainEqual(["pg:datasets", "listByCreator", { createdBy: CREATOR }]);
    expect(keys).toContainEqual(["pg:datasets", "maxTileCacheVersion"]);
    expect(keys).toContainEqual(["pg:tile-archives", "metas"]);
    expect(keys).toContainEqual(["pg:datasets", "getSourceFileUrl", { datasetId: D1 }]);
    detach();
  });

  it("invalidates the catalog families on INSERT without introducing rows", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const summaries = listSummariesQueryOptions().queryKey;
    queryClient.setQueryData(summaries, page([]).rows);
    // The channel rides the dataset page's get query; the summaries alone
    // never activate anything.
    observe(queryClient, datasetsGetOptions({ datasetId: D1 }).queryKey);
    observe(queryClient, summaries);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("datasets", {
      eventType: "INSERT",
      new: rawDatasetRow("44444444-4444-4444-8444-444444444444"),
      old: {},
    });

    expect(queryClient.getQueryData(summaries)).toStrictEqual([]);
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:datasets", "list"]);
    expect(keys).toContainEqual(["pg:datasets", "listSummaries"]);
    expect(keys).toContainEqual(["pg:datasets", "listDraftSummaries"]);
    expect(keys).toContainEqual(["pg:datasets", "listByCreator", { createdBy: CREATOR }]);
    expect(keys).toContainEqual(["pg:datasets", "maxTileCacheVersion"]);
    detach();
  });

  it("clears the caches and cascades on DELETE", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, datasetsGetOptions({ datasetId: D1 }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    onlyChannel(stub.channels).deliver("datasets", {
      eventType: "DELETE",
      new: {},
      old: { id: D1 },
    });

    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:datasets", "maxTileCacheVersion"]);
    expect(keys).toContainEqual(["pg:tile-archives", "metas"]);
    expect(keys).toContainEqual(["pg:versions", "list", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:versions", "head", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:tags", "list", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:collections", "listCollectionsByDataset", { datasetId: D1 }]);
    detach();
  });
});

describe("versions / tags / catalog / maps events (invalidate-only surfaces)", () => {
  it("invalidates the version chain on INSERT and the specific frozen rows on DELETE", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, listVersionsQueryOptions({ datasetId: D1 }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("dataset_versions", {
      eventType: "INSERT",
      new: { created_at: CREATED_AT, dataset_id: D1, id: "v1", ref: "v1" },
      old: {},
    });
    await tick();
    let keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:versions", "list", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:versions", "head", { datasetId: D1 }]);
    expect(keys).not.toContainEqual(["pg:versions", "get", { versionId: "v1" }]);

    channel.deliver("dataset_versions", { eventType: "DELETE", new: {}, old: { id: "v1" } });
    await tick();
    keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:versions", "get", { versionId: "v1" }]);
    expect(keys).toContainEqual(["pg:versions", "versionEntries", { versionId: "v1" }]);
    detach();
  });

  it("invalidates the dataset's tag list and the tag get on retire", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, tagsListOptions({ datasetId: D1 }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("tags", {
      eventType: "UPDATE",
      new: { dataset_id: D1, id: "tag-1", retired_at: CREATED_AT },
      old: { id: "tag-1" },
    });
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:tags", "list", { datasetId: D1 }]);
    expect(keys).toContainEqual(["pg:tags", "get", { tagId: "tag-1" }]);
    detach();
  });

  it("invalidates consumption edges — source side exact, consumer side from the row image (#222)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, consumedByQueryOptions({ sourceDatasetId: D1 }).queryKey);
    observe(queryClient, listConsumerReferencesQueryOptions({ consumerId: "derived-1" }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("consumer_references", {
      eventType: "INSERT",
      new: { consumer_id: "derived-1", id: "ref-1", mode: "float", source_dataset_id: D1 },
      old: {},
    });
    await tick();
    let keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:versions", "consumedBy", { sourceDatasetId: D1 }]);
    expect(keys).toContainEqual(["pg:versions", "consumerReferences", { consumerId: "derived-1" }]);

    // DELETE carries the PK only (default replica identity): the source-side
    // key stays exact, the consumer-side key is not nameable.
    invalidate.mockClear();
    channel.deliver("consumer_references", {
      eventType: "DELETE",
      new: {},
      old: { id: "ref-1" },
    });
    await tick();
    keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:versions", "consumedBy", { sourceDatasetId: D1 }]);
    expect(keys).not.toContainEqual([
      "pg:versions",
      "consumerReferences",
      { consumerId: "derived-1" },
    ]);
    detach();
  });

  it("invalidates the retention policy on version_policies edits (#222)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, retentionPolicyQueryOptions({ datasetKey: D1 }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("version_policies", {
      eventType: "UPDATE",
      new: { dataset_key: D1, keep_versions: 3, pinned_refs: ["v2"] },
      old: { dataset_key: D1 },
    });
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:versions", "retentionPolicy", { datasetKey: D1 }]);
    detach();
  });

  it("invalidates collection membership keys on both sides of a membership change", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, listCollectionsByDatasetQueryOptions({ datasetId: D1 }).queryKey);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("collection_datasets", {
      eventType: "INSERT",
      new: { collection_id: "c1", dataset_id: D1, kind: "standard" },
      old: {},
    });
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:collections", "list"]);
    expect(keys).toContainEqual(["pg:collections", "listMemberships"]);
    expect(keys).toContainEqual(["pg:collections", "listDatasets", { collectionId: "c1" }]);
    expect(keys).toContainEqual(["pg:collections", "listCollectionsByDataset", { datasetId: D1 }]);
    detach();
  });

  it("invalidates map-layer keys scoped by map_id, falling back broadly on DELETE", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    // The channel rides the dataset's layer-data query (a map workspace's
    // layer rows keep its dataset active — pg-entries-loader's listPage keys).
    observe(queryClient, ["pg:geometries", "rowsForTiles", { cursor: null, datasetId: D1 }]);
    observe(queryClient, ["pg:maps", "listPlacements", { mapId: "m1" }]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    // The 0020 placement shape: layer_member_id names the layer membership.
    channel.deliver("map_layers", {
      eventType: "UPDATE",
      new: {
        id: "placement-1",
        layer_member_id: "mem-1",
        map_id: "m1",
        order: 1,
        visible: true,
      },
      old: { id: "placement-1" },
    });
    await tick();
    let keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:maps", "listAllPlacements"]);
    expect(keys).toContainEqual(["pg:maps", "listPlacements", { mapId: "m1" }]);

    channel.deliver("map_layers", { eventType: "DELETE", new: {}, old: { id: "placement-1" } });
    await tick();
    keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:maps", "listPlacements"]);
    detach();
  });

  it("invalidates the layers keys broadly (project-scoped tables — no dataset filter matches)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    observe(queryClient, ["pg:geometries", "rowsForTiles", { cursor: null, datasetId: D1 }]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const channel = onlyChannel(stub.channels);

    channel.deliver("layers", {
      eventType: "UPDATE",
      new: { id: "layer-row-1", name: "Parks", project_id: "p1", style: {}, visible: true },
      old: { id: "layer-row-1" },
    });
    channel.deliver("layer_children", {
      eventType: "INSERT",
      new: {
        child_kind: "owned",
        child_layer_id: "l2",
        group_id: "layer-row-1",
        id: "c1",
        order: 0,
      },
      old: null,
    });
    await tick();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(["pg:layers"]);
    detach();
  });
});

describe("completeness semantics (ui-polish-expectations survive realtime)", () => {
  it("a patch replaces rows without flipping a loaded surface into loading", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const search = searchEntriesQueryOptions({ datasetId: D1 }).queryKey;
    const observer = new QueryObserver(queryClient, {
      queryFn: async () => page([entryRow("e1", D1)]),
      queryKey: search,
    });
    const unsubscribe = observer.subscribe(vi.fn());
    await tick();
    await tick();
    expect(stateIs(queryClient, search, "success", "idle")).toBe(true);

    onlyChannel(stub.channels).deliver("entries", {
      eventType: "UPDATE",
      new: rawEntry("e1", D1, "Point"),
      old: { id: "e1" },
    });

    // The patch landed instantly, and nothing re-fetched for it.
    expect(stateIs(queryClient, search, "success", "idle")).toBe(true);
    expect(queryClient.getQueryData(search)).toStrictEqual(page([entryRow("e1", D1, "Point")]));
    unsubscribe();
    detach();
  });

  it("an INSERT invalidation refetches in place (status success, no loading gate)", async () => {
    const queryClient = newClient();
    const stub = stubRealtimeClient();
    const detach = attachDatasetRealtime(queryClient, stub.client);
    const search = searchEntriesQueryOptions({ datasetId: D1 }).queryKey;
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryFn: async () => {
        fetches += 1;
        return page([entryRow("e1", D1)]);
      },
      queryKey: search,
    });
    const unsubscribe = observer.subscribe(vi.fn());
    await tick();
    await tick();
    expect(fetches).toBe(1);

    onlyChannel(stub.channels).deliver("entries", {
      eventType: "INSERT",
      new: rawEntry("e2", D1, null),
      old: {},
    });

    // The coalescer hasn't fired yet; the surface still reads loaded.
    expect(stateIs(queryClient, search, "success", "idle")).toBe(true);
    await tick();
    // The reconcile refetch runs IN PLACE: status stays success while fetching
    // (the loading chips' completeness gate is never touched).
    expect(stateIs(queryClient, search, "success")).toBe(true);
    await tick();
    await tick();
    expect(fetches).toBe(2);
    expect(stateIs(queryClient, search, "success", "idle")).toBe(true);
    unsubscribe();
    detach();
  });
});

describe("matcher mirror (invalidation matchers find the store modules' queries)", () => {
  it("dataset-scoped matchers find listPage/searchEntries queries for exactly that dataset", () => {
    const queryClient = new QueryClient();
    const other = "55555555-5555-4555-8555-555555555555";
    queryClient.setQueryData(
      listPageQueryOptions({ datasetId: D1, cursor: null, numItems: 50 }).queryKey,
      page([]),
    );
    queryClient.setQueryData(searchEntriesQueryOptions({ datasetId: D1 }).queryKey, page([]));
    queryClient.setQueryData(
      listPageQueryOptions({ datasetId: other, cursor: null, numItems: 50 }).queryKey,
      page([]),
    );
    const found = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["pg:entries", "listPage", { datasetId: D1 }] })
      .map((query) => query.queryKey);
    expect(found).toStrictEqual([
      listPageQueryOptions({ datasetId: D1, cursor: null, numItems: 50 }).queryKey,
    ]);
    const foundSearch = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["pg:entries", "searchEntries", { datasetId: D1 }] })
      .map((query) => query.queryKey);
    expect(foundSearch).toStrictEqual([searchEntriesQueryOptions({ datasetId: D1 }).queryKey]);
  });

  it("the store modules' key shapes this layer patches/matches are pinned", () => {
    expect(entriesGetOptions({ entryId: "e1" }).queryKey).toStrictEqual([
      "pg:entries",
      "get",
      { entryId: "e1" },
    ]);
    expect(listForIdsQueryOptions({ entryIds: ["e1"] }).queryKey).toStrictEqual([
      "pg:entries",
      "listForIds",
      { entryIds: ["e1"] },
    ]);
    expect(getByEntryQueryOptions({ entryId: "e1" }).queryKey).toStrictEqual([
      "pg:geometries",
      "getByEntry",
      { entryId: "e1" },
    ]);
    expect(rowsForTilesQueryOptions({ cursor: null, datasetId: D1 }).queryKey).toStrictEqual([
      "pg:geometries",
      "rowsForTiles",
      { cursor: null, datasetId: D1 },
    ]);
    expect(datasetsGetOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:datasets",
      "get",
      { datasetId: D1 },
    ]);
    expect(datasetsListOptions().queryKey).toStrictEqual(["pg:datasets", "list", 1000]);
    expect(listSummariesQueryOptions().queryKey).toStrictEqual([
      "pg:datasets",
      "listSummaries",
      1000,
    ]);
    expect(listDraftSummariesQueryOptions().queryKey).toStrictEqual([
      "pg:datasets",
      "listDraftSummaries",
      1000,
    ]);
    expect(listByCreatorQueryOptions({ createdBy: "u1" }).queryKey).toStrictEqual([
      "pg:datasets",
      "listByCreator",
      { createdBy: "u1" },
    ]);
    expect(getSourceFileUrlQueryOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:datasets",
      "getSourceFileUrl",
      { datasetId: D1 },
    ]);
    expect(maxTileCacheVersionQueryOptions().queryKey).toStrictEqual([
      "pg:datasets",
      "maxTileCacheVersion",
    ]);
    expect(listVersionsQueryOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:versions",
      "list",
      { datasetId: D1 },
    ]);
    expect(versionsGetOptions({ versionId: "v1" }).queryKey).toStrictEqual([
      "pg:versions",
      "get",
      { versionId: "v1" },
    ]);
    expect(headOfChainQueryOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:versions",
      "head",
      { datasetId: D1 },
    ]);
    expect(versionEntriesQueryOptions({ versionId: "v1" }).queryKey).toStrictEqual([
      "pg:versions",
      "versionEntries",
      { versionId: "v1" },
    ]);
    expect(tagsListOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:tags",
      "list",
      { datasetId: D1 },
    ]);
    expect(tagsGetOptions({ tagId: "t1" }).queryKey).toStrictEqual([
      "pg:tags",
      "get",
      { tagId: "t1" },
    ]);
    expect(collectionsListOptions().queryKey).toStrictEqual(["pg:collections", "list"]);
    expect(collectionsGetOptions({ collectionId: "c1" }).queryKey).toStrictEqual([
      "pg:collections",
      "get",
      { collectionId: "c1" },
    ]);
    expect(listDatasetsQueryOptions({ collectionId: "c1" }).queryKey).toStrictEqual([
      "pg:collections",
      "listDatasets",
      { collectionId: "c1" },
    ]);
    expect(listMembershipsQueryOptions().queryKey).toStrictEqual([
      "pg:collections",
      "listMemberships",
    ]);
    expect(listCollectionsByDatasetQueryOptions({ datasetId: D1 }).queryKey).toStrictEqual([
      "pg:collections",
      "listCollectionsByDataset",
      { datasetId: D1 },
    ]);
    expect(mapsGetOptions({ mapId: "m1" }).queryKey).toStrictEqual([
      "pg:maps",
      "get",
      { mapId: "m1" },
    ]);
    expect(listAllPlacementsQueryOptions().queryKey).toStrictEqual([
      "pg:maps",
      "listAllPlacements",
    ]);
    expect(listPlacementsQueryOptions({ mapId: "m1" }).queryKey).toStrictEqual([
      "pg:maps",
      "listPlacements",
      { mapId: "m1" },
    ]);
  });
});
