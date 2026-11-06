import { queryOptions } from "@tanstack/react-query";

import {
  clientOf,
  queryRow,
  queryRows,
  STORAGE_SIGNED_URL_TTL_SECONDS,
  type StoreOptions,
} from "./client";

/**
 * The layer-styles store's ICON half (issue #257 / ADR 0019) — uploaded
 * point-marker icons (`icons.list` / `icons.upload` / `icons.remove`) over
 * `public.marker_sprites` + the `marker-sprites` bucket (0005 §3.4/§6).
 *
 * The STYLE half retired with `layer_styles` itself: style documents live
 * ON the layer rows now (`layers.style` — the layers store's update), the
 * per-`(mapId, renderId)` fragments having been the pre-layers
 * approximation. The `@caden/layer-styles` validators/engine are untouched
 * — they compile and validate the fragments wherever they are stored.
 *
 * Marker uploads keep the ADR 0013 contract: PNG only, rasterized in the
 * uploader's browser, never an SVG. The §6 upload shape is: the browser
 * asks for a signed upload URL, PUTs the bytes, then writes the row —
 * server-issued, single-purpose URLs, so there is no pending-upload
 * provenance problem to manage.
 *
 * Attribution is NOT sent: migration 0005 stamps `uploaded_by` (insert)
 * from `auth.uid()` with a BEFORE trigger — the 0003 rule that "identity
 * is stamped from the request, never claimed from a client payload".
 * Convex parity: uploads are shared with every signed-in user (ADR 0009) —
 * RLS, not this module, draws the visibility line.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL (§3.4/§6),
 * not the generated `database.types.ts` (see `./client`).
 */

// ---------------------------------------------------------------------------
// Uploaded marker icons (ADR 0013; bucket §6)
// ---------------------------------------------------------------------------

/** The `marker-sprites` bucket holding uploaded icons (design §6). */
export const MARKER_SPRITES_BUCKET = "marker-sprites";

/**
 * One uploaded icon as the layer-styles UI reads it. `name` is the
 * `user-<id>` sprite name styles reference (docs/layer-styles.md);
 * `url` is a short-lived signed read URL (null when signing failed — the
 * icon renders as circles until the next list refresh, the same shape the
 * Convex read handed back).
 */
export interface UploadedIconRow {
  iconId: string;
  name: string;
  label: string;
  url: string | null;
  sdf: boolean;
  width: number;
  height: number;
  pixelRatio: number;
  uploadedBy: string;
}

interface MarkerSpriteRpcRow {
  height: number;
  id: string;
  label: string;
  pixel_ratio: number;
  sdf: boolean;
  /** Aliased in the select (`storagePath:storage_path`). */
  storagePath: string;
  /** Aliased in the select (`uploadedBy:uploaded_by`). */
  uploadedBy: string;
  width: number;
}

/** The uploads list width (the Convex picker listed up to 500). */
export const DEFAULT_ICONS_LIMIT = 500;

/** Lists every uploaded icon with a fresh signed read URL per row (§6: private bucket, signed reads). */
export async function listIcons(options?: StoreOptions): Promise<UploadedIconRow[]> {
  const client = clientOf(options);
  const sprites = await queryRows<MarkerSpriteRpcRow>(
    client
      .from("marker_sprites")
      .select(
        "height,id,label,pixel_ratio,sdf,storagePath:storage_path,uploadedBy:uploaded_by,width",
      )
      .order("uploaded_at", { ascending: false })
      .limit(DEFAULT_ICONS_LIMIT),
  );
  // Signed in parallel — one round trip per sprite, not per row.
  return await Promise.all(sprites.map(async (sprite) => await iconRowOf(client, sprite)));
}

/** One sprite row as the picker reads it: metadata plus its signed read URL. */
async function iconRowOf(
  client: ReturnType<typeof clientOf>,
  sprite: MarkerSpriteRpcRow,
): Promise<UploadedIconRow> {
  return {
    height: sprite.height,
    iconId: sprite.id,
    label: sprite.label,
    name: uploadedIconName(sprite.id),
    pixelRatio: sprite.pixel_ratio,
    sdf: sprite.sdf,
    uploadedBy: sprite.uploadedBy,
    url: await signedIconUrl(client, sprite.storagePath),
    width: sprite.width,
  };
}

/** The `user-<id>` icon name a style references (docs/layer-styles.md "Point markers"). */
export function uploadedIconName(iconId: string): string {
  return `user-${iconId}`;
}

/** One signed read URL for an icon, or null (a failed signature reads as a missing file, never a thrown list). */
async function signedIconUrl(
  client: ReturnType<typeof clientOf>,
  storagePath: string,
): Promise<string | null> {
  try {
    const { data, error } = await client.storage
      .from(MARKER_SPRITES_BUCKET)
      .createSignedUrl(storagePath, STORAGE_SIGNED_URL_TTL_SECONDS);
    if (error !== null || data === null) {
      return null;
    }
    return data.signedUrl;
  } catch {
    return null;
  }
}

/** The upload payload after the browser rasterized the file (ADR 0013: PNG only, 24 px glyph box at 2x). */
export interface UploadIconArgs {
  /** The rasterized PNG bytes. */
  png: Blob;
  /** Human label from the file name (the picker's search text). */
  label: string;
  /** Stored as an SDF when tintable, so the style's colors apply. */
  sdf: boolean;
  width: number;
  height: number;
  pixelRatio: number;
}

/** The createIcon result contract the upload form renders (`icons.create` parity). */
export type UploadIconResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Uploads one icon: signed upload URL → PUT the PNG → insert the
 * `marker_sprites` row (§6's order — the URL is server-issued and
 * single-purpose, so a refused row can leave an orphan object, which is
 * inert: nothing references it). Returns `{ok: false}` instead of throwing,
 * matching the Convex `icons.create` contract the upload form renders.
 */
export async function uploadIcon(
  args: UploadIconArgs,
  options?: StoreOptions,
): Promise<UploadIconResult> {
  const client = clientOf(options);
  // The path prefix doesn't need the uid to be readable — any caller-owned
  // unique prefix works; the row's `uploaded_by` trigger stamps identity.
  const path = `icons/${crypto.randomUUID()}.png`;
  const signed = await client.storage.from(MARKER_SPRITES_BUCKET).createSignedUploadUrl(path);
  if (signed.error !== null || signed.data === null) {
    return {
      error: signed.error === null ? "Couldn't start the upload." : signed.error.message,
      ok: false,
    };
  }
  const response = await fetch(signed.data.signedUrl, {
    body: args.png,
    headers: { "Content-Type": "image/png" },
    method: "PUT",
  });
  if (!response.ok) {
    return { error: `The upload failed (HTTP ${response.status}). Try again.`, ok: false };
  }
  try {
    const row = await queryRow<{ id: string }>(
      client
        .from("marker_sprites")
        // `uploaded_by` deliberately omitted — the 0005 trigger stamps it.
        .insert({
          height: args.height,
          label: args.label,
          pixel_ratio: args.pixelRatio,
          sdf: args.sdf,
          storage_path: path,
          width: args.width,
        })
        .select("id")
        .single(),
    );
    if (row === null) {
      return { error: "The icon row didn't come back.", ok: false };
    }
    return { name: uploadedIconName(row.id), ok: true };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message !== ""
          ? error.message
          : "Couldn't record the icon.",
      ok: false,
    };
  }
}

/**
 * Deletes an uploaded icon: the row first (styles referencing the name fall
 * back to circles immediately), then the object (best-effort — a failed
 * object delete leaves an unreachable orphan, never a broken picker).
 */
export async function removeIcon(args: { iconId: string }, options?: StoreOptions): Promise<void> {
  const client = clientOf(options);
  const deleted = await queryRows<{ storagePath: string }>(
    client.from("marker_sprites").delete().eq("id", args.iconId).select("storagePath:storage_path"),
  );
  const first = deleted[0];
  if (first === undefined) {
    return;
  }
  try {
    await client.storage.from(MARKER_SPRITES_BUCKET).remove([first.storagePath]);
  } catch {
    // Orphan object; inert. (The Convex-era storage.delete rolled back with
    // the row via the transaction — PostgREST is single-statement.)
  }
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1)
// ---------------------------------------------------------------------------

export function listIconsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:layer-styles", "listIcons"],
    queryFn: async () => await listIcons(options),
  });
}
