// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The layer-styles module's access model and validation
 * (docs/layer-styles.md), driven through `api.layerStyles.styles.*` on a
 * test backend with the json-cms component mounted (the apps.test.ts setup).
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { compileStyle, defaultEditor } from "@caden/layer-styles/compile";
import type { LayerStyle } from "@caden/layer-styles/validators";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("/convex/**/*.ts");

function initTest() {
  const t = convexTest(schema, modules);
  registerJsonCms(t);
  return t;
}

type Backend = ReturnType<typeof initTest>;

function as(t: Backend, subject: string) {
  return t.withIdentity({ subject });
}

type Caller = ReturnType<typeof as>;

async function setup(t: Backend) {
  const owner = as(t, "owner"),
    datasetId = await owner.mutation(api.schemas.create, {
      schema: { properties: { kind: { type: "string" } }, title: "Parks", type: "object" },
    }),
    mapId = await owner.mutation(api.maps.create, { name: "Parks map" });
  return { datasetId, mapId, owner };
}

const RED: LayerStyle = compileStyle(defaultEditor("#ef4444"));

async function save(caller: Caller, mapId: string, renderId: string, style: LayerStyle = RED) {
  await caller.mutation(api.layerStyles.styles.set, { mapId, renderId, style });
}

describe("layer styles", () => {
  it("rejects signed-out callers", async () => {
    const t = initTest();
    await expect(t.query(api.layerStyles.styles.listForMap, { mapId: "x" })).rejects.toThrow(
      /signed out/i,
    );
  });

  it("saves, replaces, lists, and resets a dataset's style on a map", async () => {
    const t = initTest(),
      { datasetId, mapId, owner } = await setup(t);
    await save(owner, mapId, datasetId);
    const blue = compileStyle(defaultEditor("#3b82f6"));
    await save(owner, mapId, datasetId, blue);
    const listed = await owner.query(api.layerStyles.styles.listForMap, { mapId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ renderId: datasetId, style: blue });

    await owner.mutation(api.layerStyles.styles.reset, { mapId, renderId: datasetId });
    expect(await owner.query(api.layerStyles.styles.listForMap, { mapId })).toEqual([]);
  });

  it("keeps styles per map", async () => {
    const t = initTest(),
      { datasetId, mapId, owner } = await setup(t),
      otherMapId = await owner.mutation(api.maps.create, { name: "Other map" });
    await save(owner, mapId, datasetId);
    expect(await owner.query(api.layerStyles.styles.listForMap, { mapId: otherMapId })).toEqual([]);
  });

  it("lets any signed-in collaborator style a shared map (ADR 0009)", async () => {
    const t = initTest(),
      { datasetId, mapId } = await setup(t),
      collaborator = as(t, "collaborator");
    await save(collaborator, mapId, datasetId);
    expect(await collaborator.query(api.layerStyles.styles.listForMap, { mapId })).toHaveLength(1);
  });

  it("refuses unknown maps and datasets", async () => {
    const t = initTest(),
      { datasetId, mapId, owner } = await setup(t);
    await expect(save(owner, "not-a-map", datasetId)).rejects.toThrow(/map not found/i);
    await expect(save(owner, mapId, "not-a-dataset")).rejects.toThrow(/dataset not found/i);
  });

  it("never writes an invisible dataset id into shared map state", async () => {
    const t = initTest(),
      { mapId, owner } = await setup(t),
      other = as(t, "other"),
      privateId = await other.mutation(api.schemas.create, {
        schema: { properties: {}, title: "Private", type: "object" },
      });
    await other.mutation(api.schemas.setVisibility, {
      schemaId: privateId,
      visibility: "author",
    });
    await expect(save(owner, mapId, privateId)).rejects.toThrow(/dataset not found/i);
    // Its creator can style it.
    await save(other, mapId, privateId);
  });

  it("validates the style document", async () => {
    const t = initTest(),
      { datasetId, mapId, owner } = await setup(t);
    await expect(save(owner, mapId, datasetId, { layers: [], version: 1 })).rejects.toThrow(
      /1 to 8 layers/i,
    );
    const badEditor = compileStyle({ ...defaultEditor("#000000"), opacity: 2 });
    await expect(save(owner, mapId, datasetId, badEditor)).rejects.toThrow(/opacity/i);
    const badBreaks = compileStyle({
      ...defaultEditor("#000000"),
      renderer: {
        breaks: [20, 10],
        colors: ["#111111", "#222222", "#333333"],
        field: "pop",
        kind: "graduated",
        method: "equal",
        ramp: "blues",
      },
    });
    await expect(save(owner, mapId, datasetId, badBreaks)).rejects.toThrow(/increase/i);
    const huge: LayerStyle = {
      layers: [{ paint: { "fill-color": "x".repeat(40_000) }, type: "fill" }],
      version: 1,
    };
    await expect(save(owner, mapId, datasetId, huge)).rejects.toThrow(/too large/i);
  });
});
