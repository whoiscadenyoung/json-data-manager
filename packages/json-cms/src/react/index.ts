"use client";

// Provider + context
export { JsonCmsProvider, useJsonCmsApi } from "./provider.js";

// Hooks
export {
  useSchemas,
  useSchema,
  useEntries,
  useEntry,
  useEntriesForSchemas,
  useReferencingEntries,
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
export type {
  JsonCmsApi,
  SchemaDoc,
  EntryDoc,
  GeometryDoc,
  ImportStatusDoc,
  ReferencingEntryDoc,
} from "./types.js";
export type { SchemaId, EntryId, GeometryId } from "../client/index.js";

// Foreign-reference (relation) utilities — link one dataset's entries to
// another's (see ../shared/reference.ts for the underlying JSON Schema
// convention).
export {
  REFERENCE_KEYWORD,
  getReferenceFields,
  extractReferenceIds,
  extractReferences,
  isReferenceMeta,
} from "../shared/reference.js";
export type {
  ReferenceMeta,
  ReferenceField,
  ExtractedReference,
  ReferenceCandidate,
} from "../shared/reference.js";
export { buildReferenceUiSchema, buildReferenceCandidates } from "./lib/reference-ui-schema.js";

// Framework-agnostic utilities
export { inferSchemaFromData } from "./lib/infer-schema.js";
export { parseDataRows } from "./lib/parse-data.js";
export type { ParseDataResult, ParseError } from "./lib/parse-data.js";

// Tabular import parsers (JSON/JSONL, CSV, Excel) — a pluggable registry so
// a format can be added, removed, or disabled in one place. See
// `import-parsers/registry.ts` for how to toggle one off.
export {
  getEnabledImportParsers,
  getAllImportParsers,
  findImportParser,
  enabledAcceptString,
  enabledExtensionsHint,
} from "./lib/import-parsers/registry.js";
export type {
  ImportParser,
  ImportParseResult,
  ImportParseError,
  ParsedSheet,
} from "./lib/import-parsers/types.js";
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

// Resolves a `GeometryDoc`'s `geometryJson`/`geometryUrl` (see its doc
// comment in types.ts) into an actual `Geometry` — handles the client-side
// fetch + cache for the (rare) storage-backed case transparently.
export { useResolvedGeometries } from "./lib/geometry-resolve.js";
export type { ResolvableGeometryRow } from "./lib/geometry-resolve.js";

// Splits an import's rows into upload-sized chunks client-side — see its
// doc comment for why (Convex components can't use the Node runtime, so no
// server-side step can safely parse a whole multi-tens-of-MB upload at once).
export { chunkRowsForImport } from "./lib/chunk-rows.js";
export type { ImportRow } from "./lib/chunk-rows.js";

// Auto-loads every page of a paginated query (e.g. `listGeometries`,
// `listGeometriesByCollection`) instead of Convex's own incremental
// "load more" `usePaginatedQuery` — for consumers (like map rendering) that
// need the complete result set.
export { useAllPaginated } from "./lib/all-paginated.js";
