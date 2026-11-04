// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { firstArg, postgrestError, queryAt, runQueryOptions, stubSupabase } from "./test-support";

/** The element at the index, or a loud failure (the no-optional-chaining test style). */
function at<T>(rows: ReadonlyArray<T>, index: number): T {
  const item = rows[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index} (have ${rows.length}).`);
  }
  return item;
}

/** The value, or a loud failure when null/undefined. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}
import {
  DEFAULT_KEEP_VERSIONS,
  VERSION_DIFF_LIMIT,
  badgeStateOf,
  badgesOf,
  diffVersionRows,
  enforceVersionRetention,
  getVersionDelta,
  headsOf,
  retentionPolicyQueryOptions,
  setKeepVersions,
  setReferenceMode,
  setVersionPinned,
  syncReference,
  type ChainHead,
} from "./versions";

/** One dataset_versions wire row (camelCase aliases over the DDL). */
function versionWire(id: string, datasetId: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "user-1",
    datasetId,
    id,
    lineage: { frozenAt: 1, snapshotRef: `ref-${id}`, versionLabel: "v1" },
    publishKey: `key-${id}`,
    ref: `ref-${id}`,
    versionLabel: "v1",
    ...overrides,
  };
}

function head(id: string, ref: string, frozenAt: number): ChainHead {
  return { anchorId: "d1", frozenAt, ref, versionId: id, versionLabel: "v1" };
}

describe("versions.badgeStateOf — the drift decision (chain.ts port)", () => {
  it("answers current when the recorded ref is the head", () => {
    expect(badgeStateOf("ref-1", head("v1", "ref-1", 100))).toBe("current");
  });

  it("answers drift when the head moved past the recorded ref", () => {
    expect(badgeStateOf("ref-1", head("v2", "ref-2", 200))).toBe("drift");
  });

  it("answers live for a live-read source with no head, missing when the chain vanished", () => {
    expect(badgeStateOf(undefined, undefined)).toBe("live");
    expect(badgeStateOf("ref-1", undefined)).toBe("missing");
  });

  it("answers current for a live-read consumer frozen after the head (the no-nag rule)", () => {
    expect(badgeStateOf(undefined, head("v1", "ref-1", 100), 200)).toBe("current");
    expect(badgeStateOf(undefined, head("v1", "ref-1", 100), 50)).toBe("drift");
  });
});

describe("versions.badgesOf — the notify-equivalent projection", () => {
  it("joins edges + heads into badge rows with recorded and head fields", () => {
    // Realistic epoch frozenAt values: the float edge's drift decision
    // compares the head's freeze time against the edge's creation time.
    const edgeFrozenAt = Date.parse("2026-11-01T00:00:00Z");
    const heads = new Map([
      ["d1", head("v2", "ref-2", Date.parse("2026-11-02T00:00:00Z"))],
      ["d2", head("v3", "ref-3", Date.parse("2026-11-03T00:00:00Z"))],
    ]);
    const badges = badgesOf(
      [
        {
          consumerId: "c1",
          createdAt: new Date(edgeFrozenAt).toISOString(),
          id: "e1",
          mode: "pin",
          pinnedRef: "ref-2",
          pinnedVersionId: "v2",
          consumerKind: "fork",
          sourceDatasetId: "d1",
        },
        {
          consumerId: "c1",
          createdAt: new Date(edgeFrozenAt).toISOString(),
          id: "e2",
          mode: "float",
          pinnedRef: null,
          pinnedVersionId: null,
          consumerKind: "map",
          sourceDatasetId: "d2",
        },
      ],
      heads,
      new Map([["v2", "v2"]]),
    );
    expect(badges.length).toBe(2);
    const pinned = at(badges, 0);
    expect(pinned.state).toBe("current");
    expect(pinned.recordedRef).toBe("ref-2");
    expect(pinned.headRef).toBe("ref-2");
    const float = at(badges, 1);
    // A float edge whose head froze AFTER the consumer did: drift (the
    // live-read rule — a head from before the consumer is already reflected).
    expect(float.state).toBe("drift");
    expect(float.headRef).toBe("ref-3");
  });

  it("answers missing for a pin whose chain vanished", () => {
    const badges = badgesOf(
      [
        {
          consumerId: "c1",
          createdAt: "2026-11-01T00:00:00+00:00",
          id: "e1",
          mode: "pin",
          pinnedRef: "ref-gone",
          pinnedVersionId: "v-gone",
          consumerKind: "fork",
          sourceDatasetId: "d1",
        },
      ],
      new Map(),
    );
    expect(at(badges, 0).state).toBe("missing");
  });
});

describe("versions.headsOf — one ordered read, newest row per dataset", () => {
  it("keeps the FIRST row per dataset (the read is created_at desc)", () => {
    const rows = [
      versionWire("v2", "d1", { ref: "ref-2", versionLabel: "v2" }),
      versionWire("v1", "d1"),
      versionWire("v9", "d2", { ref: "ref-9" }),
    ];
    const heads = headsOf(rows);
    expect(present(heads.get("d1")).versionId).toBe("v2");
    expect(present(heads.get("d1")).ref).toBe("ref-2");
    expect(present(heads.get("d2")).ref).toBe("ref-9");
  });

  it("falls back to the parsed created_at when lineage carries no frozenAt", () => {
    const rows = [versionWire("v1", "d1", { lineage: {}, createdAt: "2026-01-01T00:00:00Z" })];
    expect(present(headsOf(rows).get("d1")).frozenAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
});

describe("versions.diffVersionRows — the versioning.ts algorithm", () => {
  it("emits add / update / delete ops with before-state fields on deletes", () => {
    const ops = diffVersionRows(
      [
        { data: { label: "keep", lat: 1, extra: "x" }, key: "keep" },
        { data: { label: "gone", lat: 2 }, key: "gone" },
      ],
      [
        { data: { label: "keep", lat: 5, extra: "x" }, key: "keep" },
        { data: { label: "new", lat: 3 }, key: "new" },
      ],
    );
    const adds = ops.filter((op) => op.op === "add");
    const updates = ops.filter((op) => op.op === "update");
    const deletes = ops.filter((op) => op.op === "delete");
    expect(adds.length).toBe(1);
    expect(at(adds, 0).entryKey).toBe("new");
    expect(at(adds, 0).geometryChanged).toBe(true);
    expect(updates.length).toBe(1);
    expect(at(updates, 0).fields.map((field) => field.name)).toStrictEqual(["lat"]);
    expect(at(updates, 0).geometryChanged).toBe(true);
    expect(deletes.length).toBe(1);
    expect(at(deletes, 0).entryKey).toBe("gone");
    expect(at(deletes, 0).fields.some((field) => field.name === "lat")).toBe(true);
  });

  it("drops updates with no changed fields (the length>0 rule)", () => {
    const ops = diffVersionRows(
      [{ data: { label: "same", note: "n" }, key: "same" }],
      [{ data: { label: "same", note: "n" }, key: "same" }],
    );
    expect(ops.length).toBe(0);
  });
});

/** N light diff rows with stable labels (the bounded-read fixture). */
function lightRows(n: number): Array<{ data: Record<string, unknown>; entryId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    data: { label: `row-${String(i)}` },
    entryId: `e-${String(i)}`,
  }));
}

describe("versions.getVersionDelta — the bounded on-demand read", () => {
  it("reads both sides bounded at LIMIT+1 and reports exact truncation", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((_query) => {
      if (method(_query) === "version_entries") {
        return { data: lightRows(VERSION_DIFF_LIMIT + 1) };
      }
      return { data: [] };
    });
    const delta = await getVersionDelta({ aVersionId: "a", bVersionId: "b" }, { supabase: client });
    expect(delta.truncated).toBe(true);
    expect(queries.length).toBe(2);
    const first = queryAt(queries, 0);
    expect(first.table).toBe("version_entries");
    expect(firstArg(first, "limit")).toBe(VERSION_DIFF_LIMIT + 1);
  });

  it("counts add/remove/update ops and clears truncation under the budget", async () => {
    const { client, respond } = stubSupabase();
    respond((_query) => ({ data: [{ data: { label: "x" }, entryId: "e1" }] }));
    const delta = await getVersionDelta({ aVersionId: "a", bVersionId: "b" }, { supabase: client });
    expect(delta.truncated).toBe(false);
    expect(delta.added + delta.removed + delta.updated).toBeLessThanOrEqual(delta.ops.length);
  });
});

/** The recorded query's table or rpc name (test-side, no optional chaining). */
function method(query: { rpc: string | null; table: string | null }): string {
  return query.rpc ?? query.table ?? "";
}

describe("versions writes — rows-affected returns (the silent-denial rule)", () => {
  it("setKeepVersions upserts the policy row then runs the retention RPC", async () => {
    const { client, queries, respond } = stubSupabase(() => ({ data: [{ datasetKey: "d1" }] }));
    respond((query) => {
      if (query.rpc === "enforce_version_retention") {
        return { data: 2 };
      }
      return { data: [{ datasetKey: "d1" }] };
    });
    const retired = await setKeepVersions({ datasetKey: "d1", keep: 3 }, { supabase: client });
    expect(retired).toBe(2);
    const upsert = queryAt(queries, 0);
    expect(upsert.table).toBe("version_policies");
    expect(firstArg(upsert, "upsert")).toStrictEqual({ dataset_key: "d1", keep_versions: 3 });
    const rpc = queryAt(queries, 1);
    expect(rpc.rpc).toBe("enforce_version_retention");
    expect(rpc.rpcArgs).toStrictEqual({ p_dataset: "d1" });
  });

  it("setKeepVersions refuses keep < 1 (the Keep at least one version rule)", async () => {
    const { client } = stubSupabase();
    await expect(
      setKeepVersions({ datasetKey: "d1", keep: 0 }, { supabase: client }),
    ).rejects.toThrow("Keep at least one version.");
  });

  it("setVersionPinned adds and removes refs on the policy row (pinRefIntoPolicyStore parity)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (
        method(query) === "version_policies" &&
        query.operations.some((op) => op.method === "select" && op.args.length === 0)
      ) {
        return { data: null };
      }
      return { data: [{ datasetKey: "d1" }] };
    });
    const affected = await setVersionPinned(
      { datasetKey: "d1", pinned: true, ref: "ref-1" },
      { supabase: client },
    );
    expect(affected).toBe(1);
    const upsert = queryAt(queries, 1);
    expect(firstArg(upsert, "upsert")).toStrictEqual({
      dataset_key: "d1",
      pinned_refs: ["ref-1"],
    });
  });

  it("setVersionPinned removes an existing ref (absence on float answers defaults)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.operations.some((op) => op.method === "eq" && op.args[0] === "dataset_key")) {
        return {
          data: [{ datasetKey: "d1", keepVersions: 5, pinnedRefs: ["ref-1", "ref-2"] }],
        };
      }
      return { data: [{ datasetKey: "d1" }] };
    });
    const affected = await setVersionPinned(
      { datasetKey: "d1", pinned: false, ref: "ref-1" },
      { supabase: client },
    );
    expect(affected).toBe(1);
    const upsert = queryAt(queries, 1);
    expect(firstArg(upsert, "upsert")).toStrictEqual({
      dataset_key: "d1",
      pinned_refs: ["ref-2"],
    });
  });

  it("setReferenceMode rejects a pinless pin (the DB check's client mirror)", async () => {
    const { client } = stubSupabase();
    await expect(
      setReferenceMode({ mode: "pin", referenceId: "r1" }, { supabase: client }),
    ).rejects.toThrow("A pin needs its version");
  });

  it("syncReference repins the edge to the head and reports rows affected", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (method(query) === "consumer_references") {
        return {
          data: [
            {
              consumerId: "c1",
              createdAt: "2026-11-01T00:00:00+00:00",
              id: "r1",
              mode: "pin",
              pinnedRef: "ref-old",
              pinnedVersionId: "v-old",
              consumerKind: "fork",
              sourceDatasetId: "d1",
            },
          ],
        };
      }
      if (method(query) === "dataset_versions") {
        return { data: [versionWire("v-new", "d1", { ref: "ref-new" })] };
      }
      return { data: [{ id: "r1" }] };
    });
    const sync = await syncReference({ referenceId: "r1" }, { supabase: client });
    expect(sync.affected).toBe(1);
    expect(present(sync.head).ref).toBe("ref-new");
    const update = queryAt(queries, 2);
    expect(update.table).toBe("consumer_references");
    expect(firstArg(update, "update")).toStrictEqual({
      mode: "pin",
      pinned_ref: "ref-new",
      pinned_version_id: "v-new",
    });
  });

  it("syncReference answers 0 without an update when already at head", async () => {
    const { client, respond } = stubSupabase();
    respond((query) => {
      if (method(query) === "consumer_references") {
        return {
          data: [
            {
              consumerId: "c1",
              createdAt: "2026-11-01T00:00:00+00:00",
              id: "r1",
              mode: "pin",
              pinnedRef: "ref-new",
              pinnedVersionId: "v-new",
              consumerKind: "fork",
              sourceDatasetId: "d1",
            },
          ],
        };
      }
      return { data: [versionWire("v-new", "d1", { ref: "ref-new" })] };
    });
    const sync = await syncReference({ referenceId: "r1" }, { supabase: client });
    expect(sync.affected).toBe(0);
  });

  it("enforceVersionRetention reads the scalar RPC count and refuses non-numeric shapes", async () => {
    const { client, queries } = stubSupabase(() => ({ data: 3 }));
    const retired = await enforceVersionRetention("d1", { supabase: client });
    expect(retired).toBe(3);
    const rpc = queryAt(queries, 0);
    expect(rpc.rpc).toBe("enforce_version_retention");
    await expect(
      enforceVersionRetention("d1", {
        supabase: stubSupabase(() => ({ data: null, error: postgrestError() })).client,
      }),
    ).rejects.toThrow("permission denied");
  });
});

describe("versions reads — queryOptions shapes", () => {
  it("retentionPolicyQueryOptions answers the DEFAULTS on an absent row (the RLS-invisible-anchor rule)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const policy = await runQueryOptions(
      retentionPolicyQueryOptions({ datasetKey: "d1" }, { supabase: client }),
    );
    expect(policy.keepVersions).toBe(DEFAULT_KEEP_VERSIONS);
    expect(policy.pinnedRefs).toStrictEqual([]);
  });

  it("retentionPolicyQueryOptions passes the stored row through when present", async () => {
    const { client } = stubSupabase(() => ({
      data: [{ datasetKey: "d1", keepVersions: 4, pinnedRefs: ["ref-1"] }],
    }));
    const policy = await runQueryOptions(
      retentionPolicyQueryOptions({ datasetKey: "d1" }, { supabase: client }),
    );
    expect(policy.keepVersions).toBe(4);
    expect(policy.pinnedRefs).toStrictEqual(["ref-1"]);
  });
});
