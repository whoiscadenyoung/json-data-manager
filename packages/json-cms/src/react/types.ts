import type { FunctionReference } from "convex/server";

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
 * A stored geometry document, as returned by `listGeometries`. Holds the
 * heavy coordinate payload — the only place it lives.
 */
export interface GeometryDoc {
  _id: string;
  _creationTime: number;
  schemaId: SchemaId;
  entryId: EntryId;
  /** This geometry's own top-level type. */
  type: string;
  /** The full GeoJSON geometry (coordinates and all). */
  geometry: unknown;
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
  listGeometries: FunctionReference<"query", "public", { schemaId: string }, GeometryDoc[]>;
  createEntry: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; data: unknown; geometry?: unknown },
    EntryId
  >;
  createEntriesBulk: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; entries: Array<{ data: unknown; geometry?: unknown }> },
    EntryId[]
  >;
  updateEntry: FunctionReference<
    "mutation",
    "public",
    { entryId: string; data: unknown; geometry?: unknown },
    null
  >;
  deleteEntry: FunctionReference<"mutation", "public", { entryId: string }, null>;
  deleteEntriesBySchema: FunctionReference<"mutation", "public", { schemaId: string }, number>;
  // Batched dataset import
  generateImportUploadUrl: FunctionReference<"mutation", "public", Empty, string>;
  startImport: FunctionReference<
    "mutation",
    "public",
    { schemaId: string; storageId: string; total: number },
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
  storageId: string;
  total: number;
  processed: number;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  workflowId?: string;
}
