import { describe, expect, it, vi } from "vitest";

// The lib's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any lib import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  postgrestError,
  stubSupabase,
  type RecordedQuery,
  type ScriptedResponse,
} from "#/lib/store/test-support";

import { pgPublishProjectBundle } from "./pg-bundle-publish";

/** The element at the index, or a loud failure (the no-optional-chaining test style). */
function at<T>(rows: ReadonlyArray<T>, index: number): T {
  const item = rows[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index} (have ${rows.length}).`);
  }
  return item;
}

/** The project both presses share. */
const PROJECT = {
  artifactCount: 3,
  createdAt: "2026-11-04T00:00:00+00:00",
  createdBy: "creator-1",
  description: "One year of SMART data.",
  id: "project-1",
  title: "SMART 2024",
  updatedAt: "2026-11-04T00:00:00+00:00",
};
const ARTIFACTS = [
  {
    addedBy: "creator-1",
    artifactId: "dataset-a",
    artifactKind: "dataset",
    id: "art-1",
    projectId: "project-1",
  },
  {
    addedBy: "creator-1",
    artifactId: "dataset-b",
    artifactKind: "dataset",
    id: "art-2",
    projectId: "project-1",
  },
  {
    addedBy: "creator-1",
    artifactId: "map-1",
    artifactKind: "map",
    id: "art-3",
    projectId: "project-1",
  },
];
const BUNDLE_ROW = {
  collectionId: null,
  createdBy: "creator-1",
  error: null,
  finishedAt: null,
  id: "bundle-1",
  lastProgressAt: "2026-11-04T00:00:00+00:00",
  projectDescription: PROJECT.description,
  projectId: "project-1",
  startedAt: "2026-11-04T00:00:00+00:00",
  status: "running",
  title: PROJECT.title,
};
const MEMBER_A = {
  attemptId: null,
  bundleId: "bundle-1",
  datasetKey: "dataset-a",
  error: null,
  groupId: null,
  id: "member-a",
  kind: "dataset",
  layerTargets: null,
  publish: true,
  publishedVersionId: null,
  status: "pending",
};
const MEMBER_B = {
  ...MEMBER_A,
  datasetKey: "dataset-b",
  id: "member-b",
  publish: false,
  status: "referenced",
};
const MEMBER_C = {
  ...MEMBER_A,
  datasetKey: "dataset-c",
  id: "member-c",
  status: "pending",
};
const MEMBER_MAP = {
  ...MEMBER_A,
  datasetKey: "map-1",
  id: "member-map",
  kind: "map",
  layerTargets: ["dataset-a", "dataset-c"],
};

/** The full argument list of the query's first operation with `method`, or undefined. */
function methodOf(query: RecordedQuery, method: string): unknown[] | undefined {
  const op = query.operations.find((candidate) => candidate.method === method);
  return op === undefined ? undefined : op.args;
}

/**
 * The stateful press responder: the member statuses UPDATE as the press
 * checkpoints them, so completeBundle's terminal-state read matches what
 * the loop recorded (the run's honesty, end to end through the store legs).
 */
function pressResponder(state: {
  bundlesInserts: number;
  failOnPublishNumber: number;
  latest: Record<string, unknown> | null;
  publishes: number;
  memberStatus: Map<string, string>;
}): (query: RecordedQuery) => ScriptedResponse {
  // The responder dispatches every table the press legs touch — one branch
  // per table in leg order, each a two-line script; splitting it would
  // scatter the run's scripted state across closures and the tests read it
  // as one press.
  // oxlint-disable-next-line eslint/complexity -- the branch-per-table dispatch IS the scripted run, kept in one readable place.
  return (query): ScriptedResponse => {
    if (query.rpc === "publish_version") {
      state.publishes += 1;
      if (state.publishes === state.failOnPublishNumber) {
        return { error: postgrestError("new row violates row-level security policy") };
      }
      return { data: `version-${state.publishes}` };
    }
    if (query.table === "projects") {
      return { data: [PROJECT] };
    }
    if (query.table === "project_artifacts") {
      return { data: ARTIFACTS };
    }
    if (query.table === "dataset_versions") {
      // dataset-b already published (its head exists); dataset-a and
      // dataset-c never did.
      const eq = methodOf(query, "eq");
      const datasetId = eq === undefined ? undefined : eq[1];
      if (datasetId === "dataset-b") {
        return { data: [{ id: "version-b1", versionLabel: "v1" }] };
      }
      return { data: [] };
    }
    if (query.table === "map_layers") {
      // The map layers dataset-a (already a project artifact — the dedupe
      // path) AND dataset-c, which the project never added — the layer
      // target the bundle rule pulls into the plan.
      return { data: [{ targetId: "dataset-a" }, { targetId: "dataset-c" }] };
    }
    if (query.table === "collections") {
      return { data: [{ id: "collection-1" }] };
    }
    if (query.table === "collection_datasets") {
      return { data: [{ dataset_id: "x" }] };
    }
    if (query.table === "consumer_references") {
      return { data: [{ id: "edge-1" }] };
    }
    if (query.table === "publish_bundles") {
      if (methodOf(query, "insert") !== undefined) {
        state.bundlesInserts += 1;
        return { data: [{ id: `bundle-${state.bundlesInserts}` }] };
      }
      if (methodOf(query, "update") !== undefined) {
        const failed = [...state.memberStatus.values()].some((status) => status === "failed");
        return {
          data: [
            {
              ...BUNDLE_ROW,
              id: BUNDLE_ROW.id,
              status: failed ? "failed" : "completed",
            },
          ],
        };
      }
      // The join/latest read.
      return { data: state.latest === null ? [] : [state.latest] };
    }
    if (query.table === "publish_bundle_members") {
      if (methodOf(query, "insert") !== undefined) {
        return { data: [{ id: "inserted" }] };
      }
      const update = methodOf(query, "update");
      if (update !== undefined) {
        const patch = update[0] as Record<string, unknown>;
        const eqs = query.operations.filter((op) => op.method === "eq");
        const idOp = eqs.find((op) => op.args[0] === "id");
        const memberId = idOp === undefined ? undefined : idOp.args[1];
        const memberIdText = typeof memberId === "string" ? memberId : "unknown-member";
        if (memberIdText !== "unknown-member" && typeof patch.status === "string") {
          state.memberStatus.set(memberIdText, patch.status);
        }
        return { data: [{ id: memberIdText }] };
      }
      // The member read: statuses reflect the recorded checkpoints.
      return {
        data: [
          { ...MEMBER_A, status: state.memberStatus.get("member-a") ?? "pending" },
          { ...MEMBER_B, status: state.memberStatus.get("member-b") ?? "referenced" },
          { ...MEMBER_C, status: state.memberStatus.get("member-c") ?? "pending" },
          { ...MEMBER_MAP, status: state.memberStatus.get("member-map") ?? "pending" },
        ],
      };
    }
    return { data: null };
  };
}

function freshState(latest: Record<string, unknown> | null = null): {
  bundlesInserts: number;
  failOnPublishNumber: number;
  latest: Record<string, unknown> | null;
  publishes: number;
  memberStatus: Map<string, string>;
} {
  return {
    bundlesInserts: 0,
    failOnPublishNumber: -1,
    latest,
    publishes: 0,
    memberStatus: new Map(),
  };
}

describe("pgPublishProjectBundle", () => {
  it("publishes never-published datasets, marks published ones referenced-only, links the maps, and closes completed", async () => {
    const state = freshState();
    const stub = stubSupabase(pressResponder(state));
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(outcome).toEqual({
      bundleId: "bundle-1",
      collectionId: "collection-1",
      failedKeys: [],
      status: "completed",
    });
    // Exactly TWO publish_version calls — dataset-a (the artifact) AND
    // dataset-c (the map's non-artifact layer target, pulled into the plan
    // by the bundle closure); dataset-b joined referenced, never re-frozen.
    const rpcs = stub.queries.filter((query) => query.rpc === "publish_version");
    expect(rpcs).toHaveLength(2);
    // The deterministic publish key rides the bundle+member pair.
    const rpc = rpcs[0];
    expect(rpc === undefined ? undefined : rpc.rpcArgs.p_publish_key).toBe("bundle-1:member-a");
    expect(rpc === undefined ? undefined : rpc.rpcArgs.p_version_label).toBe("v1");
    expect(rpcs[1] === undefined ? undefined : rpcs[1].rpcArgs.p_publish_key).toBe(
      "bundle-1:member-c",
    );
    // The map member reached "linked" AFTER the dataset publishes (the leg order).
    expect(state.memberStatus.get("member-map")).toBe("linked");
    expect(state.memberStatus.get("member-a")).toBe("published");
    expect(state.memberStatus.get("member-c")).toBe("published");
    // The promoted collection files every dataset member whose frozen row
    // stands: the two newly frozen rows AND dataset-b filing itself as the
    // referenced member.
    const memberships = stub.queries.filter((query) => query.table === "collection_datasets");
    expect(memberships).toHaveLength(3);
  });

  it("joins a RUNNING press instead of forking a second bundle, reusing its collection", async () => {
    const state = freshState({ ...BUNDLE_ROW, collectionId: "collection-keep" });
    const stub = stubSupabase(pressResponder(state));
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(
      stub.queries.some(
        (query) =>
          query.table === "publish_bundles" &&
          query.operations.some((op) => op.method === "insert"),
      ),
    ).toBe(false);
    expect(outcome.collectionId).toBe("collection-keep");
    // The joined press reuses the bundle id (resume, not fork).
    expect(outcome.bundleId).toBe("bundle-1");
  });

  it("keeps completed members standing when a member fails, and closes the press 'failed'", async () => {
    const state = freshState();
    state.failOnPublishNumber = 1;
    const stub = stubSupabase(pressResponder(state));
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedKeys).toContain("dataset-a");
    // The first member's published checkpoint stands; the failed member's
    // error names the refusal.
    expect(state.memberStatus.get("member-a")).toBe("failed");
    const failedRecord = stub.queries.find(
      (query) =>
        query.table === "publish_bundle_members" &&
        query.operations.some(
          (op) => op.method === "update" && JSON.stringify(op.args[0]).includes("failed"),
        ),
    );
    expect(failedRecord === undefined ? "" : JSON.stringify(failedRecord.operations)).toContain(
      "row-level security",
    );
    // The run closed failed with the completed-members note.
    expect(
      stub.queries.some(
        (query) =>
          query.table === "publish_bundles" &&
          query.operations.some(
            (op) => op.method === "update" && JSON.stringify(op.args[0]).includes("failed"),
          ),
      ),
    ).toBe(true);
  });

  it("answers a foreign project with the not-found error (creator-only RLS shape)", async () => {
    const state = freshState();
    const stub = stubSupabase((query) => {
      if (query.table === "projects") {
        return { data: [] };
      }
      return pressResponder(state)(query);
    });
    await expect(
      pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client }),
    ).rejects.toThrow(/isn't yours/);
  });

  it("re-links an already-linked map member on a joined press and self-heals edges to the CURRENT layers", async () => {
    // The press JOINS a running bundle whose map member an earlier leg
    // already linked. Since then, the dataset-c layer was REMOVED from the
    // map: the plan-time snapshot carries both targets, but the leg-time
    // map_layers read returns only dataset-a — so the stale dataset-c edge
    // must not survive the leg (bundles.ts:1060-1123), and the linked
    // member must be re-walked at all (no skip leaves stale edges standing).
    const layerReads: string[][] = [];
    let layersReadCount = 0;
    // The scripted run for the resume leg — one branch per table the join
    // path touches (project, artifacts, heads, layers, edges, members,
    // bundles), each a two-line answer; the tests read it as one press.
    // oxlint-disable-next-line eslint/complexity -- the branch-per-table dispatch IS the scripted run, kept in one readable place.
    const stub = stubSupabase((query) => {
      if (query.table === "projects") {
        return { data: [PROJECT] };
      }
      if (query.table === "project_artifacts") {
        return { data: [ARTIFACTS[2]] };
      }
      if (query.table === "dataset_versions") {
        // Both layer targets already published — they join referenced and
        // the press runs only the map leg.
        return { data: [{ id: "version-1", versionLabel: "v1" }] };
      }
      if (query.table === "map_layers") {
        layersReadCount += 1;
        // First read = plan time (both targets); second read = leg time
        // (the dataset-c layer was removed in between).
        const targets = layersReadCount === 1 ? ["dataset-a", "dataset-c"] : ["dataset-a"];
        layerReads.push(targets);
        return { data: targets.map((targetId) => ({ targetId })) };
      }
      if (query.table === "consumer_references") {
        // A prior leg linked BOTH snapshot targets.
        return {
          data: [
            { consumerId: "map-1", id: "edge-a", sourceDatasetId: "dataset-a" },
            { consumerId: "map-1", id: "edge-c", sourceDatasetId: "dataset-c" },
          ],
        };
      }
      if (query.table === "publish_bundle_members") {
        const isUpdate = query.operations.some((op) => op.method === "update");
        if (isUpdate) {
          return { data: [{ id: "member-map" }] };
        }
        // The joined run's member read: the map member is ALREADY linked.
        return { data: [{ ...MEMBER_MAP, status: "linked" }] };
      }
      if (query.table === "publish_bundles") {
        if (query.operations.some((op) => op.method === "insert")) {
          return { data: [{ id: "bundle-2" }] };
        }
        if (query.operations.some((op) => op.method === "update")) {
          return { data: [{ ...BUNDLE_ROW, status: "completed" }] };
        }
        // The join/latest read: a RUNNING press (the resume path).
        return { data: [{ ...BUNDLE_ROW, collectionId: "collection-keep", status: "running" }] };
      }
      return { data: null };
    });
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(outcome.status).toBe("completed");
    expect(outcome.bundleId).toBe("bundle-1");
    // The leg re-read the layers (plan + leg), and reconciliation followed
    // the LEG-TIME answer: the stale dataset-c edge deleted, no new edges.
    expect(layersReadCount).toBe(2);
    expect(layerReads[1]).toStrictEqual(["dataset-a"]);
    const deletes = stub.queries.filter(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "delete"),
    );
    expect(deletes.length).toBe(1);
    const deleteQuery = at(deletes, 0);
    const deleteEq = deleteQuery.operations.find((op) => op.method === "eq");
    expect(deleteEq === undefined ? undefined : deleteEq.args).toStrictEqual(["id", "edge-c"]);
    expect(
      stub.queries.some(
        (query) =>
          query.table === "consumer_references" &&
          query.operations.some((op) => op.method === "insert"),
      ),
    ).toBe(false);
    // The linked member was re-stamped ("linked" again), not skipped.
    const stamps = stub.queries.filter(
      (query) =>
        query.table === "publish_bundle_members" &&
        query.operations.some((op) => op.method === "update" && op.args[0] !== null),
    );
    expect(
      stamps.some((query) =>
        query.operations.some(
          (op) =>
            op.method === "update" && (op.args[0] as Record<string, unknown>).status === "linked",
        ),
      ),
    ).toBe(true);
  });

  it("mints member rows through startBundle in the canonical plan order", async () => {
    const state = freshState();
    const stub = stubSupabase(pressResponder(state));
    await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    const memberInserts = stub.queries.filter(
      (query) =>
        query.table === "publish_bundle_members" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(memberInserts).toHaveLength(4);
    const keys = memberInserts.map((query) => {
      const insert = query.operations.find((op) => op.method === "insert");
      const payload = insert === undefined ? {} : (insert.args[0] as Record<string, unknown>);
      return String(payload.dataset_key);
    });
    // datasets first, then maps (the canonical order startBundle writes);
    // dataset-c is the map's layer target pulled into the plan, and
    // dataset-a appears ONCE despite being both an artifact and a layer
    // target (the closure dedupes by id).
    expect(keys).toEqual(["dataset-a", "dataset-b", "dataset-c", "map-1"]);
  });
});
