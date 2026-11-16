// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env`; CI has no .env.local.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  createFolder,
  moveArtifacts,
  moveFolder,
  removeFolder,
  renameFolder,
} from "./project-folders";
import { argsOf, firstArg, postgrestError, queryAt, stubSupabase } from "./test-support";

describe("project-folders writes (migration 0034)", () => {
  it("createFolder trims the name and inserts under the parent", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: { id: "f1", name: "Grants", parentId: null, projectId: "p1" },
    }));
    const row = await createFolder(
      { name: "  Grants ", parentId: null, projectId: "p1" },
      { supabase: client },
    );
    expect(row === null ? null : row.id).toBe("f1");
    const insert = queryAt(queries, 0);
    expect(insert.table).toBe("project_folders");
    expect(firstArg(insert, "insert")).toStrictEqual({
      name: "Grants",
      parent_id: null,
      project_id: "p1",
    });
  });

  it("refuses a blank name before any query", async () => {
    const { client, queries } = stubSupabase();
    await expect(
      createFolder({ name: "   ", parentId: null, projectId: "p1" }, { supabase: client }),
    ).rejects.toThrow("A folder needs a name.");
    expect(queries.length).toBe(0);
  });

  it("restates a taken name (23505) in the user's terms", async () => {
    const { client } = stubSupabase(() => ({
      error: postgrestError("duplicate key value violates unique constraint", "23505"),
    }));
    await expect(
      renameFolder({ folderId: "f1", name: "Grants" }, { supabase: client }),
    ).rejects.toThrow("A folder named “Grants” already exists there.");
  });

  it("passes the tree guard's own message through (23514)", async () => {
    const { client } = stubSupabase(() => ({
      error: postgrestError("A folder cannot be moved inside itself.", "23514"),
    }));
    await expect(
      moveFolder({ folderId: "f1", parentId: "f2" }, { supabase: client }),
    ).rejects.toThrow(/^A folder cannot be moved inside itself\.$/);
  });

  it("moveFolder patches the parent and answers the affected count (0 = denied)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond(() => ({ data: [{ id: "f1" }] }));
    expect(await moveFolder({ folderId: "f1", parentId: null }, { supabase: client })).toBe(1);
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ parent_id: null });
    respond(() => ({ data: [] }));
    expect(await moveFolder({ folderId: "f1", parentId: "f2" }, { supabase: client })).toBe(0);
  });

  it("removeFolder calls delete_project_folder and answers its count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: 1 }));
    expect(await removeFolder({ folderId: "f1" }, { supabase: client })).toBe(1);
    const rpc = queryAt(queries, 0);
    expect(rpc.rpc).toBe("delete_project_folder");
    expect(rpc.rpcArgs).toStrictEqual({ p_folder: "f1" });
  });

  it("moveArtifacts sets folder_id on the membership rows; an empty move issues no query", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }, { id: "m2" }] }));
    expect(await moveArtifacts({ folderId: null, membershipIds: [] }, { supabase: client })).toBe(
      0,
    );
    expect(queries.length).toBe(0);
    expect(
      await moveArtifacts({ folderId: "f1", membershipIds: ["m1", "m2"] }, { supabase: client }),
    ).toBe(2);
    const update = queryAt(queries, 0);
    expect(update.table).toBe("project_artifacts");
    expect(firstArg(update, "update")).toStrictEqual({ folder_id: "f1" });
    expect(argsOf(update, "in")).toStrictEqual(["id", ["m1", "m2"]]);
  });

  it("moveArtifacts batches a large selection so no request carries more than 100 ids", async () => {
    const { client, queries } = stubSupabase((query) => {
      const ids = argsOf(query, "in")[1];
      return { data: Array.isArray(ids) ? ids.map((id: unknown) => ({ id })) : [] };
    });
    const membershipIds = Array.from({ length: 250 }, (_, index) => `m${index}`);
    expect(await moveArtifacts({ folderId: "f1", membershipIds }, { supabase: client })).toBe(250);
    expect(queries.length).toBe(3);
  });
});
