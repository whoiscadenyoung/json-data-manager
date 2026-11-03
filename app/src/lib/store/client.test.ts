// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  clientOf,
  nextPageCursor,
  queryRow,
  queryRows,
  sharedClient,
  throwPostgrestError,
} from "./client";
import { methodList, postgrestError, queryAt, stubSupabase } from "./test-support";

describe("sharedClient", () => {
  it("returns the same browser client across calls (one shared instance)", () => {
    expect(sharedClient()).toBe(sharedClient());
  });
});

describe("clientOf", () => {
  it("prefers the explicit override and falls back to the shared client", () => {
    const { client } = stubSupabase();
    expect(clientOf({ supabase: client })).toBe(client);
    expect(clientOf(undefined)).toBe(sharedClient());
    expect(clientOf({})).toBe(sharedClient());
  });
});

describe("throwPostgrestError", () => {
  it("carries the message and the code", () => {
    expect(() => throwPostgrestError(postgrestError("row-level security", "42501"))).toThrowError(
      "row-level security (42501)",
    );
  });
});

describe("queryRows / queryRow", () => {
  const rows = [{ id: "a" }, { id: "b" }];

  it("returns the scripted rows and narrows them", async () => {
    const rowsOut = await queryRows<{ id: string }>(Promise.resolve({ data: rows, error: null }));
    expect(rowsOut).toStrictEqual(rows);
  });

  it("throws the PostgREST error instead of returning data", async () => {
    await expect(
      queryRows(Promise.resolve({ data: rows, error: postgrestError("denied") })),
    ).rejects.toThrowError("denied (42501)");
  });

  it("reads a non-array payload as no rows", async () => {
    await expect(queryRows(Promise.resolve({ data: null, error: null }))).resolves.toStrictEqual(
      [],
    );
  });

  it("queryRow answers the first row, or null when none came back", async () => {
    await expect(
      queryRow<{ id: string }>(Promise.resolve({ data: rows, error: null })),
    ).resolves.toStrictEqual({ id: "a" });
    await expect(queryRow(Promise.resolve({ data: null, error: null }))).resolves.toBe(null);
  });
});

describe("nextPageCursor", () => {
  it("reads the last row's next_cursor, and empty pages are exhausted", () => {
    expect(nextPageCursor([{ next_cursor: null }, { next_cursor: "cursor-b" }])).toBe("cursor-b");
    expect(nextPageCursor([{ next_cursor: "cursor-a" }])).toBe("cursor-a");
    expect(nextPageCursor([])).toBe(null);
  });
});

describe("stubSupabase (the stand-in the other store tests rely on)", () => {
  it("records from() chains and resolves the scripted response", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      expect(query.table).toBe("datasets");
      return { data: [{ id: "d1" }], error: null };
    });
    const rows = await client.from("datasets").select("id").eq("id", "d1").limit(1);
    expect(rows).toStrictEqual({ data: [{ id: "d1" }], error: null });
    expect(queries.length).toBe(1);
    expect(methodList(queryAt(queries, 0))).toStrictEqual(["select", "eq", "limit"]);
  });

  it("records rpc() names and args", async () => {
    const { client, queries } = stubSupabase((query) => {
      expect(query.rpc).toBe("search_entries");
      return { data: [], error: null };
    });
    await client.rpc("search_entries", { p_dataset: "d1" });
    expect(queryAt(queries, 0).rpc).toBe("search_entries");
    expect(queryAt(queries, 0).rpcArgs).toStrictEqual({ p_dataset: "d1" });
  });

  it("records storage signed-URL requests", async () => {
    const { client, signedUrls } = stubSupabase();
    const { data } = await client.storage.from("geometries").createSignedUrl("p/1.json", 60);
    expect(data).toStrictEqual({ signedUrl: "https://signed.test/geometries/p/1.json" });
    expect(signedUrls).toStrictEqual([{ bucket: "geometries", path: "p/1.json", ttlSeconds: 60 }]);
  });
});
