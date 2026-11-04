// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { get, getQueryOptions } from "./profiles";
import {
  argsOf,
  firstArg,
  methodList,
  queryAt,
  runQueryOptions,
  stubSupabase,
} from "./test-support";

describe("profiles.get — the ADR 0009 addendum public projection", () => {
  it("selects ONLY the granted columns (email stays server-side, 0002) and keys by id", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [{ createdAt: "2026-11-03T00:00:00+00:00", id: "u1", image: null, name: "Caden" }],
      error: null,
    }));
    const row = await get({ profileId: "u1" }, { supabase: client });
    expect(row).toStrictEqual({
      createdAt: "2026-11-03T00:00:00+00:00",
      id: "u1",
      image: null,
      name: "Caden",
    });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("profiles");
    const select = String(firstArg(query, "select"));
    expect(select).toContain("name");
    expect(select).toContain("image");
    expect(select).not.toContain("email");
    expect(argsOf(query, "eq")).toStrictEqual(["id", "u1"]);
    expect(methodList(query)).toContain("limit");
  });

  it("returns null when the row is absent (a session whose profile trigger never ran)", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: null }));
    await expect(
      runQueryOptions(getQueryOptions({ profileId: "u1" }, { supabase: client })),
    ).resolves.toBe(null);
  });
});
