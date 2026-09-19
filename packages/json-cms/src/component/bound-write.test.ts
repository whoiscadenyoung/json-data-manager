import { describe, expect, it } from "vitest";
/// <reference types="vite/client" />

import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { initConvexTest } from "./setup.test.js";

/**
 * Component-level read-only enforcement for bound datasets
 * (`assertDataWritable` in lib.ts): data mutations on a `source`-marked
 * (live projection) or `lineage`-marked (frozen version) dataset are
 * rejected unless the host's sync/ingest/retirement flow attests them with
 * `boundWrite` — the attestation `exposeApi` wrappers deliberately cannot
 * carry, so the gate holds for every client-reachable path.
 */

const RESTAURANT_SCHEMA = {
  properties: {
    label: { title: "Location", type: "string" },
  },
  required: ["label"],
  title: "Restaurant locations",
  type: "object",
};

async function createBoundSchema(
  t: ReturnType<typeof initConvexTest>,
  markers: {
    lineage?: {
      frozenAt: number;
      sourceSchemaId: Id<"schemas">;
      versionLabel: string;
    };
    source?: { name: string };
  },
) {
  return t.mutation(api.lib.createSchema, {
    geometryType: "Point",
    kind: "geospatial",
    lineage: markers.lineage,
    schema: RESTAURANT_SCHEMA,
    source: markers.source,
  });
}

const POINT = JSON.stringify({ coordinates: [-76.2, 36.9], type: "Point" });

describe("bound dataset read-only enforcement", () => {
  it("rejects entry mutations on a source-marked dataset without the attestation", async () => {
    const t = initConvexTest();
    const schemaId = await createBoundSchema(t, { source: { name: "restaurantLocations" } });

    await expect(
      t.mutation(api.lib.createEntry, { data: { label: "A" }, schemaId }),
    ).rejects.toThrow("read-only projection");
    await expect(
      t.mutation(api.lib.createEntriesBulk, { entries: [{ data: { label: "A" } }], schemaId }),
    ).rejects.toThrow("read-only projection");

    const entryId: Id<"entries"> = await t.mutation(api.lib.createEntry, {
      boundWrite: "sync",
      data: { label: "A" },
      geometry: POINT,
      schemaId,
    });
    await expect(t.mutation(api.lib.updateEntry, { data: { label: "B" }, entryId })).rejects.toThrow(
      "read-only projection",
    );
    await expect(t.mutation(api.lib.deleteEntry, { entryId })).rejects.toThrow(
      "read-only projection",
    );
    await expect(t.mutation(api.lib.deleteEntriesBySchema, { schemaId })).rejects.toThrow(
      "read-only projection",
    );
  });

  it("accepts the same mutations when the host flow attests them", async () => {
    const t = initConvexTest();
    const schemaId = await createBoundSchema(t, { source: { name: "restaurantLocations" } });

    const entryId: Id<"entries"> = await t.mutation(api.lib.createEntry, {
      boundWrite: "sync",
      data: { label: "A" },
      geometry: POINT,
      schemaId,
    });
    await t.mutation(api.lib.updateEntry, {
      boundWrite: "sync",
      data: { label: "B" },
      entryId,
    });
    await t.mutation(api.lib.deleteEntry, { boundWrite: "sync", entryId });
    await t.mutation(api.lib.deleteEntriesBySchema, { boundWrite: "sync", schemaId });
  });

  it("rejects schema deletion and the import/simplify/conversion workflows on bound datasets", async () => {
    const t = initConvexTest();
    const schemaId = await createBoundSchema(t, { source: { name: "restaurantLocations" } });

    await expect(t.mutation(api.lib.deleteSchema, { schemaId })).rejects.toThrow(
      "read-only projection",
    );
    await expect(
      t.mutation(api.lib.startImport, { schemaId, storageIds: [], total: 0 }),
    ).rejects.toThrow("read-only projection");
    await expect(t.mutation(api.lib.startSimplification, { schemaId, total: 0 })).rejects.toThrow(
      "read-only projection",
    );
    await expect(
      t.mutation(api.lib.startGeospatialConversion, {
        latField: "lat",
        lonField: "lng",
        schemaId,
        total: 0,
      }),
    ).rejects.toThrow("read-only projection");

    // The same calls succeed once the host flow attests them — the
    // retirement/delete path the version-retirement flow relies on.
    await t.mutation(api.lib.deleteSchema, { boundWrite: "retire", schemaId });
  });

  it("enforces the same gate on a frozen version dataset (lineage marker)", async () => {
    const t = initConvexTest();
    const liveId = await createBoundSchema(t, { source: { name: "restaurantLocations" } });
    const versionId = await createBoundSchema(t, {
      lineage: { frozenAt: Date.now(), sourceSchemaId: liveId, versionLabel: "v1" },
    });

    await expect(
      t.mutation(api.lib.createEntry, { data: { label: "A" }, schemaId: versionId }),
    ).rejects.toThrow("read-only projection");
    await expect(t.mutation(api.lib.deleteSchema, { schemaId: versionId })).rejects.toThrow(
      "read-only projection",
    );
    await t.mutation(api.lib.deleteSchema, { boundWrite: "retire", schemaId: versionId });
  });

  it("leaves ordinary datasets fully writable", async () => {
    const t = initConvexTest();
    const schemaId = await t.mutation(api.lib.createSchema, {
      geometryType: "Point",
      kind: "geospatial",
      schema: RESTAURANT_SCHEMA,
    });

    const entryId: Id<"entries"> = await t.mutation(api.lib.createEntry, {
      data: { label: "A" },
      geometry: POINT,
      schemaId,
    });
    await t.mutation(api.lib.updateEntry, { data: { label: "B" }, entryId });
    await t.mutation(api.lib.deleteEntry, { entryId });
  });

  it("keeps metadata edits allowed on bound datasets", async () => {
    const t = initConvexTest();
    const schemaId = await createBoundSchema(t, { source: { name: "restaurantLocations" } });

    await t.mutation(api.lib.updateSchema, { schemaId, title: "Renamed" });
    const doc = await t.query(api.lib.getSchema, { schemaId });
    expect(doc?.title).toBe("Renamed");
  });
});
