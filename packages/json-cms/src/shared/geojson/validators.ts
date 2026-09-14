import { v } from "convex/values";
import type { Infer } from "convex/values";

import { GEOMETRY_TYPES } from "./types.js";

const jsonPositionValidator = v.array(v.number()),
  jsonBoundingBoxValidator = v.array(v.number()),
  jsonObjectValidator = v.object({ bbox: v.optional(jsonBoundingBoxValidator) });

export const convexPointValidator = jsonObjectValidator.extend({
  type: v.literal("Point"),
  coordinates: jsonPositionValidator,
});
export const convexMultiPointValidator = jsonObjectValidator.extend({
  type: v.literal("MultiPoint"),
  coordinates: v.array(jsonPositionValidator),
});
export const convexLineStringValidator = jsonObjectValidator.extend({
  type: v.literal("LineString"),
  coordinates: v.array(jsonPositionValidator),
});
export const convexMultiLineStringValidator = jsonObjectValidator.extend({
  type: v.literal("MultiLineString"),
  coordinates: v.array(v.array(jsonPositionValidator)),
});
export const convexPolygonValidator = jsonObjectValidator.extend({
  type: v.literal("Polygon"),
  coordinates: v.array(v.array(jsonPositionValidator)),
});
export const convexMultiPolygonValidator = jsonObjectValidator.extend({
  type: v.literal("MultiPolygon"),
  coordinates: v.array(v.array(v.array(jsonPositionValidator))),
});

/**
 * Union of all six supported geometry shapes. GeometryCollection is
 * deliberately not a member (see shared/geojson/types.ts).
 *
 * Note: Convex validators can't check array *contents* structurally
 * (e.g. that a position has exactly 2-3 finite numbers in range) — that real
 * structural validation happens in `./geometry.ts`'s `assertGeometry`. This
 * validator only enforces the outer shape so Convex accepts/rejects the
 * right JS shape at the function boundary.
 */
export const geometryArgsValidator = v.union(
  convexPointValidator,
  convexMultiPointValidator,
  convexLineStringValidator,
  convexMultiLineStringValidator,
  convexPolygonValidator,
  convexMultiPolygonValidator,
);
export type GeometryArgs = Infer<typeof geometryArgsValidator>;

export const geometryTypeValidator = v.union(
  v.literal(GEOMETRY_TYPES[0]),
  v.literal(GEOMETRY_TYPES[1]),
  v.literal(GEOMETRY_TYPES[2]),
  v.literal(GEOMETRY_TYPES[3]),
  v.literal(GEOMETRY_TYPES[4]),
  v.literal(GEOMETRY_TYPES[5]),
);
export type GeometryTypeArg = Infer<typeof geometryTypeValidator>;
