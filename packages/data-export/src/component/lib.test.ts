/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

// These tests exercise the component's metadata + storage layer directly (the
// pieces that don't need the workflow to run). The full workflow — which uses
// @convex-dev/workflow and cannot be driven to completion under convex-test
// because the workflow patches the shared JS global scope — is validated
// end-to-end against a real Convex backend (see the example and README).
describe("data-export component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeExport(t: ReturnType<typeof initConvexTest>) {
    return await t.run(async (ctx) => {
      return await ctx.db.insert("exports", {
        label: "test",
        status: "running" as const,
        tableNames: ["users"],
        readerHandle: "function://host#file:reader",
        format: "jsonl" as const,
        batchSize: 100,
        requestedAt: Date.now(),
      });
    });
  }

  test("recordFile rolls totals up onto the export", async () => {
    const t = initConvexTest();
    const exportId = await makeExport(t);

    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["{}\n"])));
    await t.mutation(internal.workflows.recordFile, {
      exportId,
      tableName: "users",
      path: "users/documents.jsonl",
      storageId,
      rowCount: 3,
      sizeBytes: 42,
    });

    const exp = await t.query(api.lib.getExport, { exportId });
    expect(exp?.totalRows).toBe(3);
    expect(exp?.totalBytes).toBe(42);

    const files = await t.query(api.lib.getExportFiles, { exportId });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("users/documents.jsonl");
  });

  test("getDownloadUrls returns a URL per file", async () => {
    const t = initConvexTest();
    const exportId = await makeExport(t);
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['{"a":1}\n'])));
    await t.mutation(internal.workflows.recordFile, {
      exportId,
      tableName: "users",
      path: "users/documents.jsonl",
      storageId,
      rowCount: 1,
      sizeBytes: 8,
    });

    const urls = await t.query(api.lib.getDownloadUrls, { exportId });
    expect(urls.files).toHaveLength(1);
    expect(urls.files[0].url).toBeTruthy();
  });

  test("listExports filters by status", async () => {
    const t = initConvexTest();
    await makeExport(t);
    const running = await t.query(api.lib.listExports, { status: "running" });
    expect(running.length).toBe(1);
    const completed = await t.query(api.lib.listExports, {
      status: "completed",
    });
    expect(completed.length).toBe(0);
  });

  test("deleteExport removes the row and its files", async () => {
    const t = initConvexTest();
    const exportId = await makeExport(t);
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["{}\n"])));
    await t.mutation(internal.workflows.recordFile, {
      exportId,
      tableName: "users",
      path: "users/documents.jsonl",
      storageId,
      rowCount: 1,
      sizeBytes: 3,
    });
    // Mark it terminal so deletion is allowed.
    await t.run(async (ctx) => {
      await ctx.db.patch(exportId, { status: "completed" });
    });

    await t.mutation(api.lib.deleteExport, { exportId });
    expect(await t.query(api.lib.getExport, { exportId })).toBeNull();
    expect(await t.query(api.lib.getExportFiles, { exportId })).toHaveLength(0);
  });

  test("captures schema/version on files and reads rows back", async () => {
    const t = initConvexTest();
    const exportId = await t.run(async (ctx) => {
      return await ctx.db.insert("exports", {
        status: "running" as const,
        tableNames: ["users"],
        readerHandle: "function://host#file:reader",
        format: "jsonl" as const,
        batchSize: 100,
        requestedAt: Date.now(),
        schemaVersion: "v1",
        schemas: { users: { type: "object" } },
      });
    });

    const docs = [
      { _id: "a", _creationTime: 1, name: "Ada" },
      { _id: "b", _creationTime: 2, name: "Grace" },
    ];
    const content = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob([content])));
    await t.mutation(internal.workflows.recordFile, {
      exportId,
      tableName: "users",
      path: "users/documents.jsonl",
      storageId,
      rowCount: 2,
      sizeBytes: content.length,
    });

    // recordFile copies the export's schema/version onto the file row.
    const files = await t.query(api.lib.getExportFiles, { exportId });
    expect(files[0].schemaVersion).toBe("v1");
    expect(files[0].schema).toEqual({ type: "object" });

    // readTable streams the documents back out of storage.
    const page = await t.action(api.lib.readTable, {
      exportId,
      tableName: "users",
    });
    expect(page.rows).toHaveLength(2);
    expect(page.isDone).toBe(true);
    expect(page.schemaVersion).toBe("v1");
    expect((page.rows[0] as { name: string }).name).toBe("Ada");
  });
});
