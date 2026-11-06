// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  addChild,
  assertAddChildSafe,
  cloneLayer,
  create,
  createForDataset,
  linkLayer,
  publishLayer,
  remove,
  stampDriftForDataset,
  update,
} from "./layers";
import { argsOf, firstArg, queryAt, stubSupabase } from "./test-support";

/** The value, or a loud failure when null/undefined (no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

/** A pre-aliased layer row (the stub skips PostgREST's select aliases). */
function layerRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-06T00:00:00Z",
    createdBy: "user-1",
    datasetMemberId: null,
    filter: null,
    id,
    kind: "data",
    labels: null,
    lifecycle: "draft",
    name: `Layer ${id}`,
    needsAttention: null,
    opacity: null,
    popup: null,
    projectId: "p1",
    style: {},
    updatedAt: "2026-11-06T00:00:00Z",
    visible: true,
    ...overrides,
  };
}

describe("layers.create — the layer row + its kind-'layer' membership (join by create only)", () => {
  it("inserts the layer, then mints the owned membership (artifact_id = the layer row)", async () => {
    const { client, queries, respond } = stubSupabase();
    let inserts = 0;
    respond(() => {
      inserts += 1;
      return inserts === 1 ? { data: { id: "l1" } } : { data: [{ id: "mem-1" }] };
    });
    const id = await create(
      { datasetMemberId: "dm-1", kind: "data", name: "Parks", projectId: "p1" },
      { supabase: client },
    );
    expect(id).toBe("l1");
    const layerInsert = queryAt(queries, 0);
    expect(firstArg(layerInsert, "insert")).toStrictEqual({
      dataset_member_id: "dm-1",
      kind: "data",
      name: "Parks",
      project_id: "p1",
    });
    const membershipInsert = queryAt(queries, 1);
    expect(firstArg(membershipInsert, "insert")).toStrictEqual({
      artifact_id: "l1",
      artifact_kind: "layer",
      project_id: "p1",
      role: "owned",
      sync_mode: "manual",
    });
  });

  it("answers null when denied (not an editor — the silent-denial rule)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const id = await create({ kind: "group", name: "Nope", projectId: "pX" }, { supabase: client });
    expect(id).toBeNull();
  });
});

describe("layers.update — styling writes clear the drift stamp", () => {
  it("a style write carries needs_attention: null", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "l1" }] }));
    const affected = await update({ layerId: "l1", style: { layers: [] } }, { supabase: client });
    expect(affected).toBe(1);
    const payload = firstArg(queryAt(queries, 0), "update") as Record<string, unknown>;
    expect(payload.style).toStrictEqual({ layers: [] });
    expect(payload.needs_attention).toBeNull();
  });

  it("a name write does not touch the stamp", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "l1" }] }));
    await update({ layerId: "l1", name: "Renamed" }, { supabase: client });
    const payload = firstArg(queryAt(queries, 0), "update") as Record<string, unknown>;
    expect("needs_attention" in payload).toBe(false);
  });
});

describe("layers.remove — the membership and the child rows go first", () => {
  it("deletes the membership, the owned child rows naming it, then the row", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "x" }] }));
    await remove({ layerId: "l1" }, { supabase: client });
    const tables = queries.map((query) => query.table);
    expect(tables.indexOf("project_artifacts")).toBeLessThan(tables.indexOf("layer_children"));
    expect(tables.indexOf("layer_children")).toBeLessThan(tables.lastIndexOf("layers"));
    const membershipDelete = queries.find(
      (query) =>
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "delete"),
    );
    expect(argsOf(present(membershipDelete), "eq").slice(0, 2)).toStrictEqual([
      "artifact_id",
      "l1",
    ]);
  });
});

describe("assertAddChildSafe — the edit-time cycle guard (ADR 0019)", () => {
  it("refuses a self-nesting group up front, with no reads", async () => {
    const { client, queries } = stubSupabase();
    await expect(
      assertAddChildSafe({ childLayerId: "g1", groupId: "g1" }, { supabase: client }),
    ).rejects.toThrow(/inside itself/);
    expect(queries.length).toBe(0);
  });

  it("walks the child's descendants and refuses when it reaches the group (B into A where A sits under B)", async () => {
    const { client, queries, respond } = stubSupabase();
    // One frontier read: B's children include A (the would-be ancestor).
    respond((query) => {
      void query;
      return {
        data: [{ childKind: "owned", childLayerId: "gA", groupId: "gB", id: "c1", order: 0 }],
      };
    });
    await expect(
      assertAddChildSafe({ childLayerId: "gB", groupId: "gA" }, { supabase: client }),
    ).rejects.toThrow(/cycle/);
    expect(queries.length).toBe(1);
  });

  it("passes when the walk bottoms out without reaching the group", async () => {
    const { client, respond } = stubSupabase();
    respond((query) => {
      void query;
      return { data: [] };
    });
    await expect(
      assertAddChildSafe({ childLayerId: "gB", groupId: "gA" }, { supabase: client }),
    ).resolves.toBeUndefined();
  });
});

describe("addChild — owned children pass the guard, linked children skip it", () => {
  it("owned: the guard runs before the insert", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      // The insert's .select() also records a select op — discriminate on
      // the insert FIRST (the projects.test lesson).
      if (
        query.table === "layer_children" &&
        query.operations.some((op) => op.method === "insert")
      ) {
        return {
          data: { childKind: "owned", childLayerId: "l1", groupId: "g1", id: "c1", order: 0 },
        };
      }
      return { data: [] };
    });
    const child = await addChild(
      { childKind: "owned", childLayerId: "l1", groupId: "g1" },
      { supabase: client },
    );
    expect(present(child).id).toBe("c1");
    // The guard's frontier read came first (before the sibling order read).
    expect(present(queries[0]).table).toBe("layer_children");
    expect(present(queries[0]).operations.some((op) => op.method === "in")).toBe(true);
  });

  it("linked: no guard read at all (a frozen foreign snapshot cannot close a cycle)", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (
        query.table === "layer_children" &&
        query.operations.some((op) => op.method === "insert")
      ) {
        return {
          data: { childKind: "linked", childLayerId: "v1", groupId: "g1", id: "c2", order: 0 },
        };
      }
      // The sibling order read only — no guard frontier (the `in` shape).
      return { data: [] };
    });
    const child = await addChild(
      { childKind: "linked", childLayerId: "v1", groupId: "g1" },
      { supabase: client },
    );
    expect(present(child).id).toBe("c2");
    // No guard read: no `in` (frontier) filter anywhere before the insert.
    expect(
      queries.some((query) =>
        query.operations.some((op) => op.method === "in" && present(op.args)[0] === "group_id"),
      ),
    ).toBe(false);
  });
});

describe("publishLayer — the append-only freeze (ADR 0019)", () => {
  it("a data version freezes the definition and pins the dataset ref at publish", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "layers" && query.operations.some((op) => op.method === "select")) {
        return {
          data: layerRow("l1", {
            datasetMemberId: "dm-1",
            needsAttention: "Schema changed — restyle",
            style: { layers: [] },
          }),
        };
      }
      if (query.table === "project_artifacts") {
        return { data: { artifactId: "dataset-1" } };
      }
      if (query.table === "dataset_versions") {
        return { data: { id: "v9", ref: "pk-9" } };
      }
      if (query.table === "layer_versions") {
        return { data: { id: "lv-1" } };
      }
      return { data: [{ id: "x" }] };
    });
    const versionId = await publishLayer({ layerId: "l1" }, { supabase: client });
    expect(versionId).toBe("lv-1");
    const versionInsert = queries.find(
      (query) =>
        query.table === "layer_versions" && query.operations.some((op) => op.method === "insert"),
    );
    const payload = firstArg(present(versionInsert), "insert") as Record<string, unknown>;
    expect(payload.dataset).toStrictEqual({
      pinnedRef: "pk-9",
      pinnedVersionId: "v9",
      sourceMemberId: "dm-1",
    });
    // The frozen definition carries the styled fields + the drift-clearing
    // is a LIVE row write, not a definition field.
    const definition = payload.definition as Record<string, unknown>;
    expect(definition.style).toStrictEqual({ layers: [] });
    expect(
      queries.some(
        (query) =>
          query.table === "layers" && query.operations.some((op) => op.method === "update"),
      ),
    ).toBe(true);
  });

  it("a group version publishes draft children FIRST, then freezes their versions", async () => {
    const { client, queries, respond } = stubSupabase();
    const group = layerRow("g1", { kind: "group" });
    const child = layerRow("child-1", { datasetMemberId: "dm-2" });
    // One branch per table the publish legs touch — the scripted run read
    // in one place (the maps-int fixture disposition).
    // oxlint-disable-next-line eslint/complexity -- the branch-per-table dispatch IS the scripted run.
    respond((query) => {
      if (query.table === "layers" && query.operations.some((op) => op.method === "select")) {
        // The point read's eq names the layer — the group's publish reads
        // the group, the child's reads the child.
        const eq = query.operations.find((op) => op.method === "eq");
        const named = eq === undefined ? undefined : eq.args[1];
        return named === "g1" ? { data: group } : { data: child };
      }
      if (
        query.table === "layer_children" &&
        query.operations.some((op) => op.method === "select")
      ) {
        return {
          data: [
            { childKind: "owned", childLayerId: "child-1", groupId: "g1", id: "c1", order: 0 },
          ],
        };
      }
      if (
        query.table === "layer_versions" &&
        query.operations.some((op) => op.method === "insert")
      ) {
        // The freezes (child first, then the group) — each answers its id.
        const inserts = queries.filter(
          (candidate) =>
            candidate.table === "layer_versions" &&
            candidate.operations.some((op) => op.method === "insert"),
        ).length;
        return { data: { id: `lv-${inserts}` } };
      }
      if (
        query.table === "layer_versions" &&
        query.operations.some((op) => op.method === "select")
      ) {
        // nextVersionLabel's chain read: empty (v1 for every freeze).
        return { data: [] };
      }
      if (query.table === "project_artifacts") {
        return { data: { artifactId: "dataset-2" } };
      }
      if (query.table === "dataset_versions") {
        return { data: [] };
      }
      return { data: null };
    });
    const versionId = await publishLayer({ layerId: "g1" }, { supabase: client });
    expect(versionId).toBe("lv-2");
    const versionInserts = queries.filter(
      (query) =>
        query.table === "layer_versions" && query.operations.some((op) => op.method === "insert"),
    );
    expect(versionInserts.length).toBe(2);
    // The CHILD's insert came first (the closure order).
    const first = present(versionInserts[0]);
    const firstPayload = present(first.operations.find((op) => op.method === "insert"))
      .args[0] as Record<string, unknown>;
    expect(firstPayload.layer_id).toBe("child-1");
    // The group's frozenChildren carry the child's new version.
    const groupInsert = present(versionInserts[1]);
    const groupPayload = present(groupInsert.operations.find((op) => op.method === "insert"))
      .args[0] as Record<string, unknown>;
    expect(groupPayload.frozen_children).toStrictEqual([
      { childKind: "owned", childLayerId: "child-1", versionId: "lv-1" },
    ]);
  });
});

describe("linkLayer / cloneLayer — the reuse pair (read-only pin vs editable copy)", () => {
  it("link mints the linked membership whose artifact_id IS the pinned version", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "layer_versions") {
        return {
          data: {
            createdAt: "2026-11-06T00:00:00Z",
            createdBy: "user-2",
            dataset: null,
            definition: { name: "Foreign parks" },
            frozenChildren: null,
            id: "lv-9",
            layerId: "lForeign",
            versionLabel: "v1",
          },
        };
      }
      return { data: { id: "mem-9" } };
    });
    const membership = await linkLayer(
      { projectId: "p1", sourceVersionId: "lv-9" },
      { supabase: client },
    );
    expect(present(membership).id).toBe("mem-9");
    const insert = queries.find(
      (query) =>
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "insert"),
    );
    expect(firstArg(present(insert), "insert")).toStrictEqual({
      artifact_id: "lv-9",
      artifact_kind: "layer",
      project_id: "p1",
      role: "linked",
      sync_mode: "manual",
    });
  });

  it("clone deep-copies a group: owned children become owned rows, linked children stay linked", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "layer_versions") {
        return {
          data: {
            createdAt: "2026-11-06T00:00:00Z",
            createdBy: "user-2",
            dataset: null,
            definition: { name: "Foreign group" },
            frozenChildren: null,
            id: "lv-9",
            layerId: "gForeign",
            versionLabel: "v1",
          },
        };
      }
      if (query.table === "layers" && query.operations.some((op) => op.method === "insert")) {
        // The clone's own row (its .select() would otherwise read as a point
        // read and answer the SOURCE row — the discriminator trap again).
        const inserts = queries.filter(
          (candidate) =>
            candidate.table === "layers" &&
            candidate.operations.some((op) => op.method === "insert"),
        ).length;
        return { data: { id: `new-${inserts}` } };
      }
      if (query.table === "layers" && query.operations.some((op) => op.method === "select")) {
        return {
          data: layerRow("gForeign", {
            kind: "group",
            name: "Foreign group",
            projectId: "pForeign",
          }),
        };
      }
      if (
        query.table === "layer_children" &&
        query.operations.some((op) => op.method === "select")
      ) {
        return {
          data: [
            {
              childKind: "linked",
              childLayerId: "vForeign",
              groupId: "gForeign",
              id: "c1",
              order: 0,
            },
          ],
        };
      }
      // The clone's inserts (layers row, membership, child row).
      const inserts = queries.filter((candidate) =>
        candidate.operations.some((op) => op.method === "insert"),
      ).length;
      return { data: { id: `new-${inserts}` } };
    });
    const clonedId = await cloneLayer(
      { projectId: "p1", sourceVersionId: "lv-9" },
      { supabase: client },
    );
    expect(clonedId).toBe("new-1");
    const childInsert = queries.find(
      (query) =>
        query.table === "layer_children" && query.operations.some((op) => op.method === "insert"),
    );
    const childPayload = firstArg(present(childInsert), "insert") as Record<string, unknown>;
    // The linked child stays a LINKED reference to the same frozen version.
    expect(childPayload.child_kind).toBe("linked");
    expect(childPayload.child_layer_id).toBe("vForeign");
  });
});

describe("createForDataset / stampDriftForDataset — the auto-layer + the drift stamp", () => {
  it("createForDataset names the layer after the dataset and styles nothing", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (
        query.table === "project_artifacts" &&
        query.operations.some((op) => op.method === "select")
      ) {
        return { data: { artifactId: "dataset-1" } };
      }
      if (query.table === "datasets") {
        return { data: { title: "Parks" } };
      }
      const inserts = queries.filter((candidate) =>
        candidate.operations.some((op) => op.method === "insert"),
      ).length;
      return inserts === 1 ? { data: { id: "l9" } } : { data: [{ id: "mem-9" }] };
    });
    const id = await createForDataset(
      { datasetMemberId: "dm-1", projectId: "p1" },
      { supabase: client },
    );
    expect(id).toBe("l9");
    const layerInsert = queries.find(
      (query) => query.table === "layers" && query.operations.some((op) => op.method === "insert"),
    );
    const payload = firstArg(present(layerInsert), "insert") as Record<string, unknown>;
    expect(payload.name).toBe("Parks");
    expect(payload.dataset_member_id).toBe("dm-1");
  });

  it("stampDriftForDataset walks the holding memberships and stamps their layers", async () => {
    const { client, queries, respond } = stubSupabase();
    respond((query) => {
      if (query.table === "project_artifacts") {
        return { data: [{ id: "dm-1" }, { id: "dm-2" }] };
      }
      return { data: [{ id: "l1" }] };
    });
    const stamped = await stampDriftForDataset(
      { datasetId: "dataset-1", reason: "Schema changed — restyle" },
      { supabase: client },
    );
    expect(stamped).toBe(2);
    const stamps = queries.filter(
      (query) => query.table === "layers" && query.operations.some((op) => op.method === "update"),
    );
    expect(stamps.length).toBe(2);
    const first = stamps[0];
    expect(first === undefined ? "" : String(argsOf(first, "eq")[1])).toBe("dm-1");
  });
});
