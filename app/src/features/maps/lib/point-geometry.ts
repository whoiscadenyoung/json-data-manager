import type { BoundingBox, Geometry, GeometryType } from "@caden/json-cms/react";
import type * as GeoJSON from "geojson";

import type { DatasetBoundingBox } from "#/lib/store/datasets";

/**
 * `Point` and `MultiPoint` are the "point-like" geometry types. MapLibre's
 * `fill`/`line` layers (what `MapGeoJSON` renders) draw nothing for them —
 * they need `circle`/`symbol` layers instead, which is what `MapClusterLayer`
 * renders. Everything else (`LineString`, `MultiLineString`, `Polygon`,
 * `MultiPolygon`) keeps going through `MapGeoJSON`.
 */
export function isPointLikeGeometryType(type: GeometryType): type is "Point" | "MultiPoint" {
  return type === "Point" || type === "MultiPoint";
}

/**
 * Splits geometry-bearing rows into point-like (`Point`/`MultiPoint`) and
 * everything else, using each row's denormalized top-level `type` field —
 * no need to touch `.geometry` itself to decide the split.
 */
export function splitPointLikeGeometries<T extends { type: GeometryType }>(
  rows: T[],
): { pointRows: T[]; otherRows: T[] } {
  const pointRows: T[] = [],
    otherRows: T[] = [];
  for (const row of rows) {
    (isPointLikeGeometryType(row.type) ? pointRows : otherRows).push(row);
  }
  return { pointRows, otherRows };
}

export interface PointFeatureRow<P> {
  id: string;
  geometry: Geometry;
  properties: P;
}

/** A GeoJSON Feature whose geometry is the closed polygon ring covering `bbox` (`[minLon, minLat, maxLon, maxLat]`). */
export function bboxFeature(
  bbox: [number, number, number, number],
): GeoJSON.Feature<GeoJSON.Polygon> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  };
}

/**
 * `schemas.boundingBox` is a plain `v.array(v.number())` (Convex validators
 * can't express a fixed-length tuple), but every write stores exactly 4
 * numbers — this narrows the read side back to the tuple shape `unionBbox`
 * expects, mirroring the component's own `asBoundingBox`.
 */
export function asBoundingBox(value: number[] | undefined): BoundingBox | undefined {
  if (value === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- always written as a 4-tuple server-side; the array validator can't express that statically.
  return value as BoundingBox;
}

/**
 * The Postgres dataset's stored extent (`datasets.bbox`, design §3.2 — the
 * trigger-maintained expand-only envelope, the stage-1 counterpart of
 * `schemas.boundingBox`), as PostgREST hands it back: the GeoJSON Polygon
 * the PostGIS envelope renders to. Unfolds the outer ring into the same
 * `[minLon, minLat, maxLon, maxLat]` tuple the Convex summaries carry, so a
 * map surface can instant-open either backend's dataset from its stored
 * extent — zero geometry loads on collection open (the ui-polish rule:
 * stored extent + corner "Loading features…" spinner + one exact refit at
 * completion) — with ONE conversion helper instead of per-surface
 * re-derivations. `st_envelope` always writes an axis-aligned closed ring,
 * so the ring's coordinate extremes ARE the envelope; a malformed/absent
 * bbox reads as no stored extent (the full-skeleton fallback path).
 */
export function pgBboxBounds(value: DatasetBoundingBox | undefined): BoundingBox | undefined {
  if (value === undefined || value.type !== "Polygon") {
    return undefined;
  }
  const ring = value.coordinates[0];
  if (!Array.isArray(ring) || ring.length === 0) {
    return undefined;
  }
  let minLon = Number.POSITIVE_INFINITY,
    minLat = Number.POSITIVE_INFINITY,
    maxLon = Number.NEGATIVE_INFINITY,
    maxLat = Number.NEGATIVE_INFINITY;
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) {
      return undefined;
    }
    const [lon, lat] = point;
    if (typeof lon !== "number" || typeof lat !== "number") {
      return undefined;
    }
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Builds a `Point`-only GeoJSON `FeatureCollection` for `MapClusterLayer`,
 * which only accepts `GeoJSON.Point` features. Rows are expected to already
 * be point-like (see `splitPointLikeGeometries`); a `MultiPoint` geometry is
 * exploded into one `Point` feature per coordinate, duplicating `properties`
 * onto each exploded point so identifiers like `entryId`/`schemaId` survive
 * for click handling. Any other geometry type is silently skipped (defensive
 * only — callers are expected to have already filtered to point-like rows).
 */
export function buildPointFeatureCollection<P>(
  rows: PointFeatureRow<P>[],
): GeoJSON.FeatureCollection<GeoJSON.Point, P> {
  const features: GeoJSON.Feature<GeoJSON.Point, P>[] = [];
  for (const row of rows) {
    if (row.geometry.type === "Point") {
      features.push({
        type: "Feature",
        id: row.id,
        geometry: row.geometry,
        properties: row.properties,
      });
    } else if (row.geometry.type === "MultiPoint") {
      for (const [index, coordinates] of row.geometry.coordinates.entries()) {
        features.push({
          type: "Feature",
          id: `${row.id}:${index}`,
          geometry: { type: "Point", coordinates },
          properties: row.properties,
        });
      }
    }
  }
  return { type: "FeatureCollection", features };
}
