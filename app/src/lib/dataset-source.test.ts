import { describe, expect, it } from "vitest";

import { isPostgresDatasetId } from "./dataset-source";

/**
 * The transitional split's key: the id space alone says where a dataset was
 * created (design doc §14) — Postgres rows carry gen_random_uuid() values,
 * Convex ids are 32-char lowercase alphanumerics with no dashes.
 */
describe("isPostgresDatasetId", () => {
  it("answers true for uuid ids (the Postgres backend's gen_random_uuid shape)", () => {
    expect(isPostgresDatasetId("7e9d3a61-1c2b-4f8e-9a0d-3f5b6c7d8e9f")).toBe(true);
    expect(isPostgresDatasetId("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("answers false for Convex dataset ids (32 lowercase chars, no dashes)", () => {
    expect(isPostgresDatasetId("jx78knwxh0aqmnj2jgfg80st318efn5j")).toBe(false);
  });

  it("answers false for anything else a URL might carry", () => {
    expect(isPostgresDatasetId("")).toBe(false);
    expect(isPostgresDatasetId("not-an-id")).toBe(false);
    expect(isPostgresDatasetId("7e9d3a611c2b4f8e9a0d3f5b6c7d8e9f")).toBe(false);
    // A uuid missing a dash is a Convex id shape, not a PG one — the split
    // must not misroute on near-misses.
    expect(isPostgresDatasetId("7e9d3a61-1c2b-4f8e-9a0d-3f5b6c7d8e9")).toBe(false);
  });
});
