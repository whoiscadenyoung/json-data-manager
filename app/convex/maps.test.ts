// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The derived map-layer wrapper's function-level behavior (roadmap 3a, #96):
 * `api.maps.addDerivedLayer` validates the registry row the component cannot
 * see, then records the layer through the component's widened target shape
 * (map-layer-derived-target.test.ts covers the component side). Runs through
 * `api.maps.*` / `api.derivedDatasets.*` on the real test backend, the
 * derivedDatasets.test.ts setup.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function initTest() {
  const t = convexTest(schema, modules);
  // See derivedDatasets.test.ts: the component-generic TestConvex shape vs
  // this app's concrete schema — the same instance.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

/** A saved registry row to layer onto a map (its spec shape is irrelevant to the wrapper). */
async function createSavedDerived(t: ReturnType<typeof signedIn>) {
  return t.mutation(api.derivedDatasets.save, {
    spec: { operations: [], sourceDatasetId: "someComponentDataset" },
    status: "saved",
    title: "Grants enriched",
  });
}

describe("addDerivedLayer (roadmap 3a, #96)", () => {
  it("records a layer for a real registry id, through the component's derived target shape", async () => {
    const t = signedIn(),
      derivedId = await createSavedDerived(t),
      mapId = await t.mutation(api.maps.create, { name: "Corridors" }),
      layerId = await t.mutation(api.maps.addDerivedLayer, { mapId, targetId: derivedId });
    expect(layerId).not.toBeNull();
    const layers = await t.query(api.maps.listLayers, { limit: 500, mapId });
    expect(layers).toHaveLength(1);
    expect(layers[0].targetType).toBe("derived");
    expect(layers[0].targetId).toBe(derivedId);
  });

  it("rejects a target that is not a registry row", async () => {
    const t = signedIn(),
      mapId = await t.mutation(api.maps.create, { name: "Corridors" });
    await expect(
      t.mutation(api.maps.addDerivedLayer, { mapId, targetId: "notARegistryRow" }),
    ).rejects.toThrow(/Derived dataset not found/i);
  });

  it("requires sign-in like every other map write", async () => {
    const t = initTest(),
      // The map itself needs identity (every exposeApi call is gated); the
      // final add runs on the anonymous instance.
      mapId = await t.withIdentity({ subject: "user-1" }).mutation(api.maps.create, {
        name: "Corridors",
      });
    await expect(
      t.mutation(api.maps.addDerivedLayer, { mapId, targetId: "whatever" }),
    ).rejects.toThrow(/signed out/i);
  });
});
