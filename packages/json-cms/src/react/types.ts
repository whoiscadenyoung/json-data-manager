import type { FunctionReference, PaginationOptions, PaginationResult } from "convex/server";

import type { EntryId, SchemaId } from "../client/index.js";

/**
 * A stored JSON schema document, as returned by the component's queries.
 */
export interface SchemaDoc {
  _id: SchemaId;
  _creationTime: number;
  title: string;
  description: string;
  /** JSON Schema object. */
  schema: unknown;
  /** Optional RJSF UI schema object. */
  uiSchema?: unknown;
  /** Dataset kind. Absent means `"standard"` (a plain JSON-schema dataset). */
  kind?: "standard" | "geospatial";
  /** The geometry type this dataset is locked to. Only set when `kind === "geospatial"`. */
  geometryType?: string;
  /**
   * Denormalized count of entries in this dataset that currently have a
   * geometry. Kept exactly accurate. Only meaningful for a geospatial
   * dataset.
   */
  featureCount?: number;
  /**
   * Denormalized `[minLon, minLat, maxLon, maxLat]` envelope of this
   * dataset's geometries. Best-effort and monotonically non-shrinking — it
   * grows as geometries are added/replaced but is NOT recomputed on delete,
   * so it may be larger than the true current extent. Good enough for a map
   * default viewport or a list-page summary; not exact after deletions.
   */
  boundingBox?: number[];
  /**
   * True when this dataset normalizes geometry coordinates to 6 decimal
   * places (~0.11 m) on every write — set via the importer's "Simplify
   * geometry" checkbox or the dataset page's "Simplify geometry" action.
   * Absent means no simplification (pre-flag datasets).
   */
  simplifyGeometry?: boolean;
  /** The original imported file, retained in storage for re-download. */
  sourceFileStorageId?: string;
  sourceFileName?: string;
  sourceFileSize?: number;
}

/**
 * A stored data entry document, as returned by the component's queries.
 *
 * Geometry itself is never inlined here — only a pointer. Reading a page of
 * entries (e.g. a properties table) never pulls full coordinate payloads;
 * fetch `GeometryDoc`s via `listGeometries`/`useGeometries` when you
 * actually need to render them (e.g. a map view).
 */
export interface EntryDoc {
  _id: EntryId;
  _creationTime: number;
  schemaId: SchemaId;
  /** Entry data conforming to the referenced schema. */
  data: unknown;
  /** Pointer to this entry's full geometry, if any. */
  geometryId?: string;
  /** Denormalized copy of the pointed-to geometry's top-level type — lets you render a type column / "No geometry" with no extra query. */
  geometryType?: string;
}

/**
 * One entry that references a given target entry via a foreign-reference
 * field (see the `react` package's reference utilities), as returned by
 * `listReferencingEntries`.
 */
export interface ReferencingEntryDoc {
  /** The property name on `sourceEntry.data` holding the reference. */
  fieldName: string;
  /** The dataset the referencing entry belongs to. */
  sourceSchemaId: SchemaId;
  sourceEntry: EntryDoc;
}

/**
 * A stored geometry document, as returned by `listGeometries`. Points at the
 * heavy coordinate payload rather than inlining it directly — a single
 * geometry's coordinates can be several MB, comfortably past Convex's
 * per-document size limit, so the query resolves it to one of two forms:
 *
 * - `geometryJson`: the full GeoJSON geometry, pre-serialized to a JSON
 *   string — the common case (small/medium geometries). `JSON.parse` it.
 * - `geometryUrl`: a fetchable URL for a geometry too large to fit inline —
 *   do a client-side `fetch(geometryUrl).then(r => r.json())` to get it.
 *   (`@caden/json-cms/react`'s `useResolvedGeometries` hook does this for
 *   you, with caching, for a whole list of rows at once.)
 *
 * Exactly one of the two is set on any row with a geometry at all.
 */
export interface GeometryDoc {
  _id: string;
  _creationTime: number;
  schemaId: SchemaId;
  entryId: EntryId;
  /** This geometry's own top-level type. */
  type: string;
  /** The full GeoJSON geometry, pre-serialized — `JSON.parse` it. Set when the geometry is small enough to have been stored inline. */
  geometryJson?: string;
  /** A URL to `fetch` the full GeoJSON geometry from. Set instead of `geometryJson` when the geometry was too large to store inline. */
  geometryUrl?: string;
  /** This geometry's own bounding box, if computable. */
  bbox?: number[];
}

type Empty = Record<string, never>;

/**
 * The set of function references a host app exposes for the JSON CMS
 * component (via `exposeApi`). Map your app's exposed functions to this
 * shape and hand it to `<JsonCmsProvider api={...} />`.
 *
 * The references carry their arg and return types so the hooks infer results
 * without casting. Ids are typed as plain strings here (the component exposes
 * them as `v.string()` at the trust boundary); the hooks re-brand them as
 * `SchemaId` / `EntryId` on the way out.
 */
export interface JsonCmsApi {
  listSchemas: FunctionReference<"query", "public", Empty, SchemaDoc[]>;
  getSchema: FunctionReference<"query", "public", { schemaId: string }, SchemaDoc | null>;
  createSchema: FunctionReference<
    "mutation",
    "public",
    {
      schema: unknown;
      uiSchema?: unknown;
      kind?: "standard" | "geospatial";
      geometryType?: string;
      simplifyGeometry?: boolean;
    },
    SchemaId
  >;
  updateSchema: FunctionReference<
    "mutation",
    "public",
    {
      schemaId: string;
      title?: string;
      description?: string;
      schema?: unknown;
      uiSchema?: unknown;
    },
    null
  >;
  deleteSchema: FunctionReference<"mutation", "public", { schemaId: string }, null>;
  listEntries: FunctionReference<"query", "public", { schemaId: string }, EntryDoc[]>;
  getEntry: FunctionReference<"query", "public", { entryId: string }, EntryDoc | null>;
  listEntriesForSchemas: FunctionReference<"query", "public", { schemaIds: string[] }, EntryDoc[]>;
  listReferencingEntries: FunctionReference<
    "query",
    "public",
    { entryId: string },
    ReferencingEntryDoc[]
  >;
  // Paginated — a dataset's geometry rows can cumulatively exceed Convex's
  // per-execution read-byte budget even though each individual row is
  // safely under its own document-size limit. Use `usePaginatedGeometries`
  // (or the lower-level `useAllPaginated`) to fetch every page.
  listGeometries: FunctionReference<
    "query",
    "public",
    { paginationOpts: PaginationOptions; schemaId: string },
    PaginationResult<GeometryDoc>
  >;
  // `geometry` here is a JSON *string* (see `GeometryDoc`'s doc comment) —
  // the hooks in `hooks.ts` accept a `Geometry`-shaped value and
  // `JSON.stringify` it before calling these, so callers of the hooks never
  // need to know about this wire representation.
  createEntry: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; data: unknown; geometry?: string },
    EntryId
  >;
  createEntriesBulk: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; entries: Array<{ data: unknown; geometry?: string }> },
    EntryId[]
  >;
  updateEntry: FunctionReference<
    "mutation",
    "public",
    { entryId: string; data: unknown; geometry?: string | null },
    null
  >;
  deleteEntry: FunctionReference<"mutation", "public", { entryId: string }, null>;
  deleteEntriesBySchema: FunctionReference<"mutation", "public", { schemaId: string }, number>;
  // Batched dataset import
  generateImportUploadUrl: FunctionReference<"mutation", "public", Empty, string>;
  // `storageIds`: one already-small, client-uploaded chunk blob per entry —
  // see `chunkRowsForImport` for why chunking happens client-side.
  // `sourceFile`: the original uploaded file, retained on the dataset so the
  // un-simplified source stays re-downloadable after geometry simplification.
  startImport: FunctionReference<
    "mutation",
    "public",
    {
      schemaId: string;
      storageIds: string[];
      total: number;
      sourceFile?: { name: string; size: number; storageId: string };
    },
    string
  >;
  /** URL of the original imported file, or `null` when none was retained. */
  getSourceFileUrl: FunctionReference<"query", "public", { schemaId: string }, string | null>;
  /** Rounds an existing geospatial dataset's geometry payloads to 6dp via a durable workflow; poll `getImportStatus` for progress. */
  startSimplification: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; total: number },
    string
  >;
  getImportStatus: FunctionReference<
    "query",
    "public",
    { importId: string },
    ImportStatusDoc | null
  >;
}

/**
 * Live status of a batched dataset import, as returned by `getImportStatus`.
 */
export interface ImportStatusDoc {
  _id: string;
  _creationTime: number;
  schemaId: SchemaId;
  /** @deprecated superseded by `storageIds` (one blob per client-uploaded chunk). */
  storageId?: string;
  storageIds?: string[];
  total: number;
  processed: number;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  workflowId?: string;
}
