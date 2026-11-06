import type { GeometryType } from "@caden/json-cms/react";

import type { DatasetEntryRow, DatasetGeometryRow } from "#/lib/dataset-rows";
import type { DatasetSummaryRow, DatasetBoundingBox } from "#/lib/store/datasets";
import type { DerivedDatasetSummaryRow } from "#/lib/store/derived";
import type { EntryRow } from "#/lib/store/entries";
import type { GeometryRow } from "#/lib/store/geometries";

import type { DatasetSummary, DerivedDatasetSummary } from "../lib/map-layers";

/**
 * The workspace's PG → pipeline adapters (the transitional split, design
 * §14): a saved map's rows live in Postgres, but its LAYERS may target
 * datasets from either backend, and the whole layer pipeline
 * (`features/maps/lib` — expansion, children, colors, visibility, the tile
 * decision) is typed on the Convex-era row shapes. Rather than re-deriving
 * those behaviors per backend, these adapters lift the PG store rows into
 * exactly the shapes the pipeline already consumes — one mapping per row
 * kind, in one place.
 *
 * The adapters are honest lifts, not fakes: every field maps from a real PG
 * column (§3.2/§3.4), and the fields that have no PG counterpart yet (the
 * derived/chain projections, `mapTileArchiveFormatCurrent`-style
 * pre-computes) are simply absent — optional on every type they land on.
 * Rendering stays origin-split downstream (`isPostgresDatasetId` — the
 * split predicate, `#/lib/dataset-source.ts`); these functions only bridge
 * the TYPES so one pipeline serves both id spaces.
 */

/**
 * One PG dataset summary as the pipeline's `DatasetSummary`. The field
 * mapping (§3.2 `datasets` columns ↔ the component's `toSchemaSummary`
 * projection):
 *   - `id` → `_id`; `title`/`description` pass through.
 *   - `isGeospatial` → `kind` (the union the component stores denormalized).
 *   - `bbox` (the PostGIS envelope as GeoJSON) → `boundingBox`
 *     (`[minLon, minLat, maxLon, maxLat]`, via `pgBboxBounds`' unfold —
 *     kept here as the raw number array the Convex summaries carry).
 *   - archive columns pass 1:1 under the same names (`store/datasets`
 *     exposes them RAW — the staleness/format comparison is the tile
 *     workstream's job, stage 2).
 */
export function pgSummaryToDatasetSummary(row: DatasetSummaryRow): DatasetSummary {
  return {
    _creationTime: 0,
    _id: row.id,
    // The Convex projection pre-computes the format gate; the store exposes
    // the RAW format (the tile workstream owns the comparison — see
    // store/datasets' note), so the PG adapter carries the computed flag as
    // false-with-archive-absent by honest default: the tile decision's PG
    // half reads the raw columns off the store summary, not off this
    // adapter's Convex projection.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the flag is only meaningful on the Convex path; the PG decision inputs are the RAW summaries (see the workspace's decision inputs).
    mapTileArchiveFormatCurrent: false,
    boundingBox: pgBboxTuple(row.bbox),
    createdBy: row.createdBy,
    // The Convex projection reads absent as no description; PG stores null.
    description: row.description ?? undefined,
    editPolicy: row.editPolicy,
    entryCount: row.entryCount,
    featureCount: row.featureCount,
    fieldCount: row.fieldCount,
    // The PG type union allows "GeometryCollection"; the app never writes
    // one (the store's note), and the pipeline's readers can't — the same
    // "always written server-side" posture as `pgGeometryToLayerRow`'s
    // type narrowing below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see the comment above.
    geometryType: (row.geometryType ?? undefined) as DatasetSummary["geometryType"],
    groupId: row.groupId ?? undefined,
    kind: row.isGeospatial ? "geospatial" : "standard",
    lifecycle: row.lifecycle,
    mapTileArchiveBuiltVersion: row.mapTileArchiveBuiltVersion ?? undefined,
    mapTileArchiveBytes: row.mapTileArchiveBytes ?? undefined,
    mapTileCacheVersion: row.mapTileCacheVersion,
    publishedVisibility: row.publishedVisibility,
    title: row.title,
  };
}

/** The stored extent as the flat tuple, or absent (no stored extent yet). */
export function pgBboxTuple(bbox: DatasetBoundingBox | null): number[] | undefined {
  if (bbox === null || bbox.type !== "Polygon") {
    return undefined;
  }
  const ring = bbox.coordinates[0];
  if (ring === undefined) {
    return undefined;
  }
  let minLon = Number.POSITIVE_INFINITY,
    minLat = Number.POSITIVE_INFINITY,
    maxLon = Number.NEGATIVE_INFINITY,
    maxLat = Number.NEGATIVE_INFINITY,
    any = false;
  for (const point of ring) {
    const lon = point[0],
      lat = point[1];
    if (typeof lon !== "number" || typeof lat !== "number") {
      return undefined;
    }
    any = true;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return any ? [minLon, minLat, maxLon, maxLat] : undefined;
}

/**
 * One PG layer row as the pipeline's `MapLayerDoc` (§3.4 columns → the
 * component doc): `id` → `_id`, the rest pass 1:1. `_creationTime` is a
 * Convex bookkeeping field the PG row has no counterpart for — 0 is the
 * honest placeholder (nothing in the pipeline reads it).
 */
/** One PG override row as the pipeline's `MapLayerOverride` (`child_key` → `childKey`; the doc bookkeeping fields are 0-filled placeholders, nothing reads them). */
/**
 * One PG geometry row as the seam's `DatasetGeometryRow` — the row shape
 * LayersMap's whole rendering path (keying, point split, feature building,
 * `useResolvedGeometries`) consumes. The mapping:
 *   - the PG row's identity is the ENTRY (1:1, `geometries.entry_id`
 *     UNIQUE, §3.2) — `_id` reuses it, so resolution keyed by row id and
 *     click payloads keyed by entry id agree;
 *   - `datasetId` → `schemaId` (the render id);
 *   - the RESOLVED GeoJSON (inline jsonb or a fetched storage payload —
 *     `resolveGeometryRows`) is embedded as `geometryJson`, the same inline
 *     form the Convex rows carry, so one resolver serves both backends;
 *   - `type` carries the PG union (`DatasetGeometryType`), which allows
 *     `GeometryCollection` where the Convex validator doesn't — the app
 *     never writes one (store/datasets' note), so the narrowing mirrors
 *     `asBoundingBox`'s "always written server-side" posture.
 */
export function pgGeometryToLayerRow(
  row: GeometryRow,
  resolvedGeometry: unknown,
): DatasetGeometryRow {
  return {
    _creationTime: 0,
    _id: row.entryId,
    entryId: row.entryId,
    schemaId: row.datasetId,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the PG type union allows "GeometryCollection"; the app never writes one (the store's note), and the pipeline's GeometryType-typed readers would drop it otherwise (the `asBoundingBox` posture).
    type: row.type as GeometryType,
    ...(resolvedGeometry === undefined ? {} : { geometryJson: JSON.stringify(resolvedGeometry) }),
  };
}

/**
 * One PG entry row as the seam's `DatasetEntryRow` — the shape the popup
 * panel and the layer-styles field join read (`_id` keys per-entry maps,
 * `schemaId` names the owning dataset). Same re-keying rule as
 * `pgGeometryToLayerRow`.
 */
export function pgEntryToEntryRow(row: EntryRow): DatasetEntryRow {
  return {
    _creationTime: 0,
    _id: row.id,
    data: row.data,
    schemaId: row.datasetId,
  };
}

/**
 * True when a layer target renders through the PG surface (a uuid — the
 * split predicate). Layers targeting Convex datasets keep their Convex
 * reads; layers targeting PG datasets take the store-backed loader.
 */

/**
 * One PG collection as the pipeline's `CollectionDoc` (the component's
 * collections doc): `id` → `_id`, null → absent for the optional columns;
 * the `_creationTime` placeholder follows the adapters' house rule.
 */
/** One PG group as the pipeline's `GroupSummary` (the component's groups doc). */
/**
 * One PG membership row as the pipeline's `MembershipRow` (the component's
 * schemaCollections doc): `datasetId` → `schemaId`; the synthetic `_id` is
 * the pair (the pipeline reads memberships by collection/schemaId only —
 * nothing consumes the row id).
 */
/** One PG derived-registry summary as the pipeline's `DerivedDatasetSummary`. */
export function pgDerivedToDerivedSummary(row: DerivedDatasetSummaryRow): DerivedDatasetSummary {
  return {
    _creationTime: 0,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pipeline's `DerivedDatasetSummary._id` carries the Convex registry's branded id; the PG registry's uuid keys the same string-typed render-id space (the pipeline reads it as a plain string).
    _id: row.id as DerivedDatasetSummary["_id"],
    carriesSql: row.carriesSql,
    createdBy: row.createdBy,
    description: row.description ?? undefined,
    health: row.health,
    healthReason: row.healthReason,
    sourceDatasetId: row.sourceDatasetId,
    status: row.status,
    title: row.title,
  };
}
