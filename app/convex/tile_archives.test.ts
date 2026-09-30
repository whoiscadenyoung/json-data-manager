// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The tile-archive install surface (tile_archives.ts) — behavioral coverage
 * beyond the sign-in gate (issue #138). The module is a thin wrapper around
 * the component's `setMapTileArchive` / `getMapTileArchiveMeta`; the
 * correctness mechanism under test is the `expectedVersion` guard: a
 * rebuild that raced geometry edits self-discards instead of shadowing a
 * newer dataset state. The wrapper's "installed vs discarded" answer is
 * computed by re-reading the meta pointer in the same transaction (the
 * component's discard is a silent no-op).
 *
 * Chunk blobs are planted in the component's storage with the component's
 * test action (the publish.test.ts helper) — the app wrapper passes
 * plain-string ids through, and the component re-validates them.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app. */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

const GATE = /signed out/i;

/** A geospatial dataset id (its tile version starts absent — the guard reads it as 0). */
async function geospatialDataset(t: ReturnType<typeof signedIn>): Promise<string> {
  return t.mutation(api.schemas.create, {
    geometryType: "Point",
    kind: "geospatial",
    schema: {
      properties: { label: { type: "string" } },
      title: "Tiles",
      type: "object",
    },
  });
}

/** A fake archive blob in the COMPONENT's storage (where the component's guard deletes/discards). */
async function archiveBlob(t: ReturnType<typeof signedIn>, payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  return t.action(components.jsonCms.host_support.storeTestBlob, { bytes: bytes.buffer });
}

/** The wrapper's install call shape. */
async function install(
  t: ReturnType<typeof signedIn>,
  args: {
    bytes: number;
    expectedVersion: number;
    maxZoom: number;
    schemaId: string;
    storageId: string;
  },
) {
  return t.mutation(api.tile_archives.install, args);
}

/** A metas slot narrows to the meta (null means no archive — the readers know one exists). */
function metaAt(
  metas: Array<{
    storageId: string;
    bytes?: number;
    maxZoom?: number;
    url: string;
    version: number;
  } | null>,
  index: number,
): { storageId: string; bytes?: number; maxZoom?: number; url: string; version: number } {
  const meta = metas[index];
  if (meta === null || meta === undefined) {
    throw new Error(`test fixture: no archive meta at index ${index}`);
  }
  return meta;
}

describe("install", () => {
  it("installs against the current version and reports the meta through `metas`", async () => {
    const t = signedIn();
    const schemaId = await geospatialDataset(t);
    const storageId = await archiveBlob(t, "pmtiles-bytes-v0");
    expect(
      await install(t, {
        bytes: 16,
        expectedVersion: 0,
        maxZoom: 10,
        schemaId,
        storageId,
      }),
    ).toBe("installed");

    const metas = await t.query(api.tile_archives.metas, { schemaIds: [schemaId] });
    const meta = metaAt(metas, 0);
    expect(meta.storageId).toBe(storageId);
    expect(meta.bytes).toBe(16);
    expect(meta.maxZoom).toBe(10);
    // `version` is the BUILT version — the snapshot the archive was
    // generated from, not the live counter.
    expect(meta.version).toBe(0);
    expect(meta.url).toContain("https://");
  });

  it("self-discards a rebuild raced by an edit: the incoming blob is dropped and the incumbent stays", async () => {
    const t = signedIn();
    const schemaId = await geospatialDataset(t);
    const firstBlob = await archiveBlob(t, "pmtiles-bytes-v0");
    expect(
      await install(t, {
        bytes: 16,
        expectedVersion: 0,
        maxZoom: 10,
        schemaId,
        storageId: firstBlob,
      }),
    ).toBe("installed");

    // A geometry edit lands while the next rebuild is "generating" — the
    // cache version moves on.
    await t.mutation(api.entries.create, {
      data: { label: "A" },
      geometry: JSON.stringify({ coordinates: [1, 2], type: "Point" }),
      schemaId,
    });
    const racedBlob = await archiveBlob(t, "pmtiles-bytes-raced");
    expect(
      await install(t, {
        bytes: 20,
        expectedVersion: 0,
        maxZoom: 10,
        schemaId,
        storageId: racedBlob,
      }),
    ).toBe("discarded");

    // The incumbent archive is untouched — the raced pointer never landed.
    const metas = await t.query(api.tile_archives.metas, { schemaIds: [schemaId] });
    expect(metaAt(metas, 0).storageId).toBe(firstBlob);
    expect(metaAt(metas, 0).bytes).toBe(16);

    // The rebuild rerun against the CURRENT version installs cleanly.
    const freshBlob = await archiveBlob(t, "pmtiles-bytes-v1");
    expect(
      await install(t, {
        bytes: 21,
        expectedVersion: 1,
        maxZoom: 12,
        schemaId,
        storageId: freshBlob,
      }),
    ).toBe("installed");
    const after = await t.query(api.tile_archives.metas, { schemaIds: [schemaId] });
    const fresh = metaAt(after, 0);
    expect(fresh.storageId).toBe(freshBlob);
    expect(fresh.version).toBe(1);
    expect(fresh.maxZoom).toBe(12);
  });

  it("answers discarded for a dataset that no longer exists (the blob is unreferenced)", async () => {
    const t = signedIn();
    const schemaId = await geospatialDataset(t);
    await t.run(async (ctx) => {
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId,
      });
    });
    const storageId = await archiveBlob(t, "pmtiles-orphan");
    expect(
      await install(t, {
        bytes: 5,
        expectedVersion: 0,
        maxZoom: 10,
        schemaId,
        storageId,
      }),
    ).toBe("discarded");
  });

  it("rejects a signed-out caller like every exposeApi seam", async () => {
    const t = initTest();
    const signed = signedIn();
    const schemaId = await geospatialDataset(signed);
    await expect(
      t.mutation(api.tile_archives.install, {
        bytes: 1,
        expectedVersion: 0,
        maxZoom: 10,
        schemaId,
        storageId: "blob",
      }),
    ).rejects.toThrow(GATE);
  });
});

describe("metas", () => {
  it("answers null for a dataset with no installed archive", async () => {
    const t = signedIn();
    const schemaId = await geospatialDataset(t);
    expect(await t.query(api.tile_archives.metas, { schemaIds: [schemaId] })).toStrictEqual([null]);
  });

  it("aligns with the input order and repeats a duplicated id", async () => {
    const t = signedIn();
    const withArchive = await geospatialDataset(t);
    const bare = await geospatialDataset(t);
    const storageId = await archiveBlob(t, "pmtiles-bytes");
    await install(t, {
      bytes: 12,
      expectedVersion: 0,
      maxZoom: 9,
      schemaId: withArchive,
      storageId,
    });
    const metas = await t.query(api.tile_archives.metas, {
      schemaIds: [bare, withArchive, bare, withArchive],
    });
    expect(metas).toHaveLength(4);
    // Each slot answers by its input position: null where there is no
    // archive, the same meta object where the id repeats.
    expect(metas[0]).toBeNull();
    expect(metaAt(metas, 1).storageId).toBe(storageId);
    expect(metas[2]).toBeNull();
    expect(metaAt(metas, 3).storageId).toBe(storageId);
    expect(metaAt(metas, 1).maxZoom).toBe(9);
  });
});
