// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Sharing & multi-user isolation (roadmap stage 8, #104) — the issue's
 * acceptance criteria as MULTI-IDENTITY tests on one shared backend (the
 * projects.test.ts pattern: a second `withIdentity` on the SAME instance, so
 * the assertions run against real data, never a second empty database):
 *
 * - isolation: user B cannot see or touch user A's projects, drafts, or
 *   unpublished artifacts in ANY query path — enumerations, the drafts
 *   toggle, and every by-id surface (the pre-stage-8 by-id leak);
 * - sharing grants: published datasets stay shared (the D2 default), the
 *   author can narrow one to themselves server-side, and the choice
 *   inherits onto the frozen row at publish;
 * - anonymous denial: the 0.1 gate holds across every project/share surface.
 *
 * The recorded decisions (issue #104 comment): D1 — per-creator private
 * projects, no share grants; D2 — per-artifact published visibility
 * ("author" | "everyone", default everyone) enforced server-side; maps/
 * collections/groups stay shared catalog artifacts (no identity dimension).
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema";
const modules = import.meta.glob("./**/*.ts");

const GATE_MESSAGE = /signed out/i;
/** The indistinguishable denial: a foreign row reads exactly as a missing one. */
const NO_ACCESS = /doesn't exist or you don't have access/i;
const GONE_PROJECT = /project no longer exists/i;
const GONE_RUN = /run no longer exists/i;
const GONE_ATTEMPT = /attempt no longer exists/i;
const GONE_REFERENCE = /reference no longer exists/i;
const NOTHING_TO_PUBLISH = /Nothing to publish was found/i;

/** A fresh test backend with the json-cms component mounted as in the app (the projects.test.ts shape). */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn(subject = "user-1") {
  return initTest().withIdentity({ subject });
}

type TestConvex = ReturnType<typeof signedIn>;

async function createProject(t: TestConvex, title = "SMART 2024"): Promise<string> {
  return t.mutation(api.projects.create, { title });
}

/** A lifecycle-draft dataset born INTO a project — the creator is stamped by the mutation. */
async function createProjectDraft(
  t: TestConvex,
  projectId: string,
  title = "Draft locations",
): Promise<string> {
  return t.mutation(api.projects.createDraftDataset, {
    projectId,
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** An ordinary PUBLISHED dataset through the pre-existing wrapper (absent lifecycle reads as published; createdBy = the caller). */
async function createPublishedDataset(t: TestConvex, title = "Published points"): Promise<string> {
  return t.mutation(api.schemas.create, {
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

async function addEntry(t: TestConvex, schemaId: string, label: string): Promise<string> {
  return t.mutation(api.entries.create, { data: { label }, schemaId });
}

/** The pending-upload token a chunk registration must present — issued for
 * `scope`, exactly as the client's upload flow does (issue #131). */
async function uploadToken(t: TestConvex, scope: string): Promise<string> {
  const { uploadId } = await t.run(async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.generateUploadUrl, { scope }),
  );
  return uploadId;
}

/**
 * Drives one publish to completion for `datasetKey` (a draft dataset id or a
 * saved registry row id) and returns the frozen row id — the chunk plumbing
 * every publish test here shares. A DERIVED publish must also record its
 * plan's materialized schema and spec (the executor's contract), so callers
 * pass `derived` for registry-row publishes.
 */
async function publishNow(
  t: TestConvex,
  datasetKey: string,
  derived?: { schema: unknown; spec: unknown },
): Promise<string> {
  const started = await t.mutation(api.publish.start, { datasetKey });
  await t.mutation(api.publish.plan, {
    attemptId: started.attemptId,
    chunkCount: 1,
    ...(derived === undefined
      ? {}
      : { kind: "standard" as const, schema: derived.schema, spec: derived.spec }),
    totalRows: 1,
  });
  const bytes = new TextEncoder().encode(JSON.stringify([{ data: { label: "IG-1" } }]));
  const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
    bytes: bytes.buffer,
  });
  await t.mutation(api.publish.registerChunk, {
    attemptId: started.attemptId,
    storageId,
    uploadId: await uploadToken(t, started.attemptId),
  });
  const frozen = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
  return frozen.schemaId;
}

// Fake timers for the publish flow's poller (the publish.test.ts shape) —
// active file-wide so `finishAllScheduledFunctions` can advance it.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Isolation: cross-user invisibility in EVERY query path
// ---------------------------------------------------------------------------

describe("isolation: user B never sees user A's drafts (stage 8 AC)", () => {
  it("enumerations scope drafts to their creator; by-id reads deny like a missing row", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    await addEntry(mine, draftId, "IG-1");

    const other = mine.withIdentity({ subject: "user-2" });

    // Enumeration paths (server-side filters, not UI hiding)…
    expect((await other.query(api.schemas.list, {})).map((row) => row._id)).not.toContain(draftId);
    expect((await other.query(api.schemas.listSummaries, {})).map((row) => row._id)).not.toContain(
      draftId,
    );
    // …the 5a drafts toggle: creator-scoped since stage 8 (was the widest leak).
    expect(await other.query(api.schemas.listDraftSummaries, {})).toHaveLength(0);
    expect((await mine.query(api.schemas.listDraftSummaries, {})).map((row) => row._id)).toContain(
      draftId,
    );

    // …and the by-id surfaces (the pre-stage-8 leak): every one answers the
    // same indistinguishable denial, so an id's existence never leaks.
    await expect(other.query(api.schemas.get, { schemaId: draftId })).rejects.toThrow(NO_ACCESS);
    await expect(
      other.query(api.entries.listPage, {
        paginationOpts: { cursor: null, numItems: 10 },
        schemaId: draftId,
      }),
    ).rejects.toThrow(NO_ACCESS);
    await expect(other.query(api.entries.list, { schemaId: draftId })).rejects.toThrow(NO_ACCESS);
    await expect(
      other.query(api.geometries.list, {
        paginationOpts: { cursor: null, numItems: 10 },
        schemaId: draftId,
      }),
    ).rejects.toThrow(NO_ACCESS);

    // The owner's own by-id reads keep working (positive case).
    const ownDoc = await mine.query(api.schemas.get, { schemaId: draftId });
    expect(ownDoc === null ? undefined : ownDoc.title).toBe("Draft locations");

    // Writes onto a foreign draft are denied the same way.
    await expect(
      other.mutation(api.entries.create, { data: { label: "x" }, schemaId: draftId }),
    ).rejects.toThrow(NO_ACCESS);
    await expect(
      other.mutation(api.schemas.update, { schemaId: draftId, title: "hijacked" }),
    ).rejects.toThrow(NO_ACCESS);
  });

  it("a foreign entry id resolves to its dataset and denies there too", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const entryId = await mine.mutation(api.entries.create, {
      data: { label: "IG-1" },
      schemaId: draftId,
    });
    const other = mine.withIdentity({ subject: "user-2" });
    await expect(other.query(api.entries.get, { entryId })).rejects.toThrow(NO_ACCESS);
    await expect(other.query(api.geometries.getEntryGeometry, { entryId })).rejects.toThrow(
      NO_ACCESS,
    );
    // The owner reads their own rows (positive case).
    const ownEntry = await mine.query(api.entries.get, { entryId });
    expect(ownEntry === null ? undefined : ownEntry.data).toEqual({ label: "IG-1" });
  });

  it("the workspace read never resolves another user's project, and projects stay invisible in every read", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    await createProjectDraft(mine, projectId);
    const other = mine.withIdentity({ subject: "user-2" });

    expect(await other.query(api.projects.get, { projectId })).toBeNull();
    expect((await other.query(api.projects.list, {})).map((row) => row._id)).not.toContain(
      projectId,
    );
    // The creator still sees both (positive case).
    expect(await mine.query(api.projects.get, { projectId })).not.toBeNull();
    expect((await mine.query(api.projects.list, {})).map((row) => row._id)).toContain(projectId);
  });
});

// ---------------------------------------------------------------------------
// Sharing grants: published artifacts stay shared; the author can narrow one
// ---------------------------------------------------------------------------

describe("published-visibility control (stage 8 AC, decision D2)", () => {
  it("a published dataset is shared by default; 'author' narrows it server-side; 'everyone' restores", async () => {
    const mine = signedIn();
    const publishedId = await createPublishedDataset(mine, "Shared dataset");
    const other = mine.withIdentity({ subject: "user-2" });

    // Positive sharing case: another signed-in user reads the published row…
    expect((await other.query(api.schemas.listSummaries, {})).map((row) => row._id)).toContain(
      publishedId,
    );
    await other.query(api.schemas.get, { schemaId: publishedId });

    // …but only its CREATOR may narrow it (the control is creator-only, and
    // the denial is indistinguishable from a missing row).
    await expect(
      other.mutation(api.schemas.setVisibility, { schemaId: publishedId, visibility: "author" }),
    ).rejects.toThrow(NO_ACCESS);

    await mine.mutation(api.schemas.setVisibility, {
      schemaId: publishedId,
      visibility: "author",
    });

    // Enforced server-side on EVERY catalog path — enumeration and by-id.
    expect((await other.query(api.schemas.listSummaries, {})).map((row) => row._id)).not.toContain(
      publishedId,
    );
    expect((await other.query(api.schemas.list, {})).map((row) => row._id)).not.toContain(
      publishedId,
    );
    await expect(other.query(api.schemas.get, { schemaId: publishedId })).rejects.toThrow(
      NO_ACCESS,
    );
    // Writes too: invisibility is read AND write.
    await expect(
      other.mutation(api.entries.create, { data: { label: "x" }, schemaId: publishedId }),
    ).rejects.toThrow(NO_ACCESS);
    // …while the author keeps full access.
    expect((await mine.query(api.schemas.listSummaries, {})).map((row) => row._id)).toContain(
      publishedId,
    );
    await mine.query(api.schemas.get, { schemaId: publishedId });

    // Flipping back restores the shared default for everyone.
    await mine.mutation(api.schemas.setVisibility, {
      schemaId: publishedId,
      visibility: "everyone",
    });
    expect((await other.query(api.schemas.listSummaries, {})).map((row) => row._id)).toContain(
      publishedId,
    );
  });

  it("the author's visibility choice inherits onto the frozen row at publish", async () => {
    // Fake timers for the publish flow's poller (the publish.test.ts shape).
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    await addEntry(mine, draftId, "IG-1");
    // The author marks the draft author-only BEFORE publishing…
    await mine.mutation(api.schemas.setVisibility, { schemaId: draftId, visibility: "author" });

    const started = await mine.mutation(api.publish.start, { datasetKey: draftId });
    expect(started.alreadyRunning).toBe(false);
    // One chunk blob, planted in the COMPONENT's storage exactly where the
    // client's upload-URL POST would land it (publish.test.ts's storeChunk).
    const bytes = new TextEncoder().encode(JSON.stringify([{ data: { label: "IG-1" } }]));
    const storageId = await mine.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: bytes.buffer,
    });
    await mine.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    await mine.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId: await uploadToken(mine, started.attemptId),
    });
    const frozen = await mine.mutation(api.publish.freeze, { attemptId: started.attemptId });
    expect(frozen.alreadyFrozen).toBe(false);
    await mine.finishAllScheduledFunctions(() => {
      vi.runAllTimers();
    });

    // …and the choice crossed the lifecycle line with the data: the frozen
    // row carries it…
    const frozenDoc = await mine.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: frozen.schemaId }),
    );
    expect(frozenDoc === null ? undefined : frozenDoc.publishedVisibility).toBe("author");

    // …so user B can neither enumerate nor open the published version, while
    // the author (and only the author) can.
    const other = mine.withIdentity({ subject: "user-2" });
    expect((await other.query(api.schemas.listSummaries, {})).map((row) => row._id)).not.toContain(
      frozen.schemaId,
    );
    await expect(other.query(api.schemas.get, { schemaId: frozen.schemaId })).rejects.toThrow(
      NO_ACCESS,
    );
    expect((await mine.query(api.schemas.listSummaries, {})).map((row) => row._id)).toContain(
      frozen.schemaId,
    );
  });

  it("an author-narrowed dataset's chain and consumer reads answer empty to others, real to the author", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    await addEntry(mine, draftId, "IG-1");
    const started = await mine.mutation(api.publish.start, { datasetKey: draftId });
    const bytes = new TextEncoder().encode(JSON.stringify([{ data: { label: "IG-1" } }]));
    const storageId = await mine.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: bytes.buffer,
    });
    await mine.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    await mine.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId: await uploadToken(mine, started.attemptId),
    });
    const frozen = await mine.mutation(api.publish.freeze, { attemptId: started.attemptId });
    await mine.finishAllScheduledFunctions(() => {
      vi.runAllTimers();
    });
    // Narrow the PUBLISHED row after the fact (the creator may flip their own).
    await mine.mutation(api.schemas.setVisibility, {
      schemaId: frozen.schemaId,
      visibility: "author",
    });
    // Give the chain real reads to hide: one fork-consumer edge and a stored
    // keep-policy, both on the author's draft (the chain anchor — the frozen
    // version's lineage points back at it). The edge comes from forking the
    // draft into a SECOND project (the draft is already a member of its
    // birth project — a re-add would trip the duplicate guard).
    const forkProjectId = await createProject(mine, "Fork home");
    await mine.mutation(api.projects.addArtifact, {
      artifactId: draftId,
      artifactKind: "dataset",
      projectId: forkProjectId,
    });
    await mine.mutation(api.consumption.setChainKeep, { anchorId: draftId, keep: 5 });
    const other = mine.withIdentity({ subject: "user-2" });

    // The dataset-keyed projections answer B exactly as an unknown id would…
    expect(await other.query(api.consumption.chainVersions, { anchorId: draftId })).toEqual([]);
    expect(await other.query(api.consumption.retentionPolicy, { anchorId: draftId })).toEqual({
      keepVersions: 10,
      pinnedRefs: [],
      store: "defaults",
    });
    expect(
      (await other.query(api.consumption.consumedBy, { datasetId: draftId })).consumers,
    ).toEqual([]);
    // …while the author reads their own chain: one frozen version, the stored
    // policy, and their fork consumer with its project title.
    const ownVersions = await mine.query(api.consumption.chainVersions, { anchorId: draftId });
    expect(ownVersions).toHaveLength(1);
    const ownVersion = ownVersions[0];
    expect(ownVersion === undefined ? undefined : ownVersion.schemaId).toBe(frozen.schemaId);
    expect(await mine.query(api.consumption.retentionPolicy, { anchorId: draftId })).toEqual({
      keepVersions: 5,
      pinnedRefs: [],
      store: "chain",
    });
    const ownConsumers = await mine.query(api.consumption.consumedBy, { datasetId: draftId });
    const fork = ownConsumers.consumers.find((consumer) => consumer.consumerKind === "fork");
    expect(fork === undefined ? undefined : fork.title).toBe("Fork home");
  });
});

// ---------------------------------------------------------------------------
// Permission checks: projects, bundle press, publish, consumption, derived
// ---------------------------------------------------------------------------

describe("project writes are creator-only (stage 8 AC, decision D1)", () => {
  it("membership, draft-creation, fork, and removal answer only to the creator", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const publishedId = await createPublishedDataset(mine, "Attachable");
    const other = mine.withIdentity({ subject: "user-2" });

    // A non-creator reads exactly what a missing project answers.
    await expect(
      other.mutation(api.projects.createDraftDataset, {
        projectId,
        schema: { title: "hijack", type: "object" },
      }),
    ).rejects.toThrow(GONE_PROJECT);
    await expect(
      other.mutation(api.projects.addArtifact, {
        artifactId: publishedId,
        artifactKind: "dataset",
        projectId,
      }),
    ).rejects.toThrow(GONE_PROJECT);
    await expect(
      other.mutation(api.projects.removeArtifact, {
        artifactId: publishedId,
        artifactKind: "dataset",
        projectId,
      }),
    ).rejects.toThrow(GONE_PROJECT);
    await expect(
      other.mutation(api.projects.forkAsSpec, {
        projectId,
        sourceDatasetId: publishedId,
        title: "hijack fork",
      }),
    ).rejects.toThrow(GONE_PROJECT);

    // The creator's own writes work (positive case), and nothing leaked in.
    await mine.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    const workspace = await mine.query(api.projects.get, { projectId });
    expect(workspace === null ? undefined : workspace.artifacts).toHaveLength(1);
  });

  it("the bundle press and every leg answer only to the project's creator", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const started = await mine.mutation(api.bundles.start, { projectId });
    expect(started.joined).toBe(false);
    const other = mine.withIdentity({ subject: "user-2" });

    await expect(other.mutation(api.bundles.start, { projectId })).rejects.toThrow(GONE_PROJECT);
    await expect(
      other.mutation(api.bundles.recordMember, {
        datasetKey: draftId,
        runId: started.runId,
        status: "publishing",
      }),
    ).rejects.toThrow(GONE_RUN);
    await expect(
      other.mutation(api.bundles.promoteCollection, { runId: started.runId }),
    ).rejects.toThrow(GONE_RUN);
    await expect(other.mutation(api.bundles.completeRun, { runId: started.runId })).rejects.toThrow(
      GONE_RUN,
    );
    // The press reads are creator-scoped: a foreign runId/project reads null.
    expect(await other.query(api.bundles.run, { runId: started.runId })).toBeNull();
    expect(await other.query(api.bundles.latestForProject, { projectId })).toBeNull();
    expect(await other.query(api.bundles.plan, { projectId })).toBeNull();

    // The creator drives their own press (positive case).
    await mine.mutation(api.bundles.recordMember, {
      datasetKey: draftId,
      runId: started.runId,
      status: "publishing",
    });
  });

  it("publish attempts answer only to their creator", async () => {
    const mine = signedIn();
    const draftId = await createProjectDraft(mine, await createProject(mine));
    const started = await mine.mutation(api.publish.start, { datasetKey: draftId });
    const other = mine.withIdentity({ subject: "user-2" });

    // A foreign target reads as absent…
    await expect(other.mutation(api.publish.start, { datasetKey: draftId })).rejects.toThrow(
      NOTHING_TO_PUBLISH,
    );
    // …and a foreign attemptId reads as gone on every client-driven step.
    await expect(
      other.mutation(api.publish.plan, {
        attemptId: started.attemptId,
        chunkCount: 1,
        totalRows: 1,
      }),
    ).rejects.toThrow(GONE_ATTEMPT);
    await expect(
      other.mutation(api.publish.registerChunk, {
        attemptId: started.attemptId,
        storageId: "s1",
        uploadId: "s1",
      }),
    ).rejects.toThrow(GONE_ATTEMPT);
    await expect(
      other.mutation(api.publish.freeze, { attemptId: started.attemptId }),
    ).rejects.toThrow(GONE_ATTEMPT);
    expect(await other.query(api.publish.attempt, { attemptId: started.attemptId })).toBeNull();

    // The creator keeps driving (positive case) — with a token issued for
    // the attempt, as the real client flow mints them.
    await mine.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId: "s1",
      uploadId: await uploadToken(mine, started.attemptId),
    });
  });

  it("consumption edges and chain policy answer to their owners; fork titles never leak cross-user", async () => {
    const mine = signedIn();
    const sourceId = await createPublishedDataset(mine, "Shared source");
    const projectId = await createProject(mine);
    // The fork-as-reference membership mints one float edge on the source.
    await mine.mutation(api.projects.addArtifact, {
      artifactId: sourceId,
      artifactKind: "dataset",
      projectId,
    });
    const edgeId = await mine.run(async (ctx) => {
      const edges = await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", sourceId))
        .collect();
      const edge = edges[0];
      if (edge === undefined) {
        throw new Error("expected the fork edge to exist");
      }
      return edge._id;
    });
    const other = mine.withIdentity({ subject: "user-2" });

    // The consumed-by projection NEVER surfaces another user's fork (the
    // cross-user project-title leak is closed)…
    const foreignView = await other.query(api.consumption.consumedBy, { datasetId: sourceId });
    expect(foreignView.consumers.map((consumer) => consumer.consumerKind)).not.toContain("fork");
    // …while the owner sees their own fork with its project title.
    const ownView = await mine.query(api.consumption.consumedBy, { datasetId: sourceId });
    const fork = ownView.consumers.find((consumer) => consumer.consumerKind === "fork");
    expect(fork === undefined ? undefined : fork.title).toBe("SMART 2024");

    // The edge mutations deny a non-owner…
    await expect(
      other.mutation(api.consumption.setReferenceMode, { mode: "pin", referenceId: edgeId }),
    ).rejects.toThrow(GONE_REFERENCE);
    await expect(
      other.mutation(api.consumption.syncReference, { referenceId: edgeId }),
    ).rejects.toThrow(GONE_REFERENCE);
    await expect(
      other.mutation(api.consumption.revertReference, { referenceId: edgeId }),
    ).rejects.toThrow(GONE_REFERENCE);
    // …and so does the chain's policy store (the source's creator owns it).
    await expect(
      other.mutation(api.consumption.setChainKeep, { anchorId: sourceId, keep: 2 }),
    ).rejects.toThrow(GONE_REFERENCE);

    // The owner adjusts their own edge (positive cases — float needs no
    // published chain, so it is what a fresh fork can do; pin needs a head).
    await mine.mutation(api.consumption.setReferenceMode, { mode: "float", referenceId: edgeId });
    const synced = await mine.mutation(api.consumption.syncReference, { referenceId: edgeId });
    expect(synced.mode).toBe("float");
    await mine.mutation(api.consumption.setChainKeep, { anchorId: sourceId, keep: 5 });
  });

  it("derived registry rows: drafts creator-private, saved catalog-visible, writes creator-only", async () => {
    const mine = signedIn();
    const sourceId = await createPublishedDataset(mine, "Spec source");
    const draftRowId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: sourceId },
      status: "draft",
      title: "My autosave",
    });
    const savedRowId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: sourceId },
      status: "saved",
      title: "My saved spec",
    });
    const other = mine.withIdentity({ subject: "user-2" });

    // Another user's autosave reads exactly as a missing row…
    expect(await other.query(api.derivedDatasets.get, { id: draftRowId })).toBeNull();
    expect(
      (await other.query(api.derivedDatasets.listBySource, { sourceDatasetId: sourceId })).map(
        (row) => row._id,
      ),
    ).not.toContain(draftRowId);
    // …a saved row is catalog-visible (the registry's published side)…
    expect(await other.query(api.derivedDatasets.get, { id: savedRowId })).not.toBeNull();
    expect((await other.query(api.derivedDatasets.summaries, {})).map((row) => row._id)).toContain(
      savedRowId,
    );
    // …and the writes are creator-only.
    await expect(
      other.mutation(api.derivedDatasets.save, {
        id: draftRowId,
        spec: { operations: [], sourceDatasetId: sourceId },
        status: "draft",
        title: "hijacked",
      }),
    ).rejects.toThrow(NO_ACCESS);
    await expect(other.mutation(api.derivedDatasets.remove, { id: savedRowId })).rejects.toThrow(
      NO_ACCESS,
    );

    // The owner continues and removes their own rows (positive cases).
    await mine.mutation(api.derivedDatasets.save, {
      id: draftRowId,
      spec: { operations: [], sourceDatasetId: sourceId },
      status: "saved",
      title: "My autosave",
    });
    await mine.mutation(api.derivedDatasets.remove, { id: draftRowId });
  });

  it("map layers refuse foreign invisible targets; maps stay shared catalog artifacts (recorded)", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const publishedId = await createPublishedDataset(mine, "Layerable");
    const other = mine.withIdentity({ subject: "user-2" });
    const otherMapId = await other.mutation(api.maps.create, { name: "B's map" });

    // Layering another user's draft onto a shared map would write their
    // invisible row into shared state — denied, same answer as a bad id.
    await expect(
      other.mutation(api.maps.addLayer, {
        mapId: otherMapId,
        targetId: draftId,
        targetType: "dataset",
      }),
    ).rejects.toThrow(/Dataset not found/);
    // Published rows layer fine for anyone (positive sharing case).
    await other.mutation(api.maps.addLayer, {
      mapId: otherMapId,
      targetId: publishedId,
      targetType: "dataset",
    });
    // Maps themselves stay shared (the recorded D1 boundary): B reads A's map.
    const myMapId = await mine.mutation(api.maps.create, { name: "A's map" });
    const foreignMap = await other.query(api.maps.get, { mapId: myMapId });
    expect(foreignMap === null ? undefined : foreignMap.name).toBe("A's map");
  });
});

// ---------------------------------------------------------------------------
// Batch reads, collection entries, authoring boundaries, tag path (review
// round-2 coverage): every path below must either FILTER by visibility or
// DENY — never leak, never crash a form over one invisible id
// ---------------------------------------------------------------------------

describe("stage-8 batch and cross-dataset reads (review round 2)", () => {
  it("batch entry reads filter invisible datasets; the owner still gets both", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const draftEntryId = await addEntry(mine, draftId, "draft-row");
    const publishedId = await createPublishedDataset(mine, "Visible source");
    const publishedEntryId = await addEntry(mine, publishedId, "published-row");
    const other = mine.withIdentity({ subject: "user-2" });

    // B's mixed batch (their own form's shape: visible + invisible targets)
    // answers the VISIBLE subset — no denial, no leak: the reference picker
    // shows fewer candidates instead of the form crashing.
    const batch = await other.query(api.entries.listEntriesForSchemas, {
      schemaIds: [publishedId, draftId],
    });
    expect(batch).toHaveLength(1);
    expect(batch[0].data).toEqual({ label: "published-row" });

    // The label lookup filters the same way…
    const labels = await other.query(api.entries.listForIds, {
      entryIds: [publishedEntryId, draftEntryId],
    });
    expect(labels.map((entry) => entry._id)).toEqual([publishedEntryId]);
    // …and the owner reads their own rows from both datasets.
    const ownLabels = await mine.query(api.entries.listForIds, {
      entryIds: [publishedEntryId, draftEntryId],
    });
    expect(ownLabels).toHaveLength(2);
  });

  it("an import status read denies a foreign import, answers its owner", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const bytes = new TextEncoder().encode(JSON.stringify([{ data: { label: "IG-1" } }]));
    const storageId = await mine.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: bytes.buffer,
    });
    const uploadId = await uploadToken(mine, draftId);
    const importId = await mine.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.startImport, {
        chunks: [{ storageId, uploadId }],
        schemaId: draftId,
        total: 1,
      }),
    );
    const other = mine.withIdentity({ subject: "user-2" });
    // The importId resolves to the creator's draft — a foreign read denies
    // exactly like the by-id surfaces (indistinguishable from gone).
    await expect(other.query(api.imports.getImportStatus, { importId })).rejects.toThrow(NO_ACCESS);
    const own = await mine.query(api.imports.getImportStatus, { importId });
    expect(own === null ? undefined : own.total).toBe(1);
  });

  it("collections.listDatasets hides a foreign author-only member through the wrapper", async () => {
    const mine = signedIn();
    const restrictedId = await createPublishedDataset(mine, "Restricted member");
    await mine.mutation(api.schemas.setVisibility, {
      schemaId: restrictedId,
      visibility: "author",
    });
    const collectionId = await mine.mutation(api.collections.create, { name: "Shared shelf" });
    await mine.mutation(api.collections.addSchemaToCollection, {
      collectionId,
      schemaId: restrictedId,
    });
    const other = mine.withIdentity({ subject: "user-2" });

    // The datasets read filters the invisible member (positive case: the
    // creator still sees it on the same shared collection).
    expect(await other.query(api.collections.listDatasets, { collectionId })).toEqual([]);
    const own = await mine.query(api.collections.listDatasets, { collectionId });
    expect(own.map((row) => row._id)).toContain(restrictedId);
  });

  it("sourceBadges answer [] for an author-narrowed derived row, real badges to its author", async () => {
    const mine = signedIn();
    // One derived chain: published source → saved spec → published derived row.
    const sourceId = await createPublishedDataset(mine, "Badge source");
    await addEntry(mine, sourceId, "IG-1");
    const registryId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: sourceId },
      status: "saved",
      title: "Spec over source",
    });
    const derivedId = await publishNow(mine, registryId, {
      schema: {
        properties: { label: { type: "string" } },
        title: "Spec over source",
        type: "object",
      },
      spec: { operations: [], sourceDatasetId: sourceId },
    });
    // The creator narrows the DERIVED row after the fact.
    await mine.mutation(api.schemas.setVisibility, { schemaId: derivedId, visibility: "author" });
    const other = mine.withIdentity({ subject: "user-2" });

    // B's badge read answers empty (the source graph is content too)…
    const foreignBadges = await other.query(api.consumption.sourceBadges, {
      registryIds: [],
      schemaIds: [derivedId],
    });
    expect(foreignBadges.bySchemaId[derivedId]).toEqual([]);
    // …while the author reads the real badge naming their source.
    const ownBadges = await mine.query(api.consumption.sourceBadges, {
      registryIds: [],
      schemaIds: [derivedId],
    });
    const ownRow = ownBadges.bySchemaId[derivedId];
    expect((ownRow ?? []).map((badge) => badge.sourceDatasetId)).toContain(sourceId);
  });
});

describe("stage-8 authoring boundaries (review round 2)", () => {
  it("addArtifact refuses foreign drafts (dataset and registry) but accepts visible rows", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const draftRegistryId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: draftId },
      status: "draft",
      title: "A's autosave",
    });
    const savedRegistryId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: draftId },
      status: "saved",
      title: "A's saved spec",
    });
    const publishedId = await createPublishedDataset(mine, "Shareable");
    const other = mine.withIdentity({ subject: "user-2" });
    const otherProjectId = await createProject(other, "B's project");

    // A foreign draft dataset and a foreign builder autosave read exactly as
    // missing ids at add time — they can never enter B's membership rows.
    await expect(
      other.mutation(api.projects.addArtifact, {
        artifactId: draftId,
        artifactKind: "dataset",
        projectId: otherProjectId,
      }),
    ).rejects.toThrow(/No dataset was found/);
    await expect(
      other.mutation(api.projects.addArtifact, {
        artifactId: draftRegistryId,
        artifactKind: "derived",
        projectId: otherProjectId,
      }),
    ).rejects.toThrow(/No derived dataset was found/);

    // Visible rows attach fine (the positive sharing case).
    await other.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId: otherProjectId,
    });
    await other.mutation(api.projects.addArtifact, {
      artifactId: savedRegistryId,
      artifactKind: "derived",
      projectId: otherProjectId,
    });
  });

  it("forkAsSpec refuses invisible sources; addDerivedLayer refuses foreign autosaves", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const draftRegistryId = await mine.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: draftId },
      status: "draft",
      title: "A's autosave",
    });
    const publishedId = await createPublishedDataset(mine, "Forkable");
    const other = mine.withIdentity({ subject: "user-2" });
    const otherProjectId = await createProject(other, "B's fork home");
    const otherMapId = await other.mutation(api.maps.create, { name: "B's map" });

    // A fork over a foreign draft would mint a SAVED (catalog-visible)
    // registry row naming an invisible id — refused as missing.
    await expect(
      other.mutation(api.projects.forkAsSpec, {
        projectId: otherProjectId,
        sourceDatasetId: draftId,
        title: "ghost fork",
      }),
    ).rejects.toThrow(/No dataset was found/);
    await expect(
      other.mutation(api.maps.addDerivedLayer, { mapId: otherMapId, targetId: draftRegistryId }),
    ).rejects.toThrow(/Derived dataset not found/);

    // Forking the PUBLISHED source works (the design's shape).
    const forkId = await other.mutation(api.projects.forkAsSpec, {
      projectId: otherProjectId,
      sourceDatasetId: publishedId,
      title: "Real fork",
    });
    expect(forkId).toBeDefined();
  });

  it("derivedDatasets.save refuses specs authored over invisible dependencies", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    const other = mine.withIdentity({ subject: "user-2" });

    // A spec whose source is a foreign draft reads as access-denied — a
    // saved spec over it would be a catalog-visible ghost naming an
    // invisible id.
    await expect(
      other.mutation(api.derivedDatasets.save, {
        spec: { operations: [], sourceDatasetId: draftId },
        status: "saved",
        title: "Spec over a ghost",
      }),
    ).rejects.toThrow(NO_ACCESS);
  });
});

describe("stage-8 tag path (review round 2)", () => {
  it("versionEntries/getVersionDelta/retireVersion deny foreign rows; the owner's flow works", async () => {
    const mine = signedIn();
    const projectId = await createProject(mine);
    const draftId = await createProjectDraft(mine, projectId);
    await addEntry(mine, draftId, "IG-1");
    const frozenId = await publishNow(mine, draftId);
    // Narrow the frozen row (the creator's post-publish flip) — the denial
    // case needs an actually-invisible id, not a default-visible one.
    await mine.mutation(api.schemas.setVisibility, { schemaId: frozenId, visibility: "author" });
    const other = mine.withIdentity({ subject: "user-2" });

    // The tag path's row reads answer nothing for an invisible id…
    expect(await other.query(api.tags.versionEntries, { schemaId: frozenId })).toEqual([]);
    expect(
      await other.query(api.tags.getVersionDelta, { aSchemaId: frozenId, bSchemaId: frozenId }),
    ).toEqual({
      added: 0,
      ops: [],
      removed: 0,
      truncated: false,
      updated: 0,
    });
    // …and retirement is creator-only (a publish-frozen row carries its
    // author since stage 8) — the indistinguishable not-found.
    await expect(other.mutation(api.tags.retireVersion, { schemaId: frozenId })).rejects.toThrow(
      /Version dataset not found/,
    );

    // The owner's own reads and retirement work (positive case).
    const ownRows = await mine.query(api.tags.versionEntries, { schemaId: frozenId });
    expect(ownRows).toHaveLength(1);
    await mine.mutation(api.tags.retireVersion, { schemaId: frozenId });
  });
});

// ---------------------------------------------------------------------------
// Anonymous denial: the 0.1 gate holds across every project/share surface
// ---------------------------------------------------------------------------

describe("anonymous denial (stage 8 AC: the 0.1 gate holds)", () => {
  it("rejects unauthenticated callers on the project/share surfaces", async () => {
    const t = initTest();
    // Projects
    await expect(t.mutation(api.projects.create, { title: "Nope" })).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.projects.list, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.projects.get, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    // Catalog + drafts toggle
    await expect(t.query(api.schemas.list, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.schemas.listSummaries, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.schemas.listDraftSummaries, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.schemas.get, { schemaId: "whatever" })).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.schemas.maxTileCacheVersion, {})).rejects.toThrow(GATE_MESSAGE);
    // Publish + press + consumption + registry + maps
    await expect(t.mutation(api.publish.start, { datasetKey: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.mutation(api.bundles.start, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.query(api.bundles.plan, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.query(api.consumption.consumedBy, { datasetId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      t.mutation(api.consumption.setChainKeep, { anchorId: "whatever", keep: 2 }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      t.mutation(api.derivedDatasets.save, {
        spec: { operations: [] },
        status: "draft",
        title: "Nope",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.derivedDatasets.get, { id: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.query(api.bundles.layerResolutions, { mapId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      t.mutation(api.schemas.setVisibility, { schemaId: "x", visibility: "author" }),
    ).rejects.toThrow(GATE_MESSAGE);
  });
});
