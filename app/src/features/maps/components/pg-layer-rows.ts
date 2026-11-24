import type { GeometryType } from "@caden/json-cms/react";

import type { DatasetEntryRow, DatasetGeometryRow } from "#/lib/dataset-rows";
import type {
  DatasetSummaryRow,
  DatasetBoundingBox,
  DatasetGeometryType,
} from "#/lib/store/datasets";
import type { EntryRow } from "#/lib/store/entries";
import type { GeometryRow } from "#/lib/store/geometries";

import type { DatasetSummary } from "../lib/map-layers";

/**
 * The workspace's PG → pipeline adapters (the transitional split, design
 * §14): the layer pipeline (`features/maps/lib` — colors, keyed geometry,
 * the tile decision) is typed on the row shapes in `#/lib/dataset-rows` and
 * `./lib/map-layers`. These adapters lift the PG store rows into exactly
 * those shapes — one mapping per row kind, in one place.
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
 *     kept here as the raw number array).
 *   - archive columns pass 1:1 under the same names (`store/datasets`
 *     exposes them RAW — the staleness/format comparison is the tile
 *     workstream's job, stage 2).
 */
export function pgSummaryToDatasetSummary(row: DatasetSummaryRow): DatasetSummary {
  return {
    _id: row.id,
    boundingBox: pgBboxTuple(row.bbox),
    createdBy: row.createdBy,
    // PG stores a missing description as null; the pipeline reads it as absent.
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
    // The ladder rung bridges to the pipeline's two-literal union.
    publishedVisibility: row.visibility === "members" ? "author" : "everyone",
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
 * One PG geometry row as the seam's `DatasetGeometryRow` — the row shape
 * LayersMap's whole rendering path (keying, point split, feature building,
 * `useResolvedGeometries`) consumes. The mapping:
 *   - the PG row's identity is the ENTRY (1:1, `geometries.entry_id`
 *     UNIQUE, §3.2) — `_id` reuses it, so resolution keyed by row id and
 *     click payloads keyed by entry id agree;
 *   - `datasetId` → `schemaId` (the render id);
 *   - the RESOLVED GeoJSON (inline jsonb or a fetched storage payload —
 *     `resolveGeometryRows`) is embedded as `geometryJson`;
 *   - `type` carries the PG union (`DatasetGeometryType`), which allows
 *     `GeometryCollection` where the pipeline's `GeometryType` doesn't — the app
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
 * The row-path WORKER's row as a seam row (ADR 0025's hand-off shape,
 * [remedies 1]): same re-keying rule as {@link pgGeometryToLayerRow}, but
 * the parsed geometry crosses the worker boundary as an OBJECT
 * (`geometryResolved` — the structured clone is the only remaining copy)
 * instead of a `geometryJson` string, so nothing on the main thread ever
 * stringifies or re-parses a coordinate payload. A row whose payload failed
 * to resolve carries neither field and renders nowhere — the per-row catch
 * posture the seam has always had.
 */
export interface PgResolvedGeometryRow extends DatasetGeometryRow {
  /** The parsed GeoJSON (worker-resolved); absent when resolution failed. */
  geometryResolved?: unknown;
}

/** One `PgGeometryWorkerRow` + its dataset as the seam row the pipeline consumes. */
export function pgWorkerRowToLayerRow(
  row: { entryId: string; geometry?: unknown; type: DatasetGeometryType },
  datasetId: string,
): PgResolvedGeometryRow {
  return {
    _creationTime: 0,
    _id: row.entryId,
    entryId: row.entryId,
    schemaId: datasetId,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same "never written app-side" narrowing as `pgGeometryToLayerRow`'s.
    type: row.type as GeometryType,
    ...(row.geometry === undefined ? {} : { geometryResolved: row.geometry }),
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
