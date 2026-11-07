// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  BUNDLE_MEMBER_STATUSES,
  completeBundle,
  linkMapLayers,
  listMembersQueryOptions,
  memberOrder,
  publishDataset,
  recordMember,
  startBundle,
  survivingMembers,
  type BundleMemberRow,
} from "./publishing";
import {
  allArgs,
  argsOf,
  firstArg,
  postgrestError,
  queryAt,
  runQueryOptions,
  stubSupabase,
} from "./test-support";

/** The element at the index, or a loud failure (no-optional-chaining test style). */
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

/** One bundle member wire row. */
function memberWire(overrides: Record<string, unknown> = {}): BundleMemberRow {
  return {
    attemptId: null,
    bundleId: "b1",
    datasetKey: "d1",
    error: null,
    visibilityFrom: null,
    visibilityTo: null,
    groupId: null,
    id: "m1",
    kind: "dataset",
    layerTargets: null,
    publish: true,
    publishedVersionId: null,
    status: "pending",
    ...overrides,
  };
}

describe("publishing member machine — the pure parts", () => {
  it("memberOrder sorts datasets, then derived, then maps (the canonical press order)", () => {
    expect(memberOrder("dataset")).toBeLessThan(memberOrder("derived"));
    expect(memberOrder("derived")).toBeLessThan(memberOrder("map"));
  });

  it("survivingMembers keeps only published members whose frozen row still resolves", () => {
    const members = [
      memberWire({ id: "m-ok", status: "published", publishedVersionId: "v1" }),
      memberWire({ id: "m-orphan", status: "published", publishedVersionId: null }),
      memberWire({ id: "m-failed", status: "failed", error: "boom" }),
      memberWire({ id: "m-linked", status: "linked" }),
    ];
    const alive = survivingMembers(members);
    expect(alive.map((member) => member.id)).toStrictEqual(["m-ok"]);
    expect(at(alive, 0).publishedVersionId).toBe("v1");
  });

  it("exposes every member status literal (the status machine)", () => {
    expect(BUNDLE_MEMBER_STATUSES).toStrictEqual([
      "pending",
      "publishing",
      "published",
      "referenced",
      "linked",
      "failed",
    ]);
  });
});

describe("publishing.publishDataset — the §5.4 RPC call", () => {
  it("passes the dataset/label/key/lineage arguments and returns the version id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: "v-new" }));
    const versionId = await publishDataset(
      {
        datasetId: "d1",
        lineage: { recipe: { op: "sql" } },
        publishKey: "pk-1",
        versionLabel: "v1",
      },
      { supabase: client },
    );
    expect(versionId).toBe("v-new");
    const rpc = queryAt(queries, 0);
    expect(rpc.rpc).toBe("publish_version");
    expect(rpc.rpcArgs).toStrictEqual({
      p_dataset: "d1",
      p_lineage: { recipe: { op: "sql" } },
      p_publish_key: "pk-1",
      p_version_label: "v1",
    });
  });

  it("sends a null lineage when none is given (the RPC stamps the draft shape)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: "v-new" }));
    await publishDataset(
      { datasetId: "d1", publishKey: "pk-1", versionLabel: "v1" },
      { supabase: client },
    );
    expect(queryAt(queries, 0).rpcArgs).toStrictEqual({
      p_dataset: "d1",
      p_lineage: null,
      p_publish_key: "pk-1",
      p_version_label: "v1",
    });
  });

  it("propagates the RPC's gate error (locked = creator only)", async () => {
    const { client } = stubSupabase(() => ({
      data: null,
      error: postgrestError("publish_version: dataset is not writable by the caller", "P0001"),
    }));
    await expect(
      publishDataset(
        { datasetId: "d1", publishKey: "pk-1", versionLabel: "v1" },
        { supabase: client },
      ),
    ).rejects.toThrow("not writable");
  });
});

describe("publishing.startBundle — join-or-revive + canonical member order", () => {
  it("joins a still-running latest press instead of forking one", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((_query) => ({
      data: [
        {
          collectionId: "col-1",
          createdBy: "user-1",
          error: null,
          finishedAt: null,
          id: "b-run",
          lastProgressAt: "2026-11-04T00:00:00+00:00",
          projectDescription: null,
          projectId: "p1",
          startedAt: "2026-11-04T00:00:00+00:00",
          status: "running",
          title: "SMART 2024",
        },
      ],
    }));
    const result = await startBundle(
      {
        collectionId: "col-1",
        members: [{ datasetKey: "d1", kind: "dataset", publish: true }],
        projectId: "p1",
        title: "SMART 2024",
      },
      { supabase: client },
    );
    expect(result.joined).toBe(true);
    expect(result.bundleId).toBe("b-run");
    // Only the revive touch ran — no bundle/member inserts.
    const touch = queryAt(queries, 1);
    expect(touch.table).toBe("publish_bundles");
    expect(typeof firstArg(touch, "update")).toBe("object");
  });

  it("mints the bundle + members in canonical order, referenced members born 'referenced'", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (
        query.table === "publish_bundles" &&
        query.operations.some((op) => op.method === "single")
      ) {
        return { data: { id: "b-new" } };
      }
      return { data: [{ id: "m" }] };
    });
    const result = await startBundle(
      {
        members: [
          { datasetKey: "map-1", kind: "map", layerTargets: ["d1"], publish: true },
          { datasetKey: "d-pub", kind: "dataset", publish: false },
          { datasetKey: "d-draft", kind: "dataset", groupId: "g1", publish: true },
        ],
        projectId: "p1",
        title: "SMART 2024",
      },
      { supabase: client },
    );
    expect(result.joined).toBe(false);
    expect(result.bundleId).toBe("b-new");
    const bundleInsert = queryAt(queries, 1);
    expect(bundleInsert.table).toBe("publish_bundles");
    expect(firstArg(bundleInsert, "insert")).toStrictEqual({
      collection_id: null,
      project_description: null,
      project_id: "p1",
      title: "SMART 2024",
    });
    // Minted datasets → (derived) → maps, regardless of the plan's order.
    const inserts = queries.filter((query) => query.table === "publish_bundle_members");
    expect(inserts.length).toBe(3);
    expect(firstArg(queryAt(inserts, 0), "insert")).toMatchObject({
      dataset_key: "d-pub",
      status: "referenced",
    });
    expect(firstArg(queryAt(inserts, 1), "insert")).toMatchObject({
      dataset_key: "d-draft",
      group_id: "g1",
      status: "pending",
    });
    expect(firstArg(queryAt(inserts, 2), "insert")).toMatchObject({
      dataset_key: "map-1",
      layer_targets: ["d1"],
    });
  });

  it("refuses an empty press (the server-side gate behind the disabled control)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    await expect(
      startBundle({ members: [], projectId: "p1", title: "x" }, { supabase: client }),
    ).rejects.toThrow("Nothing to publish yet");
  });
});

describe("publishing writes — the press's legs", () => {
  it("recordMember checkpoints the member and touches the run's progress", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }] }));
    const affected = await recordMember(
      { bundleId: "b1", memberId: "m1", publishedVersionId: "v1", status: "published" },
      { supabase: client },
    );
    expect(affected).toBe(1);
    const memberUpdate = queryAt(queries, 0);
    expect(memberUpdate.table).toBe("publish_bundle_members");
    expect(firstArg(memberUpdate, "update")).toStrictEqual({
      published_version_id: "v1",
      status: "published",
    });
    expect(queryAt(queries, 1).table).toBe("publish_bundles");
  });

  it("recordMember refuses an empty checkpoint", async () => {
    const { client } = stubSupabase();
    await expect(
      recordMember({ bundleId: "b1", memberId: "m1" }, { supabase: client }),
    ).rejects.toThrow("at least one field");
  });

  it("completeBundle closes failed when any member failed, keeping the error text", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "publish_bundle_members") {
        return {
          data: [
            memberWire({ status: "published", publishedVersionId: "v1" }),
            memberWire({ id: "m2", status: "failed", error: "boom" }),
          ],
        };
      }
      return {
        data: [
          {
            collectionId: "col-1",
            createdBy: "user-1",
            error:
              "1 of 2 members failed — completed members keep their published versions; press again to retry.",
            finishedAt: "2026-11-04T00:00:00+00:00",
            id: "b1",
            lastProgressAt: "2026-11-04T00:00:00+00:00",
            projectDescription: null,
            projectId: "p1",
            startedAt: "2026-11-04T00:00:00+00:00",
            status: "failed",
            title: "SMART 2024",
          },
        ],
      };
    });
    const result = await completeBundle({ bundleId: "b1" }, { supabase: client });
    expect(result.affected).toBe(1);
    expect(present(result.bundle).status).toBe("failed");
    const close = queryAt(queries, 1);
    expect(firstArg(close, "update")).toMatchObject({ status: "failed" });
  });

  it("linkMapLayers re-reads the CURRENT map_layers at leg time and reconciles edges to them", async () => {
    const { client, queries, respond } = stubSupabase();
    // The leg-time reads, per map: FIRST the current layer list, THEN the
    // existing edges (the bundles.ts:1060-1123 order). The layer list says
    // d1 + d2 — NOT any press-time snapshot the member row may carry.
    let step = 0;
    respond((query) => {
      step += 1;
      if (query.table === "map_layers") {
        return { data: [{ targetId: "d1" }, { targetId: "d2" }] };
      }
      if (query.table === "consumer_references") {
        // Existing edges: one stale target + one current.
        return {
          data: [
            { consumerId: "map-1", id: "edge-stale", sourceDatasetId: "d-gone" },
            { consumerId: "map-1", id: "edge-keep", sourceDatasetId: "d1" },
          ],
        };
      }
      return { data: [{ id: "x" }] };
    });
    // The args carry NO targets — the leg reads the layers itself.
    const linked = await linkMapLayers(
      { bundleId: "b1", maps: [{ mapId: "map-1", memberId: "m-map" }] },
      { supabase: client },
    );
    expect(linked).toBe(1);
    // The layers read came FIRST, gated to the map's dataset layers.
    const layersRead = queryAt(queries, 0);
    expect(layersRead.table).toBe("map_layers");
    expect(allArgs(layersRead, "eq")).toStrictEqual([
      ["map_id", "map-1"],
      ["target_type", "dataset"],
    ]);
    // The edge scan filters to the map's own edges (consumer_kind "map").
    const edgeScan = queryAt(queries, 1);
    expect(edgeScan.table).toBe("consumer_references");
    expect(allArgs(edgeScan, "eq")).toStrictEqual([
      ["consumer_id", "map-1"],
      ["consumer_kind", "map"],
    ]);
    // Reconciliation follows the RE-READ list: the stale edge deletes, the
    // only new edge is d2 (d1 already has one), nothing from a snapshot.
    const deletes = queries.filter(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "delete"),
    );
    expect(deletes.length).toBe(1);
    expect(allArgs(queryAt(deletes, 0), "eq")).toStrictEqual([["id", "edge-stale"]]);
    const inserts = queries.filter(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(inserts.length).toBe(1);
    expect(firstArg(queryAt(inserts, 0), "insert")).toStrictEqual({
      consumer_id: "map-1",
      consumer_kind: "map",
      mode: "float",
      source_dataset_id: "d2",
    });
    expect(step).toBeGreaterThanOrEqual(2);
  });

  it("listMembersQueryOptions reads the camelCase projection by bundle", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [memberWire()] }));
    const members = await runQueryOptions(
      listMembersQueryOptions({ bundleId: "b1" }, { supabase: client }),
    );
    expect(members.length).toBe(1);
    expect(queryAt(queries, 0).table).toBe("publish_bundle_members");
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["bundle_id", "b1"]);
  });
});
