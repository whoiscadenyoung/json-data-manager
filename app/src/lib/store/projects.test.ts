// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  addArtifact,
  create,
  listCatalogQueryOptions,
  listVisibleArtifactMembershipsQueryOptions,
  remove,
  removeArtifact,
  setSyncMode,
  update,
  type CatalogRow,
} from "./projects";
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

  it("addArtifact linked+manual pins the fork edge at the chain head (a pin, never a copy — ADR 0018)", async () => {
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
            role: "linked",
            syncMode: "manual",
          },
        };
      }
      if (query.table === "dataset_versions") {
        return { data: { id: "v2", ref: "v2" } };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await addArtifact(
      { artifactId: "d1", artifactKind: "dataset", projectId: "p1", role: "linked" },
      { supabase: client },
    );
    expect(present(result.artifact).id).toBe("m1");
    expect(result.edgeRows).toBe(1);
    expect(result.pinnedRef).toBe("v2");
    const membershipInsert = queryAt(queries, 0);
    expect(firstArg(membershipInsert, "insert")).toStrictEqual({
      artifact_id: "d1",
      artifact_kind: "dataset",
      project_id: "p1",
      role: "linked",
      sync_mode: "manual",
    });
    const edgeInsert = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(edgeInsert === undefined).toBe(false);
    expect(firstArg(edgeInsert ?? queryAt(queries, 0), "insert")).toStrictEqual({
      consumer_id: "m1",
      consumer_kind: "fork",
      mode: "pin",
      pinned_ref: "v2",
      pinned_version_id: "v2",
      source_dataset_id: "d1",
    });
  });

  it("addArtifact linked+auto floats the fork edge (sync_mode auto = float)", async () => {
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
            role: "linked",
            syncMode: "auto",
          },
        };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await addArtifact(
      {
        artifactId: "d1",
        artifactKind: "dataset",
        projectId: "p1",
        role: "linked",
        syncMode: "auto",
      },
      { supabase: client },
    );
    expect(result.edgeRows).toBe(1);
    expect(result.pinnedRef).toBeNull();
    // No head read at all — auto never needs the chain.
    expect(queries.some((query) => query.table === "dataset_versions")).toBe(false);
    const edgeInsert = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(firstArg(edgeInsert ?? queryAt(queries, 0), "insert")).toStrictEqual({
      consumer_id: "m1",
      consumer_kind: "fork",
      mode: "float",
      source_dataset_id: "d1",
    });
  });

  it("addArtifact linked+manual on a versionless chain floats honestly (nothing to pin to yet)", async () => {
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
            role: "linked",
            syncMode: "manual",
          },
        };
      }
      if (query.table === "dataset_versions") {
        return { data: null };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await addArtifact(
      { artifactId: "d1", artifactKind: "dataset", projectId: "p1", role: "linked" },
      { supabase: client },
    );
    expect(result.pinnedRef).toBeNull();
    const edgeInsert = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(firstArg(edgeInsert ?? queryAt(queries, 0), "insert")).toMatchObject({
      mode: "float",
    });
  });

  it("addArtifact mints NO edge for owned datasets (provenance is the role column — ADR 0018)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((_query) => ({
      data: {
        addedBy: "user-1",
        artifactId: "d1",
        artifactKind: "dataset",
        id: "m3",
        projectId: "p1",
        role: "owned",
        syncMode: "manual",
      },
    }));
    const result = await addArtifact(
      { artifactId: "d1", artifactKind: "dataset", projectId: "p1", role: "owned" },
      { supabase: client },
    );
    expect(result.edgeRows).toBe(0);
    expect(result.pinnedRef).toBeNull();
    expect(queries.some((query) => query.table === "consumer_references")).toBe(false);
    expect(queries.some((query) => query.table === "dataset_versions")).toBe(false);
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

describe("setSyncMode — the lockstep write (ADR 0018: intent column + edge mode move together)", () => {
  const membershipRow = {
    addedBy: "user-1",
    artifactId: "d1",
    artifactKind: "dataset" as const,
    id: "m1",
    projectId: "p1",
    role: "linked" as const,
    syncMode: "auto" as const,
  };

  it("manual pins the edge at head and stamps the membership", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        // An UPDATE's .select("id") returning also records a select op —
        // discriminate on the update itself.
        const isUpdate = query.operations.some((op) => op.method === "update");
        return isUpdate ? { data: [{ id: "m1" }] } : { data: membershipRow };
      }
      if (query.table === "dataset_versions") {
        return { data: { id: "v2", ref: "v2" } };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await setSyncMode(
      { membershipId: "m1", mode: "manual", projectId: "p1" },
      { supabase: client },
    );
    expect(result.affected).toBe(1);
    expect(result.pinnedRef).toBe("v2");
    const edgeUpdate = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "update"),
    );
    expect(edgeUpdate === undefined).toBe(false);
    expect(firstArg(edgeUpdate ?? queryAt(queries, 0), "update")).toStrictEqual({
      mode: "pin",
      pinned_ref: "v2",
      pinned_version_id: "v2",
    });
    const membershipUpdate = queries.filter(
      (query) =>
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "update"),
    );
    expect(firstArg(queryAt(membershipUpdate, 0), "update")).toStrictEqual({
      sync_mode: "manual",
    });
  });

  it("manual refuses a versionless chain (the honest 'nothing to pin to yet')", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        return { data: membershipRow };
      }
      return { data: null };
    });
    await expect(
      setSyncMode({ membershipId: "m1", mode: "manual", projectId: "p1" }, { supabase: client }),
    ).rejects.toThrow("no published version to pin");
    // Refused BEFORE any write.
    expect(
      queries.some(
        (query) =>
          query.table === "consumer_references" ||
          (query.table === "project_artifacts" &&
            query.operations.some((op) => op.method === "update")),
      ),
    ).toBe(false);
  });

  it("auto floats the edge (the pin clears) and stamps the membership", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        // An UPDATE's .select("id") returning also records a select op —
        // discriminate on the update itself.
        const isUpdate = query.operations.some((op) => op.method === "update");
        return isUpdate ? { data: [{ id: "m1" }] } : { data: membershipRow };
      }
      return { data: [{ id: "edge-1" }] };
    });
    const result = await setSyncMode(
      { membershipId: "m1", mode: "auto", projectId: "p1" },
      { supabase: client },
    );
    expect(result.affected).toBe(1);
    expect(result.pinnedRef).toBeNull();
    const edgeUpdate = queries.find(
      (query) =>
        query.table === "consumer_references" &&
        query.operations.some((op) => op.method === "update"),
    );
    expect(firstArg(edgeUpdate ?? queryAt(queries, 0), "update")).toStrictEqual({
      mode: "float",
      pinned_ref: null,
      pinned_version_id: null,
    });
  });

  it("answers 0 for a membership it cannot see (denied, not thrown)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const result = await setSyncMode(
      { membershipId: "mX", mode: "auto", projectId: "p1" },
      { supabase: client },
    );
    expect(result.affected).toBe(0);
    expect(result.pinnedRef).toBeNull();
  });
});

/** Runs the store's queryOptions factory imperatively (the bundle-press pattern): the queryFn never reads the v5 context. */
async function runCatalogRead(options: { supabase: unknown }): Promise<CatalogRow[]> {
  const query = listCatalogQueryOptions({ projectId: "p1" }, options as never);
  const fn = query.queryFn;
  if (fn === undefined) {
    throw new Error("The catalog read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the store's queryFns never read the v5 context; `never` satisfies the parameter without constructing a QueryClient for nothing.
  return await fn({} as never);
}

describe("listCatalogQueryOptions — the provenance merge (#256)", () => {
  it("joins edges + heads; update-available is pinned & head moved past the pin", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        return {
          data: [
            {
              addedBy: "user-1",
              artifactId: "dA",
              artifactKind: "dataset",
              id: "mA",
              projectId: "p1",
              role: "linked",
              syncMode: "manual",
            },
            {
              addedBy: "user-1",
              artifactId: "dB",
              artifactKind: "dataset",
              id: "mB",
              projectId: "p1",
              role: "linked",
              syncMode: "auto",
            },
            {
              addedBy: "user-1",
              artifactId: "dC",
              artifactKind: "dataset",
              id: "mC",
              projectId: "p1",
              role: "owned",
              syncMode: "manual",
            },
          ],
        };
      }
      if (query.table === "consumer_references") {
        return {
          data: [
            {
              consumerId: "mA",
              consumerKind: "fork",
              createdAt: "2026-11-05T00:00:00Z",
              id: "edgeA",
              mode: "pin",
              pinnedRef: "v1",
              pinnedVersionId: "vA1",
              sourceDatasetId: "dA",
            },
            {
              consumerId: "mB",
              consumerKind: "fork",
              createdAt: "2026-11-05T00:00:00Z",
              id: "edgeB",
              mode: "float",
              pinnedRef: null,
              pinnedVersionId: null,
              sourceDatasetId: "dB",
            },
          ],
        };
      }
      // One head read per linked source; both heads moved to v2.
      return { data: { ref: "v2", versionLabel: "v2" } };
    });
    const rows = await runCatalogRead({ supabase: client });
    expect(rows.length).toBe(3);
    const first = present(rows[0]);
    expect(first.updateAvailable).toBe(true);
    expect(first.head).toStrictEqual({ ref: "v2", versionLabel: "v2" });
    const second = present(rows[1]);
    expect(second.updateAvailable).toBe(false);
    expect(present(second.edge).mode).toBe("float");
    const third = present(rows[2]);
    expect(third.edge).toBeNull();
    expect(third.head).toBeNull();
    expect(third.updateAvailable).toBe(false);
    // The edges arrive as ONE in() read over the linked memberships' ids.
    const edgeRead = queries.find((query) => query.table === "consumer_references");
    expect(edgeRead === undefined).toBe(false);
    expect(argsOf(edgeRead ?? queryAt(queries, 0), "in")).toStrictEqual([
      "consumer_id",
      ["mA", "mB"],
    ]);
  });

  it("a catalog with no linked datasets reads edges/heads not at all", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((_query) => ({
      data: [
        {
          addedBy: "user-1",
          artifactId: "dC",
          artifactKind: "dataset",
          id: "mC",
          projectId: "p1",
          role: "owned",
          syncMode: "manual",
        },
      ],
    }));
    const rows = await runCatalogRead({ supabase: client });
    expect(rows.length).toBe(1);
    expect(present(rows[0]).updateAvailable).toBe(false);
    expect(queries.some((query) => query.table === "consumer_references")).toBe(false);
    expect(queries.some((query) => query.table === "dataset_versions")).toBe(false);
  });
});

describe("listVisibleArtifactMembershipsQueryOptions — the used-in read (#262)", () => {
  it("reads every visible membership row with the project embed, no project filter", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        {
          addedBy: "user-1",
          artifactId: "d1",
          artifactKind: "dataset",
          id: "m1",
          project: { id: "p1", title: "National Parks" },
          projectId: "p1",
          role: "owned",
          syncMode: "manual",
        },
      ],
    }));
    const query = listVisibleArtifactMembershipsQueryOptions({ supabase: client });
    const fn = query.queryFn;
    if (fn === undefined) {
      throw new Error("The memberships read carries no queryFn.");
    }
    // The queryFn context is structural (`never` satisfies it) — the row type comes from the read's generic.
    const rows = await fn({} as never);
    expect(rows.length).toBe(1);
    expect(present(rows[0].project)).toStrictEqual({ id: "p1", title: "National Parks" });
    const recorded = queryAt(queries, 0);
    expect(recorded.table).toBe("project_artifacts");
    // The chip read is UNFILTERED — the caller groups per artifact; RLS does
    // the scoping. No .eq("project_id", …) operation was recorded.
    expect(recorded.operations.some((op) => op.method === "eq")).toBe(false);
  });
});
