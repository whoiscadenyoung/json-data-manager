import type { GeometryTypeArg } from "@caden/data-core/geojson";
import { queryOptions } from "@tanstack/react-query";

import {
  clientOf,
  queryRow,
  queryRows,
  STORAGE_SIGNED_URL_TTL_SECONDS,
  type StoreOptions,
} from "./client";
import type { VisibilityLevel } from "./visibility";

/**
 * The datasets store (design doc §8.1) — the PG counterpart of today's
 * `api.cms.schemas.*` reads/writes: `list` / `listSummaries` /
 * `listDraftSummaries` / `get` / `create` / `update` / `setEditPolicy` /
 * `setVisibility` / `remove` / `markImportComplete` / `getSourceFileUrl` /
 * `maxTileCacheVersion`, over the `public.datasets` table (DDL §3.2).
 *
 * Identity and authorization live in the database, not here: RLS filters
 * every read (`can_view_dataset` — drafts and author-only rows are invisible
 * to non-creators, so "not found" is a clean empty/null) and gates every
 * write (`can_edit_dataset`). The creator-only edit-policy/visibility FLIP
 * rule (ADR 0010) is enforced by the RLS layer per the design's policy
 * matrix — this module is a plain table writer.
 *
 * NOTE: the row interfaces here are narrow locals typed from the design
 * doc's DDL, not the generated `database.types.ts` (see `./client`).
 *
 * NOTE (reconciliation): the DDL sketch defines no `ui_schema` column, so
 * the component's RJSF ui-schema payload has nowhere to land yet — `create`
 * and `update` deliberately don't accept it. The entry-form surface needs
 * that column (or a documented fold into `json_schema`) before it migrates;
 * flagged for the schema/RPC workstream.
 */

/**
 * The geometry type names the `datasets.geometry_type` check constraint
 * allows (design §3.2) — data-core's six plus GeometryCollection, which the
 * DDL keeps legal even though the app never writes one (data-core excludes
 * it: different geometry types go in different datasets).
 */
export type DatasetGeometryType = GeometryTypeArg | "GeometryCollection";

/** `datasets.kind` (migration 0027): a source dataset holds imported rows, a view holds its runs' output. */
export type DatasetKind = "source" | "view";

/** `datasets.refresh_mode` — views only. */
export type ViewRefreshMode = "manual" | "auto" | "live";

/**
 * The dataset's expand-only bbox envelope (`datasets.bbox`, design §3.2).
 * PostgREST renders the PostGIS polygon as GeoJSON; only consumers in the
 * map workstream (stage 2) read it, and they decide the final projection
 * shape — until then it stays this honest passthrough.
 */
export interface DatasetBoundingBox {
  type: "Polygon";
  coordinates: number[][][];
}

/** The `datasets` wire shape — camelCase aliases over the DDL's columns (§3.2). */
export interface DatasetRow {
  id: string;
  title: string;
  description: string | null;
  /** The stored JSON Schema object (the component's `schema` payload). */
  jsonSchema: unknown;
  /** Declared property keys (array of strings) — the search trigger's and `search_entries` key validation's source of truth (§3.2). Maintained by the write functions below from the schema's `properties`. */
  properties: string[];
  isGeospatial: boolean;
  geometryType: DatasetGeometryType | null;
  entryCount: number;
  featureCount: number;
  bbox: DatasetBoundingBox | null;
  maxGeometryRowBytes: number | null;
  editPolicy: "open" | "locked";
  visibility: VisibilityLevel;
  lifecycle: "draft" | "published";
  lineage: unknown;
  source: unknown;
  /** 'view' = rows are written only by the view's run (migration 0027). */
  kind: DatasetKind;
  /** A view's refresh mode (manual/auto/live); null for a source. */
  refreshMode?: ViewRefreshMode | null;
  /** Bumped per write statement on entries/geometries; the staleness signal. */
  dataVersion: number;
  simplifyGeometry: boolean;
  sourceFileName: string | null;
  sourceFileSize: number | null;
  sourceFilePath: string | null;
  mapTileCacheVersion: number;
  mapTileArchivePath: string | null;
  mapTileArchiveBytes: number | null;
  mapTileArchiveMaxZoom: number | null;
  mapTileArchiveBuiltVersion: number | null;
  mapTileArchiveFormat: number | null;
  groupId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The list-page projection (the `toSchemaSummary` shape, issue #53 parity):
 * everything the browser cards, pickers, and lists read — NOT the heavy
 * `json_schema` payload. `fieldCount` is derived from the declared
 * `properties` column exactly as the component derived it from the payload.
 * `mapTileArchiveFormat` is exposed RAW: the current-format comparison is
 * the tile workstream's job (stage 2), which owns the format constant —
 * mirroring it here would risk the drift the #125 note warns about.
 */
export interface DatasetSummaryRow {
  id: string;
  title: string;
  description: string | null;
  fieldCount: number;
  isGeospatial: boolean;
  geometryType: DatasetGeometryType | null;
  entryCount: number;
  featureCount: number;
  bbox: DatasetBoundingBox | null;
  editPolicy: "open" | "locked";
  visibility: VisibilityLevel;
  lifecycle: "draft" | "published";
  lineage: unknown;
  source: unknown;
  /** 'view' = a saved-steps dataset whose rows come from its runs (migration 0027). */
  kind: DatasetKind;
  /** The view's refresh mode; null for a source dataset. */
  refreshMode: ViewRefreshMode | null;
  /** True when a view's inputs or definition changed since its last good run (`view_stale`); always false for a source. */
  stale: boolean;
  groupId: string | null;
  createdBy: string;
  createdAt: string;
  mapTileCacheVersion: number;
  mapTileArchiveBuiltVersion: number | null;
  mapTileArchiveBytes: number | null;
  mapTileArchiveMaxZoom: number | null;
  mapTileArchiveFormat: number | null;
}

/** The list-page projection's select — exported for the catalog embeds (`collections.listDatasets` joins it through `collection_datasets`). */
export const SUMMARY_SELECT = [
  "id",
  "title",
  "description",
  "properties",
  "isGeospatial:is_geospatial",
  "geometryType:geometry_type",
  "entryCount:entry_count",
  "featureCount:feature_count",
  "bbox",
  "editPolicy:edit_policy",
  "visibility",
  "lifecycle",
  "lineage",
  "source",
  "kind",
  "refreshMode:refresh_mode",
  // PostgREST computed column: the view_stale(datasets) function (0027).
  "stale:view_stale",
  "groupId:group_id",
  "createdBy:created_by",
  "createdAt:created_at",
  "mapTileCacheVersion:map_tile_cache_version",
  "mapTileArchiveBuiltVersion:map_tile_archive_built_version",
  "mapTileArchiveBytes:map_tile_archive_bytes",
  "mapTileArchiveMaxZoom:map_tile_archive_max_zoom",
  "mapTileArchiveFormat:map_tile_archive_format",
].join(",");

/** The full row: the summary columns plus the heavy payload and archive bookkeeping. Exported for the catalog embeds (see `SUMMARY_SELECT`). */
export const DATASET_FULL_SELECT = [
  "id",
  "title",
  "description",
  "jsonSchema:json_schema",
  "properties",
  "isGeospatial:is_geospatial",
  "geometryType:geometry_type",
  "entryCount:entry_count",
  "featureCount:feature_count",
  "bbox",
  "maxGeometryRowBytes:max_geometry_row_bytes",
  "editPolicy:edit_policy",
  "visibility",
  "lifecycle",
  "lineage",
  "source",
  "kind",
  "refreshMode:refresh_mode",
  "dataVersion:data_version",
  "simplifyGeometry:simplify_geometry",
  "sourceFileName:source_file_name",
  "sourceFileSize:source_file_size",
  "sourceFilePath:source_file_path",
  "mapTileCacheVersion:map_tile_cache_version",
  "mapTileArchivePath:map_tile_archive_path",
  "mapTileArchiveBytes:map_tile_archive_bytes",
  "mapTileArchiveMaxZoom:map_tile_archive_max_zoom",
  "mapTileArchiveBuiltVersion:map_tile_archive_built_version",
  "mapTileArchiveFormat:map_tile_archive_format",
  "groupId:group_id",
  "createdBy:created_by",
  "createdAt:created_at",
  "updatedAt:updated_at",
].join(",");

/** Widest bound one catalog list read may ask for (the `CATALOG_READ_LIMIT` parity — Convex's per-execution cap is gone, but an unbounded catalog select is still an unbounded read). */
export const CATALOG_READ_LIMIT = 1000;

export interface DatasetSummaryWire extends Omit<DatasetSummaryRow, "fieldCount"> {
  properties: string[] | null;
}

/** Derives `fieldCount` from the declared `properties` column (the #53 projection rule). */
export function summaryOf(row: DatasetSummaryWire): DatasetSummaryRow {
  const { properties, ...rest } = row;
  return { fieldCount: properties === null ? 0 : properties.length, ...rest };
}

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function, design §8.1)
// ---------------------------------------------------------------------------

/** The full catalog rows, newest first — `api.cms.schemas.list` parity. */
export function listQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "list", CATALOG_READ_LIMIT],
    queryFn: async () =>
      await queryRows<DatasetRow>(
        clientOf(options)
          .from("datasets")
          .select(DATASET_FULL_SELECT)
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

/** The published-view summary projection — `api.cms.schemas.listSummaries` parity. The `lifecycle eq 'published'` filter is LOAD-BEARING, not RLS: can_view_dataset ADMITS a draft to its creator, so without the filter the creator's own drafts would ride the browser/summary projection and the opt-in drafts toggle (listDraftSummariesQueryOptions + withPgDrafts) would double-count them. The Convex listSummaries genuinely gated drafts; this filter restores that gate (the stage-4 review's drafts-leak fix). */
export function listSummariesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "listSummaries", CATALOG_READ_LIMIT],
    queryFn: async () => {
      const rows = await queryRows<DatasetSummaryWire>(
        clientOf(options)
          .from("datasets")
          .select(SUMMARY_SELECT)
          .eq("lifecycle", "published")
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      );
      return rows.map(summaryOf);
    },
  });
}

/** The opt-in drafts view — `api.cms.schemas.listDraftSummaries` parity; creator scoping rides RLS. */
export function listDraftSummariesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "listDraftSummaries", CATALOG_READ_LIMIT],
    queryFn: async () => {
      const rows = await queryRows<DatasetSummaryWire>(
        clientOf(options)
          .from("datasets")
          .select(SUMMARY_SELECT)
          .eq("lifecycle", "draft")
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      );
      return rows.map(summaryOf);
    },
  });
}

/**
 * The TILE pipeline's summary feed — every dataset the signed-in user can
 * see, drafts included ([remedies 1] / #287). The catalog feeds gate on
 * `lifecycle eq 'published'` (the stage-4 drafts-leak fix, still
 * load-bearing THERE), which silently excluded project-held draft datasets
 * from the tile-archive manager's watch: their maps rode the frozen row
 * path forever because the scheduler never saw them (#284's four big
 * polygon datasets were exactly this). The tile pipeline has no drafts
 * leak to fear — it runs behind the sign-in gate, its scheduling and
 * rendering are identity-scoped reads, and anon serving (0023/0024) only
 * ever touches published/frozen rows. Scope still rides RLS: a draft
 * visible to its project's members schedules; a foreign draft does not.
 */
export function tileWatchSummariesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "tileWatch", CATALOG_READ_LIMIT],
    queryFn: async () => {
      const rows = await queryRows<DatasetSummaryWire>(
        clientOf(options)
          .from("datasets")
          .select(SUMMARY_SELECT)
          // A live view saves no rows and never gets a tile archive (#305).
          .or("refresh_mode.is.null,refresh_mode.neq.live")
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      );
      return rows.map(summaryOf);
    },
  });
}

/** One dataset's full row, or null when RLS hides it — `api.cms.schemas.get` parity. */
export function getQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "get", args],
    queryFn: async () =>
      await queryRow<DatasetRow>(
        clientOf(options)
          .from("datasets")
          .select(DATASET_FULL_SELECT)
          .eq("id", args.datasetId)
          .limit(1),
      ),
  });
}

/**
 * A fetchable URL for the dataset's retained import source file
 * (`source-files` bucket), or null when there is none —
 * `api.cms.schemas.getSourceFileUrl` parity (source-file retention, §3.2).
 */
export function getSourceFileUrlQueryOptions(args: { datasetId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "getSourceFileUrl", args],
    queryFn: async () => {
      const row = await queryRow<{ sourceFilePath: string | null }>(
        clientOf(options)
          .from("datasets")
          .select("sourceFilePath:source_file_path")
          .eq("id", args.datasetId)
          .limit(1),
      );
      if (row === null || row.sourceFilePath === null) {
        return null;
      }
      const { data, error } = await clientOf(options)
        .storage.from("source-files")
        .createSignedUrl(row.sourceFilePath, STORAGE_SIGNED_URL_TTL_SECONDS);
      if (error !== null) {
        throw new Error(error.message);
      }
      return data === null ? null : data.signedUrl;
    },
  });
}

/**
 * The largest `map_tile_cache_version` across the VISIBLE datasets — the
 * persisted-light-state cache buster (`api.cms.schemas.maxTileCacheVersion`
 * parity, issue #58 part 5). One indexed row instead of a fold.
 */
export function maxTileCacheVersionQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "maxTileCacheVersion"],
    queryFn: async () => {
      const row = await queryRow<{ mapTileCacheVersion: number }>(
        clientOf(options)
          .from("datasets")
          .select("mapTileCacheVersion:map_tile_cache_version")
          .order("map_tile_cache_version", { ascending: false })
          .limit(1),
      );
      return row === null ? 0 : row.mapTileCacheVersion;
    },
  });
}

/**
 * One creator's datasets as the light summary projection — the profile
 * page's per-creator listing (`/users/$userId` keyed by `created_by`, the
 * pre-migration users-mirror shape). RLS scopes it like every catalog read:
 * the creator's drafts and author-only rows appear only to their creator.
 */
export function listByCreatorQueryOptions(args: { createdBy: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:datasets", "listByCreator", args],
    queryFn: async () => {
      const rows = await queryRows<DatasetSummaryWire>(
        clientOf(options)
          .from("datasets")
          .select(SUMMARY_SELECT)
          .eq("created_by", args.createdBy)
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      );
      return rows.map(summaryOf);
    },
  });
}

// ---------------------------------------------------------------------------
// Writes (plain functions; features wrap them in useMutation + invalidation)
// ---------------------------------------------------------------------------

/** What a dataset write may set at create time — the component `createSchema` arg set, PG column names. */
export interface CreateDatasetArgs {
  /** The JSON Schema object. `title` is the only required field (the ui-polish rule); `description` rides the schema as it does in the component. Typed `object` (what the schema editor's parsed payload is); `create` validates + narrows it. */
  schema: object;
  /** Catalog kind; omit for a standard dataset. */
  kind?: "standard" | "geospatial";
  geometryType?: DatasetGeometryType;
  simplifyGeometry?: boolean;
  /** Host-flow-only, as in the component: only the import flow may create a draft. */
  lifecycle?: "draft" | "published";
  /** Bound-dataset marker (host flows only). */
  source?: { name: string };
  visibility?: VisibilityLevel;
}

/** The declared property keys of a stored JSON Schema — `Object.keys(schema.properties)`, the same derivation the entries table's columns use. */
function declaredProperties(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties);
}

/** The component's create-time schema validation (issue #129's two client-facing errors). */
function assertValidSchemaPayload(schema: unknown): asserts schema is Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("Schema must be an object with a non-empty 'title' property.");
  }
  if (!("title" in schema) || schema.title === undefined || schema.title === "") {
    throw new Error("Schema must have a non-empty 'title' property");
  }
}

/** The description a schema payload carries, or null to clear it (a present-but-non-string value clears — the component's `in`-check reads as "no description"). */
function schemaDescription(schema: Record<string, unknown>): string | null {
  return typeof schema.description === "string" ? schema.description : null;
}

/**
 * Creates a dataset. Returns the new row's id (`createSchema` parity).
 * `title`/`description` fold out of the schema payload exactly as the
 * component does; `properties` derives from the schema's declared keys
 * (§3.2 — the search trigger and `search_entries` key validation read this
 * column, so a schema without a matching `properties` array would leave
 * every sort/filter key "undeclared").
 */
export async function create(args: CreateDatasetArgs, options?: StoreOptions): Promise<string> {
  assertValidSchemaPayload(args.schema);
  // `source` stays ABSENT when not given (host-flow-only field — the
  // component's create omits it for ordinary datasets too). There is no
  // `lineage` argument: the datasets INSERT policy can never admit a
  // non-null lineage (a frozen row is absolute read-only, ADR 0009 — the
  // with-check re-stated predicate rejects it), so the advertised argument
  // was dead weight; frozen versions materialize through the stage-4
  // definer publish path instead.
  const insert: Record<string, unknown> = {
    description: schemaDescription(args.schema),
    geometry_type: args.geometryType ?? null,
    is_geospatial: args.kind === "geospatial",
    json_schema: args.schema,
    lifecycle: args.lifecycle ?? "published",
    properties: declaredProperties(args.schema),
    visibility: args.visibility ?? "signed-in",
    simplify_geometry: args.simplifyGeometry ?? false,
    title: args.schema.title,
  };
  if (args.source !== undefined) {
    insert.source = args.source;
  }
  const row = await queryRow<{ id: string }>(
    clientOf(options).from("datasets").insert(insert).select("id").single(),
  );
  if (row === null) {
    throw new Error("Dataset insert returned no row.");
  }
  return row.id;
}

/** Metadata/structure update — the `updateSchema` arg set (see the header's ui-schema reconciliation note). */
export interface UpdateDatasetArgs {
  datasetId: string;
  title?: string;
  description?: string;
  /** Replaces the stored JSON Schema; title/description fold out of it as at create time. */
  schema?: object;
}

/**
 * Updates a dataset's metadata and/or schema. A schema replacement also
 * rewrites `title`/`description` from the payload and re-derives the
 * declared `properties` (the search vector and key validation follow the
 * schema), mirroring `buildSchemaUpdatePatch`.
 *
 * Returns the affected row count — the stage-4 silent-denial rule: an
 * RLS-filtered write (a locked dataset's non-creator, a frozen row's
 * anyone) answers 0 rows instead of throwing, and the caller must surface
 * that as the not-found/locked denial it is, never as success.
 */
export async function update(args: UpdateDatasetArgs, options?: StoreOptions): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.schema !== undefined) {
    assertValidSchemaPayload(args.schema);
    patch.json_schema = args.schema;
    patch.title = args.schema.title;
    patch.description = schemaDescription(args.schema);
    patch.properties = declaredProperties(args.schema);
  } else {
    if (args.title !== undefined) {
      patch.title = args.title;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
  }
  const rows = await queryRows<unknown>(
    clientOf(options).from("datasets").update(patch).eq("id", args.datasetId).select("id"),
  );
  return rows.length;
}

/** Creator-side edit policy (ADR 0010) — `api.cms.schemas.setEditPolicy` parity; the creator-only flip rule is RLS's (design §4 policy matrix). Returns the affected row count (0 = denied — the stage-4 silent-denial rule). */
export async function setEditPolicy(
  args: { datasetId: string; editPolicy: "open" | "locked" },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<unknown>(
    clientOf(options)
      .from("datasets")
      .update({ edit_policy: args.editPolicy })
      .eq("id", args.datasetId)
      .select("id"),
  );
  return rows.length;
}

/**
 * The dataset's visibility rung (the ladder's leaf artifact — a dataset
 * references nothing, so a widening needs no closure walk; #260, ADR
 * 0022). Narrowing and widening both ride the plain RLS'd write. Returns
 * the affected row count (0 = denied).
 */
export async function setVisibility(
  args: { datasetId: string; visibility: VisibilityLevel },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<unknown>(
    clientOf(options)
      .from("datasets")
      .update({ visibility: args.visibility })
      .eq("id", args.datasetId)
      .select("id"),
  );
  return rows.length;
}

/**
 * Flips an import-created draft to published once its import completes —
 * `api.cms.schemas.markImportComplete` parity (issue #129). Returns the
 * affected row count (0 = denied).
 */
export async function markImportComplete(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<unknown>(
    clientOf(options)
      .from("datasets")
      .update({ lifecycle: "published" })
      .eq("id", args.datasetId)
      .select("id"),
  );
  return rows.length;
}

/** Thrown by `remove` when views still read the dataset: the message lists them by title. */
export class DatasetInUseError extends Error {
  readonly views: string[];
  constructor(views: string[]) {
    super(
      views.length === 0
        ? "Other views still read this dataset, so it can't be deleted. Delete or re-point those views first."
        : `Can't delete this dataset: ${views.length === 1 ? "this view reads" : "these views read"} it: ${views.join(", ")}. Delete or re-point ${views.length === 1 ? "it" : "them"} first.`,
    );
    this.name = "DatasetInUseError";
    this.views = views;
  }
}

/** Titles of the (visible) views whose inputs include the dataset. */
export async function dependentViewTitles(
  args: { datasetId: string },
  options?: StoreOptions,
): Promise<string[]> {
  const rows = await queryRows<{ view: { title: string } | { title: string }[] | null }>(
    clientOf(options)
      .from("view_inputs")
      .select("view:view_id(title)")
      .eq("input_dataset_id", args.datasetId),
  );
  const titles: string[] = [];
  for (const row of rows) {
    const views = Array.isArray(row.view) ? row.view : row.view === null ? [] : [row.view];
    for (const view of views) {
      if (!titles.includes(view.title)) {
        titles.push(view.title);
      }
    }
  }
  return titles;
}

/**
 * Deletes a dataset. Every child (entries, geometries, references, imports,
 * memberships, versions) goes with it by ON DELETE CASCADE — the component's
 * explicit delete walks become foreign keys (design §3.4 note). Returns the
 * affected row count (0 = denied — the frozen-row delete denies everyone).
 *
 * A view's inputs are NO ACTION foreign keys: deleting a dataset that a view
 * still reads is refused by the database. This pre-checks and throws a
 * `DatasetInUseError` that names the dependent views (and maps the raw 23503
 * for views the caller cannot see).
 */
export async function remove(args: { datasetId: string }, options?: StoreOptions): Promise<number> {
  const dependents = await dependentViewTitles(args, options);
  if (dependents.length > 0) {
    throw new DatasetInUseError(dependents);
  }
  try {
    const rows = await queryRows<unknown>(
      clientOf(options).from("datasets").delete().eq("id", args.datasetId).select("id"),
    );
    return rows.length;
  } catch (error) {
    if (error instanceof Error && error.message.includes("(23503)")) {
      throw new DatasetInUseError([]);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Source-file retention (design §10 step 4) — the original import file rides
// the `source-files` bucket; the dataset row records its name/size/path so
// `getSourceFileUrlQueryOptions` can sign a re-download URL.
// ---------------------------------------------------------------------------

/** The `source-files` bucket holding retained import source files (design §6). */
export const SOURCE_FILE_BUCKET = "source-files";

/**
 * Uploads the original import file into the dataset's `source-files/`
 * folder and records `source_file_name`/`source_file_size`/`source_file_path`
 * on the dataset row in one go. The path is the storage key
 * `getSourceFileUrlQueryOptions` signs later. The dataset-row update is
 * gated by can_edit_dataset, so its affected count is the honest denial
 * answer (0 = not the editor) — the object already uploaded is then an
 * orphan, and the caller should say the write failed rather than toast
 * success.
 */
export async function uploadSourceFile(
  args: { datasetId: string; file: File },
  options?: StoreOptions,
): Promise<{ path: string; affected: number }> {
  const client = clientOf(options);
  const path = `${args.datasetId}/${encodeURIComponent(args.file.name)}`;
  const { error } = await client.storage.from(SOURCE_FILE_BUCKET).upload(path, args.file, {
    upsert: true,
  });
  if (error !== null) {
    throw new Error(error.message);
  }
  const rows = await queryRows<unknown>(
    client
      .from("datasets")
      .update({
        source_file_name: args.file.name,
        source_file_size: args.file.size,
        source_file_path: path,
      })
      .eq("id", args.datasetId)
      .select("id"),
  );
  return { affected: rows.length, path };
}
