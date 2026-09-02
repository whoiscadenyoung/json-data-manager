import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";

// NOTE: The export workflow (@convex-dev/workflow) can't be driven to
// completion under convex-test — it patches the shared JS global scope, so the
// nested workpool steps can't run here. The full run (files written, manifest,
// completion) is validated against a real backend; see the README. These tests
// cover the host wiring: the generic reader and export creation.
describe("data export example", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the generic reader pages through any table by name", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.seed, { users: 5 });

    const first = await t.query(internal.example.readTablePage, {
      table: "users",
      cursor: null,
      numItems: 2,
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);

    const second = await t.query(internal.example.readTablePage, {
      table: "users",
      cursor: first.continueCursor,
      numItems: 100,
    });
    expect(second.page).toHaveLength(3);
    expect(second.isDone).toBe(true);
  });

  test("starting an export records a running snapshot of the tables", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.seed, { users: 2 });

    const exportId = await t.mutation(api.example.runExport, {
      tableNames: ["users", "posts"],
      label: "test",
      batchSize: 2,
    });
    expect(exportId).toBeDefined();

    const exp = await t.query(api.example.getExport, { exportId });
    if (!exp) throw new Error("expected export to exist");
    expect(exp.status).toBe("running");
    expect(exp.tableNames).toEqual(["users", "posts"]);
    expect(exp.workflowId).toBeDefined();
    expect(exp.requestedAt).toBeGreaterThan(0);

    const list = await t.query(api.example.listExports, {});
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});
