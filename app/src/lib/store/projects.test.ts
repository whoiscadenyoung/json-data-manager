// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { addArtifact, create, remove, removeArtifact, update } from "./projects";
import { argsOf, firstArg, queryAt, stubSupabase } from "./test-support";

/** The value, or a loud failure when null/undefined (no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

describe("projects writes — rows-affected returns (the silent-denial rule)", () => {
  it("create refuses an empty title (the title-only-required UI rule)", async () => {
    const { client } = stubSupabase();
    await expect(create({ title: "  " }, { supabase: client })).rejects.toThrow(
      "Project must have a name",
    );
  });

  it("create inserts and reads back the id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: { id: "p1" } }));
    const id = await create({ title: "SMART 2024" }, { supabase: client });
    expect(id).toBe("p1");
    const query = queryAt(queries, 0);
    expect(query.table).toBe("projects");
    expect(firstArg(query, "insert")).toStrictEqual({ title: "SMART 2024" });
    // No artifact_count in the payload — trigger-maintained.
    const payload = firstArg(query, "insert") as Record<string, unknown>;
    expect("artifact_count" in payload).toBe(false);
  });

  it("update answers the affected count (0 = not the creator — RLS denial shape)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [] }));
    const affected = await update({ description: "d", projectId: "p1" }, { supabase: client });
    expect(affected).toBe(0);
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ description: "d" });
  });

  it("remove walks each membership's fork edge before deleting the project", async () => {
    const { client, queries, respond } = stubSupabase();
    let memberReads = 0;
    respond((query) => {
      if (
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "select")
      ) {
        memberReads += 1;
        return { data: [{ id: "m1" }, { id: "m2" }] };
      }
      return { data: [{ id: "x" }] };
    });
    const affected = await remove({ projectId: "p1" }, { supabase: client });
    expect(affected).toBe(1);
    expect(memberReads).toBe(1);
    const edgeDeletes = queries.filter(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "delete"),
    );
    expect(edgeDeletes.length).toBe(2);
    const firstDelete = queryAt(edgeDeletes, 0);
    // Two chained eq filters; argsOf answers the FIRST op's arg list.
    expect(argsOf(firstDelete, "eq")).toStrictEqual(["consumer_id", "m1"]);
  });

  it("addArtifact mints the fork's float edge for dataset members (addArtifact parity)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        return {
          data: {
            addedBy: "user-1",
            artifactId: "d1",
            artifactKind: "dataset",
            id: "m1",
            projectId: "p1",
          },
        };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await addArtifact(
      { artifactId: "d1", artifactKind: "dataset", projectId: "p1" },
      { supabase: client },
    );
    expect(present(result.artifact).id).toBe("m1");
    expect(result.edgeRows).toBe(1);
    const edgeInsert = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(edgeInsert === undefined).toBe(false);
    expect(firstArg(edgeInsert ?? queryAt(queries, 0), "insert")).toStrictEqual({
      consumer_id: "m1",
      consumer_kind: "fork",
      mode: "float",
      source_dataset_id: "d1",
    });
  });

  it("addArtifact mints NO edge for map members (only dataset memberships fork)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((_query) => ({
      data: {
        addedBy: "user-1",
        artifactId: "map-1",
        artifactKind: "map",
        id: "m2",
        projectId: "p1",
      },
    }));
    const result = await addArtifact(
      { artifactId: "map-1", artifactKind: "map", projectId: "p1" },
      { supabase: client },
    );
    expect(result.edgeRows).toBe(0);
    expect(queries.some((query) => query.table === "consumer_references")).toBe(false);
  });

  it("removeArtifact deletes the membership's fork edge then the membership", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      // The membership SELECT — the DELETE also carries a select (its
      // returning clause), so the discriminator is the delete op itself.
      if (
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "select") &&
        !query.operations.some((op) => op.method === "delete")
      ) {
        return {
          data: {
            addedBy: "user-1",
            artifactId: "d1",
            artifactKind: "dataset",
            id: "m1",
            projectId: "p1",
          },
        };
      }
      return { data: [{ id: "x" }] };
    });
    const result = await removeArtifact(
      { artifactId: "d1", projectId: "p1" },
      { supabase: client },
    );
    expect(result.affected).toBe(1);
    expect(result.edgeRows).toBe(1);
    const tables = queries.map((query) => query.table);
    // Edge first, membership second — a reference's leg dies with its membership.
    expect(tables.indexOf("consumer_references")).toBeLessThan(
      tables.lastIndexOf("project_artifacts"),
    );
  });

  it("removeArtifact answers zeros for a membership it cannot see (denied, not thrown)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const result = await removeArtifact(
      { artifactId: "d1", projectId: "p1" },
      { supabase: client },
    );
    expect(result.affected).toBe(0);
    expect(result.edgeRows).toBe(0);
  });
});
