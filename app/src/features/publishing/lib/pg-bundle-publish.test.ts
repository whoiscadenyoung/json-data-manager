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
// The completed-press fixture: datasets only. Map memberships left with
// #256 (the artifact kind domain narrowed to dataset|derived, 0019/ADR
// 0018); derived rows join the plan but their publish still refuses (the
// press's honest failure) — so a COMPLETED press needs a datasets-only
// catalog, and the plan-order test overrides the artifacts read to include
// the derived row.
const ARTIFACTS = [
  {
    addedBy: "creator-1",
    artifactId: "dataset-a",
    artifactKind: "dataset",
    id: "art-1",
    projectId: "project-1",
    role: "linked",
    syncMode: "manual",
  },
  {
    addedBy: "creator-1",
    artifactId: "dataset-b",
    artifactKind: "dataset",
    id: "art-2",
    projectId: "project-1",
    role: "linked",
    syncMode: "manual",
  },
];
const ARTIFACTS_WITH_DERIVED = [
  ...ARTIFACTS,
  {
    addedBy: "creator-1",
    artifactId: "derived-1",
    artifactKind: "derived",
    id: "art-3",
    projectId: "project-1",
    role: "linked",
    syncMode: "manual",
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
const MEMBER_D = {
  ...MEMBER_A,
  datasetKey: "derived-1",
  id: "member-d",
  kind: "derived",
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
 * `artifacts` names the catalog the plan reads — the plan-order test swaps
 * in the derived variant.
 */
function pressResponder(state: {
  artifacts: Record<string, unknown>[];
  bundlesInserts: number;
  failOnPublishNumber: number;
  latest: Record<string, unknown> | null;
  minted: string[];
  publishes: number;
  memberStatus: Map<string, string>;
  lifecycleFlips: string[];
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
      return { data: state.artifacts };
    }
    if (query.table === "dataset_versions") {
      // dataset-b already published (its head exists); dataset-a never did.
      const eq = methodOf(query, "eq");
      const datasetId = eq === undefined ? undefined : eq[1];
      if (datasetId === "dataset-b") {
        return { data: [{ id: "version-b1", versionLabel: "v1" }] };
      }
      return { data: [] };
    }
    if (query.table === "datasets") {
      // #276: the press's lifecycle flip for owned drafts — answered with
      // the updated row (draftFlipped true) and recorded for assertions.
      const update = methodOf(query, "update");
      if (update !== undefined) {
        const idOp = query.operations.find((op) => op.method === "eq" && op.args[0] === "id");
        const datasetId = idOp === undefined ? undefined : idOp.args[1];
        if (typeof datasetId === "string") {
          state.lifecycleFlips.push(datasetId);
          return { data: [{ id: datasetId }] };
        }
        return { data: [] };
      }
      return { data: [] };
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
        const args = methodOf(query, "insert");
        const payload = args === undefined ? undefined : (args[0] as Record<string, unknown>);
        if (payload !== undefined && typeof payload.dataset_key === "string") {
          state.minted.push(payload.dataset_key);
        }
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
      // The member read: the rows the plan ACTUALLY MINTED (the insert
      // branch records them), statuses reflecting the recorded checkpoints
      // — never more members than the plan produced.
      const planned: Array<Record<string, unknown>> = [];
      for (const key of state.minted) {
        if (key === "dataset-a") {
          planned.push({ ...MEMBER_A, status: state.memberStatus.get("member-a") ?? "pending" });
        } else if (key === "dataset-b") {
          planned.push({ ...MEMBER_B, status: state.memberStatus.get("member-b") ?? "referenced" });
        } else if (key === "derived-1") {
          planned.push({ ...MEMBER_D, status: state.memberStatus.get("member-d") ?? "pending" });
        }
      }
      return { data: planned };
    }
    return { data: null };
  };
}

function freshState(latest: Record<string, unknown> | null = null): {
  artifacts: Record<string, unknown>[];
  bundlesInserts: number;
  failOnPublishNumber: number;
  latest: Record<string, unknown> | null;
  /** The member rows the plan ACTUALLY minted (the stub's insert branch records them). */
  minted: string[];
  publishes: number;
  memberStatus: Map<string, string>;
  /** The datasets the press flipped to published (#276's lifecycle leg). */
  lifecycleFlips: string[];
} {
  return {
    artifacts: ARTIFACTS,
    bundlesInserts: 0,
    failOnPublishNumber: -1,
    latest,
    minted: [],
    publishes: 0,
    memberStatus: new Map(),
    lifecycleFlips: [],
  };
}

describe("pgPublishProjectBundle", () => {
  it("publishes never-published datasets, marks published ones referenced-only, and closes completed", async () => {
    const state = freshState();
    const stub = stubSupabase(pressResponder(state));
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(outcome).toEqual({
      bundleId: "bundle-1",
      collectionId: "collection-1",
      failedKeys: [],
      status: "completed",
      visibilityCappedBy: 0,
    });
    // Exactly ONE publish_version call — dataset-a (the never-published
    // artifact); dataset-b joined referenced, never re-frozen. The map legs
    // left with #256 (map memberships are out of the artifact domain until
    // [project 3] re-owns maps).
    const rpcs = stub.queries.filter((query) => query.rpc === "publish_version");
    expect(rpcs).toHaveLength(1);
    const rpc = at(rpcs, 0);
    // The deterministic publish key rides the bundle+member pair.
    expect(rpc.rpcArgs.p_publish_key).toBe("bundle-1:member-a");
    expect(rpc.rpcArgs.p_version_label).toBe("v1");
    expect(state.memberStatus.get("member-a")).toBe("published");
    // The promoted collection files every dataset member whose frozen row
    // stands: the newly frozen row AND dataset-b filing itself as the
    // referenced member.
    const memberships = stub.queries.filter((query) => query.table === "collection_datasets");
    expect(memberships).toHaveLength(2);
    // #276: the freeze rides the single-publish's lifecycle flip, so the
    // pressed draft enters the catalog like a hand-published one. dataset-b
    // (referenced-only) is never touched.
    expect(state.lifecycleFlips).toEqual(["dataset-a"]);
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

  it("mints member rows through startBundle in the canonical plan order", async () => {
    // Derived/layer/app artifacts stay OUT of the plan (#262 — D6: a press
    // is a dataset projection; layers and apps freeze per-artifact, and
    // derived rows are re-executed registry entries with no freeze). The
    // derived row in the catalog must not mint a member row nor fail the
    // press.
    const state = freshState();
    state.artifacts = ARTIFACTS_WITH_DERIVED;
    const stub = stubSupabase(pressResponder(state));
    const outcome = await pgPublishProjectBundle({ projectId: "project-1", supabase: stub.client });
    expect(outcome.failedKeys).not.toContain("derived-1");
    const memberInserts = stub.queries.filter(
      (query) =>
        query.table === "publish_bundle_members" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(memberInserts).toHaveLength(2);
    const keys = memberInserts.map((query) => {
      const insert = query.operations.find((op) => op.method === "insert");
      const payload = insert === undefined ? {} : (insert.args[0] as Record<string, unknown>);
      return String(payload.dataset_key);
    });
    expect(keys).toEqual(["dataset-a", "dataset-b"]);
  });
});
