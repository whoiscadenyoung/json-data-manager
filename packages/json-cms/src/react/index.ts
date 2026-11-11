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
  useMapTileArchiveMeta,
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
  MapTileArchiveMeta,
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
} from "@caden/data-core/reference";
export type {
  ReferenceMeta,
  ReferenceField,
  ExtractedReference,
  ReferenceCandidate,
} from "@caden/data-core/reference";
export { buildReferenceUiSchema, buildReferenceCandidates } from "./lib/reference-ui-schema.js";

// Framework-agnostic utilities
export { inferSchemaFromData } from "./lib/infer-schema.js";
export { parseDataRows } from "@caden/importers";
export type { ParseDataResult, ParseError } from "@caden/importers";

// Tabular import parsers (JSON/JSONL, CSV, Excel) — a pluggable registry so
// a format can be added, removed, or disabled in one place. See
// `import-parsers/registry.ts` for how to toggle one off.
export {
  getEnabledImportParsers,
  getAllImportParsers,
  findImportParser,
  enabledAcceptString,
  enabledExtensionsHint,
} from "@caden/importers";
export type {
  ImportParser,
  ImportParseResult,
  ImportParseError,
  ParsedSheet,
} from "@caden/importers";
export {
  createDefaultUiSchema,
  mergeUiSchemas,
  DEFAULT_SUBMIT_BUTTON_OPTIONS,
} from "./lib/ui-schema.js";
export type { UiSchema, UiOptions, UiSchemaSubmitButtonOptions } from "./lib/ui-schema.js";

// Geospatial (GeoJSON) utilities
// Coordinate-column detection — guesses a tabular dataset's lat/lon columns
// (by naming convention, validated against sample values) and builds a
// `Point` geometry from them. Powers both import-time "import as geospatial"
// detection and converting an already-imported standard dataset in place.
export {
  detectCoordinateColumns,
  extractPointGeometry,
  parseCoordinateValue,
  isValidLatitude,
  isValidLongitude,
} from "@caden/data-core/coordinate-columns";
export type { CoordinateColumnGuess } from "@caden/data-core/coordinate-columns";

export { GeoParseError, GeometryError } from "@caden/data-core/geojson";
export { assertGeometry, isValidGeometry, computeBbox, unionBbox } from "@caden/data-core/geojson";
export type { BoundingBox } from "@caden/data-core/geojson";
export { buildFeature, buildFeatureCollection } from "@caden/data-core/geojson";
export type { FeatureRow } from "@caden/data-core/geojson";
export {
  coalesceGeometryTypes,
  isGeometryCompatibleWithDatasetType,
} from "@caden/data-core/geojson";
export type { CoalesceOutcome } from "@caden/data-core/geojson";
export { GEOMETRY_TYPES } from "@caden/data-core/geojson";
export type { Geometry, GeometryType, Feature, FeatureCollection } from "@caden/data-core/geojson";
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
