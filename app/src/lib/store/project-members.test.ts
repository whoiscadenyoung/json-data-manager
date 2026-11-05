// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { invite, remove, updateRole } from "./project-members";
import { firstArg, queryAt, stubSupabase } from "./test-support";

/** The value, or a loud failure when null/undefined (no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

describe("project-members writes — the ADR 0017 invite/role/remove shapes", () => {
  it("invite resolves the email through the definer RPC, then inserts the membership", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.rpc === "project_invite_resolve") {
        return { data: "user-2" };
      }
      return {
        data: {
          addedBy: "user-1",
          createdAt: "2026-11-05T00:00:00Z",
          id: "m9",
          profile: { id: "user-2", image: null, name: "Bob" },
          projectId: "p1",
          role: "editor",
          userId: "user-2",
        },
      };
    });
    const row = await invite(
      { email: "Bob@Example.com", projectId: "p1", role: "editor" },
      { supabase: client },
    );
    expect(present(row).id).toBe("m9");
    const rpc = present(queryAt(queries, 0));
    expect(rpc.rpc).toBe("project_invite_resolve");
    expect(rpc.rpcArgs).toStrictEqual({ p_email: "Bob@Example.com", p_project: "p1" });
    const insert = queryAt(queries, 1);
    expect(insert.table).toBe("project_members");
    expect(firstArg(insert, "insert")).toStrictEqual({
      project_id: "p1",
      role: "editor",
      user_id: "user-2",
    });
  });

  it("invite throws the unknown-email validation (no membership insert follows)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.rpc === "project_invite_resolve") {
        return { data: null };
      }
      throw new Error("No query should follow an unresolved email.");
    });
    await expect(
      invite(
        { email: "nobody@example.com", projectId: "p1", role: "viewer" },
        { supabase: client },
      ),
    ).rejects.toThrow("No account was found with that email.");
    expect(queries.length).toBe(1);
  });

  it("updateRole patches the role and answers the affected count", async () => {
    const { client, queries, respond } = stubSupabase();
    respond(() => ({ data: [{ id: "m9" }] }));
    const affected = await updateRole({ memberId: "m9", role: "viewer" }, { supabase: client });
    expect(affected).toBe(1);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("project_members");
    expect(firstArg(query, "update")).toStrictEqual({ role: "viewer" });
  });

  it("updateRole answers 0 when the write is denied (the creator's owner row, or a foreign project)", async () => {
    const { client } = stubSupabase(() => ({ data: [] }));
    const affected = await updateRole({ memberId: "m9", role: "editor" }, { supabase: client });
    expect(affected).toBe(0);
  });

  it("remove deletes one membership and answers the affected count", async () => {
    const { client, queries, respond } = stubSupabase();
    respond(() => ({ data: [{ id: "m9" }] }));
    const affected = await remove({ memberId: "m9" }, { supabase: client });
    expect(affected).toBe(1);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("project_members");
    expect(query.operations.some((op) => op.method === "delete")).toBe(true);
  });
});
