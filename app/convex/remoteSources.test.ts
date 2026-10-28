// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Remote bound sources (#78, docs/remote-source-adapter-design.md): the
 * manifest check, the user-initiated Sync through the shared engine, and the
 * revision-based staleness — driven through `api.remoteSources.*` against a
 * stubbed `fetch` that serves the demo/deploy-source contract from memory.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const BASE_URL = "http://deploy-source.test/api/v1";
const SECRET = "test-secret";
const SOURCE = "deployments.routes";

interface FakeFeature {
  geometry: { coordinates: unknown; type: string } | null;
  id: string;
  properties: Record<string, unknown>;
  type: "Feature";
}

/** The foreign app's state, mutated by tests between syncs. */
interface FakeRemote {
  failNext: number;
  features: FakeFeature[];
  malformedNext: number;
  requests: string[];
  revision: number;
  schemaVersion: string;
}

function route(id: string, name: string): FakeFeature {
  return {
    geometry: {
      coordinates: [
        [
          [-122, 37],
          [-122.1, 37.1],
        ],
      ],
      type: "MultiLineString",
    },
    id,
    properties: { deploymentId: id, name, status: "live" },
    type: "Feature",
  };
}

function manifestBody(remote: FakeRemote) {
  return {
    apiVersion: 1,
    layers: [
      {
        description: "Secondary routes.",
        featureCount: remote.features.length,
        geometryType: "MultiLineString",
        key: "routes",
        revision: remote.revision,
        schema: {
          properties: { deploymentId: { type: "string" }, name: { type: "string" } },
          type: "object",
        },
        schemaVersion: remote.schemaVersion,
        title: "Deployment routes",
      },
    ],
    recordUrlTemplate: "http://deploy-source.test/deployments/{key}",
    title: "Deployments",
  };
}

/** Keyset-free paging by offset: enough to exercise the multi-page drain. */
function rowsBody(remote: FakeRemote, url: URL) {
  const limit = 2;
  const offset = Number(url.searchParams.get("cursor") ?? "0");
  const next = offset + limit;
  return {
    cursor: next < remote.features.length ? String(next) : null,
    features: remote.features.slice(offset, next),
    layer: "routes",
    revision: remote.revision,
    type: "FeatureCollection",
  };
}

function respond(remote: FakeRemote, url: URL): Response {
  if (remote.failNext > 0) {
    remote.failNext -= 1;
    return Response.json({ error: "injected" }, { status: 503 });
  }
  if (remote.malformedNext > 0) {
    remote.malformedNext -= 1;
    return new Response('{"type":"FeatureCollection","features":[{', {
      headers: { "content-type": "application/json" },
    });
  }
  if (url.pathname.endsWith("/manifest")) {
    return Response.json(manifestBody(remote));
  }
  if (url.pathname.endsWith("/layers/routes/rows")) {
    return Response.json(rowsBody(remote, url));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function stubRemote(remote: FakeRemote): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    remote.requests.push(url.pathname);
    const headers = new Headers(init === undefined ? undefined : init.headers);
    if (headers.get("authorization") !== `Bearer ${SECRET}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return respond(remote, url);
  });
}

function newRemote(): FakeRemote {
  return {
    failNext: 0,
    features: [route("dep_1", "one"), route("dep_2", "two"), route("dep_3", "three")],
    malformedNext: 0,
    requests: [],
    revision: 7,
    schemaVersion: "1",
  };
}

function signedIn() {
  const t = convexTest(schema, modules);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the sync.test.ts precedent: register takes the component-generic TestConvex shape.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t.withIdentity({ subject: "user-1" });
}

type TestConvex = ReturnType<typeof signedIn>;

async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

async function syncNow(t: TestConvex): Promise<void> {
  await t.action(api.remoteSources.sync, { source: SOURCE });
  await drainScheduled(t);
}

async function statusOf(t: TestConvex) {
  const status = await t.query(api.remoteSources.status, { source: SOURCE });
  if (status === null) {
    throw new Error("remote status is missing");
  }
  return status;
}

async function projectedKeys(t: TestConvex): Promise<string[]> {
  const status = await statusOf(t);
  if (status.bindingId === undefined) {
    return [];
  }
  const rows = await t.query(api.sync.commitFeatureMap, { bindingId: status.bindingId });
  // oxlint-disable-next-line unicorn/no-array-sort -- a throwaway copy; the lib target lacks toSorted (sources.test.ts precedent).
  return rows.map((row) => row.entryKey).sort((a, b) => a.localeCompare(b));
}

let remote: FakeRemote;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("REMOTE_SOURCE_DEPLOYMENTS_URL", BASE_URL);
  vi.stubEnv("REMOTE_SOURCE_DEPLOYMENTS_SECRET", SECRET);
  remote = newRemote();
  stubRemote(remote);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("remote sync", () => {
  it("creates the dataset from the manifest and drains every page", async () => {
    const t = signedIn();
    await syncNow(t);

    expect(await projectedKeys(t)).toStrictEqual(["dep_1", "dep_2", "dep_3"]);
    const status = await statusOf(t);
    expect(status.syncedRevision).toBe(7);
    expect(status.syncedSchemaVersion).toBe("1");
    expect(status.outOfDate).toBe(false);
    expect(status.syncedEntryCount).toBe(3);
    // Three features at two per page: the cursor drained across two pages.
    expect(remote.requests.filter((path) => path.endsWith("/rows"))).toHaveLength(2);

    const schemaId = status.schemaId;
    if (schemaId === undefined) {
      throw new Error("no dataset was created");
    }
    const dataset = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.schemas.getSchema, { schemaId }),
    );
    expect(dataset === null ? undefined : dataset.title).toBe("Deployment routes");
    expect(dataset === null ? undefined : dataset.geometryType).toBe("MultiLineString");
    expect(dataset === null ? undefined : dataset.source).toStrictEqual({ name: SOURCE });
  });

  it("mirrors remote deletes and edits on the next sync", async () => {
    const t = signedIn();
    await syncNow(t);

    remote.features = [route("dep_1", "renamed"), route("dep_4", "four")];
    remote.revision = 9;
    await syncNow(t);

    expect(await projectedKeys(t)).toStrictEqual(["dep_1", "dep_4"]);
    const run = await t.query(api.sync.latestRun, { source: SOURCE });
    expect(run === null ? undefined : [run.added, run.updated, run.removed]).toStrictEqual([
      1, 1, 2,
    ]);
    expect((await statusOf(t)).syncedRevision).toBe(9);
  });

  it("refuses the local-source mutation path", async () => {
    const t = signedIn();
    await expect(t.mutation(api.sync.startRun, { mode: "sync", source: SOURCE })).rejects.toThrow(
      /remoteSources\.sync/,
    );
  });
});

describe("staleness", () => {
  it("flags a newer remote revision as out of date, on the binding too", async () => {
    const t = signedIn();
    await syncNow(t);

    await t.action(api.remoteSources.check, { source: SOURCE });
    expect((await statusOf(t)).outOfDate).toBe(false);

    remote.revision = 8;
    // Fake timers freeze the clock; real checks land after the sync's stamp.
    vi.advanceTimersByTime(1000);
    await t.action(api.remoteSources.check, { source: SOURCE });
    const status = await statusOf(t);
    expect(status.outOfDate).toBe(true);
    expect(status.latest === undefined ? undefined : status.latest.revision).toBe(8);

    // The shared staleness stamp drives the existing "Out of date" badges.
    const binding = await t.query(api.bindings.getBySchema, { schemaId: status.schemaId ?? "" });
    expect(binding === null ? undefined : binding.sourceUpdatedAt).toBeGreaterThan(
      binding === null ? 0 : (binding.lastSyncedAt ?? 0),
    );

    await syncNow(t);
    expect((await statusOf(t)).outOfDate).toBe(false);
  });

  it("reports a never-synced source as out of date", async () => {
    const t = signedIn();
    await t.action(api.remoteSources.check, { source: SOURCE });
    const status = await statusOf(t);
    expect(status.outOfDate).toBe(true);
    expect(status.syncedRevision).toBeUndefined();
    expect(status.title).toBe("Deployment routes");
  });

  it("blocks Sync when the remote schema version changed", async () => {
    const t = signedIn();
    await syncNow(t);
    remote.schemaVersion = "2";
    await expect(t.action(api.remoteSources.sync, { source: SOURCE })).rejects.toThrow(
      /schema changed/,
    );
    expect((await statusOf(t)).schemaChanged).toBe(true);
  });
});

describe("transport failures", () => {
  it("retries a 503 and then succeeds", async () => {
    const t = signedIn();
    await t.action(api.remoteSources.sync, { source: SOURCE });
    // The collect's first two page reads fail; its backoff runs on the
    // drained fake timers.
    remote.failNext = 2;
    await drainScheduled(t);
    expect(await projectedKeys(t)).toHaveLength(3);
    expect(remote.failNext).toBe(0);
  });

  it("fails the run loudly on a malformed page and keeps the projection", async () => {
    const t = signedIn();
    await syncNow(t);

    remote.revision = 10;
    // The sync action's own manifest read succeeds; the collect's first rows page is malformed.
    await t.action(api.remoteSources.sync, { source: SOURCE });
    remote.malformedNext = 1;
    await drainScheduled(t);

    const run = await t.query(api.sync.latestRun, { source: SOURCE });
    expect(run === null ? undefined : run.status).toBe("failed");
    expect(run === null ? undefined : run.error).toMatch(/malformed/);
    expect(await projectedKeys(t)).toHaveLength(3);
    expect((await statusOf(t)).syncedRevision).toBe(7);
  });

  it("records an unreachable source on the status row", async () => {
    const t = signedIn();
    vi.stubEnv("REMOTE_SOURCE_DEPLOYMENTS_SECRET", "wrong");
    const result = await t.action(api.remoteSources.check, { source: SOURCE });
    expect(result.ok).toBe(false);
    expect((await statusOf(t)).checkError).toMatch(/HTTP 401/);
  });
});
