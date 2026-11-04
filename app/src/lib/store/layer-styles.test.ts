import type { SupabaseClient } from "@supabase/supabase-js";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  listForMap,
  listForMapQueryOptions,
  listIcons,
  listIconsQueryOptions,
  MARKER_SPRITES_BUCKET,
  removeIcon,
  resetStyle,
  setStyle,
  uploadedIconName,
  uploadIcon,
} from "./layer-styles";
import {
  allArgs,
  firstArg,
  methodList,
  postgrestError,
  queryAt,
  stubSupabase,
  type QueryResponder,
  type StubSupabase,
} from "./test-support";

const UID = "22222222-2222-2222-2222-222222222222";

/** A storage object delete recorded by the styled stub. */
interface RecordedRemoval {
  bucket: string;
  paths: string[];
}

/**
 * The shared stub (which already records `createSignedUploadUrl` — the §6
 * upload's first step) plus `storage.remove`, icon deletion's best-effort
 * half, which the geometry/entries tests never touch.
 */
function styledStub(initial?: QueryResponder): StubSupabase & {
  removals: RecordedRemoval[];
} {
  const stub = stubSupabase(initial);
  const removals: RecordedRemoval[] = [];
  const bare = stub.client as unknown as {
    storage: { from: (bucket: string) => Record<string, unknown> };
  };
  const originalFrom = bare.storage.from.bind(bare.storage);
  bare.storage = {
    from: (bucket: string) => {
      const base = originalFrom(bucket);
      return {
        ...base,
        remove: async (paths: string[]) => {
          removals.push({ bucket, paths });
          return { data: paths.map((path) => ({ path })), error: null };
        },
      };
    },
  };
  return {
    ...stub,
    client: bare as unknown as SupabaseClient,
    removals,
  };
}

/** Pre-aliased style fixture (see maps.test.ts — the stub skips select aliases). */
function styleRow(renderId: string, overrides: Record<string, unknown> = {}) {
  return {
    mapId: "m1",
    renderId,
    style: { layers: [], version: 1 },
    updatedBy: UID,
    updatedAt: "2026-11-03T00:00:00Z",
    ...overrides,
  };
}

/** Pre-aliased marker-sprite fixture. */
function spriteRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    height: 48,
    id,
    label: `Icon ${id}`,
    pixel_ratio: 2,
    sdf: true,
    storagePath: `${UID}/${id}.png`,
    uploadedBy: UID,
    width: 48,
    ...overrides,
  };
}

describe("layerStyles.listForMap — the map's saved styles", () => {
  it("selects the map's style rows and keeps the style document verbatim", async () => {
    const { client, queries } = stubSupabase(() => ({
      data: [styleRow("d1"), styleRow("d2", { style: { layers: [{ type: "fill" }] } })],
      error: null,
    }));
    const rows = await listForMap({ mapId: "m1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("layer_styles");
    expect(firstArg(query, "eq")).toBe("map_id");
    expect(rows.map((row) => row.renderId)).toStrictEqual(["d1", "d2"]);
    expect(rows[1].style).toStrictEqual({ layers: [{ type: "fill" }] });
  });

  it("throws the PostgREST error shape on failure", async () => {
    const { client } = stubSupabase(() => ({ data: null, error: postgrestError() }));
    await expect(listForMap({ mapId: "m1" }, { supabase: client })).rejects.toThrow(
      "permission denied (42501)",
    );
  });

  it("queryOptions carry the args in the key", () => {
    const { client } = stubSupabase();
    const args = { mapId: "m1" };
    expect(listForMapQueryOptions(args, { supabase: client }).queryKey).toStrictEqual([
      "pg:layer-styles",
      "listForMap",
      args,
    ]);
    expect(listIconsQueryOptions({ supabase: client }).queryKey).toStrictEqual([
      "pg:layer-styles",
      "listIcons",
    ]);
  });
});

describe("layerStyles.setStyle — the debounced save", () => {
  it("upserts on the unique (map_id, render_id); attribution is the trigger's job", async () => {
    const stub = styledStub(() => ({ data: [{ id: "s1" }], error: null }));
    const style = { layers: [{ type: "circle" }], version: 1 };
    await setStyle({ mapId: "m1", renderId: "d1", style }, { supabase: stub.client });
    const query = queryAt(stub.queries, 0);
    expect(query.table).toBe("layer_styles");
    expect(firstArg(query, "upsert")).toStrictEqual({
      map_id: "m1",
      render_id: "d1",
      style,
    });
    expect(allArgs(query, "upsert")[0][1]).toStrictEqual({ onConflict: "map_id,render_id" });
  });
});

describe("layerStyles.resetStyle — back to the assigned color", () => {
  it("deletes the (map_id, render_id) row; absent rows delete nothing", async () => {
    const { client, queries } = stubSupabase(() => ({ data: [], error: null }));
    await resetStyle({ mapId: "m1", renderId: "d1" }, { supabase: client });
    const query = queryAt(queries, 0);
    expect(methodList(query)).toStrictEqual(["delete", "eq", "eq", "select"]);
    expect(firstArg(query, "eq")).toBe("map_id");
    expect(allArgs(query, "eq")[1]).toStrictEqual(["render_id", "d1"]);
  });
});

describe("layerStyles.listIcons — the upload picker's feed", () => {
  it("lists sprites newest-first with signed read URLs and user-<id> names", async () => {
    const { client, queries, signedUrls } = stubSupabase(() => ({
      data: [spriteRow("s2"), spriteRow("s1", { uploadedBy: "other" })],
      error: null,
    }));
    const rows = await listIcons({ supabase: client });
    const query = queryAt(queries, 0);
    expect(query.table).toBe("marker_sprites");
    expect(firstArg(query, "order")).toBe("uploaded_at");
    expect(signedUrls).toStrictEqual([
      { bucket: MARKER_SPRITES_BUCKET, path: `${UID}/s2.png`, ttlSeconds: 3600 },
      { bucket: MARKER_SPRITES_BUCKET, path: `${UID}/s1.png`, ttlSeconds: 3600 },
    ]);
    expect(rows[0]).toStrictEqual({
      height: 48,
      iconId: "s2",
      label: "Icon s2",
      name: uploadedIconName("s2"),
      pixelRatio: 2,
      sdf: true,
      uploadedBy: UID,
      url: `https://signed.test/${MARKER_SPRITES_BUCKET}/${UID}/s2.png`,
      width: 48,
    });
    expect(rows[1].uploadedBy).toBe("other");
  });

  it("a failed signature reads as a null URL, never a thrown list", async () => {
    const stub = styledStub(() => ({ data: [spriteRow("s1")], error: null }));
    const bare = stub.client as unknown as {
      storage: { from: (bucket: string) => Record<string, unknown> };
    };
    bare.storage = {
      from: () => ({
        createSignedUrl: async () => ({ data: null, error: { message: "signing failed" } }),
      }),
    };
    const rows = await listIcons({ supabase: stub.client });
    expect(rows.length).toBe(1);
    expect(rows[0]).toStrictEqual({
      height: 48,
      iconId: "s1",
      label: "Icon s1",
      name: uploadedIconName("s1"),
      pixelRatio: 2,
      sdf: true,
      uploadedBy: UID,
      url: null,
      width: 48,
    });
  });
});

describe("layerStyles.uploadIcon — signed URL PUT, then the row (§6)", () => {
  it("uploads the PNG to a signed URL and inserts the sprite row", async () => {
    const stub = styledStub(() => ({ data: [{ id: "s-new" }], error: null }));
    const putCalls: Array<{ body: unknown; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: { body?: unknown }) => {
        putCalls.push({ body: init === undefined ? undefined : init.body, url: String(url) });
        return { ok: true };
      }),
    );
    try {
      const result = await uploadIcon(
        {
          height: 48,
          label: "Landmark",
          png: new Blob(["png-bytes"], { type: "image/png" }),
          pixelRatio: 2,
          sdf: true,
          width: 48,
        },
        { supabase: stub.client },
      );
      expect(result).toStrictEqual({ name: uploadedIconName("s-new"), ok: true });
      const upload = stub.signedUploadUrls[0];
      expect(upload).toBeDefined();
      if (upload === undefined) {
        return;
      }
      expect(upload.bucket).toBe(MARKER_SPRITES_BUCKET);
      expect(upload.path.startsWith("icons/")).toBe(true);
      expect(upload.path.endsWith(".png")).toBe(true);
      expect(putCalls[0].url).toBe(`https://signed-upload.test/${upload.bucket}/${upload.path}`);
      const query = queryAt(stub.queries, 0);
      expect(query.table).toBe("marker_sprites");
      const payload = firstArg(query, "insert") as Record<string, unknown>;
      expect(payload["label"]).toBe("Landmark");
      expect(payload["sdf"]).toBe(true);
      expect(payload["storage_path"]).toBe(upload.path);
      // `uploaded_by` deliberately absent — the 0005 trigger stamps it.
      expect(Object.hasOwn(payload, "uploaded_by")).toBe(false);
      expect(payload["width"]).toBe(48);
      expect(payload["height"]).toBe(48);
      expect(payload["pixel_ratio"]).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a failed PUT answers {ok:false} before any row is written", async () => {
    const stub = styledStub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    try {
      const result = await uploadIcon(
        { height: 1, label: "x", png: new Blob(["p"]), pixelRatio: 1, sdf: false, width: 1 },
        { supabase: stub.client },
      );
      expect(result).toStrictEqual({ error: expect.stringContaining("503"), ok: false });
      expect(stub.queries.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refused row answers {ok:false} instead of throwing (the createIcon contract)", async () => {
    const stub = styledStub(() => ({ data: null, error: postgrestError("row refused", "42501") }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );
    try {
      const result = await uploadIcon(
        { height: 1, label: "x", png: new Blob(["p"]), pixelRatio: 1, sdf: false, width: 1 },
        { supabase: stub.client },
      );
      expect(result).toStrictEqual({ error: expect.stringContaining("row refused"), ok: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an unsigned upload URL answers {ok:false} before any row is written", async () => {
    const stub = styledStub();
    const bare = stub.client as unknown as {
      storage: { from: (bucket: string) => Record<string, unknown> };
    };
    bare.storage = {
      from: () => ({
        createSignedUploadUrl: async () => ({ data: null, error: { message: "bucket down" } }),
      }),
    };
    const result = await uploadIcon(
      { height: 1, label: "x", png: new Blob(["p"]), pixelRatio: 1, sdf: false, width: 1 },
      { supabase: stub.client },
    );
    expect(result).toStrictEqual({ error: "bucket down", ok: false });
    expect(stub.queries.length).toBe(0);
  });
});

describe("layerStyles.removeIcon — row first, object best-effort", () => {
  it("deletes the row and removes the object by its storage path", async () => {
    const stub = styledStub(() => ({
      data: [{ storagePath: `${UID}/s1.png` }],
      error: null,
    }));
    await removeIcon({ iconId: "s1" }, { supabase: stub.client });
    const query = queryAt(stub.queries, 0);
    expect(methodList(query)).toStrictEqual(["delete", "eq", "select"]);
    expect(firstArg(query, "eq")).toBe("id");
    expect(stub.removals).toStrictEqual([
      { bucket: MARKER_SPRITES_BUCKET, paths: [`${UID}/s1.png`] },
    ]);
  });

  it("an unknown icon is a clean no-op (no object delete either)", async () => {
    const stub = styledStub(() => ({ data: [], error: null }));
    await removeIcon({ iconId: "gone" }, { supabase: stub.client });
    expect(stub.removals).toStrictEqual([]);
  });

  it("a failed object delete still resolves (the row is gone; the orphan is inert)", async () => {
    const stub = styledStub(() => ({
      data: [{ storagePath: `${UID}/s1.png` }],
      error: null,
    }));
    const bare = stub.client as unknown as {
      storage: { from: (bucket: string) => Record<string, unknown> };
    };
    bare.storage = {
      from: () => ({
        remove: async () => {
          throw new Error("storage down");
        },
      }),
    };
    await expect(removeIcon({ iconId: "s1" }, { supabase: stub.client })).resolves.toBeUndefined();
  });
});
