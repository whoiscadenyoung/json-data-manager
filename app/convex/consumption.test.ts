// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Versioned consumption's function-level behavior (roadmap stage 6, #101):
 * badge propagation through a derived chain, pin/float resolution with
 * sync/revert, the publish-completion delta vs fixture rows, and retention
 * with the pinned exemption — every acceptance criterion of the issue,
 * driven through `api.consumption.*` on a real (test) backend (the
 * publish.test.ts setup). The pure selection cores are exercised with plain
 * objects at the top, the versioning.test.ts shape.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import {
  badgeStateOf,
  chainAnchorOf,
  headOfAttemptChain,
  headOfComponentChain,
} from "./consumption";
import type { AttemptVersionLike, ChainVersion } from "./consumption";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app (the publish.test.ts setup). */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

type TestConvex = ReturnType<typeof signedIn>;

/** Runs every scheduled function — the import workflows, the publish poller, and the stage-6 completion hook — to completion. */
async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** One chunk blob, planted in the COMPONENT's storage (the publish.test.ts helper). */
async function storeChunk(t: TestConvex, rows: Array<{ data: unknown; geometry?: unknown }>) {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  return t.action(components.jsonCms.host_support.storeTestBlob, { bytes: bytes.buffer });
}

/** Creates a lifecycle-draft component dataset directly (the host-only path). The
 * suite's identity is stamped as creator — since stage 8 (#104) a draft is
 * invisible to every other identity, so the fixture must carry one. */
async function createDraftDataset(
  t: TestConvex,
  options: { entries?: Array<{ data: Record<string, unknown> }>; title?: string },
): Promise<string> {
  return t.run(async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.createSchema, {
      actorId: "user-1",
      lifecycle: "draft",
      schema: {
        properties: { label: { type: "string" } },
        title: options.title ?? "Source",
        type: "object",
      },
    }),
  );
}

/** Adds entries to a dataset through the public wrapper. */
async function addEntries(
  t: TestConvex,
  schemaId: string,
  rows: Array<{ data: Record<string, unknown> }>,
): Promise<void> {
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one write per row keeps ordering visible in assertions.
    await t.mutation(api.entries.create, { data: row.data, schemaId });
  }
}

/** Drives one full publish: plan → register → freeze → drain (the completion hook included). */
async function drivePublish(
  t: TestConvex,
  options: {
    attemptId: FunctionReturnType<typeof api.publish.start>["attemptId"];
    chunks: Array<Array<{ data: unknown }>>;
    kind?: "geospatial" | "standard";
    schema?: Record<string, unknown>;
    spec?: unknown;
    totalRows: number;
  },
): Promise<{ schemaId: string }> {
  await t.mutation(api.publish.plan, {
    attemptId: options.attemptId,
    chunkCount: options.chunks.length,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.spec === undefined ? {} : { spec: options.spec }),
    totalRows: options.totalRows,
  });
  for (const chunk of options.chunks) {
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    const storageId = await storeChunk(t, chunk);
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    await t.mutation(api.publish.registerChunk, { attemptId: options.attemptId, storageId });
  }
  const frozen = await t.mutation(api.publish.freeze, { attemptId: options.attemptId });
  await drainScheduled(t);
  return { schemaId: frozen.schemaId };
}

/** Publishes a draft's current rows as its next version (start → drive). */
async function publishDraft(
  t: TestConvex,
  draftId: string,
  rows: Array<{ data: Record<string, unknown> }>,
): Promise<{ schemaId: string }> {
  const started = await t.mutation(api.publish.start, { datasetKey: draftId });
  return drivePublish(t, {
    attemptId: started.attemptId,
    chunks: rows.length === 0 ? [] : [rows],
    totalRows: rows.length,
  });
}

/** Saves (or re-saves) a transform spec over one source dataset and publishes it. */
async function publishDerived(
  t: TestConvex,
  options: {
    chunks: Array<Array<{ data: unknown }>>;
    registryId?: string;
    sourceDatasetId: string;
    title: string;
  },
): Promise<{ registryId: string; schemaId: string }> {
  const spec = { operations: [], sourceDatasetId: options.sourceDatasetId };
  const registryId = await t.mutation(api.derivedDatasets.save, {
    ...(options.registryId === undefined ? {} : { id: options.registryId }),
    spec,
    status: "saved",
    title: options.title,
  });
  const started = await t.mutation(api.publish.start, { datasetKey: registryId });
  const driven = await drivePublish(t, {
    attemptId: started.attemptId,
    chunks: options.chunks,
    // A derived freeze records the client-reported kind — a spec without a
    // geometry source is a standard publish (the publish.test.ts shape).
    kind: "standard",
    schema: { properties: { label: { type: "string" } }, title: options.title, type: "object" },
    spec,
    totalRows: options.chunks.reduce((total, chunk) => total + chunk.length, 0),
  });
  return { registryId, schemaId: driven.schemaId };
}

/** The house lint bans optional chaining — these narrow the deep doc reads. */
function refOf(doc: { lineage?: { snapshotRef?: string } } | null): string | undefined {
  return doc === null || doc.lineage === undefined ? undefined : doc.lineage.snapshotRef;
}

/** Narrow a stored delta (or any nullable count bag) for assertions without optional chaining. */
function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value in this test");
  }
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure selection cores (plain objects — the versioning.test.ts shape)
// ---------------------------------------------------------------------------

/** A frozen version doc with only what the pure heads read. */
function version(id: string, frozenAt: number, ref: string, label: string): ChainVersion {
  return { _id: id, lineage: { frozenAt, snapshotRef: ref, versionLabel: label } };
}

/** One attempt doc with only what the pure head reads. */
function attempt(id: number, values: Partial<AttemptVersionLike>): AttemptVersionLike {
  return {
    _creationTime: id,
    publishKey: `pub-${id}`,
    publishedSchemaId: `row-${id}`,
    status: "completed",
    title: "T",
    versionLabel: `v${id}`,
    ...values,
  };
}

describe("pure cores", () => {
  describe("headOfComponentChain", () => {
    it("picks the newest freeze, not list order", () => {
      const head = headOfComponentChain([
        version("v1", 10, "r1", "v1"),
        version("v3", 30, "r3", "v3"),
        version("v2", 20, "r2", "v2"),
      ]);
      expect(head).toStrictEqual({ frozenAt: 30, ref: "r3", schemaId: "v3", versionLabel: "v3" });
    });

    it("skips versions without a snapshot ref", () => {
      const head = headOfComponentChain([
        { _id: "vBare", lineage: { frozenAt: 50 } },
        version("v1", 10, "r1", "v1"),
      ]);
      expect(head === undefined ? undefined : head.ref).toBe("r1");
    });

    it("answers undefined for an empty chain", () => {
      expect(headOfComponentChain([])).toBeUndefined();
    });
  });

  describe("headOfAttemptChain", () => {
    it("counts only completed attempts as heads — in-flight ones never badge", () => {
      const head = headOfAttemptChain([
        attempt(1, {}),
        attempt(2, { status: "uploading" }),
        attempt(3, { status: "importing" }),
      ]);
      expect(head === undefined ? undefined : head.ref).toBe("pub-1");
    });

    it("picks the newest by finishedAt and skips attempts without a frozen row", () => {
      const head = headOfAttemptChain([
        attempt(1, { finishedAt: 100 }),
        attempt(2, { finishedAt: 300 }),
        attempt(3, { finishedAt: 400, publishedSchemaId: undefined }),
      ]);
      expect(head === undefined ? undefined : head.ref).toBe("pub-2");
      expect(head === undefined ? undefined : head.versionLabel).toBe("v2");
    });

    it("falls back to creation time when an attempt never recorded finish time", () => {
      const head = headOfAttemptChain([attempt(1, { finishedAt: undefined })]);
      expect(head === undefined ? undefined : head.frozenAt).toBe(1);
    });
  });

  describe("badgeStateOf", () => {
    const head = { frozenAt: 2, ref: "r2", schemaId: "row2", versionLabel: "v2" };

    it("drifts when the recorded ref differs from the head", () => {
      expect(badgeStateOf({ ref: "r1" }, head)).toBe("drift");
    });

    it("is current when the recorded ref IS the head", () => {
      expect(badgeStateOf({ ref: "r2" }, head)).toBe("current");
    });

    it("drifts for a live read whose head froze after the consumer did", () => {
      expect(badgeStateOf({}, head, 1)).toBe("drift");
    });

    it("a head that predates the consumer's freeze is already reflected — current", () => {
      expect(badgeStateOf({}, head, 2)).toBe("current");
      expect(badgeStateOf({}, head, 3)).toBe("current");
      // Without the consumer's freeze time, a live read vs a head drifts.
      expect(badgeStateOf({}, head)).toBe("drift");
    });

    it("reads a vanished chain as missing and a never-published live source as live", () => {
      expect(badgeStateOf({ ref: "r1" }, undefined)).toBe("missing");
      expect(badgeStateOf({}, undefined)).toBe("live");
    });
  });

  describe("chainAnchorOf", () => {
    it("prefers the component anchor, then the registry anchor, then the dataset itself", () => {
      expect(chainAnchorOf({ sourceKey: "reg-1", sourceSchemaId: "draft-1" }, "row")).toBe(
        "draft-1",
      );
      expect(chainAnchorOf({ sourceKey: "reg-1" }, "row")).toBe("reg-1");
      expect(chainAnchorOf(undefined, "live-1")).toBe("live-1");
    });
  });
});

// ---------------------------------------------------------------------------
// Badge propagation through a derived chain (the AC)
// ---------------------------------------------------------------------------

describe("badge propagation through a derived chain (AC)", () => {
  it("badges a derived consumer when its source republishes, clears when it syncs, and propagates transitively", async () => {
    const t = signedIn();

    // Source draft, published once (v1) — the draft stays live, the real
    // stage-2 shape: transforms author over the LIVE dataset.
    const draftId = await createDraftDataset(t, { title: "Source" });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    await publishDraft(t, draftId, [{ data: { label: "A" } }]);

    // Derived T over the LIVE source; its freeze records {ref: undefined}
    // (live read). A consumer of T (derived-of-derived, the registry anchor)
    // — the transitive leg.
    const t1 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      sourceDatasetId: draftId,
      title: "T",
    });
    const u1 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      sourceDatasetId: t1.registryId,
      title: "U",
    });

    // Current at first: the source's existing head froze BEFORE T did (and
    // U's recorded ref IS T's head attempt).
    const before = await t.query(api.consumption.sourceBadges, {
      registryIds: [t1.registryId, u1.registryId],
      schemaIds: [t1.schemaId],
    });
    const t1Badge = before.byRegistryId[t1.registryId][0];
    expect(t1Badge.state).toBe("current");
    expect(t1Badge.sourceDatasetId).toBe(draftId);
    expect(t1Badge.sourceTitle).toBe("Source");
    expect(before.byRegistryId[u1.registryId][0].state).toBe("current");

    // The source republishes → v2: T drifts — a head froze AFTER T did.
    await addEntries(t, draftId, [{ data: { label: "B" } }]);
    await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    const drifted = await t.query(api.consumption.sourceBadges, {
      registryIds: [t1.registryId, u1.registryId],
      schemaIds: [t1.schemaId],
    });
    const driftedT = drifted.byRegistryId[t1.registryId][0];
    expect(driftedT.state).toBe("drift");
    expect(driftedT.headVersionLabel).toBe("v2");
    expect(drifted.byRegistryId[u1.registryId][0].state).toBe("current");

    // Sync T = re-run the spec through the 5b machine (the SAME registry
    // row): the new version freezes AFTER v2, re-recording its sources —
    // T's badge clears.
    const t2 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }, { data: { label: "B" } }]],
      registryId: t1.registryId,
      sourceDatasetId: draftId,
      title: "T",
    });
    expect(t2.schemaId).not.toBe(t1.schemaId);
    const afterT = await t.query(api.consumption.sourceBadges, {
      registryIds: [t1.registryId, u1.registryId],
      schemaIds: [],
    });
    expect(afterT.byRegistryId[t1.registryId][0].state).toBe("current");
    // Transitive by construction: T's new attempt is now the head of T's
    // chain, and U's recorded ref is T's OLD head — U drifts without any
    // notify machinery.
    expect(afterT.byRegistryId[u1.registryId][0].state).toBe("drift");

    // Syncing U clears it the same way.
    await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }, { data: { label: "B" } }]],
      registryId: u1.registryId,
      sourceDatasetId: t1.registryId,
      title: "U",
    });
    const afterU = await t.query(api.consumption.sourceBadges, {
      registryIds: [u1.registryId],
      schemaIds: [],
    });
    expect(afterU.byRegistryId[u1.registryId][0].state).toBe("current");
  });

  it("does not badge on an in-flight attempt (only completed ones are heads)", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {});
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    const t1 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      sourceDatasetId: draftId,
      title: "T",
    });

    // An in-flight (uploading) attempt for the source exists now — it must
    // NOT read as a head.
    await t.mutation(api.publish.start, { datasetKey: draftId });
    const badges = await t.query(api.consumption.sourceBadges, {
      registryIds: [t1.registryId],
      schemaIds: [],
    });
    expect(badges.byRegistryId[t1.registryId][0].state).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// References: pin/float, sync (repin to head), revert (repin to prior)
// ---------------------------------------------------------------------------

describe("reference pin/float, sync, and revert (AC)", () => {
  async function chainWithReference(t: TestConvex) {
    const draftId = await createDraftDataset(t, { title: "Source" });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    const t1 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      sourceDatasetId: v1.schemaId,
      title: "T",
    });
    // The save wrote one float reference edge for the saved spec.
    const consumedBy = await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId });
    const consumer = consumedBy.consumers.find((entry) => entry.consumerId === t1.registryId);
    if (consumer === undefined || consumer.referenceId === undefined) {
      throw new Error("the saved spec's reference edge is missing");
    }
    return { consumer, consumedBy, draftId, t1, v1 };
  }

  it("saves float edges for a saved spec and lists them in consumed-by", async () => {
    const t = signedIn();
    const { consumer, v1 } = await chainWithReference(t);
    expect(consumer.mode).toBe("float");
    expect(consumer.changed).toBe(false);
    expect(consumer.consumerKind).toBe("derived");
    expect(consumer.title).toBe("T");
    // Stage 6 shipped the projection knowing "derived" only; 7b (#103) adds
    // the fork and map kinds (projects.addArtifact's edge, the bundle press's
    // layer edges).
    expect(
      consumedByKnownKinds(await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId })),
    ).toStrictEqual(["derived", "fork", "map"]);
  });

  it("pins to head, drifts when the source republishes, and sync repins to the new head", async () => {
    const t = signedIn();
    const { consumer, draftId, v1 } = await chainWithReference(t);

    // Pin: mode pin, ref = the current head's ref.
    await t.mutation(api.consumption.setReferenceMode, {
      mode: "pin",
      referenceId: consumer.referenceId ?? "",
    });
    let row = await referenceRow(t, v1.schemaId, consumer.consumerId);
    expect(row.mode).toBe("pin");
    expect(row.pinnedRef).toBe((await headRefOf(t, draftId)) ?? "");

    // The source republishes: the pinned reference reads as changed.
    const v2 = await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    const changed = await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId });
    const changedConsumer = changed.consumers.find(
      (entry) => entry.consumerId === consumer.consumerId,
    );
    expect(defined(changedConsumer).changed).toBe(true);

    // Sync: repin to head — the reference now points at v2's ref.
    const synced = await t.mutation(api.consumption.syncReference, {
      referenceId: consumer.referenceId ?? "",
    });
    expect(synced.mode).toBe("pin");
    row = await referenceRow(t, v1.schemaId, consumer.consumerId);
    const v2Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v2.schemaId }),
    );
    expect(row.pinnedRef).toBe(refOf(v2Head));
    expect(row.pinnedSchemaId).toBe(v2.schemaId);
  });

  it("drops a consumer whose transform was demoted to draft or deleted — no ghosts", async () => {
    const t = signedIn();
    const { consumer, v1 } = await chainWithReference(t);

    // The builder autosave re-saves a saved row as draft: the edge survives,
    // but a draft is invisible to catalog consumers (lifecycle §3), so the
    // consumed-by list must not surface it.
    await t.mutation(api.derivedDatasets.save, {
      id: consumer.consumerId,
      spec: { operations: [], sourceDatasetId: v1.schemaId },
      status: "draft",
      title: "T",
    });
    let listing = await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId });
    expect(listing.consumers).toStrictEqual([]);

    // Re-saving restores the consumer (the edge never went away).
    await t.mutation(api.derivedDatasets.save, {
      id: consumer.consumerId,
      spec: { operations: [], sourceDatasetId: v1.schemaId },
      status: "saved",
      title: "T",
    });
    listing = await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId });
    expect(listing.consumers).toHaveLength(1);

    // Deleting the transform takes its edges with it — no ghost consumer.
    await t.mutation(api.derivedDatasets.remove, { id: consumer.consumerId });
    listing = await t.query(api.consumption.consumedBy, { datasetId: v1.schemaId });
    expect(listing.consumers).toStrictEqual([]);
  });

  it("sync is a no-op for a float reference and errors honestly with no versions to pin", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {});
    const t1 = await publishDerived(t, {
      chunks: [],
      sourceDatasetId: draftId,
      title: "T over live",
    });
    // The spec consumed a LIVE draft (never published): float reference, no head.
    const consumedBy = await t.query(api.consumption.consumedBy, { datasetId: draftId });
    const consumer = consumedBy.consumers.find((entry) => entry.consumerId === t1.registryId);
    expect(defined(consumer).mode).toBe("float");
    await expect(
      t.mutation(api.consumption.setReferenceMode, {
        mode: "pin",
        referenceId: defined(consumer).referenceId ?? "",
      }),
    ).rejects.toThrow(/no published versions to pin/i);
  });

  it("revert repins to the prior version, and the first version refuses honestly", async () => {
    const t = signedIn();
    const { consumer, draftId, v1 } = await chainWithReference(t);

    // Pin to v1's ref, then republish to v2 and sync to it.
    await t.mutation(api.consumption.setReferenceMode, {
      mode: "pin",
      referenceId: consumer.referenceId ?? "",
    });
    const v2 = await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    await t.mutation(api.consumption.syncReference, { referenceId: consumer.referenceId ?? "" });
    const v2Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v2.schemaId }),
    );

    // Revert: back to the PRIOR version's ref (append-only — v2 stays).
    const reverted = await t.mutation(api.consumption.revertReference, {
      referenceId: consumer.referenceId ?? "",
    });
    const v1Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v1.schemaId }),
    );
    expect(reverted.pinnedRef).toBe(refOf(v1Head));
    expect(refOf(v2Head)).not.toBe(reverted.pinnedRef);
    expect((await headRefOf(t, draftId)) ?? "").not.toBe(reverted.pinnedRef);

    // At the chain's first version there is nothing to revert to.
    await expect(
      t.mutation(api.consumption.revertReference, { referenceId: consumer.referenceId ?? "" }),
    ).rejects.toThrow(/first version/i);
  });
});

/** The consumedBy result's known-consumer kinds (test-local narrow). */
function consumedByKnownKinds(result: { knownConsumerKinds: string[] }): string[] {
  return result.knownConsumerKinds;
}

/** The reference row on `sourceId` held by `consumerId`, read through the consumed-by projection. */
async function referenceRow(
  t: TestConvex,
  sourceId: string,
  consumerId: string,
): Promise<{ mode: string; pinnedRef?: string; pinnedSchemaId?: string }> {
  const consumedBy = await t.query(api.consumption.consumedBy, { datasetId: sourceId });
  const consumer = consumedBy.consumers.find((entry) => entry.consumerId === consumerId);
  if (consumer === undefined) {
    throw new Error("reference vanished");
  }
  return {
    mode: consumer.mode,
    pinnedRef: consumer.pinnedRef,
    pinnedSchemaId: consumer.pinnedSchemaId,
  };
}

/** The current head ref of a draft-published chain (raw component read). */
async function headRefOf(t: TestConvex, anchorId: string): Promise<string | undefined> {
  return t.run(async (ctx) => {
    const versions = await ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      sourceSchemaId: anchorId,
    });
    const newest = versions[0];
    return refOf(newest);
  });
}

// ---------------------------------------------------------------------------
// The publish-completion delta (vs fixture rows)
// ---------------------------------------------------------------------------

describe("publish-completion delta vs fixture rows (AC)", () => {
  it("records the stored sequential delta and matches the on-demand diff's counts", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { title: "Source" });
    const v1 = await publishDraft(t, draftId, [
      { data: { label: "A" } },
      { data: { label: "B", note: "old" } },
    ]);
    // v2: B updated, A removed, C added — the fixture the counts check against.
    const v2 = await publishDraft(t, draftId, [
      { data: { label: "B", note: "new" } },
      { data: { label: "C" } },
    ]);
    const v1Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v1.schemaId }),
    );
    const v2Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v2.schemaId }),
    );
    const fromRef = refOf(v1Head) ?? "",
      toRef = refOf(v2Head) ?? "";

    // The completion hook (drainScheduled ran it) recorded the stored delta,
    // keyed by the chain anchor.
    const stored = await t.query(api.consumption.storedDelta, {
      anchorId: draftId,
      fromRef,
      toRef,
    });
    expect(stored).not.toBeNull();
    const counts = defined(stored);
    expect(counts.added).toBe(1);
    expect(counts.removed).toBe(1);
    expect(counts.updated).toBe(1);
    // The ops carry before/after values in the commits' shape.
    const updateOp = counts.ops.find((op) => op.op === "update");
    expect(defined(updateOp).entryKey).toBe("B");
    expect(defined(updateOp).fields).toStrictEqual([{ name: "note", before: "old", after: "new" }]);

    // The shipped on-demand diff agrees — reuse, not a second diff engine.
    const onDemand = await t.query(api.tags.getVersionDelta, {
      aSchemaId: v1.schemaId,
      bSchemaId: v2.schemaId,
    });
    expect(onDemand.added).toBe(counts.added);
    expect(onDemand.removed).toBe(counts.removed);
    expect(onDemand.updated).toBe(counts.updated);

    // A republish of identical rows records an EMPTY delta (append-only, but
    // the sequential record is honest about "nothing changed").
    const v3 = await publishDraft(t, draftId, [
      { data: { label: "B", note: "new" } },
      { data: { label: "C" } },
    ]);
    const v3Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v3.schemaId }),
    );
    const empty = await t.query(api.consumption.storedDelta, {
      anchorId: draftId,
      fromRef: toRef,
      toRef: refOf(v3Head) ?? "",
    });
    const emptyCounts = defined(empty);
    expect(emptyCounts.added).toBe(0);
    expect(emptyCounts.removed).toBe(0);
    expect(emptyCounts.updated).toBe(0);
    expect(emptyCounts.ops).toStrictEqual([]);
  });

  it("answers null for a pair no stored delta covers (fall back to on-demand)", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {});
    expect(
      await t.query(api.consumption.storedDelta, {
        anchorId: draftId,
        fromRef: "nope",
        toRef: "nope",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retention: keep-N with the pinned exemption, on both chain kinds (AC)
// ---------------------------------------------------------------------------

describe("retention keeps newest-N unpinned and never retires a pinned one (AC)", () => {
  it("retires surplus unpinned versions at publish completion; the pinned ref is exempt", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { title: "Source" });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);

    // Pin v1 into the chain's policy store, then tighten keep to 1.
    await t.mutation(api.consumption.setChainVersionPinned, {
      pinned: true,
      schemaId: v1.schemaId,
    });
    const policy = await t.query(api.consumption.retentionPolicy, { anchorId: draftId });
    expect(policy.store).toBe("chain");
    expect(policy.pinnedRefs).toHaveLength(1);

    await t.mutation(api.consumption.setChainKeep, { anchorId: draftId, keep: 1 });
    const v2 = await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    const v3 = await publishDraft(t, draftId, [{ data: { label: "C" } }]);

    // v2 (unpinned surplus) retired at v3's completion; v1 (pinned) survives.
    expect(await schemaExists(t, v2.schemaId)).toBe(false);
    expect(await schemaExists(t, v1.schemaId)).toBe(true);
    expect(await schemaExists(t, v3.schemaId)).toBe(true);
  });

  it("lifts the derived-side pin refusal: a published derived version pins under its chain", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {});
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    const t1 = await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      sourceDatasetId: v1.schemaId,
      title: "T",
    });

    // The pre-stage-6 refusal is gone: setVersionPinned lands in the
    // publish-chain store keyed by the sourceKey anchor.
    await t.mutation(api.tags.setVersionPinned, { pinned: true, schemaId: t1.schemaId });
    const policy = await t.query(api.consumption.retentionPolicy, { anchorId: t1.registryId });
    expect(policy.store).toBe("chain");
    expect(policy.pinnedRefs).toHaveLength(1);

    // Retention at the next publish never retires the pinned version.
    await t.mutation(api.consumption.setChainKeep, { anchorId: t1.registryId, keep: 1 });
    await publishDerived(t, {
      chunks: [[{ data: { label: "A" } }]],
      registryId: t1.registryId,
      sourceDatasetId: v1.schemaId,
      title: "T",
    });
    expect(await schemaExists(t, t1.schemaId)).toBe(true);
  });
});

/** Whether a component row still exists (retirement check). */
async function schemaExists(t: TestConvex, schemaId: string): Promise<boolean> {
  return t.run(
    async (ctx) => (await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId })) !== null,
  );
}

// ---------------------------------------------------------------------------
// analysisTargets (stage 9, #105) — the resolve-then-feed leg: identity for
// frozen version rows and chain-less datasets, float at head for live chain
// anchors, registry for visible registry rows, and "missing" for anything
// the caller cannot see (a foreign draft's existence never leaking).
// ---------------------------------------------------------------------------

describe("analysisTargets", () => {
  it("reads a frozen version row as itself (identity — the author named immutable rows)", async () => {
    const t = signedIn(),
      draft = await createDraftDataset(t, { title: "Frozen source" }),
      { schemaId: frozenV1 } = await publishDraft(t, draft, [{ data: { label: "a" } }]);
    expect(
      await t.query(api.consumption.analysisTargets, { datasetIds: [frozenV1] }),
    ).toStrictEqual([
      {
        datasetId: frozenV1,
        resolvedSchemaId: frozenV1,
        status: "identity",
        title: "Frozen source",
      },
    ]);
  });

  it("floats a live chain anchor to the head, and follows a republish to the new head", async () => {
    const t = signedIn(),
      draft = await createDraftDataset(t, { title: "Anchored source" }),
      { schemaId: frozenV1 } = await publishDraft(t, draft, [{ data: { label: "a" } }]),
      first = await t.query(api.consumption.analysisTargets, { datasetIds: [draft] });
    expect(first).toStrictEqual([
      { datasetId: draft, resolvedSchemaId: frozenV1, status: "float", title: "Anchored source" },
    ]);
    const { schemaId: frozenV2 } = await publishDraft(t, draft, [{ data: { label: "b" } }]),
      second = await t.query(api.consumption.analysisTargets, { datasetIds: [draft] });
    expect(second).toStrictEqual([
      { datasetId: draft, resolvedSchemaId: frozenV2, status: "float", title: "Anchored source" },
    ]);
    expect(frozenV2).not.toBe(frozenV1);
  });

  it("reads a chain-less dataset (a draft, nothing published) as itself", async () => {
    const t = signedIn(),
      draft = await createDraftDataset(t, { title: "Plain draft" });
    expect(await t.query(api.consumption.analysisTargets, { datasetIds: [draft] })).toStrictEqual([
      { datasetId: draft, resolvedSchemaId: draft, status: "identity", title: "Plain draft" },
    ]);
  });

  it("answers missing for unknown ids and for a foreign draft — a draft's existence never leaks (stage 8)", async () => {
    const t = signedIn(),
      foreignDraft = await t.withIdentity({ subject: "user-2" }).run(async (ctx) =>
        ctx.runMutation(components.jsonCms.lib.createSchema, {
          actorId: "user-2",
          lifecycle: "draft",
          schema: { properties: { label: { type: "string" } }, title: "Secret", type: "object" },
        }),
      );
    expect(
      await t.query(api.consumption.analysisTargets, {
        datasetIds: ["nonexistent-id", foreignDraft],
      }),
    ).toStrictEqual([
      { datasetId: "nonexistent-id", status: "missing" },
      { datasetId: foreignDraft, status: "missing" },
    ]);
  });

  it("answers registry for a visible registry row (own draft, or any saved row) and missing for a foreign draft row", async () => {
    const t = signedIn(),
      source = await createDraftDataset(t, { title: "Source" }),
      spec = { operations: [], sourceDatasetId: source },
      draftRow = await t.mutation(api.derivedDatasets.save, {
        spec,
        status: "draft",
        title: "Own analysis draft",
      });
    expect(
      await t.query(api.consumption.analysisTargets, { datasetIds: [draftRow] }),
    ).toStrictEqual([{ datasetId: draftRow, status: "registry" }]);
    const asUser2 = t.withIdentity({ subject: "user-2" });
    expect(
      await asUser2.query(api.consumption.analysisTargets, { datasetIds: [draftRow] }),
    ).toStrictEqual([{ datasetId: draftRow, status: "missing" }]);
    // The explicit Save flips the row to saved — catalog-visible, so the
    // foreign caller now gets the distinct "registry" answer.
    await t.mutation(api.derivedDatasets.save, {
      id: draftRow,
      spec,
      status: "saved",
      title: "Saved analysis",
    });
    expect(
      await asUser2.query(api.consumption.analysisTargets, { datasetIds: [draftRow] }),
    ).toStrictEqual([{ datasetId: draftRow, status: "registry" }]);
  });
});
