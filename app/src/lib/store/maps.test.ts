// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  addPlacement,
  create,
  get,
  list,
  listAllPlacements,
  listForProject,
  listPlacements,
  movePlacement,
  remove,
  removePlacement,
  saveViewport,
  setPlacementVisibility,
  update,
} from "./maps";
import { argsOf, firstArg, queryAt, stubSupabase, type QueryResponder } from "./test-support";

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases, so fixtures arrive in the aliased shape the real service hands back. */
function mapRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-06T00:00:00Z",
    createdBy: "11111111-1111-1111-1111-111111111111",
    description: null,
    id,
    name: `Map ${id}`,
    order: 0,
    project: { id: "p1", title: "SMART 2024" },
    projectId: "p1",
    updatedAt: "2026-11-06T00:00:00Z",
    viewport: null,
    basemap: null,
    ...overrides,
  };
}

/** Pre-aliased, as `mapRow` — see the fixture note above. */
function placementRow(id: string, order: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    layerMemberId: "mem-1",
    mapId: "m1",
    order,
    visible: true,
    ...overrides,
  };
}

/**
 * Scripts one responder per upcoming query, in order — the shared stub's
 * `respond` only keeps the LAST responder, and multi-query writes (addPlacement,
 * movePlacement) fire several queries inside one store call.
 */
function script(respond: (responder: QueryResponder) => void, responders: QueryResponder[]): void {
  let index = 0;
  respond((query) => {
    const responder = responders[index];
    index += 1;
    if (responder === undefined) {
      throw new Error(`No scripted responder for query ${index}.`);
    }
    return responder(query);
  });
}

/** The value, or a loud failure (the no-optional-chaining test style). */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

describe("maps.list — the explorer feed (D2: every visible map, project chips)", () => {
  it("reads the maps list newest-first with the project embed", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [mapRow("m2"), mapRow("m1")] }));
    const rows = await list({ supabase: client });
    expect(rows.map((row) => row.id)).toEqual(["m2", "m1"]);
    expect(present(rows[0]).project.title).toBe("SMART 2024");
    const query = queryAt(queries, 0);
    expect(query.table).toBe("maps");
    // Newest first: the created_at desc order filter rides the chain.
    expect(query.operations.some((op) => op.method === "order")).toBe(true);
  });

  it("answers empty (not thrown) when RLS hides every map", async () => {
    const { client } = stubSupabase(() => ({ data: [] }));
    const rows = await list({ supabase: client });
    expect(rows).toEqual([]);
  });
});

describe("maps.listForProject — the workspace's Maps view", () => {
  it("scopes to the project and orders by the display order", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [mapRow("m1")] }));
    const rows = await listForProject({ projectId: "p1" }, { supabase: client });
    expect(rows.length).toBe(1);
    const query = queryAt(queries, 0);
    const eq = argsOf(query, "eq");
    expect(eq).toStrictEqual(["project_id", "p1"]);
  });
});

describe("maps.get", () => {
  it("answers the row when visible", async () => {
    const { client } = stubSupabase(() => ({ data: mapRow("m1") }));
    const row = await get({ mapId: "m1" }, { supabase: client });
    expect(present(row).id).toBe("m1");
  });

  it("answers null when RLS hides the map (invisible reads as not-found)", async () => {
    const { client } = stubSupabase(() => ({ data: null }));
    const row = await get({ mapId: "mX" }, { supabase: client });
    expect(row).toBeNull();
  });
});

describe("maps.listPlacements — draw order", () => {
  it("orders by order asc with the id tie-break", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [placementRow("pl2", 1), placementRow("pl1", 0)],
    }));
    const rows = await listPlacements({ mapId: "m1" }, { supabase: client });
    expect(rows.map((row) => row.id)).toEqual(["pl2", "pl1"]);
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layers");
  });
});

describe("maps.listAllPlacements — the explorer/workspace cross-map feed", () => {
  it("reads every visible placement in one call", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [placementRow("pl1", 0)] }));
    const rows = await listAllPlacements({ supabase: client });
    expect(rows.length).toBe(1);
    expect(queryAt(queries, 0).table).toBe("map_layers");
  });
});

describe("maps writes — map rows", () => {
  it("create computes the display order (max + 1) and inserts the project row", async () => {
    const { client, queries, respond } = stubSupabase();
    script(respond, [
      () => ({ data: [mapRow("m0", { order: 2 })] }),
      () => ({ data: { id: "m9" } }),
    ]);
    const id = await create({ name: "Parks overview", projectId: "p1" }, { supabase: client });
    expect(id).toBe("m9");
    const insert = queries.find(
      (query) => query.table === "maps" && query.operations.some((op) => op.method === "insert"),
    );
    expect(firstArg(insert ?? queryAt(queries, 0), "insert")).toStrictEqual({
      name: "Parks overview",
      order: 3,
      project_id: "p1",
    });
  });

  it("create answers null when denied (not an editor — the silent-denial rule)", async () => {
    const { client, respond } = stubSupabase();
    script(respond, [() => ({ data: [] }), () => ({ data: null })]);
    const id = await create({ name: "Nope", projectId: "pX" }, { supabase: client });
    expect(id).toBeNull();
  });

  it("update writes the fields and answers the affected count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }] }));
    const affected = await update(
      { description: "d", mapId: "m1", name: "Renamed" },
      { supabase: client },
    );
    expect(affected).toBe(1);
    const payload = firstArg(queryAt(queries, 0), "update") as Record<string, unknown>;
    expect(payload.name).toBe("Renamed");
    expect(payload.description).toBe("d");
  });

  it("saveViewport writes the camera (last-write-wins editor state)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }] }));
    const affected = await saveViewport(
      { mapId: "m1", viewport: { zoom: 11, bounds: [0, 0, 1, 1] } },
      { supabase: client },
    );
    expect(affected).toBe(1);
    const payload = firstArg(queryAt(queries, 0), "update") as Record<string, unknown>;
    expect(payload.viewport).toStrictEqual({ zoom: 11, bounds: [0, 0, 1, 1] });
  });

  it("remove deletes the map (placements cascade at the DB)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }] }));
    await remove({ mapId: "m1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("maps");
    expect(argsOf(query, "eq")).toStrictEqual(["id", "m1"]);
  });
});

describe("maps.addPlacement — append at the end of the draw order", () => {
  it("computes the next order and inserts the membership reference", async () => {
    const { client, queries, respond } = stubSupabase();
    script(respond, [
      () => ({ data: [placementRow("pl0", 4)] }),
      () => ({ data: placementRow("pl9", 5) }),
    ]);
    const row = await addPlacement({ layerMemberId: "mem-9", mapId: "m1" }, { supabase: client });
    expect(present(row).order).toBe(5);
    const insert = queries.find(
      (query) =>
        query.table === "map_layers" && query.operations.some((op) => op.method === "insert"),
    );
    expect(firstArg(insert ?? queryAt(queries, 0), "insert")).toStrictEqual({
      layer_member_id: "mem-9",
      map_id: "m1",
      order: 5,
    });
  });

  it("answers null when the insert is denied", async () => {
    const { client, respond } = stubSupabase();
    script(respond, [
      () => ({ data: [] }),
      // The denial shape the store answers: an RLS-refused insert surfaces
      // as a 0-row answer (null), never a thrown PostgREST error.
      () => ({ data: null }),
    ]);
    const row = await addPlacement({ layerMemberId: "mem-9", mapId: "mX" }, { supabase: client });
    expect(row).toBeNull();
  });
});

describe("maps.movePlacement — the neighbor swap", () => {
  it("updates the neighbor first, then the mover (ordering reads stay gap-free)", async () => {
    const { client, queries, respond } = stubSupabase();
    script(respond, [
      () => ({ data: placementRow("pl2", 1) }),
      () => ({ data: [placementRow("pl1", 0), placementRow("pl2", 1), placementRow("pl3", 2)] }),
      () => ({ data: [{ id: "pl1" }] }),
      () => ({ data: [{ id: "pl2" }] }),
    ]);
    await movePlacement({ direction: "up", placementId: "pl2" }, { supabase: client });
    const updates = queries.filter(
      (query) =>
        query.table === "map_layers" && query.operations.some((op) => op.method === "update"),
    );
    expect(updates.length).toBe(2);
    // The neighbor FIRST: its update carries the mover's old order and the
    // neighbor's id in its eq chain.
    const first = present(updates[0]);
    const firstUpdate = first.operations.find((op) => op.method === "update");
    const firstEq = first.operations.find((op) => op.method === "eq");
    expect(present(firstUpdate).args[0]).toStrictEqual({ order: 1 });
    expect(present(firstEq).args).toStrictEqual(["id", "pl1"]);
  });

  it("no-ops at the edge (no neighbor)", async () => {
    const { client, queries, respond } = stubSupabase();
    script(respond, [
      () => ({ data: placementRow("pl1", 0) }),
      () => ({ data: [placementRow("pl1", 0)] }),
    ]);
    await movePlacement({ direction: "up", placementId: "pl1" }, { supabase: client });
    expect(
      queries.some(
        (query) =>
          query.table === "map_layers" && query.operations.some((op) => op.method === "update"),
      ),
    ).toBe(false);
  });
});

describe("maps.setPlacementVisibility / removePlacement", () => {
  it("toggles the map-local visibility and answers the count", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "pl1" }] }));
    const affected = await setPlacementVisibility(
      { placementId: "pl1", visible: false },
      { supabase: client },
    );
    expect(affected).toBe(1);
    expect(firstArg(queryAt(queries, 0), "update")).toStrictEqual({ visible: false });
  });

  it("removes the placement row", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "pl1" }] }));
    await removePlacement({ placementId: "pl1" }, { supabase: client });
    expect(argsOf(queryAt(queries, 0), "eq")).toStrictEqual(["id", "pl1"]);
  });
});
