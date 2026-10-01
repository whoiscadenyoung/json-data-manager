// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The bundle press's function-level behavior (roadmap 7b, #103): the issue's
 * acceptance criteria, driven through `api.bundles.*` on a real (test)
 * backend (the publish.test.ts/projects.test.ts setup) — bundle contents and
 * dedup, auto-publish promotion, derived-source non-promotion, exposure
 * isolation, version immutability, per-member atomicity and exact resume,
 * and the two fork legs. Per-member publishes run through the EXISTING
 * `api.publish.*` state machine exactly as the client orchestrator does
 * (src/lib/bundle-publish.ts); nothing here exercises a forked machine,
 * because there isn't one.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { CATALOG_READ_LIMIT } from "./schemas";

const modules = import.meta.glob("./**/*.ts");

const GATE_MESSAGE = /signed out/i;

/** A fresh test backend with the json-cms component mounted as in the app (the publish.test.ts shape). */
function initTest() {
  const t = convexTest(schema, modules);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- nominal-type invariance across the register helper (see publish.test.ts).
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn(subject = "user-1") {
  return initTest().withIdentity({ subject });
}

type TestConvex = ReturnType<typeof signedIn>;

/** rows[index] without optional chaining (the lint ban) — the repo's ternary style, factored once. */
function at<T>(rows: readonly T[], index: number): T | undefined {
  return rows[index];
}

/** A narrowed property of a possibly-null/undefined doc. */
function prop<T, K extends keyof T>(owner: T | null | undefined, key: K): T[K] | undefined {
  return owner === null || owner === undefined ? undefined : owner[key];
}

/** The plan read, narrowed — throws (failing the test with a clear name) when the project is gone. */
async function planOf(t: TestConvex, projectId: string) {
  const plan = await t.query(api.bundles.plan, { projectId });
  if (plan === null) {
    throw new Error("plan vanished");
  }
  return plan;
}

/** The pending-upload token a chunk registration must present — issued for
 * the attempt, exactly as the client's upload flow does (issue #131). */
async function uploadToken(t: TestConvex, scope: string): Promise<string> {
  const { uploadId } = await t.run(async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.generateUploadUrl, { scope }),
  );
  return uploadId;
}

/** Chunk rows a test seeds, keyed by member datasetKey. */
type ChunkRow = { data: unknown; geometry?: unknown };
type PlanOverrides = {
  chunks: ChunkRow[];
  geometryType?: FunctionArgs<typeof api.publish.plan>["geometryType"];
  kind?: "geospatial" | "standard";
  schema?: Record<string, unknown>;
  spec?: unknown;
};
type PlanByKey = Record<string, PlanOverrides>;

/** Runs every scheduled function to completion (the publish.test.ts drain). */
async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function createProject(t: TestConvex, title = "SMART 2024"): Promise<string> {
  return t.mutation(api.projects.create, { description: "The year's bundle", title });
}

/** A lifecycle-draft component dataset IN the project, with entries. */
async function createProjectDraft(
  t: TestConvex,
  projectId: string,
  rows: ChunkRow[] = [{ data: { label: "A" } }],
  title = "Draft locations",
  geometryType?: "Point",
): Promise<string> {
  const schemaId = await t.mutation(api.projects.createDraftDataset, {
    geometryType:
      geometryType === undefined
        ? undefined
        : (geometryType as
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon"),
    kind: geometryType === undefined ? undefined : "geospatial",
    projectId,
    schema: {
      properties: { label: { type: "string" } },
      title,
      type: "object",
    },
  });
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one write per row keeps ordering visible in assertions.
    await t.mutation(api.entries.create, {
      data: row.data,
      geometry: row.geometry === undefined ? undefined : JSON.stringify(row.geometry),
      schemaId,
    });
  }
  return schemaId;
}

/** An ordinary PUBLISHED dataset (the pre-existing wrapper — absent lifecycle reads as published). */
async function createPublishedDataset(t: TestConvex, title = "Published points"): Promise<string> {
  return t.mutation(api.schemas.create, {
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** The press's client half, driven exactly as src/lib/bundle-publish.ts does: per member, the 5b machine, then the host legs. */
// oxlint-disable-next-line eslint/complexity -- the press driver IS the client orchestrator's loop, sequential by design.
async function driveBundlePress(
  t: TestConvex,
  projectId: string,
  plans: PlanByKey,
): Promise<{ runId: Id<"bundleRuns">; status: string }> {
  const started = await t.mutation(api.bundles.start, { projectId }),
    run = await t.query(api.bundles.run, { runId: started.runId });
  if (run === null) {
    throw new Error("the run vanished");
  }
  for (const member of run.members) {
    if (!member.publish || member.kind === "map" || member.status === "published") {
      continue;
    }
    const plan = plans[member.datasetKey];
    if (plan === undefined) {
      throw new Error(`test bug: no chunk plan for member ${member.datasetKey}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- members publish in press order, each through the full 5b machine.
    await t.mutation(api.bundles.recordMember, {
      datasetKey: member.datasetKey,
      runId: started.runId,
      status: "publishing",
    });
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const attempt = await t.mutation(api.publish.start, { datasetKey: member.datasetKey });
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await t.mutation(api.publish.plan, {
      attemptId: attempt.attemptId,
      chunkCount: plan.chunks.length === 0 ? 0 : 1,
      ...(plan.geometryType === undefined ? {} : { geometryType: plan.geometryType }),
      ...(plan.kind === undefined ? {} : { kind: plan.kind }),
      ...(plan.schema === undefined ? {} : { schema: plan.schema }),
      ...(plan.spec === undefined ? {} : { spec: plan.spec }),
      totalRows: plan.chunks.length,
    });
    if (plan.chunks.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
        bytes: new TextEncoder().encode(JSON.stringify(plan.chunks)).buffer,
      });
      // oxlint-disable-next-line no-await-in-loop -- see above.
      const uploadId = await uploadToken(t, attempt.attemptId);
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await t.mutation(api.publish.registerChunk, {
        attemptId: attempt.attemptId,
        rowCount: plan.chunks.length,
        storageId,
        uploadId,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- see above.
    const frozen = await t.mutation(api.publish.freeze, { attemptId: attempt.attemptId });
    // oxlint-disable-next-line no-await-in-loop -- each attempt's import completes before the next member starts.
    await drainScheduled(t);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await t.mutation(api.bundles.recordMember, {
      attemptId: attempt.attemptId,
      datasetKey: member.datasetKey,
      publishedSchemaId: frozen.schemaId,
      runId: started.runId,
      status: "published",
    });
  }
  await t.mutation(api.bundles.promoteCollection, { runId: started.runId });
  await t.mutation(api.bundles.linkMapLayers, { runId: started.runId });
  const closed = await t.mutation(api.bundles.completeRun, { runId: started.runId });
  return { runId: started.runId, status: closed.status };
}

/** The run read, narrowed. */
async function runOf(t: TestConvex, runId: Id<"bundleRuns">) {
  const run = await t.query(api.bundles.run, { runId });
  if (run === null) {
    throw new Error("run vanished");
  }
  return run;
}

/** A dataset's frozen versions of either chain kind, read through the component. */
async function versionsOf(t: TestConvex, sourceSchemaId: string) {
  return t.run(async (ctx) =>
    ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      limit: CATALOG_READ_LIMIT,
      sourceSchemaId,
    }),
  );
}

async function lifecycleOf(t: TestConvex, schemaId: string): Promise<string | undefined> {
  return t.run(async (ctx) => {
    const doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
    return doc === null ? undefined : doc.lifecycle;
  });
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe("gate", () => {
  it("rejects the bundle surface signed out", async () => {
    const t = initTest();
    await expect(t.query(api.bundles.plan, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.mutation(api.bundles.start, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(t.query(api.bundles.layerResolutions, { mapId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
  });
});

// ---------------------------------------------------------------------------
// AC 1: exactly one bundle — contents and dedup
// ---------------------------------------------------------------------------

describe("one press, one bundle (AC 1)", () => {
  it("freezes deduped referenced datasets once each, promotes the collection, and links the map", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(
      t,
      projectId,
      [
        { data: { label: "Downtown" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } },
        { data: { label: "Riverside" }, geometry: { coordinates: [-89.5, 39.9], type: "Point" } },
      ],
      "IG points",
      "Point",
    );
    const draftB = await createProjectDraft(
      t,
      projectId,
      [{ data: { label: "Zone 1" } }],
      "IG zones",
    );
    // A referenced THREE ways: membership, a collection layer, and its own
    // dataset layer — the bundle freezes it once.
    const workingSet = await t.mutation(api.collections.create, { name: "Working set" });
    await t.mutation(api.collections.addSchemaToCollection, {
      collectionId: workingSet,
      schemaId: draftA,
    });
    const mapId = await t.mutation(api.maps.create, { name: "SMART 2024 map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await t.mutation(api.maps.addLayer, { mapId, targetId: workingSet, targetType: "collection" });
    await t.mutation(api.maps.addLayer, { mapId, targetId: draftA, targetType: "dataset" });

    const plan = await planOf(t, projectId);
    expect(plan.members.filter((member) => member.kind === "dataset")).toHaveLength(2);
    expect(plan.dropped).toStrictEqual([]);
    const mapPlan = plan.members.find((member) => member.kind === "map");
    expect(prop(mapPlan, "layerTargets")).toStrictEqual([draftA]);

    const before = (await t.query(api.schemas.listSummaries, { limit: 1000 })).length;
    const press = await driveBundlePress(t, projectId, {
      [draftA]: {
        chunks: [
          { data: { label: "Downtown" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } },
          { data: { label: "Riverside" }, geometry: { coordinates: [-89.5, 39.9], type: "Point" } },
        ],
        geometryType: "Point",
        kind: "geospatial",
      },
      [draftB]: { chunks: [{ data: { label: "Zone 1" } }] },
    });

    expect(press.status).toBe("completed");
    const run = await runOf(t, press.runId);
    expect(run.run.status).toBe("completed");
    expect(run.run.collectionId).not.toBeUndefined();
    const statuses = new Map(run.members.map((member) => [member.datasetKey, member.status]));
    expect(statuses.get(draftA)).toBe("published");
    expect(statuses.get(draftB)).toBe("published");
    expect(statuses.get(mapId)).toBe("linked");

    // Dedup: A referenced three ways → exactly ONE frozen row (v1).
    expect(await versionsOf(t, draftA)).toHaveLength(1);
    expect(await versionsOf(t, draftB)).toHaveLength(1);
    // Exactly the bundle's datasets entered the catalog — one frozen row per
    // referenced dataset, nothing else.
    expect((await t.query(api.schemas.listSummaries, { limit: 1000 })).length).toBe(before + 2);

    // The promoted collection: named for the project, holding the frozen rows.
    const collectionId = run.run.collectionId;
    if (collectionId === undefined) {
      throw new Error("the press never recorded its collection");
    }
    const collection = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getCollection, { collectionId }),
    );
    expect(prop(collection, "name")).toBe("SMART 2024");
    const filed = (await t.query(api.collections.listDatasets, { collectionId })).map(
      (row) => row._id,
    );
    expect(filed).toHaveLength(2);
    const frozenA = prop(at(await versionsOf(t, draftA), 0), "_id") ?? "";
    const frozenB = prop(at(await versionsOf(t, draftB), 0), "_id") ?? "";
    expect(filed).toContain(frozenA);
    expect(filed).toContain(frozenB);

    // The map leg: one float reference per direct dataset layer target.
    const edges = await t.run(async (ctx) =>
      ctx.db
        .query("consumerReferences")
        .withIndex("by_consumer", (q) => q.eq("consumerId", mapId))
        .collect(),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      consumerKind: "map",
      mode: "float",
      sourceDatasetId: draftA,
    });

    // Drafts stay draft-side, untouched (publish is promotion of a COPY).
    expect(await lifecycleOf(t, draftA)).toBe("draft");
    expect(await lifecycleOf(t, draftB)).toBe("draft");
  });

  it("re-attaches the frozen row to its draft's group so group layers keep rendering", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(
      t,
      projectId,
      [{ data: { label: "P" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } }],
      "IG points",
      "Point",
    );
    const groupId = await t.mutation(api.groups.create, { name: "IG group" });
    await t.mutation(api.collections.setSchemaGroup, { groupId, schemaId: draftA });
    const mapId = await t.mutation(api.maps.create, { name: "Group map" });
    await t.mutation(api.maps.addLayer, { mapId, targetId: groupId, targetType: "group" });

    const press = await driveBundlePress(t, projectId, {
      [draftA]: {
        chunks: [{ data: { label: "P" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } }],
        geometryType: "Point",
        kind: "geospatial",
      },
    });
    expect(press.status).toBe("completed");
    const frozenA = at(await versionsOf(t, draftA), 0);
    expect(prop(frozenA, "groupId")).toBe(groupId);
  });
});

// ---------------------------------------------------------------------------
// AC 2/3: auto-publish promotion; derived sources stay out; exposure isolation
// ---------------------------------------------------------------------------

describe("auto-publish and exposure (AC 2, AC 3)", () => {
  it("publishes a derived member through the derived path while its source stays private", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    // The source: a standalone draft referenced ONLY by the spec — not a
    // project member, not a map layer, not in a collection.
    const sourceId = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        // Stage 8: drafts are creator-scoped — the fixture carries the
        // suite's identity so the owner's reads (and the press) see it.
        actorId: "user-1",
        lifecycle: "draft",
        schema: { properties: { label: { type: "string" } }, title: "RL raw", type: "object" },
      }),
    );
    await t.mutation(api.entries.create, { data: { label: "RL-1" }, schemaId: sourceId });
    const spec = { operations: [], sourceDatasetId: sourceId };
    const registryId = await t.mutation(api.derivedDatasets.save, {
      spec,
      status: "saved",
      title: "RL enriched",
    });
    await t.mutation(api.projects.addArtifact, {
      artifactId: registryId,
      artifactKind: "derived",
      projectId,
    });

    // The closure names the derived member, never the source.
    const plan = await planOf(t, projectId);
    const planKeys = plan.members.map((member) => member.datasetKey);
    expect(planKeys).toStrictEqual([registryId]);

    const press = await driveBundlePress(t, projectId, {
      [registryId]: {
        chunks: [{ data: { label: "RL-1" } }],
        kind: "standard",
        schema: { properties: { label: { type: "string" } }, title: "RL enriched", type: "object" },
        spec,
      },
    });
    expect(press.status).toBe("completed");

    // The derived member froze through the 5b derived path: lineage names
    // the recipe and the source version.
    const run = await runOf(t, press.runId);
    const derivedMember = run.members.find((member) => member.datasetKey === registryId);
    expect(prop(derivedMember, "status")).toBe("published");
    const frozenId = prop(derivedMember, "publishedSchemaId") ?? "";
    const frozen = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: frozenId }),
    );
    const lineage = prop(frozen, "lineage");
    expect(prop(lineage, "sourceKey")).toBe(registryId);
    expect(prop(lineage, "recipe")).toStrictEqual(spec);
    expect(prop(lineage, "sourceVersions")).toEqual([{ datasetId: sourceId }]);

    // Exposure isolation: the source never left the project — still a draft,
    // no frozen row, invisible to catalog reads — while the derived row is
    // catalog-visible and its lineage still names the source.
    expect(await lifecycleOf(t, sourceId)).toBe("draft");
    expect(await versionsOf(t, sourceId)).toHaveLength(0);
    const catalog = await t.query(api.schemas.listSummaries, { limit: 1000 });
    expect(catalog.some((row) => row._id === sourceId)).toBe(false);
    expect(catalog.some((row) => row._id === frozenId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Referenced published artifacts join as members, not versions
// ---------------------------------------------------------------------------

describe("referenced published datasets", () => {
  it("gain membership only — no attempt, no new version", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const publishedId = await createPublishedDataset(t);
    await t.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    const press = await driveBundlePress(t, projectId, {});
    expect(press.status).toBe("completed");
    const run = await runOf(t, press.runId);
    expect(run.members).toHaveLength(1);
    expect(prop(at(run.members, 0), "status")).toBe("referenced");
    expect(prop(at(run.members, 0), "publish")).toBe(false);

    // No publish attempt was ever minted for it.
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", publishedId))
        .collect(),
    );
    expect(attempts).toHaveLength(0);

    // …but the collection leg still files it into the promoted collection.
    const collectionId = run.run.collectionId ?? "";
    const filed = (await t.query(api.collections.listDatasets, { collectionId })).map(
      (row) => row._id,
    );
    expect(filed).toStrictEqual([publishedId]);
  });
});

// ---------------------------------------------------------------------------
// AC 4: version immutability under a re-press
// ---------------------------------------------------------------------------

describe("republish (AC 4: append-only)", () => {
  it("re-pressing creates NEW version rows and never touches prior ones", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(t, projectId, [{ data: { label: "A" } }], "Points");

    const first = await driveBundlePress(t, projectId, {
      [draftA]: { chunks: [{ data: { label: "A" } }] },
    });
    expect(first.status).toBe("completed");
    const v1 = at(await versionsOf(t, draftA), 0);
    expect(prop(prop(v1, "lineage"), "versionLabel")).toBe("v1");
    const v1Count = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: prop(v1, "_id") ?? "" }),
    );
    expect(prop(v1Count, "entryCount")).toBe(1);

    // A NEW run (never a reopened one), a NEW version.
    const second = await driveBundlePress(t, projectId, {
      [draftA]: {
        chunks: [{ data: { label: "A" } }, { data: { label: "B" } }],
      },
    });
    expect(second.runId).not.toBe(first.runId);
    expect(second.status).toBe("completed");
    // The promoted collection is created once and REUSED across presses —
    // a re-press refills it, never mints a same-named twin.
    const firstRun = await runOf(t, first.runId);
    const secondRun = await runOf(t, second.runId);
    expect(secondRun.run.collectionId).toBe(firstRun.run.collectionId);
    const versions = await versionsOf(t, draftA);
    expect(versions).toHaveLength(2);
    const labels = versions
      .map((version) => prop(version.lineage, "versionLabel"))
      // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; .toSorted() isn't in the lib app/convex typechecks against.
      .sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(labels).toStrictEqual(["v1", "v2"]);

    // The prior row is untouched — one row, one entry — and stays read-only.
    const v1After = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: prop(v1, "_id") ?? "" }),
    );
    expect(prop(v1After, "_id")).toBe(prop(v1, "_id"));
    expect(prop(v1After, "entryCount")).toBe(1);
    await expect(
      t.mutation(api.entries.create, { data: { label: "x" }, schemaId: prop(v1, "_id") ?? "" }),
    ).rejects.toThrow(/read-only/i);
  });
});

// ---------------------------------------------------------------------------
// Per-member atomicity and exact resume
// ---------------------------------------------------------------------------

describe("partial bundles and resume", () => {
  // oxlint-disable-next-line eslint/complexity -- the press is driven member-by-member, the crash scenario's whole point.
  it("a failed member keeps the bundle partial; completed members keep their frozen rows", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(t, projectId, [{ data: { label: "A" } }], "Fine");
    // The draft itself is fine — the BAD geometry rides the CHUNK (the import
    // rejects it, the exact publish.test.ts failure shape).
    const draftB = await createProjectDraft(
      t,
      projectId,
      [{ data: { label: "B" } }],
      "Broken geometry",
    );

    // Start the press by hand so B publishes a chunk the import will reject.
    const started = await t.mutation(api.bundles.start, { projectId });
    const run = await runOf(t, started.runId);
    for (const member of run.members) {
      if (member.kind === "map" || !member.publish || member.status === "published") {
        continue;
      }
      const isBroken = member.datasetKey === draftB;
      // oxlint-disable-next-line no-await-in-loop -- press order.
      await t.mutation(api.bundles.recordMember, {
        datasetKey: member.datasetKey,
        runId: started.runId,
        status: "publishing",
      });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const attempt = await t.mutation(api.publish.start, { datasetKey: member.datasetKey });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      await t.mutation(api.publish.plan, {
        attemptId: attempt.attemptId,
        chunkCount: 1,
        ...(isBroken ? { geometryType: "Point", kind: "geospatial" } : {}),
        totalRows: 1,
      });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
        bytes: new TextEncoder().encode(
          JSON.stringify(
            isBroken
              ? [{ data: { label: "B" }, geometry: { coordinates: "nope", type: "Point" } }]
              : [{ data: { label: "A" } }],
          ),
        ).buffer,
      });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const uploadId = await uploadToken(t, attempt.attemptId);
      // oxlint-disable-next-line no-await-in-loop -- press order.
      await t.mutation(api.publish.registerChunk, {
        attemptId: attempt.attemptId,
        rowCount: 1,
        storageId,
        uploadId,
      });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const frozen = await t.mutation(api.publish.freeze, { attemptId: attempt.attemptId });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      await drainScheduled(t);
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const attemptDoc = await t.query(api.publish.attempt, { attemptId: attempt.attemptId });
      // oxlint-disable-next-line no-await-in-loop -- press order.
      const failed = attemptDoc !== null && attemptDoc.status === "failed";
      // oxlint-disable-next-line no-await-in-loop -- press order.
      await t.mutation(api.bundles.recordMember, {
        datasetKey: member.datasetKey,
        error: failed ? (attemptDoc.error ?? "the import failed") : undefined,
        publishedSchemaId: failed ? undefined : frozen.schemaId,
        runId: started.runId,
        status: failed ? "failed" : "published",
      });
    }
    await t.mutation(api.bundles.promoteCollection, { runId: started.runId });
    await t.mutation(api.bundles.linkMapLayers, { runId: started.runId });
    const closed = await t.mutation(api.bundles.completeRun, { runId: started.runId });
    expect(closed.status).toBe("failed");

    // A kept its frozen row; B's half-built row was swept — its key retryable.
    expect(await versionsOf(t, draftA)).toHaveLength(1);
    expect(await versionsOf(t, draftB)).toHaveLength(0);
    const failedRun = await runOf(t, started.runId);
    expect(failedRun.run.error).toContain("1 of 2");
  });

  it("a re-press after a crash joins the running run and never forks an in-flight member", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(t, projectId, [{ data: { label: "A" } }], "Points");

    // Press one: the client started A's attempt, then the browser died.
    const started = await t.mutation(api.bundles.start, { projectId });
    const attempt = await t.mutation(api.publish.start, { datasetKey: draftA });
    await t.mutation(api.bundles.recordMember, {
      datasetKey: draftA,
      runId: started.runId,
      status: "publishing",
    });

    // The resumed browser re-presses: the SAME run is joined…
    const rejoined = await t.mutation(api.bundles.start, { projectId });
    expect(rejoined.joined).toBe(true);
    expect(rejoined.runId).toBe(started.runId);

    // …and the member publishes through the SAME attempt (the 5b
    // join-or-revive), landing one version — not two.
    await t.mutation(api.publish.plan, {
      attemptId: attempt.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: new TextEncoder().encode(JSON.stringify([{ data: { label: "A" } }])).buffer,
    });
    const uploadId = await uploadToken(t, attempt.attemptId);
    // oxlint-disable-next-line no-await-in-loop -- the registration rides its token.
    await t.mutation(api.publish.registerChunk, {
      attemptId: attempt.attemptId,
      rowCount: 1,
      storageId,
      uploadId,
    });
    const frozen = await t.mutation(api.publish.freeze, { attemptId: attempt.attemptId });
    await drainScheduled(t);
    await t.mutation(api.bundles.recordMember, {
      attemptId: attempt.attemptId,
      datasetKey: draftA,
      publishedSchemaId: frozen.schemaId,
      runId: started.runId,
      status: "published",
    });
    await t.mutation(api.bundles.promoteCollection, { runId: started.runId });
    await t.mutation(api.bundles.linkMapLayers, { runId: started.runId });
    const closed = await t.mutation(api.bundles.completeRun, { runId: started.runId });
    expect(closed.status).toBe("completed");

    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", draftA))
        .collect(),
    );
    expect(attempts).toHaveLength(1);
    expect(await versionsOf(t, draftA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The fork legs
// ---------------------------------------------------------------------------

describe("fork-as-reference", () => {
  it("mints one float consumer edge with the membership and deletes it with the membership", async () => {
    const t = signedIn();
    const publishedId = await createPublishedDataset(t);
    const projectId = await createProject(t);

    const membershipId = await t.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    const edges = await t.run(async (ctx) =>
      ctx.db
        .query("consumerReferences")
        .withIndex("by_consumer", (q) => q.eq("consumerId", membershipId))
        .collect(),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      consumerKind: "fork",
      mode: "float",
      sourceDatasetId: publishedId,
    });

    // The consumed-by projection names the fork — and the kinds it knows.
    const consumedBy = await t.query(api.consumption.consumedBy, { datasetId: publishedId });
    expect(consumedBy.knownConsumerKinds).toContain("fork");
    const forkConsumer = consumedBy.consumers.find((row) => row.consumerId === membershipId);
    expect(forkConsumer).toMatchObject({
      consumerKind: "fork",
      mode: "float",
      title: "SMART 2024",
    });

    // Removing the membership takes the edge with it.
    await t.mutation(api.projects.removeArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    const after = await t.run(async (ctx) =>
      ctx.db
        .query("consumerReferences")
        .withIndex("by_consumer", (q) => q.eq("consumerId", membershipId))
        .collect(),
    );
    expect(after).toHaveLength(0);
  });
});

describe("fork-as-spec", () => {
  it("creates a saved identity spec over the source, born a member, publishable day one", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const publishedId = await createPublishedDataset(t, "Restaurants");
    await t.mutation(api.entries.create, {
      data: { label: "R1" },
      schemaId: publishedId,
    });

    const forkId = await t.mutation(api.projects.forkAsSpec, {
      projectId,
      sourceDatasetId: publishedId,
      title: "Fork of Restaurants",
    });
    const forkRow = await t.run(async (ctx) => ctx.db.get(forkId));
    expect(forkRow).toMatchObject({
      dependsOn: [publishedId],
      sourceDatasetId: publishedId,
      status: "saved",
      title: "Fork of Restaurants",
    });
    expect(prop(forkRow, "spec")).toStrictEqual({ operations: [], sourceDatasetId: publishedId });

    // The membership landed with it, and the save path's float edge exists.
    const workspace = await t.query(api.projects.get, { projectId });
    expect(
      workspace !== null && workspace.artifacts.some((artifact) => artifact.artifactId === forkId),
    ).toBe(true);
    const consumedBy = await t.query(api.consumption.consumedBy, { datasetId: publishedId });
    expect(consumedBy.consumers.some((row) => row.consumerId === forkId)).toBe(true);

    // Publish the fork: the 5b derived path, never a copy of the source.
    const plan = await planOf(t, projectId);
    expect(plan.members.map((member) => member.datasetKey)).toStrictEqual([forkId]);
    const press = await driveBundlePress(t, projectId, {
      [forkId]: {
        chunks: [{ data: { label: "R1" } }],
        kind: "standard",
        schema: {
          properties: { label: { type: "string" } },
          title: "Fork of Restaurants",
          type: "object",
        },
        spec: { operations: [], sourceDatasetId: publishedId },
      },
    });
    expect(press.status).toBe("completed");
    const run = await runOf(t, press.runId);
    const frozenId = prop(at(run.members, 0), "publishedSchemaId") ?? "";
    const frozen = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: frozenId }),
    );
    const lineage = prop(frozen, "lineage");
    expect(prop(lineage, "sourceKey")).toBe(forkId);
    expect(prop(lineage, "sourceVersions")).toEqual([{ datasetId: publishedId }]);
    // The source row is untouched by the fork's publish.
    const source = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: publishedId }),
    );
    expect(prop(source, "lineage")).toBeUndefined();
  });

  it("refuses a fork naming nothing", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    await expect(
      t.mutation(api.projects.forkAsSpec, {
        projectId,
        sourceDatasetId: "nowhere-id",
        title: "Fork of nothing",
      }),
    ).rejects.toThrow(/no dataset was found/i);
  });
});

// ---------------------------------------------------------------------------
// The map leg's resolution (the stale-id trap)
// ---------------------------------------------------------------------------

describe("layer resolutions", () => {
  it("resolves a float layer to the chain's head and follows a new version", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(
      t,
      projectId,
      [{ data: { label: "A" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } }],
      "IG points",
      "Point",
    );
    const mapId = await t.mutation(api.maps.create, { name: "Map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await t.mutation(api.maps.addLayer, { mapId, targetId: draftA, targetType: "dataset" });

    // Before any press there is no chain — the layer renders itself (no
    // resolution row minted yet).
    expect(await t.query(api.bundles.layerResolutions, { mapId })).toStrictEqual([]);

    const press = await driveBundlePress(t, projectId, {
      [draftA]: {
        chunks: [{ data: { label: "A" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } }],
        geometryType: "Point",
        kind: "geospatial",
      },
    });
    const run = await runOf(t, press.runId);
    const frozenV1 = prop(
      run.members.find((member) => member.datasetKey === draftA),
      "publishedSchemaId",
    );

    let resolutions = await t.query(api.bundles.layerResolutions, { mapId });
    expect(resolutions).toStrictEqual([
      { anchorId: draftA, mode: "float", resolvedSchemaId: frozenV1 },
    ]);

    // Republish the draft directly (its own page's flow): the float layer
    // follows the new head.
    const attempt = await t.mutation(api.publish.start, { datasetKey: draftA });
    await t.mutation(api.publish.plan, {
      attemptId: attempt.attemptId,
      chunkCount: 1,
      geometryType: "Point",
      kind: "geospatial",
      totalRows: 1,
    });
    const storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: new TextEncoder().encode(
        JSON.stringify([
          { data: { label: "A2" }, geometry: { coordinates: [-89.4, 39.7], type: "Point" } },
        ]),
      ).buffer,
    });
    const uploadId = await uploadToken(t, attempt.attemptId);
    // oxlint-disable-next-line no-await-in-loop -- the registration rides its token.
    await t.mutation(api.publish.registerChunk, {
      attemptId: attempt.attemptId,
      rowCount: 1,
      storageId,
      uploadId,
    });
    await t.mutation(api.publish.freeze, { attemptId: attempt.attemptId });
    await drainScheduled(t);

    resolutions = await t.query(api.bundles.layerResolutions, { mapId });
    expect(prop(at(resolutions, 0), "resolvedSchemaId")).not.toBe(frozenV1);
    const headAtPin = prop(at(resolutions, 0), "resolvedSchemaId");

    // Pinning the reference freezes the layer to the row the pin names (the
    // head at pin time — stage 6's semantics, unchanged for map consumers).
    const referenceId = await t.run(async (ctx) => {
      const edges = await ctx.db
        .query("consumerReferences")
        .withIndex("by_consumer", (q) => q.eq("consumerId", mapId))
        .collect();
      return prop(at(edges, 0), "_id") ?? "";
    });
    await t.mutation(api.consumption.setReferenceMode, { mode: "pin", referenceId });
    const pinned = await t.query(api.bundles.layerResolutions, { mapId });
    expect(prop(at(pinned, 0), "mode")).toBe("pin");
    expect(prop(at(pinned, 0), "resolvedSchemaId")).toBe(headAtPin);
  });
});

describe("review fixes", () => {
  it("refuses to press an empty project", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    await expect(t.mutation(api.bundles.start, { projectId })).rejects.toThrow(
      /nothing to publish/i,
    );
  });

  it("scopes the project reads to the creator — another user's plan, run, and link answer null", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    await createProjectDraft(t, projectId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.bundles.start, { projectId });

    expect(await t.query(api.bundles.plan, { projectId })).not.toBeNull();
    expect(await t.query(api.bundles.latestForProject, { projectId })).not.toBeNull();
    expect(await t.query(api.bundles.run, { runId: started.runId })).not.toBeNull();

    const other = signedIn("user-2");
    expect(await other.query(api.bundles.plan, { projectId })).toBeNull();
    expect(await other.query(api.bundles.latestForProject, { projectId })).toBeNull();
    expect(await other.query(api.bundles.run, { runId: started.runId })).toBeNull();
  });

  it("orders derived members sources-before-forks within one press", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const sourceId = await createProjectDraft(t, projectId, [{ data: { label: "S" } }], "Source");
    const forkA = await t.mutation(api.projects.forkAsSpec, {
      projectId,
      sourceDatasetId: sourceId,
      title: "Fork A",
    });
    // Fork B over fork A — derived-of-derived — added to the project FIRST
    // (registry row + membership), so discovery order would publish B before
    // A without the topological sort.
    const forkB = await t.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: forkA },
      status: "saved",
      title: "Fork B",
    });
    await t.mutation(api.projects.addArtifact, {
      artifactId: forkB,
      artifactKind: "derived",
      projectId,
    });

    const plan = await planOf(t, projectId);
    const derivedKeys = plan.members
      .filter((member) => member.kind === "derived")
      .map((member) => member.datasetKey);
    expect(derivedKeys).toStrictEqual([forkA, forkB]);
  });

  it("drops a foreign draft that merely shares a layered collection", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const ownDraft = await createProjectDraft(t, projectId, [{ data: { label: "Mine" } }]);
    const shared = await t.mutation(api.collections.create, { name: "Shared shelf" });
    await t.mutation(api.collections.addSchemaToCollection, {
      collectionId: shared,
      schemaId: ownDraft,
    });
    // Another project's WIP, sharing the collection.
    const otherProject = await createProject(t, "Other year");
    const foreignDraft = await createProjectDraft(
      t,
      otherProject,
      [{ data: { label: "Theirs" } }],
      "Their WIP",
    );
    await t.mutation(api.collections.addSchemaToCollection, {
      collectionId: shared,
      schemaId: foreignDraft,
    });
    const mapId = await t.mutation(api.maps.create, { name: "Map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await t.mutation(api.maps.addLayer, { mapId, targetId: shared, targetType: "collection" });

    const plan = await planOf(t, projectId);
    const keys = plan.members.map((member) => member.datasetKey);
    expect(keys).toContain(ownDraft);
    expect(keys).not.toContain(foreignDraft);
    expect(plan.dropped.some((entry) => entry.id === foreignDraft)).toBe(true);
  });

  it("reconciles map edges with the map's CURRENT layers — a removed layer loses its edge on the next press", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftA = await createProjectDraft(t, projectId, [{ data: { label: "A" } }], "A");
    const draftB = await createProjectDraft(t, projectId, [{ data: { label: "B" } }], "B");
    const mapId = await t.mutation(api.maps.create, { name: "Map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await t.mutation(api.maps.addLayer, { mapId, targetId: draftA, targetType: "dataset" });
    const layerB = await t.mutation(api.maps.addLayer, {
      mapId,
      targetId: draftB,
      targetType: "dataset",
    });

    const first = await driveBundlePress(t, projectId, {
      [draftA]: { chunks: [{ data: { label: "A" } }] },
      [draftB]: { chunks: [{ data: { label: "B" } }] },
    });
    const edgesOf = async () =>
      t.run(async (ctx) =>
        ctx.db
          .query("consumerReferences")
          .withIndex("by_consumer", (q) => q.eq("consumerId", mapId))
          .collect(),
      );
    expect((await edgesOf()).map((edge) => edge.sourceDatasetId)).toStrictEqual([draftA, draftB]);

    // The author removes B's layer; the next press's map leg reconciles.
    await t.mutation(api.maps.removeLayer, { layerId: layerB ?? "" });
    await driveBundlePress(t, projectId, {
      [draftA]: { chunks: [{ data: { label: "A" } }] },
      [draftB]: { chunks: [{ data: { label: "B" } }] },
    });
    const after = await edgesOf();
    expect(after).toHaveLength(1);
    expect(prop(at(after, 0), "sourceDatasetId")).toBe(draftA);
    expect((await runOf(t, first.runId)).run.status).toBe("completed");
  });
});
