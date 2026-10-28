import { isGeometryCompatibleWithDatasetType } from "@caden/data-core/geojson";
import { GeoParseError, GeometryError } from "@caden/data-core/geojson";
import {
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  roundGeometryCoordinates,
  unionBbox,
} from "@caden/data-core/geojson";
import type { BoundingBox } from "@caden/data-core/geojson";
import type { Geometry } from "@caden/data-core/geojson";
import type { GeometryTypeArg } from "@caden/data-core/geojson";
import { extractReferences } from "@caden/data-core/reference";
import { ConvexError } from "convex/values";

import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import {
  byteLength,
  inlineGeometryFieldsOrThrow,
  parseAndValidateGeometry,
} from "../geometry_storage.js";
import type { ResolvedGeometry } from "../geometry_storage.js";

// Entry mutation helpers
//
// Geometry is never stored inline on `entries` — only a pointer
// (`geometryId`) plus a denormalized `geometryType` string live there. The
// heavy coordinate payload lives in the `geometries` table (see schema.ts),
// so reading a page of entries (the properties table) never pulls full
// geometries along for the ride. Every mutation below that adds/replaces/
// removes a geometry also keeps the owning schema's denormalized
// `featureCount`/`boundingBox` summary up to date (see schema.ts for the
// exact contract on each field).
//
// A geometry argument is always a JSON *string* here, never the nested-array
// `Geometry` shape directly — see geometry_storage.ts's doc comment for why
// (Convex's 8192-elements-per-array limit, which real-world GIS rings
// routinely exceed).

/** Deletes a geometry row's external storage blob, if it has one. No-ops otherwise — safe to call on a row about to be deleted or replaced. */
export async function deleteGeometryStorageIfAny(
  ctx: MutationCtx,
  geometryDoc: { geometryStorageId?: Id<"_storage"> } | null,
): Promise<void> {
  if (geometryDoc && geometryDoc.geometryStorageId !== undefined) {
    await ctx.storage.delete(geometryDoc.geometryStorageId);
  }
}

/**
 * Normalizes a validated geometry to the dataset's simplified precision when
 * its schema doc opts in (`simplifyGeometry`): rounds every coordinate to
 * `GEOMETRY_SIMPLIFY_DECIMAL_PLACES` and re-serializes, so the stored payload
 * is the rounded text. Returns the original geometry/json pair unchanged
 * otherwise.
 */
export function simplifyGeometryPayload(
  geometry: Geometry,
  geometryJson: string,
  schemaDoc: { simplifyGeometry?: boolean },
): { geometry: Geometry; geometryJson: string } {
  if (schemaDoc.simplifyGeometry !== true) {
    return { geometry, geometryJson };
  }
  const rounded = roundGeometryCoordinates(geometry, GEOMETRY_SIMPLIFY_DECIMAL_PLACES);
  return { geometry: rounded, geometryJson: JSON.stringify(rounded) };
}

/** Runs `fn`, rethrowing geometry parse/validate failures as client-facing ConvexErrors. */
function asConvexError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GeometryError || err instanceof GeoParseError) {
      throw new ConvexError(err.message);
    }
    throw err;
  }
}

/**
 * Validates a JSON-string geometry argument against the schema doc's
 * `kind`/`geometryType`, and resolves it to the fields a `geometries` row
 * needs. Returns `undefined` when no geometry was provided.
 *
 * Only called from plain mutations, which can't write to file storage — a
 * geometry whose JSON text is too large to store inline is rejected with a
 * clear error rather than silently dropped or truncated; the caller is
 * expected to use the bulk import flow instead (`startImport`), whose
 * action-backed prep step (`import_prep.ts`) can fall back to file storage.
 */
export function validateEntryGeometry(
  geometryJsonArg: string | undefined,
  schemaDoc: {
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
  },
): ResolvedGeometry | undefined {
  if (geometryJsonArg === undefined) {
    return undefined;
  }
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  const geometry = asConvexError(() => parseAndValidateGeometry(geometryJsonArg));
  if (!isGeometryCompatibleWithDatasetType(geometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${geometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  const resolved = simplifyGeometryPayload(geometry, geometryJsonArg, schemaDoc);
  return asConvexError(() => inlineGeometryFieldsOrThrow(resolved.geometryJson, resolved.geometry));
}

/**
 * `schemas.boundingBox` is a plain `v.array(v.number())` (Convex validators
 * can't express a fixed-length tuple), but every write to it always stores
 * exactly 4 numbers (see `applyGeometryStatsDelta`). This narrows the read
 * side back to the tuple shape `unionBbox` expects.
 */
function asBoundingBox(value: number[] | undefined): BoundingBox | undefined {
  if (value === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- always written as a 4-tuple by `applyGeometryStatsDelta`; the array validator can't express that statically.
  return value as BoundingBox;
}

/**
 * `resolvedGeometryValidator`'s `bbox` field is, like `schemas.boundingBox`
 * above, a plain `v.array(v.number())` (Convex validators can't express a
 * fixed-length tuple) — but it's always written as a 4-tuple by
 * `computeBbox`/`resolveGeometryStorage`. Narrows an already-resolved
 * geometry (as received from `insertEntriesChunkInternal`'s args) back to
 * the tuple-typed `ResolvedGeometry` shape the rest of this module uses.
 */
export function asResolvedGeometry(value: {
  bbox?: number[];
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  type: GeometryTypeArg;
}): ResolvedGeometry {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    bbox: value.bbox as BoundingBox | undefined,
    geometryJson: value.geometryJson,
    geometryStorageId: value.geometryStorageId,
    type: value.type,
  };
}

/**
 * Folds a geometry add/remove/replace into a schema doc's denormalized
 * `featureCount`/`boundingBox` summary — and bumps `mapTileCacheVersion` in
 * the same patch, so any geometry-affecting write invalidates the dataset's
 * tile archive in the same transaction (see `bumpMapTileCacheVersion`).
 * `featureCount` is kept exactly accurate (clamped at 0). `boundingBox` only
 * ever grows (via `unionBbox`) — see the field's doc comment in schema.ts
 * for why deletes don't shrink it back down.
 */
export async function applyGeometryStatsDelta(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { featureCount?: number; boundingBox?: number[]; mapTileCacheVersion?: number },
  countDelta: number,
  newBbox: BoundingBox | undefined,
): Promise<void> {
  const featureCount = Math.max(0, (schemaDoc.featureCount ?? 0) + countDelta),
    boundingBox = unionBbox(asBoundingBox(schemaDoc.boundingBox), newBbox);
  await ctx.db.patch(schemaId, {
    boundingBox,
    featureCount,
    mapTileCacheVersion: (schemaDoc.mapTileCacheVersion ?? 0) + 1,
  });
}

/**
 * Folds an entry add/remove into a schema doc's denormalized `entryCount`
 * (clamped at 0). The entry-side counterpart of `applyGeometryStatsDelta`:
 * deliberately separate, because a data-only write (rows with no geometry)
 * changes `entryCount` but must NOT bump `mapTileCacheVersion` — the tile
 * archive is a pure function of the geometries, and a spurious version bump
 * would schedule a pointless rebuild.
 */
export async function applyEntryCountDelta(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { entryCount?: number },
  delta: number,
): Promise<void> {
  if (delta === 0) {
    return;
  }
  await ctx.db.patch(schemaId, {
    entryCount: Math.max(0, (schemaDoc.entryCount ?? 0) + delta),
  });
}

/**
 * Monotonically bumps a schema's `mapTileCacheVersion` (`absent = 0`) — the
 * invalidation signal for the dataset's tile archive (issue #58): a rebuild
 * worker snapshots the version before generating, and `setMapTileArchive`
 * discards the result unless the version is still current. Patched into
 * every path that already maintains `featureCount`/`boundingBox`
 * (via `applyGeometryStatsDelta`) plus the two that patch the schema row
 * directly — simplify batches and `deleteEntriesBySchema`/`deleteSchema`.
 * Unconditional, including below-threshold datasets: the field costs one
 * number and keeps the invariant simple ("version changed ⇒ data changed").
 */
export async function bumpMapTileCacheVersion(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { mapTileCacheVersion?: number },
): Promise<void> {
  await ctx.db.patch(schemaId, {
    mapTileCacheVersion: (schemaDoc.mapTileCacheVersion ?? 0) + 1,
  });
}

/**
 * Inserts a `geometries` row for `entryId` and patches the entry's pointer
 * fields (`geometryId`/`geometryType`) to reference it. Returns the new
 * row's own bbox for the caller to fold into the schema's summary.
 */
async function attachGeometry(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  schemaId: Id<"schemas">,
  resolved: ResolvedGeometry,
): Promise<BoundingBox | undefined> {
  const geometryId = await ctx.db.insert("geometries", {
    bbox: resolved.bbox,
    entryId,
    geometryJson: resolved.geometryJson,
    geometryStorageId: resolved.geometryStorageId,
    schemaId,
    type: resolved.type,
  });
  await ctx.db.patch(entryId, { geometryId, geometryType: resolved.type });
  return resolved.bbox;
}

/**
 * Deletes every `references` row naming one entry, on either side of the
 * pointer: rows sourced from it, and rows targeting it from some other
 * dataset's entry (which would otherwise dangle, pointing at a deleted
 * entry). A row can appear in both queries for a self-referencing entry,
 * hence the de-dupe. Called per entry by the batched delete drain (issue
 * #128) — every reference row naming a deleted schema names one of its
 * entries, so per-entry cleanup covers both sides of the old schema-wide
 * pass.
 */
export async function deleteReferencesForEntry(
  ctx: MutationCtx,
  entryId: Id<"entries">,
): Promise<void> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query("references")
      .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
      .collect(),
    ctx.db
      .query("references")
      .withIndex("by_target_entry", (q) => q.eq("targetEntryId", entryId))
      .collect(),
  ]);
  const seen = new Set<Id<"references">>();
  await Promise.all(
    [...asSource, ...asTarget]
      .filter((row) => {
        if (seen.has(row._id)) {
          return false;
        }
        seen.add(row._id);
        return true;
      })
      .map(async (row) => ctx.db.delete(row._id)),
  );
}

/**
 * Re-derives an entry's outgoing `references` rows from its current `data`
 * against its schema's reference fields (see ../shared/reference.ts).
 * Simplest-correct approach: wipe this entry's existing rows and reinsert
 * from scratch, rather than diffing — a dataset entry only ever has a
 * handful of reference fields, so this is cheap and can't drift.
 *
 * A referenced id that doesn't normalize to a real `entries`/`schemas` id,
 * or whose target entry doesn't actually belong to the declared target
 * schema, is silently skipped — a stale/malformed reference in `data`
 * (e.g. the target entry was since deleted) shouldn't block saving the
 * source entry.
 */
export async function syncEntryReferences(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  sourceSchemaId: Id<"schemas">,
  schemaDoc: { schema: unknown },
  data: unknown,
): Promise<void> {
  const existing = await ctx.db
    .query("references")
    .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
    .collect();
  await Promise.all(existing.map(async (row) => ctx.db.delete(row._id)));

  await Promise.all(
    extractReferences(schemaDoc.schema, data).map(async (ref) => {
      const targetSchemaId = ctx.db.normalizeId("schemas", ref.targetSchemaId),
        targetEntryId = ctx.db.normalizeId("entries", ref.targetEntryId);
      if (!targetSchemaId || !targetEntryId) {
        return;
      }
      const targetEntry = await ctx.db.get(targetEntryId);
      if (!targetEntry || targetEntry.schemaId !== targetSchemaId) {
        return;
      }
      await ctx.db.insert("references", {
        fieldName: ref.fieldName,
        sourceEntryId: entryId,
        sourceSchemaId,
        targetEntryId,
        targetSchemaId,
      });
    }),
  );
}

/**
 * One row's geometry argument, as accepted by `insertEntryBatch`: either a
 * raw JSON string awaiting validation (the single-entry mutation paths —
 * `createEntry`/`updateEntry`/`createEntriesBulk`), or an already-resolved
 * `ResolvedGeometry` (the bulk-import path, whose `import_prep.ts` action
 * already validated + resolved it before this ever runs in a mutation).
 */
type PendingGeometry = string | ResolvedGeometry;

function isResolvedGeometry(value: PendingGeometry): value is ResolvedGeometry {
  return typeof value !== "string";
}

/** Re-validates just the cheap part (dataset-kind/geometry-type compatibility) for an already-resolved geometry. The expensive structural validation already happened in `import_prep.ts`. */
function checkResolvedGeometryCompatible(
  resolved: ResolvedGeometry,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): void {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  if (!isGeometryCompatibleWithDatasetType(resolved.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${resolved.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
}

/**
 * Server-side cap on one entry's serialized `data` payload (issue #129):
 * AJV row validation runs client-side only, so `v.any()` on `entries.data`
 * otherwise accepts anything a caller posts. Convex caps a document at
 * ~1 MiB total; this sits under that with headroom for the row's pointer
 * fields. Checked on every write path so the invariant holds regardless of
 * entry point.
 */
const ENTRY_DATA_MAX_BYTES = 1_000_000;

/** Throws unless `data` serializes under the entry payload cap. */
export function assertEntryDataSize(data: unknown): void {
  if (byteLength(JSON.stringify(data)) > ENTRY_DATA_MAX_BYTES) {
    throw new ConvexError(
      `Entry data exceeds the ${ENTRY_DATA_MAX_BYTES} byte limit — split or trim the row before saving.`,
    );
  }
}

/**
 * Inserts a batch of `{data, geometry?}` rows as entries, attaching a
 * `geometries` row for any row that has one, and folds the whole batch's
 * count-added/bbox-expansion into a single `schemas` patch at the end
 * (not one patch per row). Every row's geometry is validated up front, so
 * the whole batch fails atomically before any inserts happen if one is bad.
 * Returns the inserted entry ids in the same order as `rows`.
 */
export async function insertEntryBatch(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: {
    schema: unknown;
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
    featureCount?: number;
    entryCount?: number;
    boundingBox?: number[];
  },
  rows: Array<{ data: unknown; geometry?: PendingGeometry }>,
): Promise<Array<Id<"entries">>> {
  const resolvedGeometries = rows.map((row) => {
    // The payload cap is checked before anything else so an oversized row
    // fails the batch atomically (issue #129).
    assertEntryDataSize(row.data);
    if (row.geometry === undefined) {
      return undefined;
    }
    if (isResolvedGeometry(row.geometry)) {
      checkResolvedGeometryCompatible(row.geometry, schemaDoc);
      return row.geometry;
    }
    return validateEntryGeometry(row.geometry, schemaDoc);
  });

  let addedCount = 0,
    unionedBbox: BoundingBox | undefined;

  const ids = await Promise.all(
    rows.map(async ({ data }, i) => {
      const entryId = await ctx.db.insert("entries", { data, schemaId }),
        resolved = resolvedGeometries[i];
      if (resolved !== undefined) {
        const bbox = await attachGeometry(ctx, entryId, schemaId, resolved);
        addedCount += 1;
        unionedBbox = unionBbox(unionedBbox, bbox);
      }
      await syncEntryReferences(ctx, entryId, schemaId, schemaDoc, data);
      return entryId;
    }),
  );

  if (addedCount > 0) {
    await applyGeometryStatsDelta(ctx, schemaId, schemaDoc, addedCount, unionedBbox);
  }
  // Every inserted row counts toward `entryCount`, geometry or not.
  await applyEntryCountDelta(ctx, schemaId, schemaDoc, rows.length);

  return ids;
}

/**
 * Replaces (or newly attaches) an entry's geometry with `resolved`. Patches
 * the existing `geometries` row in place when the entry already had one
 * (no `featureCount` change, since this is a replace, not an add) —
 * clearing whichever of `geometryJson`/`geometryStorageId` the new value
 * *doesn't* use, and deleting the old row's external storage blob (if it had
 * one) now that it's no longer referenced; otherwise attaches a new row and
 * increments `featureCount`. Either way expands the schema's `boundingBox`.
 */
export async function replaceEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
  resolved: ResolvedGeometry,
): Promise<void> {
  if (entry.geometryId !== undefined) {
    const existing = await ctx.db.get(entry.geometryId);
    await ctx.db.patch(entry.geometryId, {
      bbox: resolved.bbox,
      geometry: undefined,
      geometryJson: resolved.geometryJson,
      geometryStorageId: resolved.geometryStorageId,
      type: resolved.type,
    });
    await ctx.db.patch(entry._id, { geometryType: resolved.type });
    await deleteGeometryStorageIfAny(ctx, existing);
    await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 0, resolved.bbox);
    return;
  }
  const bbox = await attachGeometry(ctx, entry._id, entry.schemaId, resolved);
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 1, bbox);
}
