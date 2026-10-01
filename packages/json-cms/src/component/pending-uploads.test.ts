/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Upload provenance (issue #131): every upload URL the component mints
 * records a `pendingUploads` row, every consumer claim must present a live,
 * same-scope token, and unclaimed rows are swept. Driven through the same
 * surfaces the real flows use — `generateUploadUrl` → blob → `startImport`'s
 * client path / the host claim — plus the public-result check that no
 * client-exposed read leaks a `_storage` id.
 *
 * Blob planting uses the host-support test action (convex-test does not
 * serve upload URLs; see host_support.storeTestBlob) — the token mechanics
 * under test are independent of how the bytes landed.
 */
import { registerWorkflowComponent } from "../test-support/workflow-register.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { PENDING_UPLOAD_TTL_MS } from "./host_support.js";
import { initConvexTest } from "./setup.test.js";

type TestCtx = ReturnType<typeof initConvexTest>;

/**
 * A test backend with the nested workflow engine registered — `startImport`
 * hands every import to it, so the happy-path test below needs the
 * registration even though it never drains a step.
 */
function initTest() {
  const t = initConvexTest();
  // The empty name mounts the engine where THIS harness's component code
  // resolves it (`components.workflow` — no `jsonCms/` prefix; that shape is
  // the host suites').
  registerWorkflowComponent(t, "");
  return t;
}

/** Plants one chunk blob in the component's storage, exactly where a client upload would land. */
async function plantChunk(t: TestCtx, rows: unknown[]): Promise<Id<"_storage">> {
  return t.run(async (ctx) =>
    ctx.storage.store(new Blob([JSON.stringify(rows)], { type: "application/json" })),
  );
}

async function createImportSchema(t: TestCtx): Promise<Id<"schemas">> {
  return t.mutation(api.lib.createSchema, {
    schema: {
      properties: { name: { type: "string" } },
      title: "Provenance Schema",
      type: "object",
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generateUploadUrl", () => {
  it("records every issuance, with its scope", async () => {
    const t = initTest();
    const issued = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });
    expect(issued.storageUrl).toContain("https://");
    expect(issued.uploadId).toBeTruthy();
    const row = await t.run(async (ctx) => ctx.db.get(issued.uploadId));
    if (row === null) {
      throw new Error("test fixture: issuance row vanished");
    }
    expect(row.scope).toBe("schema-1");

    // A scope-less issuance (the host-internal shape) is tracked too — and
    // can never satisfy a claim, which the claim tests below pin.
    const anonymous = await t.mutation(api.lib.generateUploadUrl, {});
    const anonymousRow = await t.run(async (ctx) => ctx.db.get(anonymous.uploadId));
    if (anonymousRow === null) {
      throw new Error("test fixture: issuance row vanished");
    }
    expect(anonymousRow.scope).toBeUndefined();
  });
});

describe("claimUpload", () => {
  it("consumes a live same-scope token exactly once", async () => {
    const t = initTest();
    const { uploadId } = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });

    await t.mutation(api.host_support.claimUpload, { scope: "schema-1", uploadId });

    // The row is gone — a replayed claim fails closed.
    expect(await t.run(async (ctx) => ctx.db.get(uploadId))).toBeNull();
    await expect(
      t.mutation(api.host_support.claimUpload, { scope: "schema-1", uploadId }),
    ).rejects.toThrow(/never issued/);
  });

  it("rejects a token issued for another scope", async () => {
    const t = initTest();
    const { uploadId } = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });

    await expect(
      t.mutation(api.host_support.claimUpload, { scope: "schema-2", uploadId }),
    ).rejects.toThrow(/different dataset or publish attempt/);
    // The rejected claim left the row alive for its rightful consumer.
    expect(await t.run(async (ctx) => ctx.db.get(uploadId))).not.toBeNull();
  });

  it("rejects a fabricated token", async () => {
    const t = initTest();
    await expect(
      t.mutation(api.host_support.claimUpload, { scope: "schema-1", uploadId: "nope123" }),
    ).rejects.toThrow(/never issued/);
  });
});

describe("startImport provenance", () => {
  it("accepts claimed chunks with live tokens and consumes them", async () => {
    const t = initTest(),
      schemaId = await createImportSchema(t),
      chunk = await plantChunk(t, [{ name: "a" }]),
      { uploadId } = await t.mutation(api.lib.generateUploadUrl, { scope: schemaId });

    await t.mutation(api.lib.startImport, {
      chunks: [{ storageId: chunk, uploadId }],
      schemaId,
      total: 1,
    });

    expect(await t.run(async (ctx) => ctx.db.get(uploadId))).toBeNull();
  });

  it("rejects a storage id whose token was issued for another dataset", async () => {
    const t = initTest(),
      schemaId = await createImportSchema(t),
      otherSchemaId = await createImportSchema(t),
      chunk = await plantChunk(t, [{ name: "a" }]),
      // Issued against the OTHER dataset — the classic cross-dataset mixup
      // the provenance check exists for.
      { uploadId } = await t.mutation(api.lib.generateUploadUrl, { scope: otherSchemaId });

    await expect(
      t.mutation(api.lib.startImport, {
        chunks: [{ storageId: chunk, uploadId }],
        schemaId,
        total: 1,
      }),
    ).rejects.toThrow(/different dataset or publish attempt/);
  });

  it("rejects a storage id with no token at all", async () => {
    const t = initTest(),
      schemaId = await createImportSchema(t),
      chunk = await plantChunk(t, [{ name: "a" }]);

    await expect(
      t.mutation(api.lib.startImport, {
        chunks: [{ storageId: chunk, uploadId: "fabricated000" }],
        schemaId,
        total: 1,
      }),
    ).rejects.toThrow(/never issued/);
  });

  it("rejects a raw storageIds list on the client path", async () => {
    const t = initTest(),
      schemaId = await createImportSchema(t),
      chunk = await plantChunk(t, [{ name: "a" }]);

    await expect(
      t.mutation(api.lib.startImport, { schemaId, storageIds: [chunk], total: 1 }),
    ).rejects.toThrow(/raw storage ids/);
  });

  it("keeps the host-attested path working with plain storage ids", async () => {
    const t = initTest(),
      schemaId = await createImportSchema(t),
      chunk = await plantChunk(t, [{ name: "a" }]);

    // The host flows (freeze/tag ingest) arrive with the `boundWrite`
    // attestation no client wrapper can carry — their ids were vetted at
    // their own boundary. No tokens requested or consumed.
    const importId = await t.mutation(api.lib.startImport, {
      boundWrite: "publish",
      schemaId,
      storageIds: [chunk],
      total: 1,
    });
    expect(importId).toBeTruthy();
  });
});

describe("sweepAbandonedUploads", () => {
  it("sweeps unclaimed rows past the TTL and keeps younger ones", async () => {
    const t = initTest();
    const stale = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });
    // ...time passes; a fresh issuance lands after the stale one.
    vi.setSystemTime(Date.now() + PENDING_UPLOAD_TTL_MS + 60_000);
    const fresh = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });

    const swept = await t.mutation(api.host_support.sweepAbandonedUploads, {});

    expect(swept).toBe(1);
    expect(await t.run(async (ctx) => ctx.db.get(stale.uploadId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(fresh.uploadId))).not.toBeNull();
  });

  it("never sweeps a row inside the TTL", async () => {
    const t = initTest();
    const { uploadId } = await t.mutation(api.lib.generateUploadUrl, { scope: "schema-1" });

    vi.setSystemTime(Date.now() + PENDING_UPLOAD_TTL_MS - 60_000);
    expect(await t.mutation(api.host_support.sweepAbandonedUploads, {})).toBe(0);
    expect(await t.run(async (ctx) => ctx.db.get(uploadId))).not.toBeNull();
  });
});

describe("public results carry no storage ids", () => {
  it("no client-exposed read of a fully-decorated dataset carries a _storage id", async () => {
    const t = initTest(),
      schemaId = await t.mutation(api.lib.createSchema, {
        geometryType: "Point",
        kind: "geospatial",
        schema: { properties: { n: { type: "number" } }, title: "Tiles", type: "object" },
      }),
      archive = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["pmtiles"], { type: "application/octet-stream" })),
      ),
      sourceFile = await t.run(async (ctx) =>
        ctx.storage.store(new Blob(["original"], { type: "application/json" })),
      );
    await t.mutation(api.lib.setMapTileArchive, {
      bytes: 7,
      expectedVersion: 0,
      maxZoom: 12,
      schemaId,
      storageId: archive,
    });

    // A started import (its workflow never drains under this harness) leaves
    // the status doc holding the chunk pointers — exactly what
    // `getImportStatus` used to hand back. The source file rides the same
    // call, so the dataset also has a retained original.
    const chunk = await plantChunk(t, [{ name: "a" }]),
      chunkIssue = await t.mutation(api.lib.generateUploadUrl, { scope: schemaId }),
      sourceIssue = await t.mutation(api.lib.generateUploadUrl, { scope: schemaId }),
      importId = await t.mutation(api.lib.startImport, {
        chunks: [{ storageId: chunk, uploadId: chunkIssue.uploadId }],
        schemaId,
        sourceFile: {
          name: "original.json",
          size: 8,
          storageId: sourceFile,
          uploadId: sourceIssue.uploadId,
        },
        total: 1,
      });

    // A second dataset (no source file) and a collection covering both, so
    // the list reads have rows beyond the primary one.
    const otherSchemaId = await createImportSchema(t),
      collectionId = await t.mutation(api.lib.createCollection, { name: "Collection" });
    await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId });
    await t.mutation(api.lib.addSchemaToCollection, { collectionId, schemaId: otherSchemaId });

    // Every planted blob id must be absent from every public result — the
    // storage-id secrecy half of issue #131, enforced at the value level so
    // a leak through ANY field (present or future) fails this check.
    const planted = [archive, sourceFile, chunk];
    const expectNoLeak = (label: string, result: unknown) => {
      const serialized = JSON.stringify(result ?? null) ?? "";
      for (const id of planted) {
        expect(serialized.includes(id), `${label} leaked a _storage id`).toBe(false);
      }
    };

    // The full-doc reads (the finding-1 fix): the stored shape minus the two
    // `_storage` pointers, with the retained source file downgraded to a flag.
    const doc = await t.query(api.lib.getSchema, { schemaId });
    if (doc === null) {
      throw new Error("test fixture: the decorated dataset vanished");
    }
    expect(doc.hasSourceFile).toBe(true);
    expect("mapTileArchiveStorageId" in doc).toBe(false);
    expect("sourceFileStorageId" in doc).toBe(false);
    expectNoLeak("getSchema", doc);

    const plainDoc = await t.query(api.lib.getSchema, { schemaId: otherSchemaId });
    if (plainDoc === null) {
      throw new Error("test fixture: the plain dataset vanished");
    }
    expect(plainDoc.hasSourceFile).toBe(false);

    const listed = await t.query(api.lib.listSchemas, { limit: 500, viewerId: "someone" });
    expect(listed.map((row) => row._id).toSorted()).toStrictEqual(
      [schemaId, otherSchemaId].toSorted(),
    );
    expectNoLeak("listSchemas", listed);

    const inCollection = await t.query(api.lib.listSchemasByCollection, {
      collectionId,
      viewerId: "someone",
    });
    expect(inCollection.map((row) => row._id).toSorted()).toStrictEqual(
      [schemaId, otherSchemaId].toSorted(),
    );
    expectNoLeak("listSchemasByCollection", inCollection);

    // Import status: progress only, never the chunk pointers.
    const status = await t.query(api.lib.getImportStatus, { importId });
    expect(status).not.toBeNull();
    expect("storageId" in (status ?? {})).toBe(false);
    expect("storageIds" in (status ?? {})).toBe(false);
    expectNoLeak("getImportStatus", status);

    // The tile meta: exactly the decision fields, never the blob pointer.
    const meta = await t.query(api.lib.getMapTileArchiveMeta, { schemaId });
    expect(meta).not.toBeNull();
    expect(Object.keys(meta ?? {}).toSorted()).toStrictEqual([
      "bytes",
      "maxZoom",
      "url",
      "version",
    ]);
    expectNoLeak("getMapTileArchiveMeta", meta);

    // The summaries: no archive storage id either (issue #131).
    const summaries = await t.query(api.lib.listSchemaSummaries, {
      limit: 500,
      viewerId: "someone",
    });
    const row = summaries.find((summary) => summary._id === schemaId);
    expect(row).toBeDefined();
    expect("mapTileArchiveStorageId" in (row ?? {})).toBe(false);
    expectNoLeak("listSchemaSummaries", summaries);

    const drafts = await t.query(api.lib.listDraftSchemaSummaries, {
      limit: 500,
      viewerId: "someone",
    });
    expectNoLeak("listDraftSchemaSummaries", drafts);
  });
});
