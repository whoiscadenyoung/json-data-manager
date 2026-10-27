// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Uploaded marker icons (docs/layer-styles.md "Uploaded icons"): auth, the
 * stored-file checks and limits, refusals that leave no file behind, and
 * deletion — plus the style-side marker validation in `styles.set`.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { compileStyle, defaultEditor } from "../../src/features/layer-styles/lib/compile";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { ICON_LIMITS, type Marker } from "./validators";

const modules = import.meta.glob("/convex/**/*.ts");

function initTest() {
  const t = convexTest(schema, modules);
  registerJsonCms(t);
  return t;
}

type Backend = ReturnType<typeof initTest>;

/**
 * A stored file of `bytes` bytes and the given content type. convex-test's
 * `storage.store` records no content type (a real upload takes it from the
 * POST's Content-Type header), so the test sets it on the `_storage` row.
 */
async function storeFile(t: Backend, bytes: number, type = "image/png"): Promise<Id<"_storage">> {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only write to the system table convex-test leaves without a content type.
    await (ctx.db as unknown as { patch: (id: string, value: object) => Promise<void> }).patch(
      storageId,
      { contentType: type },
    );
    return storageId;
  });
}

async function fileExists(t: Backend, storageId: Id<"_storage">) {
  return t.run(async (ctx) => (await ctx.db.system.get("_storage", storageId)) !== null);
}

const ICON_ARGS = { height: 60, label: "Hydrant", pixelRatio: 2, sdf: true, width: 60 };

describe("uploaded icons", () => {
  it("rejects signed-out callers", async () => {
    const t = initTest(),
      storageId = await storeFile(t, 100);
    await expect(t.mutation(api.layerStyles.icons.generateUploadUrl, {})).rejects.toThrow(
      /signed out/i,
    );
    await expect(t.query(api.layerStyles.icons.list, {})).rejects.toThrow(/signed out/i);
    await expect(
      t.mutation(api.layerStyles.icons.create, { ...ICON_ARGS, storageId }),
    ).rejects.toThrow(/signed out/i);
  });

  it("registers an uploaded PNG and lists it for every collaborator", async () => {
    const t = initTest(),
      uploader = t.withIdentity({ subject: "uploader" }),
      storageId = await storeFile(t, 2048);
    expect(typeof (await uploader.mutation(api.layerStyles.icons.generateUploadUrl, {}))).toBe(
      "string",
    );
    const created = await uploader.mutation(api.layerStyles.icons.create, {
      ...ICON_ARGS,
      label: "  Hydrant  ",
      storageId,
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.name).toBe(`user-${created.iconId}`);
    const listed = await t
      .withIdentity({ subject: "collaborator" })
      .query(api.layerStyles.icons.list, {});
    expect(listed).toEqual([
      expect.objectContaining({
        iconId: created.iconId,
        label: "Hydrant",
        name: created.name,
        sdf: true,
        uploadedBy: "uploader",
        width: 60,
      }),
    ]);
    expect(listed[0].url).toEqual(expect.any(String));
    await expect(
      uploader.mutation(api.layerStyles.icons.create, { ...ICON_ARGS, storageId }),
    ).rejects.toThrow(/already an icon/i);
  });

  it("refuses files that break the limits and deletes them", async () => {
    const t = initTest(),
      user = t.withIdentity({ subject: "user" }),
      cases: Array<[Id<"_storage">, Partial<typeof ICON_ARGS>, RegExp]> = [
        [await storeFile(t, 100, "image/svg+xml"), {}, /PNG/],
        [await storeFile(t, ICON_LIMITS.fileBytes + 1), {}, /too large/],
        [await storeFile(t, 100), { width: ICON_LIMITS.maxPx + 1 }, /width/],
        [await storeFile(t, 100), { height: 0 }, /height/],
        [await storeFile(t, 100), { pixelRatio: 3 }, /pixel ratio/],
        [await storeFile(t, 100), { label: "   " }, /Name the icon/],
      ];
    for (const [storageId, patch, message] of cases) {
      const result = await user.mutation(api.layerStyles.icons.create, {
        ...ICON_ARGS,
        ...patch,
        storageId,
      });
      expect(result).toEqual({ error: expect.stringMatching(message), ok: false });
      expect(await fileExists(t, storageId)).toBe(false);
    }
    expect(await user.query(api.layerStyles.icons.list, {})).toEqual([]);
  });

  it("deletes an icon and its file", async () => {
    const t = initTest(),
      user = t.withIdentity({ subject: "user" }),
      storageId = await storeFile(t, 100),
      created = await user.mutation(api.layerStyles.icons.create, { ...ICON_ARGS, storageId });
    if (!created.ok) {
      throw new Error(created.error);
    }
    await t
      .withIdentity({ subject: "someone-else" })
      .mutation(api.layerStyles.icons.remove, { iconId: created.iconId });
    expect(await user.query(api.layerStyles.icons.list, {})).toEqual([]);
    expect(await fileExists(t, storageId)).toBe(false);
    // Deleting twice is a no-op.
    await user.mutation(api.layerStyles.icons.remove, { iconId: created.iconId });
  });
});

describe("marker styles", () => {
  const MARKER: Marker = {
    allowOverlap: true,
    icon: "maki-hospital",
    kind: "icon",
    rotation: 0,
    size: 20,
  };

  async function setup() {
    const t = initTest(),
      owner = t.withIdentity({ subject: "owner" }),
      datasetId = await owner.mutation(api.schemas.create, {
        schema: { properties: { kind: { type: "string" } }, title: "Clinics", type: "object" },
      }),
      mapId = await owner.mutation(api.maps.create, { name: "Clinics map" });
    return { datasetId, mapId, owner };
  }

  it("saves icon markers", async () => {
    const { datasetId, mapId, owner } = await setup(),
      style = compileStyle({ ...defaultEditor("#ef4444"), marker: MARKER });
    await owner.mutation(api.layerStyles.styles.set, { mapId, renderId: datasetId, style });
    const [saved] = await owner.query(api.layerStyles.styles.listForMap, { mapId });
    expect(saved.style.layers[3]).toMatchObject({ type: "symbol" });
  });

  it("refuses unknown icon names and out-of-range markers", async () => {
    const { datasetId, mapId, owner } = await setup(),
      save = async (marker: Marker, categoryIcon?: string) =>
        owner.mutation(api.layerStyles.styles.set, {
          mapId,
          renderId: datasetId,
          style: compileStyle({
            ...defaultEditor("#ef4444"),
            marker,
            ...(categoryIcon === undefined
              ? {}
              : {
                  renderer: {
                    categories: [{ color: "#111111", icon: categoryIcon, value: "a" }],
                    field: "kind",
                    kind: "categorical",
                    otherColor: "#999999",
                  },
                }),
          }),
        });
    await expect(save({ ...MARKER, icon: "<script>" })).rejects.toThrow(/icon name/i);
    await expect(save(MARKER, "airport-15")).rejects.toThrow(/icon name/i);
    await expect(save({ ...MARKER, size: 500 })).rejects.toThrow(/marker size/i);
    await expect(save({ ...MARKER, sizeScale: 10 })).rejects.toThrow(/largest class/i);
  });
});
