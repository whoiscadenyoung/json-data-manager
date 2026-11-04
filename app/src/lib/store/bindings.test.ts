// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  bindingForDatasetQueryOptions,
  isRemoteStale,
  isSyncStale,
  resumeDueRun,
  runSync,
  setRetention,
  type BindingRow,
} from "./bindings";
import {
  registerSource,
  unregisterSource,
  type CommitFeedEntry,
  type ProjectionRow,
} from "./sources";
import {
  firstArg,
  queryAt,
  runQueryOptions,
  stubSupabase,
  type RecordedQuery,
} from "./test-support";

/** The engine's RPC names in the order the driver fires them, as recorded by the stub. */
function rpcNames(queries: ReadonlyArray<RecordedQuery>): string[] {
  return queries.filter((query) => query.rpc !== null).map((query) => query.rpc ?? "(none)");
}

function wireBinding(id: string, overrides: Partial<BindingRow> = {}): BindingRow {
  return {
    createdAt: "2026-11-04T00:00:00+00:00",
    datasetId: "22222222-2222-4222-8222-222222222222",
    id,
    keepVersions: null,
    lastAppliedCommitId: null,
    lastAppliedCommitSeq: null,
    lastReconciledAt: null,
    lastSyncedAt: null,
    pinnedRefs: [],
    remoteRevision: null,
    remoteSchemaVersion: null,
    schemaMapping: null,
    source: "test.stand-in",
    sourceUpdatedAt: null,
    syncedEntryCount: null,
    ...overrides,
  };
}

/** A stand-in client source with a tiny feed and two rows (registered per test, unregistered after). */
function useStandIn() {
  const rows: ProjectionRow[] = [
    {
      data: { label: "Alpha", lat: 1, lng: 2 },
      geometry: { coordinates: [2, 1], type: "Point" },
      key: "k1",
    },
    {
      data: { label: "Beta", lat: 3, lng: 4 },
      geometry: { coordinates: [4, 3], type: "Point" },
      key: "k2",
    },
  ];
  const feed: CommitFeedEntry[] = [
    {
      at: 1_700_000_000_000,
      foreignCommitId: "fc-1",
      message: "first",
      ops: [
        {
          entryKey: "k1",
          fields: [{ after: "Alpha2", name: "label" }],
          geometryChanged: false,
          op: "update",
        },
      ],
      seq: 1,
    },
  ];
  registerSource({
    commitsSince: async () => feed,
    dataset: {
      description: "Stand-in",
      geometryType: "Point",
      kind: "geospatial",
      schema: { type: "object" },
      title: "Stand-in",
    },
    key: "test.stand-in",
    listRows: async () => ({ cursor: null, rows, revision: 7 }),
    newestCommit: async () => feed[0] ?? null,
    mapping: {
      entryKey: "row.id",
      fields: { label: "label" },
      geometry: { kind: "latLng", lat: "lat", lng: "lng" },
    },
    transport: "client",
  });
  return () => {
    unregisterSource("test.stand-in");
  };
}

/** The value, or a loud failure when null/undefined (the no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

describe("bindings reads", () => {
  it("bindingForDataset reads the dataset-scoped row (the page's binding lookup)", async () => {
    const stub = stubSupabase((query) =>
      query.table === "dataset_bindings"
        ? { data: [wireBinding("b-1")], error: null }
        : { data: null, error: null },
    );
    const binding = await runQueryOptions(
      bindingForDatasetQueryOptions({ datasetId: "d-1" }, { supabase: stub.client }),
    );
    expect(present(binding).id).toBe("b-1");
    expect(firstArg(queryAt(stub.queries, 0), "eq")).toBe("dataset_id");
  });
});

describe("staleness (the sync card's badges)", () => {
  it("answers stale when the source changed after the last sync", () => {
    expect(
      isSyncStale({
        lastSyncedAt: "2026-11-04T00:00:00Z",
        sourceUpdatedAt: "2026-11-04T01:00:00Z",
      }),
    ).toBe(true);
    expect(
      isSyncStale({
        lastSyncedAt: "2026-11-04T02:00:00Z",
        sourceUpdatedAt: "2026-11-04T01:00:00Z",
      }),
    ).toBe(false);
    expect(isSyncStale({ lastSyncedAt: null, sourceUpdatedAt: "2026-11-04T01:00:00Z" })).toBe(
      false,
    );
  });

  it("answers remote-stale when the manifest revision moved past the synced one", () => {
    expect(isRemoteStale({ remoteRevision: 3 }, 4)).toBe(true);
    expect(isRemoteStale({ remoteRevision: 4 }, 4)).toBe(false);
    expect(isRemoteStale({ remoteRevision: null }, 4)).toBe(false);
    expect(isRemoteStale({ remoteRevision: 3 }, undefined)).toBe(false);
  });
});

/**
 * The stub answering the driver's reads: the FIRST binding read answers
 * nothing (so the driver exercises find-or-create via binding_ensure), the
 * rest answer the row; one repeating run row by id; and the RPC scripts —
 * `binding_start_run` hands back a fresh run, `binding_mark_collected`
 * wins the lease, and the sweep answers a short (0) batch, the driver's
 * stop signal.
 */
function engineStub(binding: BindingRow, run: Record<string, unknown>) {
  let bindingReads = 0;
  return stubSupabase((query) => {
    if (query.rpc === "binding_start_run") {
      return { data: [{ already_running: false, claim: "claim-1", run_id: "run-1" }], error: null };
    }
    if (query.rpc === "binding_mark_collected") {
      return { data: true, error: null };
    }
    if (query.rpc === "binding_sweep_batch") {
      return { data: 0, error: null };
    }
    if (query.table === "dataset_bindings") {
      bindingReads += 1;
      return bindingReads === 1 ? { data: null, error: null } : { data: [binding], error: null };
    }
    if (query.table === "sync_runs") {
      return {
        data: [{ id: "run-1", bindingId: binding.id, claim: "claim-1", ...run }],
        error: null,
      };
    }
    return { data: null, error: null };
  });
}

describe("runSync (the keyed/resumable engine's client half)", () => {
  it("drains the source, uploads chunks, and drives the engine RPCs in order", async () => {
    const cleanup = useStandIn();
    const binding = wireBinding("b-1", { lastAppliedCommitSeq: null });
    const stub = engineStub(binding, {
      chunkIndex: 0,
      chunkPaths: ["d/sync-runs/run-1/0.json"],
      mode: "sync",
      needsReconcile: false,
      rowOffset: 0,
      status: "applying",
    });
    stub.downloads.push({
      blob: new Blob([
        JSON.stringify([
          {
            data: { label: "Alpha", lat: 1, lng: 2 },
            geometry: { coordinates: [2, 1], type: "Point" },
            key: "k1",
          },
          {
            data: { label: "Beta", lat: 3, lng: 4 },
            geometry: { coordinates: [4, 3], type: "Point" },
            key: "k2",
          },
        ]),
      ]),
    });

    try {
      const outcome = await runSync(
        { mode: "sync", source: "test.stand-in" },
        { supabase: stub.client },
      );
      expect(outcome.alreadyRunning).toBe(false);
      expect(outcome.runId).toBe("run-1");

      const names = rpcNames(stub.queries);
      // The engine's server half in order: bind (ensure — the binding row
      // was missing) → start → mark → apply → finalize → sweep. A full pass
      // has no baseline cursor, so start_run carries mode "sync" (the tail
      // decision).
      expect(names[0]).toBe("binding_ensure");
      expect(names[1]).toBe("binding_start_run");
      expect(names[2]).toBe("binding_mark_collected");
      expect(names[3]).toBe("binding_apply_rows_batch");
      expect(names[4]).toBe("binding_finalize_run");
      expect(names[5]).toBe("binding_sweep_batch");

      const uploaded = present(stub.uploads[0]);
      expect(uploaded.path).toBe("22222222-2222-4222-8222-222222222222/sync-runs/run-1/0.json");
      expect(uploaded.bucket).toBe("sync-chunks");
      const startCall = present(stub.queries.find((query) => query.rpc === "binding_start_run"));
      expect(startCall.rpcArgs.p_mode).toBe("sync");
    } finally {
      cleanup();
    }
  });

  it("takes the commit-tail path when the binding has a baseline cursor", async () => {
    const cleanup = useStandIn();
    const binding = wireBinding("b-1", { lastAppliedCommitSeq: 0 });
    const stub = engineStub(binding, {
      chunkIndex: 0,
      chunkPaths: ["d/sync-runs/run-1/0.json"],
      mode: "commit-tail",
      needsReconcile: false,
      rowOffset: 0,
      status: "applying",
    });
    stub.downloads.push({
      blob: new Blob([
        JSON.stringify([
          {
            at: 1_700_000_000_000,
            foreignCommitId: "fc-1",
            message: "first",
            ops: [
              {
                entryKey: "k1",
                fields: [{ after: "Alpha2", name: "label" }],
                geometryChanged: false,
                op: "update",
              },
            ],
            seq: 1,
          },
        ]),
      ]),
    });

    try {
      await runSync({ mode: "sync", source: "test.stand-in" }, { supabase: stub.client });
      const startCall = present(stub.queries.find((query) => query.rpc === "binding_start_run"));
      expect(startCall.rpcArgs.p_mode).toBe("commit-tail");
      const applyCall = stub.queries.find((query) => query.rpc === "binding_apply_commits_batch");
      expect(applyCall).toBeDefined();
      // A tail run skips the sweep — its commits carried the deletes.
      expect(stub.queries.find((query) => query.rpc === "binding_sweep_batch")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("fails the run cleanly and removes its chunks when a leg throws", async () => {
    const cleanup = useStandIn();
    const binding = wireBinding("b-1");
    const stub = engineStub(binding, {
      chunkIndex: 0,
      chunkPaths: ["d/sync-runs/run-1/0.json"],
      mode: "sync",
      rowOffset: 0,
      status: "failed",
    });
    // No download scripted → the apply leg throws (the chunk is missing).
    try {
      await expect(
        runSync({ mode: "sync", source: "test.stand-in" }, { supabase: stub.client }),
      ).rejects.toThrow(/Sync chunk/);
      const failCall = stub.queries.find((query) => query.rpc === "binding_fail_run");
      expect(failCall).toBeDefined();
      expect(stub.removes.length).toBe(1);
      expect(present(stub.removes[0]).bucket).toBe("sync-chunks");
    } finally {
      cleanup();
    }
  });

  it("joins an already-running run instead of forking a second driver", async () => {
    const cleanup = useStandIn();
    const stub = stubSupabase((query) => {
      if (query.rpc === "binding_start_run") {
        return { data: [{ already_running: true, claim: "", run_id: "run-9" }], error: null };
      }
      if (query.table === "dataset_bindings") {
        return { data: [wireBinding("b-1")], error: null };
      }
      return { data: null, error: null };
    });
    try {
      const outcome = await runSync({ source: "test.stand-in" }, { supabase: stub.client });
      expect(outcome.alreadyRunning).toBe(true);
      expect(outcome.runId).toBe("run-9");
      // No collect/upload legs fired.
      expect(stub.uploads.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("resumeDueRun (the pg_cron work items' consumer)", () => {
  it("claims and finishes a scheduled run", async () => {
    const cleanup = useStandIn();
    const stub = stubSupabase((query) =>
      query.rpc === "binding_claim_run"
        ? { data: "claim-9", error: null }
        : query.table === "sync_runs"
          ? {
              data: [
                {
                  chunkIndex: 0,
                  chunkPaths: ["d/sync-runs/run-5/0.json"],
                  id: "run-5",
                  mode: "reconcile",
                  rowOffset: 0,
                  status: "applying",
                },
              ],
              error: null,
            }
          : { data: null, error: null },
    );
    stub.downloads.push({ blob: new Blob([JSON.stringify([])]) });
    try {
      const claimed = await resumeDueRun({ runId: "run-5" }, { supabase: stub.client });
      expect(claimed).toBe(true);
      expect(stub.queries.some((query) => query.rpc === "binding_claim_run")).toBe(true);
      expect(stub.queries.some((query) => query.rpc === "binding_finalize_run")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("answers false when there is nothing to claim (the run settled)", async () => {
    const stub = stubSupabase((query) =>
      query.rpc === "binding_claim_run" ? { data: null, error: null } : { data: null, error: null },
    );
    const claimed = await resumeDueRun({ runId: "run-x" }, { supabase: stub.client });
    expect(claimed).toBe(false);
  });
});

describe("setRetention (the keep-N/pin knobs)", () => {
  it("sends only the fields the caller set", async () => {
    const stub = stubSupabase(() => ({ data: [{ id: "b-1" }], error: null }));
    const rows = await setRetention(
      { bindingId: "b-1", keepVersions: 3 },
      { supabase: stub.client },
    );
    expect(rows).toBe(1);
    expect(firstArg(queryAt(stub.queries, 0), "update")).toEqual({ keep_versions: 3 });
  });

  it("refuses a no-op update with the store's explicit error", async () => {
    const stub = stubSupabase();
    await expect(setRetention({ bindingId: "b-1" }, { supabase: stub.client })).rejects.toThrow(
      /needs a field to set/,
    );
  });
});
