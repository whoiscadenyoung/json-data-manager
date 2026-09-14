"use client";

// Provider + context
export { JsonCmsProvider, useJsonCmsApi } from "./provider.js";

// Hooks
export {
  useSchemas,
  useSchema,
  useEntries,
  useEntry,
  useGeometries,
  useCreateSchema,
  useUpdateSchema,
  useDeleteSchema,
  useCreateEntry,
  useCreateEntriesBulk,
  useUpdateEntry,
  useDeleteEntry,
  useDeleteEntriesBySchema,
  useDatasetImport,
} from "./hooks.js";
export type { StartDatasetImportArgs, DatasetImportHandle } from "./hooks.js";

// Types
export type { JsonCmsApi, SchemaDoc, EntryDoc, GeometryDoc, ImportStatusDoc } from "./types.js";
export type { SchemaId, EntryId, GeometryId } from "../client/index.js";

// Framework-agnostic utilities
export { inferSchemaFromData } from "./lib/infer-schema.js";
export { parseDataRows } from "./lib/parse-data.js";
export type { ParseDataResult, ParseError } from "./lib/parse-data.js";
export {
  createDefaultUiSchema,
  mergeUiSchemas,
  DEFAULT_SUBMIT_BUTTON_OPTIONS,
} from "./lib/ui-schema.js";
export type { UiSchema, UiOptions, UiSchemaSubmitButtonOptions } from "./lib/ui-schema.js";

// Geospatial (GeoJSON) utilities
export { GeoParseError, GeometryError } from "../shared/geojson/error.js";
export {
  assertGeometry,
  isValidGeometry,
  computeBbox,
  unionBbox,
} from "../shared/geojson/geometry.js";
export type { BoundingBox } from "../shared/geojson/geometry.js";
export { buildFeature, buildFeatureCollection } from "../shared/geojson/geojson.js";
export type { FeatureRow } from "../shared/geojson/geojson.js";
export {
  coalesceGeometryTypes,
  isGeometryCompatibleWithDatasetType,
} from "../shared/geojson/coalesce.js";
export type { CoalesceOutcome } from "../shared/geojson/coalesce.js";
export { GEOMETRY_TYPES } from "../shared/geojson/types.js";
export type {
  Geometry,
  GeometryType,
  Feature,
  FeatureCollection,
} from "../shared/geojson/types.js";
export { looksLikeGeoJson, parseGeoJsonFeatures } from "./lib/geojson-import.js";
export type { GeoJsonRow, GeoJsonParseResult, GeoJsonFeatureError } from "./lib/geojson-import.js";
