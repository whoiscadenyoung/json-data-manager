import { GeoParseError, GeometryError } from "../shared/geojson/error.js";
import { assertGeometry, computeBbox } from "../shared/geojson/geometry.js";
import type { BoundingBox } from "../shared/geojson/geometry.js";
import type { Geometry } from "../shared/geojson/types.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import type { Id } from "./_generated/dataModel.js";

/**
 * Shared logic for how a geometry's coordinate payload is represented once
 * it leaves the wire (a JSON string, see `lib.ts`'s `geometry` mutation
 * args) and needs to be persisted. Used by both `lib.ts` (plain mutations —
 * can only ever produce an inline `geometryJson`, since a `MutationCtx`
 * can't write to file storage) and `import_prep.ts` (the Node-runtime bulk
 * import action — can also produce a `geometryStorageId` for geometries too
 * large to fit inline).
 *
 * Why a JSON string at all, rather than the nested-array `Geometry` shape
 * directly: Convex caps any single array — including one nested inside a
 * document field or a function argument — at 8192 elements. Real-world GIS
 * boundary data routinely has a single ring/position-list well beyond that
 * (one measured case: 25,389 points in one ring). Serializing to text before
 * it ever crosses a Convex value boundary (an argument or a document write)
 * sidesteps that limit entirely; only the resulting *document*'s ~1 MiB size
 * cap remains, which is what forces sufficiently large geometries out to
 * file storage instead of an inline field.
 */

/**
 * A geometry's serialized JSON text is stored inline on its `geometries` row
 * when it fits under this many bytes — comfortably under Convex's ~1 MiB
 * per-document limit, leaving headroom for the row's other fields (ids,
 * bbox, type) and for Convex's own storage overhead. Anything larger must go
 * to file storage instead.
 */
export const INLINE_GEOMETRY_BYTE_LIMIT = 900_000;

const textEncoder = new TextEncoder();

/** UTF-8 byte length of `text` — what Convex's size limits actually measure, not JS string `.length` (which counts UTF-16 code units). */
export function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * Parses + structurally validates a geometry JSON string, translating a
 * JSON syntax error into the same `GeoParseError` class `assertGeometry`
 * itself throws for a structural problem — callers only need to catch one
 * pair of error types regardless of which stage failed.
 */
export function parseAndValidateGeometry(json: string): Geometry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GeoParseError("Geometry is not valid JSON.");
  }
  return assertGeometry(parsed);
}

/** The fields a `geometries` row needs, regardless of which storage form its payload took. */
export interface ResolvedGeometry {
  bbox: BoundingBox | undefined;
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  type: GeometryTypeArg;
}

/**
 * Resolves an already-validated geometry to its inline `geometryJson` field,
 * for callers that only ever have a `MutationCtx` (no file-storage write
 * access) — the single-entry `createEntry`/`updateEntry`/`createEntriesBulk`
 * mutations. Throws a `GeometryError` (never silently truncates or drops
 * data) when the geometry's JSON text is too large to fit inline; those
 * callers translate that into a `ConvexError` telling the caller to use the
 * bulk import flow instead, which resolves through `resolveGeometryStorage`
 * below and can fall back to file storage.
 */
export function inlineGeometryFieldsOrThrow(json: string, geometry: Geometry): ResolvedGeometry {
  const size = byteLength(json);
  if (size > INLINE_GEOMETRY_BYTE_LIMIT) {
    throw new GeometryError(
      `Geometry is too large to attach directly (${size} bytes, limit ${INLINE_GEOMETRY_BYTE_LIMIT}). Use the bulk import flow for large geometries instead.`,
    );
  }
  return { bbox: computeBbox(geometry), geometryJson: json, type: geometry.type };
}

/** Minimal shape of an action's `ctx.storage` this module needs — avoids importing a concrete `ActionCtx` type into a module shared with `lib.ts`. */
export interface GeometryStorageWriter {
  store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">>;
}

/**
 * Resolves an already-validated geometry to either an inline `geometryJson`
 * (the common case) or a `geometryStorageId` pointing at a new file-storage
 * blob holding the same JSON text (for a geometry too large to fit inline —
 * measured up to ~4 MB in real datasets). Only usable from a context with
 * file-storage write access (an action), which is why this is the path the
 * bulk-import prep step uses instead of `inlineGeometryFieldsOrThrow`.
 */
export async function resolveGeometryStorage(
  ctx: { storage: GeometryStorageWriter },
  geometry: Geometry,
  json: string,
): Promise<ResolvedGeometry> {
  const bbox = computeBbox(geometry),
    type = geometry.type;
  if (byteLength(json) <= INLINE_GEOMETRY_BYTE_LIMIT) {
    return { bbox, geometryJson: json, type };
  }
  const geometryStorageId = await ctx.storage.store(new Blob([json], { type: "application/json" }));
  return { bbox, geometryStorageId, type };
}
