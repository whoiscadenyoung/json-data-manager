// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  addLayer,
  create,
  get,
  list,
  listAllLayers,
  listLayers,
  listOverrides,
  listOverridesQueryOptions,
  moveLayer,
  remove,
  removeLayer,
  setLayerVisibility,
  setMapLayerOverride,
  update,
} from "./maps";
import {
  allArgs,
  argsOf,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  stubSupabase,
  type QueryResponder,
  type StubSupabase,
} from "./test-support";

/** Pre-aliased (camelCase) — the stub skips PostgREST's `select` aliases, so fixtures arrive in the aliased shape the real service hands back. */
function mapRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    createdAt: "2026-11-03T00:00:00Z",
    createdBy: "11111111-1111-1111-1111-111111111111",
    description: null,
    id,
    name: `Map ${id}`,
    updatedAt: "2026-11-03T00:00:00Z",
    ...overrides,
  };
}

/** Pre-aliased, as `mapRow` — see the fixture note above. */
function layerRow(id: string, order: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    mapId: "m1",
    order,
    targetId: "d1",
    targetType: "dataset",
    visible: true,
    ...overrides,
  };
}

/**
 * Scripts one responder per upcoming query, in order — the shared stub's
 * `respond` only keeps the LAST responder, and multi-query writes (addLayer,
 * moveLayer) fire several queries inside one store call.
 */
function script(stub: StubSupabase, responders: QueryResponder[]): void {
  let index = 0;
  stub.respond((query) => {
    const responder = responders[index];
    index += 1;
    if (responder === undefined) {
      throw new Error(`No scripted responder for query ${index}.`);
    }
    return responder(query);
  });
}

describe("maps.list — the maps index feed", () => {
  it("selects the maps table newest-first and maps the columns to consumer shape", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [mapRow("m2", { createdAt: "2026-11-03T01:00:00Z" }), mapRow("m1")],
      error: null,
    }));
    const rows = await list({ supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("maps");
    expect(firstArg(query, "order")).toBe("created_at");
    expect(argsOf(query, "order")[1]).toStrictEqual({ ascending: false });
    expect(rows[0]).toStrictEqual({
      createdAt: "2026-11-03T01:00:00Z",
      createdBy: "11111111-1111-1111-1111-111111111111",
      description: null,
      id: "m2",
      name: "Map m2",
      updatedAt: "2026-11-03T00:00:00Z",
    });
  });

  it("throws the PostgREST error shape on failure", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: postgrestError() }));
    await expect(list({ supabase: client })).rejects.toThrow("permission denied (42501)");
  });
});

describe("maps.get", () => {
  it("filters by id and answers the single row", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [mapRow("m1")], error: null }));
    const row = await get({ mapId: "m1" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "eq")).toBe("id");
    expect(argsOf(queryAt(queries, 0), "eq")[1]).toBe("m1");
    expect(row).not.toBeNull();
    expect(row === null ? "" : row.id).toBe("m1");
  });

  it("answers null when RLS hides the row (empty read)", async () => {
    const { client } = stubSupabase(() => ({ data: [], error: null }));
    expect(await get({ mapId: "m1" }, { supabase: client })).toBeNull();
  });
});

describe("maps.listLayers — draw order", () => {
  it("orders by the layer position with the id tie-break", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [layerRow("l1", 0), layerRow("l2", 1)],
      error: null,
    }));
    const rows = await listLayers({ mapId: "m1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layers");
    expect(firstArg(query, "eq")).toBe("map_id");
    expect(argsOf(query, "eq")[1]).toBe("m1");
    expect(argsOf(query, "order")[0]).toBe("order");
    expect(argsOf(query, "order")[1]).toStrictEqual({ ascending: true });
    expect(allArgs(query, "order")[1]).toStrictEqual(["id", { ascending: true }]);
    expect(rows.map((row) => `${row.id}:${row.order}`)).toStrictEqual(["l1:0", "l2:1"]);
    expect(rows[0]).toMatchObject({ mapId: "m1", targetType: "dataset", visible: true });
  });
});

describe("maps.listAllLayers — the index/sheet cross-map feed", () => {
  it("reads every map's layers with no map filter (counts computed client-side)", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [layerRow("l1", 0), layerRow("l2", 1, { mapId: "m2" })],
      error: null,
    }));
    const rows = await listAllLayers({ supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layers");
    expect(methodList(query).includes("eq")).toBe(false);
    expect(rows.length).toBe(2);
  });
});

describe("maps.listOverrides — the issue #53 map-scoped read", () => {
  it("embeds the parent layer with !inner to filter to the map and strips it from the rows", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [
        {
          childKey: "group:g1",
          id: "o1",
          layerId: "l1",
          map_layers: { map_id: "m1" },
          visible: false,
        },
      ],
      error: null,
    }));
    const rows = await listOverrides({ mapId: "m1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layer_overrides");
    expect(firstArg(query, "eq")).toBe("map_layers.map_id");
    expect(argsOf(query, "eq")[1]).toBe("m1");
    expect(rows).toStrictEqual([{ childKey: "group:g1", id: "o1", layerId: "l1", visible: false }]);
  });

  it("queryOptions carry the args in the key", () => {
    const { client } = stubSupabase();
    const args = { mapId: "m1" };
    expect(listOverridesQueryOptions(args, { supabase: client }).queryKey).toStrictEqual([
      "pg:maps",
      "listOverrides",
      args,
    ]);
  });
});

describe("maps writes", () => {
  it("create inserts name/description and returns the new id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m-new" }], error: null }));
    const id = await create({ description: "d", name: "Corridor" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("maps");
    expect(firstArg(query, "insert")).toStrictEqual({ description: "d", name: "Corridor" });
    expect(methodList(query)).toStrictEqual(["insert", "select", "single"]);
    expect(id).toBe("m-new");
  });

  it("create omits the description key when absent (column default applies)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m-new" }], error: null }));
    await create({ name: "Corridor" }, { supabase: client });
    expect(firstArg(queryAt(queries, 0), "insert")).toStrictEqual({ name: "Corridor" });
  });

  it("update writes name and clears an emptied description", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }], error: null }));
    await update({ description: undefined, mapId: "m1", name: "Renamed" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("maps");
    const payload = firstArg(query, "update") as Record<string, unknown>;
    expect(payload["name"]).toBe("Renamed");
    expect(payload["description"]).toBeNull();
    expect(firstArg(query, "eq")).toBe("id");
    expect(argsOf(query, "eq")[1]).toBe("m1");
  });

  it("remove deletes by id (layers/overrides cascade server-side)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "m1" }], error: null }));
    await remove({ mapId: "m1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(methodList(query)[0]).toBe("delete");
    expect(firstArg(query, "eq")).toBe("id");
    expect(argsOf(query, "eq")[1]).toBe("m1");
  });
});

describe("maps.addLayer — append at the end of the draw order", () => {
  it("reads the current layers, then inserts at max order + 1", async () => {
    const stub = stubSupabase();
    script(stub, [
      () => ({ data: [layerRow("l1", 0), layerRow("l2", 4)], error: null }),
      () => ({
        data: [layerRow("l3", 5, { target_id: "c1", target_type: "collection" })],
        error: null,
      }),
    ]);
    const row = await addLayer(
      { mapId: "m1", targetId: "c1", targetType: "collection" },
      { supabase: stub.client },
    );
    expect(stub.queries[0].table).toBe("map_layers");
    expect(stub.queries[1].table).toBe("map_layers");
    expect(firstArg(stub.queries[1], "insert")).toStrictEqual({
      map_id: "m1",
      order: 5,
      target_id: "c1",
      target_type: "collection",
    });
    expect(row).toMatchObject({ id: "l3", order: 5 });
  });

  it("a first layer lands at position 0", async () => {
    const stub = stubSupabase();
    script(stub, [
      () => ({ data: [], error: null }),
      () => ({ data: [layerRow("l1", 0)], error: null }),
    ]);
    const row = await addLayer(
      { mapId: "m1", targetId: "d1", targetType: "dataset" },
      { supabase: stub.client },
    );
    expect(firstArg(stub.queries[1], "insert")).toMatchObject({ order: 0 });
    expect(row.order).toBe(0);
  });
});

describe("maps.moveLayer — the neighbor swap", () => {
  it("swaps orders with the previous layer on 'up' (neighbor first)", async () => {
    const stub = stubSupabase();
    script(stub, [
      // 1: the layer read; 2: the layers list; 3+4: the two updates.
      () => ({ data: [layerRow("l2", 1)], error: null }),
      () => ({
        data: [layerRow("l1", 0), layerRow("l2", 1), layerRow("l3", 2)],
        error: null,
      }),
      () => ({ data: [{ id: "l1" }], error: null }),
      () => ({ data: [{ id: "l2" }], error: null }),
    ]);
    await moveLayer({ direction: "up", layerId: "l2" }, { supabase: stub.client });
    expect(firstArg(stub.queries[2], "update")).toStrictEqual({ order: 1 });
    expect(firstArg(stub.queries[2], "eq")).toBe("id");
    expect(argsOf(stub.queries[2], "eq")[1]).toBe("l1");
    expect(firstArg(stub.queries[3], "update")).toStrictEqual({ order: 0 });
    expect(firstArg(stub.queries[3], "eq")).toBe("id");
    expect(argsOf(stub.queries[3], "eq")[1]).toBe("l2");
  });

  it("is a no-op when there is no neighbor in the direction (single-layer map)", async () => {
    const stub = stubSupabase();
    script(stub, [
      () => ({ data: [layerRow("l1", 0)], error: null }),
      () => ({ data: [layerRow("l1", 0)], error: null }),
    ]);
    await moveLayer({ direction: "down", layerId: "l1" }, { supabase: stub.client });
    expect(stub.queries.length).toBe(2);
    expect(methodList(stub.queries[1]).includes("update")).toBe(false);
  });

  it("is a no-op for an unknown layer (deleted mid-click)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await moveLayer({ direction: "up", layerId: "gone" }, { supabase: client });
    expect(queries.length).toBe(1);
  });
});

describe("maps.setLayerVisibility / removeLayer", () => {
  it("visibility updates the visible column by layer id", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "l1" }], error: null }));
    await setLayerVisibility({ layerId: "l1", visible: false }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(firstArg(query, "update")).toStrictEqual({ visible: false });
    expect(firstArg(query, "eq")).toBe("id");
    expect(argsOf(query, "eq")[1]).toBe("l1");
  });

  it("removeLayer deletes the layer row (overrides cascade server-side)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "l1" }], error: null }));
    await removeLayer({ layerId: "l1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layers");
    expect(methodList(query)[0]).toBe("delete");
  });
});

describe("maps.setMapLayerOverride — the #53 hide-writes/show-clears semantics", () => {
  it("hiding upserts a {visible:false} row on the unique (layer_id, child_key)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "o1" }], error: null }));
    await setMapLayerOverride(
      { childKey: "dataset:d1", layerId: "l1", visible: false },
      { supabase: client },
    );
    const query = queryAt(queries, 0);
    expect(query.table).toBe("map_layer_overrides");
    expect(firstArg(query, "upsert")).toStrictEqual({
      child_key: "dataset:d1",
      layer_id: "l1",
      visible: false,
    });
    expect(argsOf(query, "upsert")[1]).toStrictEqual({ onConflict: "layer_id,child_key" });
  });

  it("showing deletes any override row (back to the default visible)", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [{ id: "o1" }], error: null }));
    await setMapLayerOverride(
      { childKey: "group:g1", layerId: "l1", visible: true },
      { supabase: client },
    );
    const query = queryAt(queries, 0);
    expect(methodList(query)).toStrictEqual(["delete", "eq", "eq", "select"]);
    expect(firstArg(query, "eq")).toBe("layer_id");
    expect(allArgs(query, "eq")[0]).toStrictEqual(["layer_id", "l1"]);
    expect(allArgs(query, "eq")[1]).toStrictEqual(["child_key", "group:g1"]);
  });
});
