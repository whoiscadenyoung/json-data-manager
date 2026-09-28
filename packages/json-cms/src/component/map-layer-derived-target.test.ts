import { describe, expect, it } from "vitest";

import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

/**
 * The "derived" map-layer target (roadmap 3a, #96): `targetId` holds a
 * HOST-side registry id as a plain string — the component cannot query host
 * tables, so persistence is shape-level here (existence is the host
 * wrapper's job) while every other layer behavior stays uniform.
 */
describe("addMapLayer derived targets (roadmap 3a, #96)", () => {
  it("stores a derived layer from a host-side registry id and reads it back", async () => {
    const t = initConvexTest(),
      mapId = await t.mutation(api.lib.createMap, { name: "Map" }),
      layerId = await t.mutation(api.lib.addMapLayer, {
        mapId,
        targetId: "dRegistryRow1",
        targetType: "derived",
      });
    expect(layerId).not.toBeNull();
    const layers = await t.query(api.lib.listMapLayers, { mapId });
    expect(layers).toHaveLength(1);
    expect(layers[0].targetType).toBe("derived");
    // The host id rides through verbatim (never mangled into a component id).
    expect(layers[0].targetId).toBe("dRegistryRow1");
    expect(layers[0].visible).toBe(true);
  });

  it("rejects an empty derived target id (the shape-level check)", async () => {
    const t = initConvexTest(),
      mapId = await t.mutation(api.lib.createMap, { name: "Map" });
    await expect(
      t.mutation(api.lib.addMapLayer, { mapId, targetId: "", targetType: "derived" }),
    ).rejects.toThrow("Derived dataset not found");
  });

  it("dedupes the same derived target like any other layer", async () => {
    const t = initConvexTest(),
      mapId = await t.mutation(api.lib.createMap, { name: "Map" }),
      first = await t.mutation(api.lib.addMapLayer, {
        mapId,
        targetId: "dRegistryRow1",
        targetType: "derived",
      }),
      second = await t.mutation(api.lib.addMapLayer, {
        mapId,
        targetId: "dRegistryRow1",
        targetType: "derived",
      });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("treats derived layers like any layer for visibility, moves, and removal", async () => {
    const t = initConvexTest(),
      mapId = await t.mutation(api.lib.createMap, { name: "Map" }),
      layerId = await t.mutation(api.lib.addMapLayer, {
        mapId,
        targetId: "dRegistryRow1",
        targetType: "derived",
      });
    if (layerId === null) {
      throw new Error("layer was not created");
    }
    await t.mutation(api.lib.setMapLayerVisibility, { layerId, visible: false });
    let layers = await t.query(api.lib.listMapLayers, { mapId });
    expect(layers[0].visible).toBe(false);

    await t.mutation(api.lib.moveMapLayer, { direction: "up", layerId });
    layers = await t.query(api.lib.listMapLayers, { mapId });
    expect(layers[0].order).toBe(0);

    await t.mutation(api.lib.removeMapLayer, { layerId });
    layers = await t.query(api.lib.listMapLayers, { mapId });
    expect(layers).toHaveLength(0);
  });
});
