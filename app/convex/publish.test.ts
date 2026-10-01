// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The materialized publish's function-level behavior (roadmap 5b, #100):
 * freeze idempotency by publish key, read-only enforcement on the frozen
 * row, lineage contents (recipe + source versions), interruption resume, and
 * the geometrySource side of the join — every acceptance criterion of the
 * issue, driven through `api.publish.*` on a real (test) backend (the
 * derivedDatasets.test.ts setup). The client executor's pairing decisions
 * are unit-tested in src/lib/publish-spec.test.ts; here the chunk rows are
 * handed to the host directly, exactly as the orchestrator would after
 * executing.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** The attempt id type, as the start mutation mints it. */
type AttemptId = FunctionReturnType<typeof api.publish.start>["attemptId"];

const GATE_MESSAGE = /signed out/i;

/** A fresh test backend with the json-cms component mounted as in the app —
 * `register` also mounts the component's nested workflow engine
 * (`jsonCms/workflow`), which drives the frozen row's import and without
 * which a freeze could not hand off to the durable import. */
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

/**
 * Runs every scheduled function — the component's import workflow steps and
 * the publish flow's pollImport — to completion. Fake timers are active for
 * the whole drain so the poller's runAfter(500ms) re-arms and in-action
 * sleeps are advanceable; functions scheduled BEFORE fake timers activated
 * would be skipped (their real-clock time hasn't passed), so callers enter
 * fake time before the freeze.
 */
async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** One chunk blob, planted in the COMPONENT's storage exactly where the
 * client's upload-URL POST would land it (component storage is namespaced —
 * a host-stored blob is invisible to insertChunkFromStorage; see the
 * component's storeTestBlob), plus the pending-upload token its URL was
 * "issued" under — minted for the attempt, exactly as the client's upload
 * flow does (issue #131). */
async function storeChunk(
  t: TestConvex,
  attemptId: AttemptId,
  rows: Array<{ data: unknown; geometry?: unknown }>,
): Promise<{ storageId: string; uploadId: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows)),
    storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: bytes.buffer,
    }),
    { uploadId } = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.generateUploadUrl, { scope: attemptId }),
    );
  return { storageId, uploadId };
}

interface PointRow {
  data: Record<string, unknown>;
  geometry?: { coordinates: [number, number]; type: "Point" };
}

/** Creates a lifecycle-draft component dataset directly (the host-only path). */
async function createDraftDataset(
  t: TestConvex,
  options: {
    entries?: PointRow[];
    geometryType?: "Point";
    properties?: Record<string, unknown>;
    title?: string;
  },
): Promise<string> {
  return t.run(async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.createSchema, {
      // The suite's identity is stamped as creator — since stage 8 (#104) a
      // draft is invisible to every other identity, so the fixture carries one.
      actorId: "user-1",
      geometryType: options.geometryType === undefined ? undefined : "Point",
      kind: options.geometryType === undefined ? undefined : "geospatial",
      lifecycle: "draft",
      schema: {
        properties:
          options.properties === undefined ? { label: { type: "string" } } : options.properties,
        title: options.title ?? "Draft locations",
        type: "object",
      },
    }),
  );
}

/** Adds entries to a dataset through the public wrapper (geometry = GeoJSON JSON text). */
async function addEntries(t: TestConvex, schemaId: string, rows: PointRow[]): Promise<void> {
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one write per row keeps ordering visible in assertions.
    await t.mutation(api.entries.create, {
      data: row.data,
      geometry: row.geometry === undefined ? undefined : JSON.stringify(row.geometry),
      schemaId,
    });
  }
}

/** The draft's entry count, read back through the component. */
async function entryCountOf(t: TestConvex, schemaId: string): Promise<number | undefined> {
  return t.run(async (ctx) => {
    const doc = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
    return doc === null ? undefined : doc.entryCount;
  });
}

async function attemptById(t: TestConvex, attemptId: AttemptId) {
  const attempt = await t.query(api.publish.attempt, { attemptId });
  if (attempt === null) {
    throw new Error("attempt vanished");
  }
  return attempt;
}

/** Drives one full publish for tests that pre-built their chunks: plan → register → freeze → drain. */
async function drivePublish(
  t: TestConvex,
  options: {
    attemptId: AttemptId;
    chunks: Array<Array<{ data: unknown; geometry?: unknown }>>;
    geometryType?: string;
    kind?: "geospatial" | "standard";
    schema?: Record<string, unknown>;
    spec?: unknown;
    totalRows: number;
  },
): Promise<{ alreadyFrozen: boolean; schemaId: string }> {
  await t.mutation(api.publish.plan, {
    attemptId: options.attemptId,
    chunkCount: options.chunks.length,
    ...(options.geometryType === undefined ? {} : { geometryType: options.geometryType }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.spec === undefined ? {} : { spec: options.spec }),
    totalRows: options.totalRows,
  });
  for (const chunk of options.chunks) {
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    const { storageId, uploadId } = await storeChunk(t, options.attemptId, chunk);
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    await t.mutation(api.publish.registerChunk, {
      attemptId: options.attemptId,
      storageId,
      uploadId,
    });
  }
  const frozen = await t.mutation(api.publish.freeze, { attemptId: options.attemptId });
  await drainScheduled(t);
  return { alreadyFrozen: frozen.alreadyFrozen, schemaId: frozen.schemaId };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gate", () => {
  it("rejects publishing signed out", async () => {
    const t = initTest();
    await expect(t.mutation(api.publish.start, { datasetKey: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
  });
});

describe("publishing an imported draft (AC 1: a real frozen row; sources unchanged)", () => {
  it("freezes the draft's rows into a published, read-only version dataset", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {
      entries: [
        { data: { label: "Downtown" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } },
        { data: { label: "Riverside" }, geometry: { coordinates: [-89.5, 39.9], type: "Point" } },
      ],
      geometryType: "Point",
    });
    await addEntries(t, draftId, [
      { data: { label: "Downtown" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } },
      { data: { label: "Riverside" }, geometry: { coordinates: [-89.5, 39.9], type: "Point" } },
    ]);
    const draftCount = await entryCountOf(t, draftId);

    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(started.alreadyRunning).toBe(false);
    expect(started.datasetKind).toBe("draft");
    const { schemaId } = await drivePublish(t, {
      attemptId: started.attemptId,
      chunks: [
        [
          { data: { label: "Downtown" }, geometry: { coordinates: [-89.6, 39.8], type: "Point" } },
          { data: { label: "Riverside" }, geometry: { coordinates: [-89.5, 39.9], type: "Point" } },
        ],
      ],
      geometryType: "Point",
      kind: "geospatial",
      totalRows: 2,
    });

    // The published row is a real, catalog-visible dataset with exact counts.
    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    if (published === null) {
      throw new Error("the published row vanished");
    }
    expect(published.lifecycle).toBeUndefined(); // absent reads as published
    expect(published.entryCount).toBe(2);
    expect(published.featureCount).toBe(2);
    expect(published.boundingBox).not.toBeUndefined();
    const lineage = published.lineage;
    expect(lineage === undefined ? undefined : lineage.sourceSchemaId).toBe(draftId);
    expect(lineage === undefined ? undefined : lineage.versionLabel).toBe("v1");
    const ref = lineage === undefined ? undefined : lineage.snapshotRef;
    expect(ref === undefined ? "" : ref.startsWith("pub_")).toBe(true);
    const summaries = await t.query(api.schemas.listSummaries, { limit: 1000 });
    expect(summaries.some((summary) => summary._id === schemaId)).toBe(true);

    // Sources unchanged: the draft keeps its rows, its flag, and its counts.
    const draft = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: draftId }),
    );
    expect(draft === null ? undefined : draft.lifecycle).toBe("draft");
    expect(draft === null ? undefined : draft.entryCount).toBe(draftCount);

    // AC 2: the artifact is an ordinary dataset — its entries read through
    // the ordinary entry surface with zero surface-specific code.
    const page = await t.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId,
    });
    expect(page.page).toHaveLength(2);

    // The attempt completed once the import did.
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("completed");
    expect(attempt.publishedSchemaId).toBe(schemaId);
    expect(attempt.importId).not.toBeUndefined();
  });

  it("keeps the draft publishable again: a republish is v2, a new row (append-only)", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {
      entries: [{ data: { label: "A" } }],
    });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);

    const first = await t.mutation(api.publish.start, { datasetKey: draftId });
    const v1 = await drivePublish(t, {
      attemptId: first.attemptId,
      chunks: [[{ data: { label: "A" } }]],
      totalRows: 1,
    });
    const second = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.alreadyRunning).toBe(false);
    const v2 = await drivePublish(t, {
      attemptId: second.attemptId,
      chunks: [[{ data: { label: "A" } }, { data: { label: "B" } }]],
      totalRows: 2,
    });

    expect(v2.schemaId).not.toBe(v1.schemaId);
    const versions = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.listSchemaVersions, { sourceSchemaId: draftId }),
    );
    expect(versions).toHaveLength(2);
    const labels = versions
      .map((version) => (version.lineage === undefined ? "?" : version.lineage.versionLabel))
      // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; .toSorted() isn't in the lib app/convex typechecks against.
      .sort((a, b) => a.localeCompare(b));
    expect(labels).toStrictEqual(["v1", "v2"]);
    // Each version's own counts, untouched by the later publish.
    const v1Doc = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v1.schemaId }),
    );
    expect(v1Doc === null ? undefined : v1Doc.entryCount).toBe(1);
    const v2Doc = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v2.schemaId }),
    );
    expect(v2Doc === null ? undefined : v2Doc.entryCount).toBe(2);
  });

  it("publishes an empty draft: zero chunks still produce a completed version", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [] });
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    const { schemaId } = await drivePublish(t, {
      attemptId: started.attemptId,
      chunks: [],
      totalRows: 0,
    });
    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    expect(published === null ? undefined : published.entryCount).toBe(0);
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("completed");
  });
});

describe("read-only enforcement (AC 3: vN rejects data writes)", () => {
  it("rejects entry writes and deletion on the published row without an attestation", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    const { schemaId } = await drivePublish(t, {
      attemptId: started.attemptId,
      chunks: [[{ data: { label: "A" } }]],
      totalRows: 1,
    });

    // The public wrapper path cannot carry boundWrite, and the component's
    // own gate rejects what no attestation covers.
    await expect(
      t.mutation(api.entries.create, { data: { label: "x" }, schemaId }),
    ).rejects.toThrow(/read-only/i);
    // The auth gate's friendlier message fires first on the wrapper path; the
    // component's own gate is the one that holds regardless of entry point.
    await expect(t.mutation(api.schemas.remove, { schemaId })).rejects.toThrow(/read-only here/i);
  });
});

describe("freeze idempotency by publish key (AC 4's keyed half)", () => {
  it("freezing twice, and starting twice, land on one row and one attempt", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);

    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    const { storageId, uploadId } = await storeChunk(t, started.attemptId, [
      { data: { label: "A" } },
    ]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId,
    });

    const first = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    // A concurrent/duplicate freeze of the SAME key cannot fork a second v1.
    const second = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    expect(first.alreadyFrozen).toBe(false);
    expect(second.alreadyFrozen).toBe(true);
    expect(second.schemaId).toBe(first.schemaId);

    // Re-invoking start mid-publish joins the SAME attempt — the retry path.
    const rejoined = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(rejoined.attemptId).toBe(started.attemptId);
    expect(rejoined.alreadyRunning).toBe(true);

    await drainScheduled(t);
    const versions = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.listSchemaVersions, { sourceSchemaId: draftId }),
    );
    expect(versions).toHaveLength(1);
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("completed");
  });

  it("refuses a freeze before every planned chunk has landed", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 2,
      totalRows: 2,
    });
    const { storageId, uploadId } = await storeChunk(t, started.attemptId, [
      { data: { label: "A" } },
    ]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId,
    });
    await expect(t.mutation(api.publish.freeze, { attemptId: started.attemptId })).rejects.toThrow(
      /finish uploading/i,
    );
  });
});

describe("chunk registration (the freeze's checkpoint contract)", () => {
  it("registers a replayed storage id once — a client replay cannot inflate the count", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    const { storageId, uploadId } = await storeChunk(t, started.attemptId, [
      { data: { label: "A" } },
    ]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId,
    });
    // The replay (flaky network, Convex mutation retry) — must not append twice.
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId,
    });

    const progress = await attemptById(t, started.attemptId);
    expect(progress.chunkCount).toBe(1);
    // The plan stands — freeze directly (re-planning to 0 would clobber it).
    const frozen = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    expect(frozen.alreadyFrozen).toBe(false);
    const schemaId = frozen.schemaId;
    await drainScheduled(t);
    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    expect(published === null ? undefined : published.entryCount).toBe(1);
  });

  it("rejects a chunk whose upload token was issued for another attempt", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    // A second attempt's issuance — the cross-attempt mixup the provenance
    // check exists for (issue #131): the blob must never join THIS
    // attempt's checkpoint (its reset/failure cleanup would delete it).
    const otherAttempt = await t.mutation(api.publish.start, {
      datasetKey: await createDraftDataset(t, { entries: [{ data: { label: "B" } }] }),
    });
    const chunk = await storeChunk(t, otherAttempt.attemptId, [{ data: { label: "A" } }]);
    await expect(
      t.mutation(api.publish.registerChunk, {
        attemptId: started.attemptId,
        storageId: chunk.storageId,
        uploadId: chunk.uploadId,
      }),
    ).rejects.toThrow(/different dataset or publish attempt/);
    expect((await attemptById(t, started.attemptId)).chunkCount).toBe(0);
  });

  it("rejects a chunk with a fabricated upload token", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    const chunk = await storeChunk(t, started.attemptId, [{ data: { label: "A" } }]);
    await expect(
      t.mutation(api.publish.registerChunk, {
        attemptId: started.attemptId,
        storageId: chunk.storageId,
        uploadId: "fabricated000",
      }),
    ).rejects.toThrow(/never issued/);
    expect((await attemptById(t, started.attemptId)).chunkCount).toBe(0);
  });

  it("refuses to freeze an attempt whose registrations climbed above its plan", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    for (const rows of [[{ data: { label: "A" } }], [{ data: { label: "stray" } }]]) {
      // oxlint-disable-next-line no-await-in-loop -- two registrations, order irrelevant.
      const { storageId, uploadId } = await storeChunk(t, started.attemptId, rows);
      // oxlint-disable-next-line no-await-in-loop -- see above.
      await t.mutation(api.publish.registerChunk, {
        attemptId: started.attemptId,
        storageId,
        uploadId,
      });
    }
    await expect(t.mutation(api.publish.freeze, { attemptId: started.attemptId })).rejects.toThrow(
      /finish uploading/i,
    );
    // The unwedge is the CLIENT's reset-on-registered>planned decision —
    // unit-tested over `resumePlan` in src/lib/publish.test.ts.
  });
});

describe("interruption resume (AC 4: no duplicate or lost rows)", () => {
  it("resumes the same attempt after a dead browser and completes exactly once", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, {
      entries: [{ data: { label: "A" } }, { data: { label: "B" } }],
    });
    await addEntries(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);

    // Attempt one: two chunks planned, one lands, then the browser dies.
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 2,
      totalRows: 2,
    });
    const firstChunk = await storeChunk(t, started.attemptId, [{ data: { label: "A" } }]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId: firstChunk.storageId,
      uploadId: firstChunk.uploadId,
    });
    const progress = await attemptById(t, started.attemptId);
    expect(progress.chunkCount).toBe(1);
    expect(progress.plannedChunkCount).toBe(2);

    // The "new" browser re-invokes publish: same attempt, resume index 1.
    const resumed = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(resumed.attemptId).toBe(started.attemptId);
    expect(resumed.alreadyRunning).toBe(true);
    expect(resumed.chunkCount).toBe(1);
    const secondChunk = await storeChunk(t, started.attemptId, [{ data: { label: "B" } }]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId: secondChunk.storageId,
      uploadId: secondChunk.uploadId,
    });
    // The plan stands (re-planning is only for a changed chunk count) — the
    // resumed client freezes once both planned chunks are registered.
    const frozen = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    expect(frozen.alreadyFrozen).toBe(false);
    const schemaId = frozen.schemaId;
    await drainScheduled(t);
    // Exactly the planned rows: no duplicate, no loss.
    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    expect(published === null ? undefined : published.entryCount).toBe(2);
    const page = await t.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId,
    });
    const labels = page.page.map((entry) => (entry.data as { label?: string }).label);
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; .toSorted() isn't in the lib app/convex typechecks against.
    expect(labels.sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toStrictEqual(["A", "B"]);
  });

  it("resets the upload when the re-execution produces a different chunk count", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 3,
      totalRows: 3,
    });
    const stale = await storeChunk(t, started.attemptId, [{ data: { label: "stale" } }]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId: stale.storageId,
      uploadId: stale.uploadId,
    });

    // The resumed client's fresh execution finds a different shape → reset.
    await t.mutation(api.publish.resetUpload, { attemptId: started.attemptId });
    const progress = await attemptById(t, started.attemptId);
    expect(progress.chunkCount).toBe(0);
    expect(progress.plannedChunkCount).toBeUndefined();
    // …and the publish then lands on its own new plan.
    const { schemaId } = await drivePublish(t, {
      attemptId: started.attemptId,
      chunks: [[{ data: { label: "A" } }]],
      totalRows: 1,
    });
    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    expect(published === null ? undefined : published.entryCount).toBe(1);
  });
});

describe("publishing a saved transform (AC 5: lineage + geometrySource)", () => {
  interface SourcesResult {
    locationsId: string;
    registryId: string;
    rlId: string;
  }

  async function createSources(t: TestConvex): Promise<SourcesResult> {
    // The geometry side: a geospatial draft whose entries carry Points.
    const locationsId = await createDraftDataset(t, {
      geometryType: "Point",
      properties: { geometryId: { type: "string" }, label: { type: "string" } },
      title: "Locations",
    });
    await addEntries(t, locationsId, [
      {
        data: { geometryId: "geo-1", label: "Downtown" },
        geometry: { coordinates: [-89.6, 39.8], type: "Point" },
      },
    ]);
    // The join side: a standard dataset joined on label → locations.label.
    const rlId = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-1",
        lifecycle: "draft",
        schema: {
          properties: { label: { type: "string" }, locationId: { type: "string" } },
          title: "Restaurant locations",
          type: "object",
        },
      }),
    );
    await addEntries(t, rlId, [{ data: { label: "RL-1", locationId: "Downtown" } }]);
    const spec = {
      geometrySource: { column: "geometryId", lookupDatasetId: locationsId, side: "lookup" },
      operations: [
        {
          baseKey: "locationId",
          fields: ["label"],
          kind: "lookup",
          lookupDatasetId: locationsId,
          lookupKey: "label",
          namespace: "locations",
        },
      ],
      sourceDatasetId: rlId,
    };
    const registryId = await t.mutation(api.derivedDatasets.save, {
      spec,
      status: "saved",
      title: "RL enriched",
    });
    return { locationsId, registryId, rlId };
  }

  it("materializes the spec with recipe + source versions in lineage, geometry from the join side", async () => {
    const t = signedIn();
    const { locationsId, registryId, rlId } = await createSources(t);
    const countsBefore = await Promise.all([entryCountOf(t, locationsId), entryCountOf(t, rlId)]);

    const started = await t.mutation(api.publish.start, { datasetKey: registryId });
    expect(started.datasetKind).toBe("derived");
    const spec = {
      geometrySource: { column: "geometryId", lookupDatasetId: locationsId, side: "lookup" },
      operations: [
        {
          baseKey: "locationId",
          fields: ["label"],
          kind: "lookup",
          lookupDatasetId: locationsId,
          lookupKey: "label",
          namespace: "locations",
        },
      ],
      sourceDatasetId: rlId,
    };
    const { schemaId } = await drivePublish(t, {
      attemptId: started.attemptId,
      // The chunk rows the client executor emits for this spec: one row, the
      // matched lookup side's geometry payload, plumbing column stripped.
      chunks: [
        [
          {
            data: {
              "locations.label": "Downtown",
              label: "RL-1",
              locationId: "Downtown",
            },
            geometry: { coordinates: [-89.6, 39.8], type: "Point" },
          },
        ],
      ],
      geometryType: "Point",
      kind: "geospatial",
      schema: { properties: {}, title: "RL enriched", type: "object" },
      spec,
      totalRows: 1,
    });

    const published = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId }),
    );
    if (published === null) {
      throw new Error("the published row vanished");
    }
    // The frozen row: geospatial with the geometry-source side's type, exact
    // counts (one entry, one feature), and generalized lineage.
    expect(published.kind).toBe("geospatial");
    expect(published.geometryType).toBe("Point");
    expect(published.entryCount).toBe(1);
    expect(published.featureCount).toBe(1);
    const lineage = published.lineage;
    expect(lineage === undefined ? undefined : lineage.versionLabel).toBe("v1");
    expect(lineage === undefined ? undefined : lineage.sourceKey).toBe(registryId);
    expect(lineage === undefined ? true : lineage.sourceSchemaId === undefined).toBe(true);
    expect(lineage === undefined ? undefined : lineage.recipe).toStrictEqual(spec);
    // toEqual: Convex values carry no undefined — optional cells the source
    // didn't fill (a plain live source has no ref/frozenAt) drop in storage.
    // Order is specDependencies': the spec's source, then each lookup side.
    expect(lineage === undefined ? undefined : lineage.sourceVersions).toEqual([
      { datasetId: rlId, frozenAt: undefined, ref: undefined },
      { datasetId: locationsId, frozenAt: undefined, ref: undefined },
    ]);
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("completed");

    // Sources unchanged.
    expect(await entryCountOf(t, locationsId)).toBe(countsBefore[0]);
    expect(await entryCountOf(t, rlId)).toBe(countsBefore[1]);
  });

  it("refuses to freeze a transform whose sources went stale after it was saved", async () => {
    const t = signedIn();
    const { rlId, registryId } = await createSources(t);
    // The source's declared structure loses the join key — the compute-on-read
    // health walk now reports stale.
    await t.mutation(api.schemas.update, {
      schema: {
        properties: { other: { type: "string" } },
        title: "Restaurant locations",
        type: "object",
      },
      schemaId: rlId,
    });

    const started = await t.mutation(api.publish.start, { datasetKey: registryId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 0,
      kind: "standard",
      schema: { properties: {}, title: "RL enriched", type: "object" },
      totalRows: 0,
    });
    await expect(t.mutation(api.publish.freeze, { attemptId: started.attemptId })).rejects.toThrow(
      /can't publish/i,
    );
  });

  it("refuses to publish a builder autosave (a draft registry row)", async () => {
    const t = signedIn();
    const { rlId } = await createSources(t);
    const draftRowId = await t.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: rlId },
      status: "draft",
      title: "Untitled transform",
    });
    await expect(t.mutation(api.publish.start, { datasetKey: draftRowId })).rejects.toThrow(
      /autosave/i,
    );
  });
});

describe("failed imports keep the key retryable", () => {
  it("fails the attempt, deletes the half-built row, and leaves the publish key unused", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    // A chunk whose geometry is not valid GeoJSON fails the import workflow.
    await drivePublish(t, {
      attemptId: started.attemptId,
      chunks: [[{ data: { label: "A" }, geometry: { coordinates: "nope", type: "Point" } }]],
      geometryType: "Point",
      kind: "geospatial",
      totalRows: 1,
    });
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("failed");
    expect(attempt.error).not.toBeUndefined();
    // publishedSchemaId stays set (the freeze wrote it before the import
    // failed) — the KEY retryability is what matters, verified below.

    // The half-built frozen row is gone — the key stays retryable.
    const startedAgain = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(startedAgain.attemptId).not.toBe(started.attemptId);
    const versions = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.listSchemaVersions, { sourceSchemaId: draftId }),
    );
    expect(versions).toHaveLength(0);
  });
});

describe("stale-attempt revival", () => {
  it("revives an importing attempt past the stale window by re-arming the poll", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [{ data: { label: "A" } }] });
    await addEntries(t, draftId, [{ data: { label: "A" } }]);
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: 1,
      totalRows: 1,
    });
    const { storageId, uploadId } = await storeChunk(t, started.attemptId, [
      { data: { label: "A" } },
    ]);
    await t.mutation(api.publish.registerChunk, {
      attemptId: started.attemptId,
      storageId,
      uploadId,
    });
    const frozen = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    expect(frozen.alreadyFrozen).toBe(false);

    // Move the fake clock past STALE_ATTEMPT_MS WITHOUT firing timers: the
    // poller's deadline lapses on the clock, and the next start revives the
    // attempt instead of forking (advanceTimersByTime would RUN the poller
    // and finish the import, making the attempt terminal).
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);
    const revived = await t.mutation(api.publish.start, { datasetKey: draftId });
    expect(revived.attemptId).toBe(started.attemptId);
    expect(revived.alreadyRunning).toBe(true);

    await drainScheduled(t);
    const attempt = await attemptById(t, started.attemptId);
    expect(attempt.status).toBe("completed");
    // Unmentioned internal invariant: the import completed exactly once.
    const versions = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.listSchemaVersions, { sourceSchemaId: draftId }),
    );
    expect(versions).toHaveLength(1);
  });
});

// The poll action is driven through the scheduler everywhere above; this
// direct call documents its no-op guard for non-importing attempts.
describe("pollImport guards", () => {
  it("no-ops on an attempt that is not importing", async () => {
    const t = signedIn();
    const draftId = await createDraftDataset(t, { entries: [] });
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await expect(
      t.action(internal.publish.pollImport, { attemptId: started.attemptId }),
    ).resolves.toBe(null);
  });
});
