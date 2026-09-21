import { WorkflowManager } from "@convex-dev/workflow";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { extractPointGeometry } from "../shared/coordinate-columns.js";
import { isGeometryCompatibleWithDatasetType } from "../shared/geojson/coalesce.js";
import { GeoParseError, GeometryError } from "../shared/geojson/error.js";
import {
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  roundGeometryCoordinates,
  unionBbox,
} from "../shared/geojson/geometry.js";
import type { BoundingBox } from "../shared/geojson/geometry.js";
import type { Geometry } from "../shared/geojson/types.js";
import { geometryTypeValidator } from "../shared/geojson/validators.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import { extractReferences } from "../shared/reference.js";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import {
  INLINE_GEOMETRY_BYTE_LIMIT,
  byteLength,
  inlineGeometryFieldsOrThrow,
  parseAndValidateGeometry,
  resolveGeometryStorage,
} from "./geometry_storage.js";
import type { ResolvedGeometry } from "./geometry_storage.js";
import schema from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102_400, // 100 KB
  // Hard cap on `listEntriesForIds` — one indexed `get` per id, but an
  // unbounded id list would still be an unbounded read.
  LIST_ENTRIES_FOR_IDS_MAX = 200,
  // Durable workflow engine (nested component) that drives batched imports.
  workflow = new WorkflowManager(components.workflow),
  collectionValidator = schema.tables.collections.validator.extend({
    _creationTime: v.number(),
    _id: v.id("collections"),
  }),
  groupValidator = schema.tables.groups.validator.extend({
    _creationTime: v.number(),
    _id: v.id("groups"),
  }),
  mapValidator = schema.tables.maps.validator.extend({
    _creationTime: v.number(),
    _id: v.id("maps"),
  }),
  mapLayerValidator = schema.tables.mapLayers.validator.extend({
    _creationTime: v.number(),
    _id: v.id("mapLayers"),
  }),
  mapLayerOverrideValidator = schema.tables.mapLayerOverrides.validator.extend({
    _creationTime: v.number(),
    _id: v.id("mapLayerOverrides"),
  }),
  schemaCollectionValidator = schema.tables.schemaCollections.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemaCollections"),
  }),
  schemaValidator = schema.tables.schemas.validator.extend({
    _creationTime: v.number(),
    _id: v.id("schemas"),
  }),
  entryValidator = schema.tables.entries.validator.extend({
    _creationTime: v.number(),
    _id: v.id("entries"),
  }),
  // The normalized shape every reader of `geometries` gets back — see
  // `resolveGeometryOutput`. Exactly one of `geometryJson`/`geometryUrl` is
  // set (barring a row with no geometry payload at all, which shouldn't
  // happen but isn't asserted against here).
  geometryOutputValidator = v.object({
    _creationTime: v.number(),
    _id: v.id("geometries"),
    bbox: v.optional(v.array(v.number())),
    entryId: v.id("entries"),
    geometryJson: v.optional(v.string()),
    geometryUrl: v.optional(v.string()),
    schemaId: v.id("schemas"),
    type: geometryTypeValidator,
  }),
  // The fields a resolved geometry carries through the bulk-import path,
  // once `import_prep.ts` has already validated it and decided inline vs.
  // file storage — see `geometry_storage.ts`'s `ResolvedGeometry`.
  resolvedGeometryValidator = v.object({
    bbox: v.optional(v.array(v.number())),
    geometryJson: v.optional(v.string()),
    geometryStorageId: v.optional(v.id("_storage")),
    type: geometryTypeValidator,
  }),
  entryReferenceValidator = v.object({
    fieldName: v.string(),
    sourceEntry: entryValidator,
    sourceSchemaId: v.id("schemas"),
  }),
  // Host-only attestation that a data write is driven by the host's
  // bound-dataset flows (its sync, tag ingest, unbind, or version-retirement
  // path) rather than by a user. Carried on every data-mutating function and
  // checked by `assertDataWritable`; the value names the flow for diagnostics.
  boundWriteValidator = v.optional(v.string());

/**
 * Component-level read-only enforcement for bound datasets
 * (docs/bound-datasets-design.md §2): a schema marked `source` (a live
 * projection of a connected external source) or `lineage` (a frozen
 * point-in-time version) rejects data writes that don't carry the host's
 * `boundWrite` attestation.
 *
 * The enforcement holds regardless of entry point because the attestation is
 * deliberately absent from every `exposeApi` wrapper's args: Convex arg
 * validators are exact, so a browser client cannot smuggle it through a host
 * wrapper, and component functions have no client-facing path at all. The
 * only callers who can supply it are host functions invoking the component
 * directly — exactly the sync/ingest/retirement flows the writes belong to.
 * It is an attestation, not a secret: the host is trusted code; what is
 * enforced is that user-driven paths cannot reach marked datasets' data.
 */
function assertDataWritable(
  schemaDoc: Pick<Doc<"schemas">, "lineage" | "source">,
  boundWrite: string | undefined,
): void {
  if (boundWrite !== undefined) {
    return;
  }
  if (schemaDoc.source !== undefined || schemaDoc.lineage !== undefined) {
    throw new ConvexError(
      "This dataset is a read-only projection of a connected external source — " +
        "its data changes only through that source's sync/ingest flow, never by direct edits.",
    );
  }
}

// Schema queries

export const listSchemas = query({
  args: {},
  handler: async (ctx) => ctx.db.query("schemas").order("desc").collect(),
  returns: v.array(schemaValidator),
});

/** Number of top-level `properties` on a stored JSON schema — the datasets
 * browser's "N fields" badge. Mirrors the app's `fieldCount` helper so the
 * projection can replace the raw `schema` payload there (issue #53). */
function storedSchemaFieldCount(schemaJson: unknown): number {
  if (typeof schemaJson !== "object" || schemaJson === null || Array.isArray(schemaJson)) {
    return 0;
  }
  const properties = (schemaJson as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return 0;
  }
  return Object.keys(properties).length;
}

/**
 * List-page projection of `listSchemas` (issue #53): every field the
 * datasets browser, groups/collections pages, pickers, and the map workspace
 * read — but NOT `schema`/`uiSchema` (each up to the 100 KB
 * `SCHEMA_SIZE_LIMIT`, dead weight on pages that only show titles, counts,
 * and type tags). The only schema-derived value is `fieldCount`, computed
 * here so the browser card doesn't need the raw payload either. The Structure
 * tab and schema editor keep reading the full doc via `getSchema`.
 * `createdBy` (ADR 0007's authorship stamp) rides along so host list
 * surfaces can attribute datasets without the payloads.
 */
export const listSchemaSummaries = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("schemas").order("desc").collect();
    return docs.map((doc) => ({
      _creationTime: doc._creationTime,
      _id: doc._id,
      boundingBox: doc.boundingBox,
      // Authorship rides the projection so list surfaces (the profile page's
      // per-creator listing, the browser's "by X" line) can show and group by
      // creator without pulling the heavy schema payloads. The host resolves
      // the opaque id to a display name via its own users mirror.
      createdBy: doc.createdBy,
      description: doc.description,
      entryCount: doc.entryCount,
      featureCount: doc.featureCount,
      fieldCount: storedSchemaFieldCount(doc.schema),
      geometryType: doc.geometryType,
      groupId: doc.groupId,
      kind: doc.kind,
      lineage: doc.lineage,
      mapTileArchiveBuiltVersion: doc.mapTileArchiveBuiltVersion,
      mapTileArchiveBytes: doc.mapTileArchiveBytes,
      mapTileArchiveMaxZoom: doc.mapTileArchiveMaxZoom,
      mapTileArchiveStorageId: doc.mapTileArchiveStorageId,
      mapTileCacheVersion: doc.mapTileCacheVersion,
      source: doc.source,
      title: doc.title,
    }));
  },
  returns: v.array(
    schemaValidator
      .pick(
        "_creationTime",
        "_id",
        "boundingBox",
        "createdBy",
        "description",
        "entryCount",
        "featureCount",
        "geometryType",
        "groupId",
        "kind",
        "lineage",
        "mapTileArchiveBuiltVersion",
        "mapTileArchiveBytes",
        "mapTileArchiveMaxZoom",
        "mapTileArchiveStorageId",
        "mapTileCacheVersion",
        "source",
        "title",
      )
      .extend({ fieldCount: v.number() }),
  ),
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => ctx.db.get(args.schemaId),
  returns: v.union(v.null(), schemaValidator),
});

/**
 * Frozen versions (tags) of one bound dataset, newest freeze first — the
 * dataset page's "Versions" list. Only docs carrying `lineage` are in the
 * index, so ordinary datasets list nothing here.
 */
export const listSchemaVersions = query({
  args: { sourceSchemaId: v.id("schemas") },
  handler: async (ctx, args) =>
    ctx.db
      .query("schemas")
      .withIndex("by_lineage_source", (q) => q.eq("lineage.sourceSchemaId", args.sourceSchemaId))
      .order("desc")
      .collect(),
  returns: v.array(schemaValidator),
});

/**
 * The frozen version ingested from one snapshot ref, if any — the tag
 * ingest's idempotency check. Matches a ref already frozen under an older
 * live dataset too, so re-ingesting after the live dataset was re-created
 * can't duplicate versions of the same snapshot.
 */
export const getSchemaVersionBySnapshotRef = query({
  args: { snapshotRef: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("schemas")
      .withIndex("by_lineage_snapshotRef", (q) => q.eq("lineage.snapshotRef", args.snapshotRef))
      .first(),
  returns: v.union(v.null(), schemaValidator),
});

/**
 * A fetchable URL for the original file this dataset was imported from
 * (retained through `startImport`'s `sourceFile`), or `null` when the
 * dataset has no retained source file or its blob is gone. Lets clients
 * re-download the exact uploaded bytes even after geometry has been
 * simplified on write.
 */
export const getSourceFileUrl = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc || schemaDoc.sourceFileStorageId === undefined) {
      return null;
    }
    return ctx.storage.getUrl(schemaDoc.sourceFileStorageId);
  },
  returns: v.union(v.null(), v.string()),
});

// Tile archive (issue #58)
//
// The per-dataset MVT/PMTiles rendering cache. The rebuild worker (part 3)
// snapshots `mapTileCacheVersion`, generates the archive from that exact
// data, uploads the blob, then installs it here. Correctness lives in the
// `expectedVersion` guard below, not in any client-side debounce: a rebuild
// that started against stale data self-discards instead of shadowing a
// newer dataset state.

/**
 * A fetchable URL for the dataset's current tile archive, plus the metadata
 * a client needs to decide between the tile path and the row path
 * (`version` currency check, byte size, max zoom). All fields absent/null
 * when the dataset has no installed archive (or its blob is gone) — read
 * that as "row path only".
 */
export const getMapTileArchiveMeta = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (
      !schemaDoc ||
      schemaDoc.mapTileArchiveStorageId === undefined ||
      schemaDoc.mapTileCacheVersion === undefined ||
      // Part 3's amendment: `version` is the version the archive was BUILT
      // from (`mapTileArchiveBuiltVersion`), not the live counter — every
      // consumer (the react hook doc, issue #61's stale-on-view trigger)
      // compares it against `schemaDoc.mapTileCacheVersion`. An archive
      // missing the built-version field can only predate this field (dev
      // installs from before the amendment); treat it as no archive rather
      // than serve an unanchored staleness check.
      schemaDoc.mapTileArchiveBuiltVersion === undefined
    ) {
      return null;
    }
    // `ctx.storage.getUrl` works in queries (same precedent as
    // `resolveGeometryOutput`/`getSourceFileUrl`); a `null` URL means the
    // blob was already deleted out from under the pointer — treat that as
    // no archive rather than handing the client a dead link.
    const url = await ctx.storage.getUrl(schemaDoc.mapTileArchiveStorageId);
    if (url === null) {
      return null;
    }
    return {
      bytes: schemaDoc.mapTileArchiveBytes,
      maxZoom: schemaDoc.mapTileArchiveMaxZoom,
      storageId: schemaDoc.mapTileArchiveStorageId,
      url,
      version: schemaDoc.mapTileArchiveBuiltVersion,
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      bytes: v.optional(v.number()),
      maxZoom: v.optional(v.number()),
      storageId: v.id("_storage"),
      url: v.string(),
      version: v.number(),
    }),
  ),
});

/**
 * Installs a freshly generated tile archive onto a schema, guarded by the
 * version snapshot the rebuild worker took BEFORE generating: if
 * `expectedVersion` no longer matches the schema's current
 * `mapTileCacheVersion`, edits landed while the archive was being built —
 * so the incoming blob is deleted and nothing is patched (a stale rebuild
 * self-discards, and the client's next staleness check will trigger a
 * rebuild against the newer version). On match, the superseded archive blob
 * is deleted (blobs are immutable; a new generation is a new blob) and all
 * five fields are patched atomically.
 *
 * Deliberately a PUBLIC component mutation, NOT exposed through `exposeApi`:
 * a component-internal function is invisible to the host app entirely (the
 * generated ComponentApi only carries public functions), and the rebuild
 * worker — app-level code (part 3) — reaches this through a thin
 * app-layer mutation wrapping `components.jsonCms.lib.setMapTileArchive`.
 * Because `exposeApi` never re-exports it, no browser client has a path to
 * it — which is the property the issue's "internal" actually meant.
 */
export const setMapTileArchive = mutation({
  args: {
    bytes: v.number(),
    expectedVersion: v.number(),
    maxZoom: v.number(),
    schemaId: v.id("schemas"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      // The dataset itself is gone — its archive blob is now unreferenced.
      await ctx.storage.delete(args.storageId);
      return;
    }
    // An absent version field reads as 0 — a dataset that predates these
    // fields (or was cleared) has never had a geometry-affecting write.
    const currentVersion = schemaDoc.mapTileCacheVersion ?? 0;
    if (currentVersion !== args.expectedVersion) {
      // Stale rebuild: edits happened during generation. Discard the
      // incoming blob; leave the row (including any current archive)
      // untouched.
      await ctx.storage.delete(args.storageId);
      return;
    }

    const superseded = schemaDoc.mapTileArchiveStorageId;
    if (superseded !== undefined && superseded !== args.storageId) {
      await ctx.storage.delete(superseded);
    }
    // Patch all five fields: the three archive pointers plus
    // `mapTileArchiveBuiltVersion` (the snapshot this archive was built
    // from — equal to the current version here, which is what makes
    // `getMapTileArchiveMeta`'s `version` the staleness comparison
    // anchor), and `mapTileCacheVersion` explicitly so "an installed
    // archive always carries a version" holds even for a legacy
    // absent-field row.
    await ctx.db.patch(args.schemaId, {
      mapTileArchiveBuiltVersion: args.expectedVersion,
      mapTileArchiveBytes: args.bytes,
      mapTileArchiveMaxZoom: args.maxZoom,
      mapTileArchiveStorageId: args.storageId,
      mapTileCacheVersion: args.expectedVersion,
    });
  },
});

// Schema mutations

/** Throws unless a `kind`/`geometryType` pair is a valid combination for a schema doc. */
function assertKindAndGeometryType(
  kind: "standard" | "geospatial" | undefined,
  geometryType: GeometryTypeArg | undefined,
): void {
  if (kind === "geospatial" && geometryType === undefined) {
    throw new ConvexError("A geospatial dataset must specify a geometryType.");
  }
  if (kind !== "geospatial" && geometryType !== undefined) {
    throw new ConvexError("A standard dataset cannot specify a geometryType.");
  }
}

/** Throws unless `simplifyGeometry` is only requested for a geospatial dataset — a standard dataset has no geometry to simplify. */
function assertSimplifyGeometryApplies(
  kind: "standard" | "geospatial" | undefined,
  simplifyGeometry: boolean | undefined,
): void {
  if (simplifyGeometry !== undefined && kind !== "geospatial") {
    throw new ConvexError("Only a geospatial dataset can simplify geometry.");
  }
}

export const createSchema = mutation({
  args: {
    // The host's identity string for the actor creating this dataset —
    // stored on the doc as `createdBy` (see the field's doc on the
    // `schemas` table). The exposeApi wrapper fills this from its `auth`
    // hook's return value; clients can't set it directly (the wrapper's
    // validators are exact and it builds the component call itself).
    // Optional so host flows that create datasets without an acting user
    // (bound-sync re-creates, tag ingest) can omit it.
    actorId: v.optional(v.string()),
    geometryType: v.optional(geometryTypeValidator),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schema: v.any(),
    // Marks the dataset as a read-only projection of a connected external
    // source — see the `source` field's doc on the `schemas` table. Absent
    // for ordinary user-created datasets.
    source: v.optional(v.object({ name: v.string() })),
    // Marks the dataset as a frozen point-in-time version (tag) of a bound
    // live dataset — see the `lineage` field's doc on the `schemas` table.
    // Written by the host's tag-ingest flow, never by user-facing creates.
    lineage: v.optional(
      v.object({
        frozenAt: v.number(),
        snapshotRef: v.optional(v.string()),
        sourceSchemaId: v.id("schemas"),
        versionLabel: v.string(),
      }),
    ),
    // Normalize every geometry coordinate to GEOMETRY_SIMPLIFY_DECIMAL_PLACES
    // on write — see `simplifyGeometryPayload` below. Geospatial-only.
    simplifyGeometry: v.optional(v.boolean()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (!args.schema.title) {
      throw new ConvexError("Schema must have a non-empty 'title' property");
    }

    assertKindAndGeometryType(args.kind, args.geometryType);
    assertSimplifyGeometryApplies(args.kind, args.simplifyGeometry);

    const schemaStr = JSON.stringify(args.schema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }

    if (args.uiSchema !== undefined) {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
    }

    const schemaId = await ctx.db.insert("schemas", {
      boundingBox: undefined,
      createdBy: args.actorId,
      description: args.schema.description,
      entryCount: 0,
      featureCount: args.kind === "geospatial" ? 0 : undefined,
      geometryType: args.geometryType,
      kind: args.kind,
      lineage: args.lineage,
      schema: args.schema,
      simplifyGeometry: args.simplifyGeometry,
      source: args.source,
      title: args.schema.title,
      uiSchema: args.uiSchema,
    });

    return schemaId;
  },
  returns: v.id("schemas"),
});

export const updateSchema = mutation({
  args: {
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const patch: Record<string, unknown> = {};

    if (args.schema === undefined) {
      if (args.title !== undefined) {
        patch.title = args.title;
      }
      if (args.description !== undefined) {
        patch.description = args.description;
      }
    } else {
      if (!args.schema.title) {
        throw new ConvexError("Schema must have a non-empty 'title' property");
      }
      const schemaStr = JSON.stringify(args.schema);
      if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("Schema exceeds the 100 KB size limit.");
      }
      patch.schema = args.schema;
      patch.title = args.schema.title;
      patch.description = args.schema.description;
    }

    if (args.uiSchema !== undefined) {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
      patch.uiSchema = args.uiSchema;
    }

    await ctx.db.patch(args.schemaId, patch);
  },
});

export const deleteSchema = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }
    // Deleting a dataset deletes its data, so a bound dataset's deletion
    // belongs to the host's unbind/retirement flows only.
    assertDataWritable(existing, args.boundWrite);

    // Delete all entries and geometries associated with this schema first
    const [entries, geometries, memberships] = await Promise.all([
      ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
      ctx.db
        .query("geometries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
      ctx.db
        .query("schemaCollections")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
    ]);

    await Promise.all([
      ...entries.map(async (entry) => ctx.db.delete(entry._id)),
      ...geometries.map(async (geometry) => {
        await ctx.db.delete(geometry._id);
        await deleteGeometryStorageIfAny(ctx, geometry);
      }),
      deleteReferencesForSchema(ctx, args.schemaId),
      ...memberships.map(async (membership) => ctx.db.delete(membership._id)),
      // Any map layer pointing at this dataset goes with it.
      deleteMapLayersForTarget(ctx, args.schemaId),
      // The retained original import file goes with the dataset — nothing
      // else can reference a schema's own source-file blob.
      existing.sourceFileStorageId !== undefined
        ? ctx.storage.delete(existing.sourceFileStorageId)
        : undefined,
      // Same for the tile archive's blob (see setMapTileArchive) — the whole
      // schema doc is going away, so the cache fields die with it.
      existing.mapTileArchiveStorageId !== undefined
        ? ctx.storage.delete(existing.mapTileArchiveStorageId)
        : undefined,
    ]);

    await ctx.db.delete(args.schemaId);
  },
});

// Collection queries

export const listCollections = query({
  args: {},
  handler: async (ctx) => ctx.db.query("collections").order("desc").collect(),
  returns: v.array(collectionValidator),
});

export const getCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => ctx.db.get(args.collectionId),
  returns: v.union(v.null(), collectionValidator),
});

// Collection mutations

export const createCollection = mutation({
  args: {
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }
    return ctx.db.insert("collections", { description: args.description, name: args.name });
  },
  returns: v.id("collections"),
});

export const updateCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    description: v.optional(v.string()),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Collection must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.collectionId, patch);
  },
});

/**
 * Deletes a collection along with every group inside it. Membership is
 * many-to-many (see `schemaCollections`), so member datasets simply lose
 * this one collection — their other collection memberships are untouched.
 * Datasets inside the deleted groups become ungrouped.
 */
export const deleteCollection = mutation({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.collectionId);
    if (!existing) {
      throw new ConvexError("Collection not found");
    }

    const [groups, memberships] = await Promise.all([
      ctx.db
        .query("groups")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
      ctx.db
        .query("schemaCollections")
        .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
        .collect(),
    ]);

    const groupedDatasets = await Promise.all(
      groups.map(async (group) =>
        ctx.db
          .query("schemas")
          .withIndex("by_group", (q) => q.eq("groupId", group._id))
          .collect(),
      ),
    );

    await Promise.all([
      ...groups.map(async (group) => ctx.db.delete(group._id)),
      ...memberships.map(async (membership) => ctx.db.delete(membership._id)),
      ...groupedDatasets
        .flat()
        .map(async (dataset) => ctx.db.patch(dataset._id, { groupId: undefined })),
      // Map layers pointing at this collection (or any of its groups, which
      // are being deleted just above) go with it.
      deleteMapLayersForCollectionTree(
        ctx,
        args.collectionId,
        groups.map((group) => group._id),
      ),
    ]);

    await ctx.db.delete(args.collectionId);
  },
});

// Group queries

/**
 * Lists groups — every group when `collectionId` is omitted (standalone
 * groups included), or just the groups nested in that collection.
 */
export const listGroups = query({
  args: { collectionId: v.optional(v.id("collections")) },
  handler: async (ctx, args) => {
    const { collectionId } = args;
    if (collectionId === undefined) {
      return ctx.db.query("groups").order("desc").collect();
    }
    return ctx.db
      .query("groups")
      .withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
      .collect();
  },
  returns: v.array(groupValidator),
});

export const getGroup = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => ctx.db.get(args.groupId),
  returns: v.union(v.null(), groupValidator),
});

// Group mutations

/**
 * Creates a group, optionally nested in a collection — a group can also
 * float standalone (`collectionId` omitted).
 */
export const createGroup = mutation({
  args: {
    collectionId: v.optional(v.id("collections")),
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }
    if (args.collectionId !== undefined) {
      const collection = await ctx.db.get(args.collectionId);
      if (!collection) {
        throw new ConvexError("Collection not found");
      }
    }
    return ctx.db.insert("groups", {
      collectionId: args.collectionId,
      description: args.description,
      name: args.name,
    });
  },
  returns: v.id("groups"),
});

export const updateGroup = mutation({
  args: {
    description: v.optional(v.string()),
    groupId: v.id("groups"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Group must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.groupId, patch);
  },
});

/**
 * Deletes a group. Its datasets are not deleted — they just become ungrouped.
 * Their collection memberships (see `schemaCollections`) are untouched.
 */
export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }

    const datasets = await ctx.db
      .query("schemas")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();

    await Promise.all([
      ...datasets.map(async (dataset) => ctx.db.patch(dataset._id, { groupId: undefined })),
      // Map layers pointing at this group go with it.
      deleteMapLayersForTarget(ctx, args.groupId),
    ]);

    await ctx.db.delete(args.groupId);
  },
});

// Dataset <-> collection/group association
//
// Collections are many-to-many (a dataset can sit in any number of them, via
// the `schemaCollections` join table — see schema.ts), while a dataset has at
// most one group. The two relationships are independent: neither mutation
// side touches the other.

export const listSchemasByCollection = query({
  args: { collectionId: v.id("collections") },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_collection", (q) => q.eq("collectionId", args.collectionId))
      .collect();
    const datasets = await Promise.all(memberships.map(async (row) => ctx.db.get(row.schemaId)));
    return datasets.filter((dataset) => dataset !== null);
  },
  returns: v.array(schemaValidator),
});

/** Every `{dataset, collection}` membership row — lets clients count/filter memberships without one query per collection. */
export const listSchemaCollections = query({
  args: {},
  handler: async (ctx) => ctx.db.query("schemaCollections").collect(),
  returns: v.array(schemaCollectionValidator),
});

/** The collections a dataset currently belongs to. */
export const listCollectionsBySchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    const collections = await Promise.all(
      memberships.map(async (row) => ctx.db.get(row.collectionId)),
    );
    return collections.filter((collection) => collection !== null);
  },
  returns: v.array(collectionValidator),
});

/** Adds a dataset to a collection (a no-op if the membership already exists). */
export const addSchemaToCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const [dataset, collection] = await Promise.all([
      ctx.db.get(args.schemaId),
      ctx.db.get(args.collectionId),
    ]);
    if (!dataset) {
      throw new ConvexError("Schema not found");
    }
    if (!collection) {
      throw new ConvexError("Collection not found");
    }

    const existing = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    if (existing.some((row) => row.collectionId === args.collectionId)) {
      return;
    }
    await ctx.db.insert("schemaCollections", {
      collectionId: args.collectionId,
      // Denormalized for `listGeospatialSchemaIdsByCollection` (see the
      // field's doc comment in schema.ts) — read at insert time so the
      // membership row never needs the schema doc to answer "geospatial?".
      kind: dataset.kind,
      schemaId: args.schemaId,
    });
  },
});

/** Removes one of a dataset's collection memberships. Its other memberships and its group are untouched. */
export const removeSchemaFromCollection = mutation({
  args: {
    collectionId: v.id("collections"),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    await Promise.all(
      memberships
        .filter((row) => row.collectionId === args.collectionId)
        .map(async (row) => ctx.db.delete(row._id)),
    );
  },
});

/**
 * Sets (or clears, via `null`) a dataset's group. Group membership is
 * independent of collection memberships — this never touches the
 * `schemaCollections` join table.
 */
export const setSchemaGroup = mutation({
  args: {
    groupId: v.union(v.id("groups"), v.null()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    if (args.groupId === null) {
      await ctx.db.patch(args.schemaId, { groupId: undefined });
      return;
    }

    const group = await ctx.db.get(args.groupId);
    if (!group) {
      throw new ConvexError("Group not found");
    }
    await ctx.db.patch(args.schemaId, { groupId: args.groupId });
  },
});

/**
 * Sets (or clears, via `null`) which collection a group lives in. A group
 * lives in at most one collection (`groups.collectionId` — see schema.ts);
 * "adding" a group to a collection IS setting it here, moving it out of any
 * collection it previously lived in. The group's datasets' own
 * `schemaCollections` memberships are untouched — group membership is
 * independent of dataset membership (see setSchemaGroup). Mirrors
 * setSchemaGroup's shape for datasets.
 */
export const setGroupCollection = mutation({
  args: {
    collectionId: v.union(v.id("collections"), v.null()),
    groupId: v.id("groups"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.groupId);
    if (!existing) {
      throw new ConvexError("Group not found");
    }

    if (args.collectionId === null) {
      await ctx.db.patch(args.groupId, { collectionId: undefined });
      return;
    }

    const collection = await ctx.db.get(args.collectionId);
    if (!collection) {
      throw new ConvexError("Collection not found");
    }
    await ctx.db.patch(args.groupId, { collectionId: args.collectionId });
  },
});

// Map queries

export const listMaps = query({
  args: {},
  handler: async (ctx) => ctx.db.query("maps").order("desc").collect(),
  returns: v.array(mapValidator),
});

export const getMap = query({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => ctx.db.get(args.mapId),
  returns: v.union(v.null(), mapValidator),
});

// Map mutations

export const createMap = mutation({
  args: {
    description: v.optional(v.string()),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.name.trim()) {
      throw new ConvexError("Map must have a name");
    }
    return ctx.db.insert("maps", { description: args.description, name: args.name });
  },
  returns: v.id("maps"),
});

export const updateMap = mutation({
  args: {
    description: v.optional(v.string()),
    mapId: v.id("maps"),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.mapId);
    if (!existing) {
      throw new ConvexError("Map not found");
    }
    if (args.name !== undefined && !args.name.trim()) {
      throw new ConvexError("Map must have a name");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) {
      patch.name = args.name;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
    await ctx.db.patch(args.mapId, patch);
  },
});

/** Deletes a map and every layer in it. The layers' targets are untouched. */
export const deleteMap = mutation({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.mapId);
    if (!existing) {
      throw new ConvexError("Map not found");
    }

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
      .collect();
    // deleteMapLayersForTarget deletes each layer's override rows too.
    await Promise.all(layers.map(async (layer) => deleteMapLayersForLayer(ctx, layer._id)));
    await ctx.db.delete(args.mapId);
  },
});

// Map layer queries

/**
 * Lists a map's layers in draw order (the `by_map` index covers
 * `[mapId, order]`, so an ascending index scan IS the draw order). With
 * `mapId` omitted, lists every layer across all maps — lets a client count
 * layers per map in one query instead of one query per map.
 */
export const listMapLayers = query({
  args: { mapId: v.optional(v.id("maps")) },
  handler: async (ctx, args) => {
    const { mapId } = args;
    if (mapId === undefined) {
      return ctx.db.query("mapLayers").order("asc").collect();
    }
    return ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", mapId))
      .order("asc")
      .collect();
  },
  returns: v.array(mapLayerValidator),
});

// Map layer mutations

const mapLayerTargetTypeValidator = v.union(
  v.literal("collection"),
  v.literal("group"),
  v.literal("dataset"),
);

/**
 * Validates that `targetId` — a plain string from the host app (see
 * exposeApi's note on id validation) — names an existing row of the table
 * `targetType` implies, returning its normalized component id.
 */
async function normalizeMapLayerTarget(
  ctx: MutationCtx,
  targetType: "collection" | "group" | "dataset",
  targetId: string,
): Promise<Id<"collections"> | Id<"groups"> | Id<"schemas">> {
  const label =
    targetType === "collection" ? "Collection" : targetType === "group" ? "Group" : "Dataset";
  const assertFound = (doc: unknown) => {
    if (doc === null) {
      throw new ConvexError(`${label} not found`);
    }
  };
  switch (targetType) {
    case "collection": {
      const id = ctx.db.normalizeId("collections", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
    case "group": {
      const id = ctx.db.normalizeId("groups", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
    default: {
      const id = ctx.db.normalizeId("schemas", targetId);
      if (id === null) {
        throw new ConvexError(`${label} not found`);
      }
      assertFound(await ctx.db.get(id));
      return id;
    }
  }
}

/**
 * Adds a layer to the end of a map, visible by default. A no-op when this
 * exact target is already a layer of the map (same duplicate guard as
 * addSchemaToCollection).
 */
export const addMapLayer = mutation({
  args: {
    mapId: v.id("maps"),
    targetId: v.string(),
    targetType: mapLayerTargetTypeValidator,
  },
  returns: v.union(v.id("mapLayers"), v.null()),
  handler: async (ctx, args) => {
    const map = await ctx.db.get(args.mapId);
    if (!map) {
      throw new ConvexError("Map not found");
    }
    const targetId = await normalizeMapLayerTarget(ctx, args.targetType, args.targetId);

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
      .collect();
    if (
      layers.some((layer) => layer.targetType === args.targetType && layer.targetId === targetId)
    ) {
      return null;
    }

    return ctx.db.insert("mapLayers", {
      mapId: args.mapId,
      order: layers.reduce((next, layer) => Math.max(next, layer.order + 1), 0),
      targetId,
      targetType: args.targetType,
      visible: true,
    });
  },
});

export const removeMapLayer = mutation({
  args: { layerId: v.id("mapLayers") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }
    const overrides = await ctx.db
      .query("mapLayerOverrides")
      .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
      .collect();
    await Promise.all([
      ...overrides.map(async (override) => ctx.db.delete(override._id)),
      ctx.db.delete(args.layerId),
    ]);
  },
});

export const setMapLayerVisibility = mutation({
  args: { layerId: v.id("mapLayers"), visible: v.boolean() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }
    await ctx.db.patch(args.layerId, { visible: args.visible });
  },
});

/**
 * Every override row for one layer (only rows the user has explicitly
 * toggled exist — see the table's doc comment in schema.ts). The client
 * combines them with the layer's live children to derive effective child
 * visibility, so stale overrides (children since removed) are simply
 * ignored, not cleaned up.
 */
export const listMapLayerOverrides = query({
  args: { layerId: v.id("mapLayers") },
  handler: async (ctx, args) =>
    ctx.db
      .query("mapLayerOverrides")
      .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
      .collect(),
  returns: v.array(mapLayerOverrideValidator),
});

/** Every override row within ONE map's layers — the saved-map workspace's
 * single read for child visibility (issue #53's opportunistic scoping: the
 * old variant collected the whole `mapLayerOverrides` table across all
 * maps). Resolves the map's layers through the `by_map` index, then each
 * layer's overrides through `by_layer`, so the read stays proportional to
 * this map's own toggled children no matter how many maps exist. */
export const listMapLayerOverridesForMap = query({
  args: { mapId: v.id("maps") },
  handler: async (ctx, args) => {
    const layers = await ctx.db
        .query("mapLayers")
        .withIndex("by_map", (q) => q.eq("mapId", args.mapId))
        .collect(),
      rows = await Promise.all(
        layers.map(async (layer) =>
          ctx.db
            .query("mapLayerOverrides")
            .withIndex("by_layer", (q) => q.eq("layerId", layer._id))
            .collect(),
        ),
      );
    return rows.flat();
  },
  returns: v.array(mapLayerOverrideValidator),
});

/**
 * Sets (or clears, via `null`) a child's visibility override within one
 * layer. `childKey` is `group:<id>` or `dataset:<id>` — validated only as a
 * string here (the id inside cannot be checked against a table without
 * knowing which); the client derives keys from real children, and a stale
 * key is inert (it matches no rendered child). Clearing removes the row so
 * untouched children stay untouched.
 */
export const setMapLayerOverride = mutation({
  args: {
    childKey: v.string(),
    layerId: v.id("mapLayers"),
    visible: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const layer = await ctx.db.get(args.layerId);
    if (!layer) {
      throw new ConvexError("Layer not found");
    }

    const existing = (
        await ctx.db
          .query("mapLayerOverrides")
          .withIndex("by_layer", (q) => q.eq("layerId", args.layerId))
          .collect()
      ).filter((row) => row.childKey === args.childKey),
      // Clearing (`visible` undefined) removes any override row; setting
      // replaces any existing row for the same childKey.
      deleteExisting = Promise.all(existing.map(async (row) => ctx.db.delete(row._id)));
    if (args.visible === undefined) {
      await deleteExisting;
      return;
    }
    await deleteExisting;
    await ctx.db.insert("mapLayerOverrides", {
      childKey: args.childKey,
      layerId: args.layerId,
      visible: args.visible,
    });
  },
});

/**
 * Swaps a layer with its neighbor in draw order (`up` = toward the top of
 * the list / first drawn). A no-op when the layer is already at that end.
 */
export const moveMapLayer = mutation({
  args: {
    direction: v.union(v.literal("up"), v.literal("down")),
    layerId: v.id("mapLayers"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.layerId);
    if (!existing) {
      throw new ConvexError("Layer not found");
    }

    const layers = await ctx.db
      .query("mapLayers")
      .withIndex("by_map", (q) => q.eq("mapId", existing.mapId))
      .order("asc")
      .collect();
    const index = layers.findIndex((layer) => layer._id === args.layerId),
      neighbor = args.direction === "up" ? layers[index - 1] : layers[index + 1];
    if (neighbor === undefined || index === -1) {
      return;
    }
    await Promise.all([
      ctx.db.patch(args.layerId, { order: neighbor.order }),
      ctx.db.patch(neighbor._id, { order: existing.order }),
    ]);
  },
});

/** Deletes one map layer along with any child visibility overrides it carries. */
async function deleteMapLayersForLayer(ctx: MutationCtx, layerId: Id<"mapLayers">): Promise<void> {
  const overrides = await ctx.db
    .query("mapLayerOverrides")
    .withIndex("by_layer", (q) => q.eq("layerId", layerId))
    .collect();
  await Promise.all([
    ...overrides.map(async (override) => ctx.db.delete(override._id)),
    ctx.db.delete(layerId),
  ]);
}

/**
 * Deletes every map layer (and its override rows) pointing at `targetId` —
 * called when a collection, group, or dataset is deleted, so no layer ever
 * dangles at a missing target.
 */
async function deleteMapLayersForTarget(
  ctx: MutationCtx,
  targetId: Id<"collections"> | Id<"groups"> | Id<"schemas">,
): Promise<void> {
  const layers = await ctx.db
    .query("mapLayers")
    .withIndex("by_target", (q) => q.eq("targetId", targetId))
    .collect();
  await Promise.all(layers.map(async (layer) => deleteMapLayersForLayer(ctx, layer._id)));
}

/**
 * Same as {@link deleteMapLayersForTarget}, but for a whole collection tree:
 * a collection deletion takes its nested groups along (see deleteCollection),
 * so layers pointing at those groups must go too.
 */
async function deleteMapLayersForCollectionTree(
  ctx: MutationCtx,
  collectionId: Id<"collections">,
  groupIds: Array<Id<"groups">>,
): Promise<void> {
  await Promise.all([
    deleteMapLayersForTarget(ctx, collectionId),
    ...groupIds.map(async (groupId) => deleteMapLayersForTarget(ctx, groupId)),
  ]);
}

// Entry queries

export const listEntries = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    return ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .order("desc")
      .collect();
  },
  returns: v.array(entryValidator),
});

/**
 * Normalizes one `geometries` row into the shape every reader gets back:
 * exactly one of `geometryJson` (parseable inline text) or `geometryUrl` (a
 * fetchable URL, for a geometry too large to store inline) is set. This
 * transparently handles all on-disk forms a row can be in — new rows carry
 * `geometryJson`/`geometryStorageId`; a pre-migration row may still carry
 * only the legacy inline `geometry` field — so callers never need to know
 * which one a given row has.
 *
 * `ctx.storage.getUrl` is available from a `query` (unlike `ctx.storage.get`,
 * which reads blob content and is action-only) — that's what makes it
 * possible to resolve a storage-backed geometry to something a client can
 * fetch directly, without needing an action-backed read path.
 */
async function resolveGeometryOutput(
  ctx: QueryCtx,
  row: {
    _creationTime: number;
    _id: Id<"geometries">;
    bbox?: number[];
    entryId: Id<"entries">;
    // Untyped here (not the `Geometry` union) — Convex's own `bbox` field on
    // this legacy sub-shape is a plain `v.array(v.number())`, which doesn't
    // structurally match the `geojson` package's strict-tuple `BBox` type;
    // this function only ever re-serializes it, never inspects its shape.
    geometry?: unknown;
    geometryJson?: string;
    geometryStorageId?: Id<"_storage">;
    schemaId: Id<"schemas">;
    type: GeometryTypeArg;
  },
): Promise<{
  _creationTime: number;
  _id: Id<"geometries">;
  bbox?: number[];
  entryId: Id<"entries">;
  geometryJson?: string;
  geometryUrl?: string;
  schemaId: Id<"schemas">;
  type: GeometryTypeArg;
}> {
  const base = {
    _creationTime: row._creationTime,
    _id: row._id,
    bbox: row.bbox,
    entryId: row.entryId,
    schemaId: row.schemaId,
    type: row.type,
  };
  if (row.geometryJson !== undefined) {
    return { ...base, geometryJson: row.geometryJson };
  }
  if (row.geometryStorageId !== undefined) {
    const url = await ctx.storage.getUrl(row.geometryStorageId);
    return url === null ? base : { ...base, geometryUrl: url };
  }
  if (row.geometry !== undefined) {
    return { ...base, geometryJson: JSON.stringify(row.geometry) };
  }
  return base;
}

// Convex caps a single query execution at reading ~16 MiB total across every
// document it touches — and caps a function's return value at the same 16 MiB
// — independent of, and much larger than, the ~900 KB per-document
// `INLINE_GEOMETRY_BYTE_LIMIT` a single `geometries` row can carry. A dataset
// with hundreds of rows near that inline limit can still blow the 16 MiB
// *cumulative* budget in one unpaginated `.collect()`, even though every
// individual row is safely under its own limit.
//
// `listGeometries` pages through results manually — `.withIndex(...).gt(
// "_creationTime", cursor).take(n)` — rather than using Convex's own
// `.paginate()`: components cannot call `.paginate()` at all ("paginate()
// is only supported in the app" — confirmed against a real deployment, not
// just a doc comment; see `paginateGeometriesBySchema`'s doc comment), so
// there's no `maximumBytesRead` safety net available here. Instead, pages
// are budgeted by *bytes*: rows are `.take()`-n in small chunks while the
// cumulative payload estimate stays under the budget, so a page of point
// geometries (a few dozen bytes each) fills toward the row ceiling while a
// page of near-inline-limit polygons stops after a handful — the round-trip
// count tracks the data's actual size, not its worst case. (A fixed 8-row
// cap used to make 13 KB of point data cost 17 round trips; the same data
// now fits one page.)
/** Upper bound on the payload bytes one page may carry (exported for tests). */
export const GEOMETRY_PAGE_BYTE_BUDGET = 5_000_000; // ~5 MB of payload per page — safely under the 16 MiB per-execution read cap (which the schema-existence read and per-document overhead also share), with room for the one-row overshoot below. Sized as much for rendering cadence as for safety: each page is one serial round trip with a render in between, and after real-world feedback that ~10 MB pages read as one big stall per arrival, the budget is small enough that pages land as a steady stream instead.

/** Minimum geometry-payload size a dataset must reach before a tile archive is worth building for it (exported for tests). Below this the existing row-based read path is already cheap enough — SMART's ~13 KB of points would gain nothing from a 256 KB archive. Consumed by the rebuild worker (issue #58 part 3), not by this component. */
export const MAP_TILE_ARCHIVE_MIN_BYTES = 262_144; // 256 KB

/** High safety ceiling on rows per page; the byte budget is what actually bounds a real page long before this unless every row is tiny. */
const MAX_GEOMETRY_PAGE_ROWS = 500;

// Cap on rows per `.take()` while the remaining budget is plentiful. The
// width actually used scales down with the remaining budget (see
// `takeGeometryRows`) so a page can stop right on the budget, and the
// possible overshoot at a page boundary — rows read but deliberately left
// for the next page — stays down to a single ~900 KB row.
const GEOMETRY_PAGE_CHUNK_ROWS = 8;

/** One `geometries` row, as read directly off `ctx.db` (before `resolveGeometryOutput` normalizes it). */
interface GeometryDbRow {
  _creationTime: number;
  _id: Id<"geometries">;
  bbox?: number[];
  entryId: Id<"entries">;
  geometry?: unknown;
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  schemaId: Id<"schemas">;
  type: GeometryTypeArg;
}

/**
 * Upper-bounds one row's contribution to the page budget. Inline rows cost
 * exactly their JSON text; a pre-migration legacy row costs its
 * re-serialized form; a storage-backed row's payload lives in a blob this
 * query never touches (the client fetches it separately via
 * `geometryUrl`), so it's charged the worst-case inline size — conservative
 * for the budget, which is the safe direction.
 */
function estimateGeometryRowBytes(row: GeometryDbRow): number {
  if (row.geometryJson !== undefined) {
    return byteLength(row.geometryJson);
  }
  if (row.geometry !== undefined) {
    return byteLength(JSON.stringify(row.geometry));
  }
  return INLINE_GEOMETRY_BYTE_LIMIT;
}

/**
 * Parses a `_creationTime` pagination cursor ("", null → undefined).
 * Shared by the geometry and entries paginators, which resume identically.
 */
function parseCreationTimeCursor(cursor: string | null): number | undefined {
  const afterCreationTime = cursor === null || cursor === "" ? undefined : Number(cursor);
  if (afterCreationTime !== undefined && !Number.isFinite(afterCreationTime)) {
    throw new ConvexError("Invalid pagination cursor.");
  }
  return afterCreationTime;
}

/**
 * One `.take()` of a schema's `geometries` rows starting just after
 * `afterTime`, at the widest row count the remaining byte budget can
 * safely absorb: never more rows than the budget could hold even if every
 * one were worst-case `INLINE_GEOMETRY_BYTE_LIMIT` size, so the possible
 * overshoot at a page boundary — rows read but deliberately left for the
 * next page — stays down to a single ~900 KB row.
 *
 * Returns `requested` alongside the rows so the caller can tell "the index
 * ran dry" (`rows.length < requested`) from "the page budget stopped us".
 */
async function takeGeometryRows(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  afterTime: number | undefined,
  maxRows: number,
  remainingBytes: number,
): Promise<{ requested: number; rows: GeometryDbRow[] }> {
  const requested = Math.min(
    maxRows,
    GEOMETRY_PAGE_CHUNK_ROWS,
    Math.max(1, Math.floor(remainingBytes / INLINE_GEOMETRY_BYTE_LIMIT)),
  );
  return {
    requested,
    rows: await ctx.db
      .query("geometries")
      .withIndex("by_schema", (q) =>
        afterTime === undefined
          ? q.eq("schemaId", schemaId)
          : q.eq("schemaId", schemaId).gt("_creationTime", afterTime),
      )
      .order("asc")
      .take(requested),
  };
}

/**
 * Manual cursor-based pagination over one schema's `geometries` rows.
 * Convex components cannot call `.paginate()` — confirmed at push time
 * against a real deployment ("paginate() is only supported in the app"),
 * not merely a documented restriction — so this hand-rolls the same shape
 * `.paginate()` would produce (`{page, isDone, continueCursor}`), with an
 * explicit byte budget standing in for the `maximumBytesRead` safety net
 * `.paginate()` would have provided.
 *
 * The cursor is just the last-returned row's `_creationTime` (the index's
 * implicit trailing sort key); resuming means `.gt("_creationTime", cursor)`
 * on the same index range.
 *
 * Rows are read in small chunks and accumulate into the page until either
 * the index is exhausted (`isDone`) or the next row would push the page's
 * cumulative payload estimate past `GEOMETRY_PAGE_BYTE_BUDGET` — in which
 * case the page stops early with `isDone: false` and the unserved rows are
 * simply re-read by the next page (the overshoot is at most one ~900 KB
 * row; see `takeGeometryRows`). `numItems` is honored only up to
 * `MAX_GEOMETRY_PAGE_ROWS` — never more, as the last-resort ceiling — and
 * at least one row is always returned per call, so the cursor always
 * advances and a caller paging to `isDone` can never stall.
 */
async function paginateGeometriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  paginationOpts: { cursor: string | null; numItems: number },
): Promise<{ continueCursor: string; isDone: boolean; page: GeometryDbRow[] }> {
  const rowLimit = Math.max(1, Math.min(paginationOpts.numItems, MAX_GEOMETRY_PAGE_ROWS)),
    page: GeometryDbRow[] = [];
  let payloadBytes = 0,
    afterTime = parseCreationTimeCursor(paginationOpts.cursor),
    budgetFull = false,
    isDone = false;

  while (!budgetFull && page.length < rowLimit) {
    // oxlint-disable-next-line no-await-in-loop -- each chunk resumes from the previous chunk's last row; inherently sequential.
    const { requested, rows: chunk } = await takeGeometryRows(
      ctx,
      schemaId,
      afterTime,
      rowLimit - page.length,
      GEOMETRY_PAGE_BYTE_BUDGET - payloadBytes,
    );

    let drained = chunk.length < requested;
    for (const row of chunk) {
      const rowBytes = estimateGeometryRowBytes(row);
      if (payloadBytes > 0 && payloadBytes + rowBytes > GEOMETRY_PAGE_BYTE_BUDGET) {
        // This row would push the page over budget — stop here and leave it
        // (and everything after) for the next page. The rows behind it were
        // already read either way; nothing is lost, only re-read.
        budgetFull = true;
        break;
      }
      page.push(row);
      payloadBytes += rowBytes;
      afterTime = row._creationTime;
    }

    if (budgetFull || !drained) {
      continue; // More rows may follow; the while conditions decide.
    }
    isDone = true; // The index ran dry inside this page.
    break;
  }

  const lastRow = page[page.length - 1];
  return {
    continueCursor:
      lastRow === undefined ? (paginationOpts.cursor ?? "") : String(lastRow._creationTime),
    isDone,
    page,
  };
}

/**
 * List the full-geometry rows for a schema, one page at a time — the ONLY
 * read path that pulls full coordinate payloads. Reserved for map
 * rendering; the properties table (`listEntries`) never touches this table.
 * Callers must page through with `paginationOpts.cursor` until `isDone` —
 * see `useAllPaginated` in the `react` package (also used internally by
 * `useGeometries`), which does this for you.
 */
export const listGeometries = query({
  args: { paginationOpts: paginationOptsValidator, schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const result = await paginateGeometriesBySchema(ctx, args.schemaId, args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(result.page.map(async (row) => resolveGeometryOutput(ctx, row))),
    };
  },
  returns: paginationResultValidator(geometryOutputValidator),
});

/**
 * The single geometry attached to one entry (1:1 — see the `geometries`
 * table's doc comment), or `null` when the entry has none. Lets entry-level
 * views (entry details) fetch one geometry without dragging in the whole
 * dataset's paginated set.
 */
export const getEntryGeometry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    const geometry = await ctx.db
      .query("geometries")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId))
      .unique();
    if (geometry === null) {
      return null;
    }
    return resolveGeometryOutput(ctx, geometry);
  },
  returns: v.union(v.null(), geometryOutputValidator),
});

/**
 * The `_id`s of every geospatial dataset in a collection, via its
 * `schemaCollections` membership rows. Each row carries a denormalized
 * `kind` (see schema.ts), so the common case reads only the membership rows —
 * no `schemas` doc fetch per membership (issue #54's collection-level N+1).
 * Rows from before the denormalization have no `kind` and fall back to one
 * schema-doc read, so results are identical either way; the
 * `backfillDatasetSummaries` maintenance mutation stamps them in one pass.
 */
async function listGeospatialSchemaIdsByCollection(ctx: QueryCtx, collectionId: Id<"collections">) {
  const memberships = await ctx.db
    .query("schemaCollections")
    .withIndex("by_collection", (q) => q.eq("collectionId", collectionId))
    .collect();
  const ids = await Promise.all(
    memberships.map(async (row) => {
      if (row.kind !== undefined) {
        return row.kind === "geospatial" ? row.schemaId : null;
      }
      const schemaDoc = await ctx.db.get(row.schemaId);
      return schemaDoc !== null && schemaDoc.kind === "geospatial" ? row.schemaId : null;
    }),
  );
  return ids.filter((id): id is Id<"schemas"> => id !== null);
}

// NOTE on the collection-level map view: there is deliberately no
// `listGeometriesByCollection` aggregate query. Convex allows at most ONE
// `.paginate()` call per query execution ("Only a single paginated query is
// allowed per function execution" — a hard platform limit, not a style
// preference); a collection's geometries are spread across several
// independently-indexed schemas (`geometries` has no `collectionId` of its
// own to scan in one index-scoped pass), so aggregating them server-side
// would need either multiple `.paginate()` calls in one execution (not
// allowed) or a denormalized `collectionId` on every `geometries` row kept
// in sync on every schema re-org (an expensive cascading update, itself
// subject to the very same resource limits this fix exists to respect).
// Instead, the client already has the collection's geospatial schema ids
// (from `listSchemasByCollection` / its own `datasets` list) and calls the
// already-paginated `listGeometries` once per schema, merging client-side —
// see `useAllPaginated` and the collection map route for the pattern.

/**
 * Aggregated entry rows for every geospatial dataset in a collection — joined
 * client-side for feature-detail popups on the collection map view.
 *
 * `limit` optionally caps rows taken PER DATASET (issue #54): these per-dataset
 * collects are unbounded by nature (a collection spans several datasets), and
 * a dataset past Convex's ~16 MiB per-execution read budget would fail the
 * whole query. Pass a cap at call sites that don't need the full set; the
 * group-page export is the one caller that legitimately wants everything and
 * omits the cap.
 */
export const listEntriesByCollection = query({
  args: { collectionId: v.id("collections"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const schemaIds = await listGeospatialSchemaIdsByCollection(ctx, args.collectionId),
      rows = await Promise.all(
        schemaIds.map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            // An omitted cap reads as "no cap" — `take` with the max safe
            // integer simply runs until the index range is exhausted.
            .take(args.limit ?? Number.MAX_SAFE_INTEGER),
        ),
      );
    return rows.flat();
  },
  returns: v.array(entryValidator),
});

export const getEntry = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => ctx.db.get(args.entryId),
  returns: v.union(v.null(), entryValidator),
});

/**
 * Entries from several datasets at once, flattened into one list (each row
 * still carries its own `schemaId`). Powers building a reference field's
 * candidate picker without one round trip per referenced dataset.
 *
 * `limit` optionally caps rows taken PER DATASET (issue #54) — same rationale
 * as `listEntriesByCollection`. The map workspace's popup lookup passes a cap;
 * callers that genuinely need every row omit it.
 */
export const listEntriesForSchemas = query({
  args: { limit: v.optional(v.number()), schemaIds: v.array(v.id("schemas")) },
  handler: async (ctx, args) => {
    const unique = [...new Set(args.schemaIds)],
      rows = await Promise.all(
        unique.map(async (schemaId) =>
          ctx.db
            .query("entries")
            .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
            .take(args.limit ?? Number.MAX_SAFE_INTEGER),
        ),
      );
    return rows.flat();
  },
  returns: v.array(entryValidator),
});

/** Largest number of rows one `listEntriesPage` page may return — entries are
 * thin (see CONVERSION_BATCH_SIZE's note), so a fixed row cap is the honest
 * read bound; payload-budgeted chunking would only matter for pathological
 * `data` payloads that already break every other entries read today. */
const MAX_ENTRY_PAGE_ROWS = 500;

/**
 * Server-side paginated view of one dataset's entries (issue #54): the
 * entries-table equivalent of `listGeometries`. Entries pages keep every
 * query execution bounded no matter how big the dataset grows — an unbounded
 * read of a 20k-row import would blow the ~16 MiB per-execution cap (Convex
 * components cannot call `.paginate()`; see `paginateEntriesBySchema`).
 * Ordered newest-first, matching the pre-pagination table.
 */
export const listEntriesPage = query({
  args: { paginationOpts: paginationOptsValidator, schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    const { page, isDone, continueCursor } = await paginateEntriesBySchema(
      ctx,
      args.schemaId,
      args.paginationOpts.cursor,
      Math.max(1, Math.min(args.paginationOpts.numItems, MAX_ENTRY_PAGE_ROWS)),
      "desc",
    );
    return { continueCursor, isDone, page };
  },
  returns: paginationResultValidator(entryValidator),
});

/**
 * Entries by id — the reference-field label lookup (issue #54): the entries
 * table resolves the human-readable labels for exactly the entries its loaded
 * rows reference, instead of loading every row of every referenced dataset
 * just to label a handful of links. Missing/deleted ids are simply absent
 * from the result; callers render the raw id as a fallback.
 */
export const listEntriesForIds = query({
  args: { entryIds: v.array(v.id("entries")) },
  handler: async (ctx, args) => {
    if (args.entryIds.length > LIST_ENTRIES_FOR_IDS_MAX) {
      throw new ConvexError(`entryIds exceeds ${LIST_ENTRIES_FOR_IDS_MAX} items`);
    }
    const seen = new Set(args.entryIds);
    return (await Promise.all([...seen].map(async (entryId) => await ctx.db.get(entryId)))).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
  },
  returns: v.array(entryValidator),
});

/**
 * Reverse lookup: every other dataset's entry that currently references
 * `entryId`, via the `references` index (see schema.ts) — an indexed
 * lookup rather than a scan of every other dataset's entries.
 */
export const listReferencingEntries = query({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => {
    const refs = await ctx.db
        .query("references")
        .withIndex("by_target_entry", (q) => q.eq("targetEntryId", args.entryId))
        .collect(),
      results = await Promise.all(
        refs.map(async (ref) => {
          const sourceEntry = await ctx.db.get(ref.sourceEntryId);
          return sourceEntry
            ? { fieldName: ref.fieldName, sourceEntry, sourceSchemaId: ref.sourceSchemaId }
            : null;
        }),
      );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  },
  returns: v.array(entryReferenceValidator),
});

// Internal queries/mutations for use within the component

export const getSchemaInternal = internalQuery({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => ctx.db.get(args.schemaId),
  returns: v.union(v.null(), schemaValidator),
});

export const getEntryInternal = internalQuery({
  args: { entryId: v.id("entries") },
  handler: async (ctx, args) => ctx.db.get(args.entryId),
  returns: v.union(v.null(), entryValidator),
});

// Entry mutations
//
// Geometry is never stored inline on `entries` — only a pointer
// (`geometryId`) plus a denormalized `geometryType` string live there. The
// heavy coordinate payload lives in the `geometries` table (see schema.ts),
// so reading a page of entries (the properties table) never pulls full
// geometries along for the ride. Every mutation below that adds/replaces/
// removes a geometry also keeps the owning schema's denormalized
// `featureCount`/`boundingBox` summary up to date (see schema.ts for the
// exact contract on each field).
//
// A geometry argument is always a JSON *string* here, never the nested-array
// `Geometry` shape directly — see geometry_storage.ts's doc comment for why
// (Convex's 8192-elements-per-array limit, which real-world GIS rings
// routinely exceed).

/** Deletes a geometry row's external storage blob, if it has one. No-ops otherwise — safe to call on a row about to be deleted or replaced. */
async function deleteGeometryStorageIfAny(
  ctx: MutationCtx,
  geometryDoc: { geometryStorageId?: Id<"_storage"> } | null,
): Promise<void> {
  if (geometryDoc && geometryDoc.geometryStorageId !== undefined) {
    await ctx.storage.delete(geometryDoc.geometryStorageId);
  }
}

/**
 * Normalizes a validated geometry to the dataset's simplified precision when
 * its schema doc opts in (`simplifyGeometry`): rounds every coordinate to
 * `GEOMETRY_SIMPLIFY_DECIMAL_PLACES` and re-serializes, so the stored payload
 * is the rounded text. Returns the original geometry/json pair unchanged
 * otherwise.
 */
function simplifyGeometryPayload(
  geometry: Geometry,
  geometryJson: string,
  schemaDoc: { simplifyGeometry?: boolean },
): { geometry: Geometry; geometryJson: string } {
  if (schemaDoc.simplifyGeometry !== true) {
    return { geometry, geometryJson };
  }
  const rounded = roundGeometryCoordinates(geometry, GEOMETRY_SIMPLIFY_DECIMAL_PLACES);
  return { geometry: rounded, geometryJson: JSON.stringify(rounded) };
}

/** Runs `fn`, rethrowing geometry parse/validate failures as client-facing ConvexErrors. */
function asConvexError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof GeometryError || err instanceof GeoParseError) {
      throw new ConvexError(err.message);
    }
    throw err;
  }
}

/**
 * Validates a JSON-string geometry argument against the schema doc's
 * `kind`/`geometryType`, and resolves it to the fields a `geometries` row
 * needs. Returns `undefined` when no geometry was provided.
 *
 * Only called from plain mutations, which can't write to file storage — a
 * geometry whose JSON text is too large to store inline is rejected with a
 * clear error rather than silently dropped or truncated; the caller is
 * expected to use the bulk import flow instead (`startImport`), whose
 * action-backed prep step (`import_prep.ts`) can fall back to file storage.
 */
function validateEntryGeometry(
  geometryJsonArg: string | undefined,
  schemaDoc: {
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
  },
): ResolvedGeometry | undefined {
  if (geometryJsonArg === undefined) {
    return undefined;
  }
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  const geometry = asConvexError(() => parseAndValidateGeometry(geometryJsonArg));
  if (!isGeometryCompatibleWithDatasetType(geometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${geometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  const resolved = simplifyGeometryPayload(geometry, geometryJsonArg, schemaDoc);
  return asConvexError(() => inlineGeometryFieldsOrThrow(resolved.geometryJson, resolved.geometry));
}

/**
 * `schemas.boundingBox` is a plain `v.array(v.number())` (Convex validators
 * can't express a fixed-length tuple), but every write to it always stores
 * exactly 4 numbers (see `applyGeometryStatsDelta`). This narrows the read
 * side back to the tuple shape `unionBbox` expects.
 */
function asBoundingBox(value: number[] | undefined): BoundingBox | undefined {
  if (value === undefined) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- always written as a 4-tuple by `applyGeometryStatsDelta`; the array validator can't express that statically.
  return value as BoundingBox;
}

/**
 * `resolvedGeometryValidator`'s `bbox` field is, like `schemas.boundingBox`
 * above, a plain `v.array(v.number())` (Convex validators can't express a
 * fixed-length tuple) — but it's always written as a 4-tuple by
 * `computeBbox`/`resolveGeometryStorage`. Narrows an already-resolved
 * geometry (as received from `insertEntriesChunkInternal`'s args) back to
 * the tuple-typed `ResolvedGeometry` shape the rest of this module uses.
 */
function asResolvedGeometry(value: {
  bbox?: number[];
  geometryJson?: string;
  geometryStorageId?: Id<"_storage">;
  type: GeometryTypeArg;
}): ResolvedGeometry {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    bbox: value.bbox as BoundingBox | undefined,
    geometryJson: value.geometryJson,
    geometryStorageId: value.geometryStorageId,
    type: value.type,
  };
}

/**
 * Folds a geometry add/remove/replace into a schema doc's denormalized
 * `featureCount`/`boundingBox` summary — and bumps `mapTileCacheVersion` in
 * the same patch, so any geometry-affecting write invalidates the dataset's
 * tile archive in the same transaction (see `bumpMapTileCacheVersion`).
 * `featureCount` is kept exactly accurate (clamped at 0). `boundingBox` only
 * ever grows (via `unionBbox`) — see the field's doc comment in schema.ts
 * for why deletes don't shrink it back down.
 */
async function applyGeometryStatsDelta(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { featureCount?: number; boundingBox?: number[]; mapTileCacheVersion?: number },
  countDelta: number,
  newBbox: BoundingBox | undefined,
): Promise<void> {
  const featureCount = Math.max(0, (schemaDoc.featureCount ?? 0) + countDelta),
    boundingBox = unionBbox(asBoundingBox(schemaDoc.boundingBox), newBbox);
  await ctx.db.patch(schemaId, {
    boundingBox,
    featureCount,
    mapTileCacheVersion: (schemaDoc.mapTileCacheVersion ?? 0) + 1,
  });
}

/**
 * Folds an entry add/remove into a schema doc's denormalized `entryCount`
 * (clamped at 0). The entry-side counterpart of `applyGeometryStatsDelta`:
 * deliberately separate, because a data-only write (rows with no geometry)
 * changes `entryCount` but must NOT bump `mapTileCacheVersion` — the tile
 * archive is a pure function of the geometries, and a spurious version bump
 * would schedule a pointless rebuild.
 */
async function applyEntryCountDelta(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { entryCount?: number },
  delta: number,
): Promise<void> {
  if (delta === 0) {
    return;
  }
  await ctx.db.patch(schemaId, {
    entryCount: Math.max(0, (schemaDoc.entryCount ?? 0) + delta),
  });
}

/**
 * Monotonically bumps a schema's `mapTileCacheVersion` (`absent = 0`) — the
 * invalidation signal for the dataset's tile archive (issue #58): a rebuild
 * worker snapshots the version before generating, and `setMapTileArchive`
 * discards the result unless the version is still current. Patched into
 * every path that already maintains `featureCount`/`boundingBox`
 * (via `applyGeometryStatsDelta`) plus the two that patch the schema row
 * directly — simplify batches and `deleteEntriesBySchema`/`deleteSchema`.
 * Unconditional, including below-threshold datasets: the field costs one
 * number and keeps the invariant simple ("version changed ⇒ data changed").
 */
async function bumpMapTileCacheVersion(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { mapTileCacheVersion?: number },
): Promise<void> {
  await ctx.db.patch(schemaId, {
    mapTileCacheVersion: (schemaDoc.mapTileCacheVersion ?? 0) + 1,
  });
}

/**
 * Inserts a `geometries` row for `entryId` and patches the entry's pointer
 * fields (`geometryId`/`geometryType`) to reference it. Returns the new
 * row's own bbox for the caller to fold into the schema's summary.
 */
async function attachGeometry(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  schemaId: Id<"schemas">,
  resolved: ResolvedGeometry,
): Promise<BoundingBox | undefined> {
  const geometryId = await ctx.db.insert("geometries", {
    bbox: resolved.bbox,
    entryId,
    geometryJson: resolved.geometryJson,
    geometryStorageId: resolved.geometryStorageId,
    schemaId,
    type: resolved.type,
  });
  await ctx.db.patch(entryId, { geometryId, geometryType: resolved.type });
  return resolved.bbox;
}

/**
 * Deletes every `references` row for `schemaId`, on either side of the
 * pointer: rows sourced from one of this schema's own entries (gone with
 * the schema), and rows targeting one of its entries from some other
 * dataset's entry (which would otherwise dangle, pointing at a deleted
 * entry). A row can appear in both queries for a schema that
 * self-references, hence the de-dupe.
 */
async function deleteReferencesForSchema(ctx: MutationCtx, schemaId: Id<"schemas">): Promise<void> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query("references")
      .withIndex("by_source_schema", (q) => q.eq("sourceSchemaId", schemaId))
      .collect(),
    ctx.db
      .query("references")
      .withIndex("by_target_schema", (q) => q.eq("targetSchemaId", schemaId))
      .collect(),
  ]);
  const seen = new Set<Id<"references">>();
  await Promise.all(
    [...asSource, ...asTarget]
      .filter((row) => {
        if (seen.has(row._id)) {
          return false;
        }
        seen.add(row._id);
        return true;
      })
      .map(async (row) => ctx.db.delete(row._id)),
  );
}

/** Same as {@link deleteReferencesForSchema}, scoped to a single entry (both as source and as target). */
async function deleteReferencesForEntry(ctx: MutationCtx, entryId: Id<"entries">): Promise<void> {
  const [asSource, asTarget] = await Promise.all([
    ctx.db
      .query("references")
      .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
      .collect(),
    ctx.db
      .query("references")
      .withIndex("by_target_entry", (q) => q.eq("targetEntryId", entryId))
      .collect(),
  ]);
  const seen = new Set<Id<"references">>();
  await Promise.all(
    [...asSource, ...asTarget]
      .filter((row) => {
        if (seen.has(row._id)) {
          return false;
        }
        seen.add(row._id);
        return true;
      })
      .map(async (row) => ctx.db.delete(row._id)),
  );
}

/**
 * Re-derives an entry's outgoing `references` rows from its current `data`
 * against its schema's reference fields (see ../shared/reference.ts).
 * Simplest-correct approach: wipe this entry's existing rows and reinsert
 * from scratch, rather than diffing — a dataset entry only ever has a
 * handful of reference fields, so this is cheap and can't drift.
 *
 * A referenced id that doesn't normalize to a real `entries`/`schemas` id,
 * or whose target entry doesn't actually belong to the declared target
 * schema, is silently skipped — a stale/malformed reference in `data`
 * (e.g. the target entry was since deleted) shouldn't block saving the
 * source entry.
 */
async function syncEntryReferences(
  ctx: MutationCtx,
  entryId: Id<"entries">,
  sourceSchemaId: Id<"schemas">,
  schemaDoc: { schema: unknown },
  data: unknown,
): Promise<void> {
  const existing = await ctx.db
    .query("references")
    .withIndex("by_source_entry", (q) => q.eq("sourceEntryId", entryId))
    .collect();
  await Promise.all(existing.map(async (row) => ctx.db.delete(row._id)));

  await Promise.all(
    extractReferences(schemaDoc.schema, data).map(async (ref) => {
      const targetSchemaId = ctx.db.normalizeId("schemas", ref.targetSchemaId),
        targetEntryId = ctx.db.normalizeId("entries", ref.targetEntryId);
      if (!targetSchemaId || !targetEntryId) {
        return;
      }
      const targetEntry = await ctx.db.get(targetEntryId);
      if (!targetEntry || targetEntry.schemaId !== targetSchemaId) {
        return;
      }
      await ctx.db.insert("references", {
        fieldName: ref.fieldName,
        sourceEntryId: entryId,
        sourceSchemaId,
        targetEntryId,
        targetSchemaId,
      });
    }),
  );
}

/**
 * One row's geometry argument, as accepted by `insertEntryBatch`: either a
 * raw JSON string awaiting validation (the single-entry mutation paths —
 * `createEntry`/`updateEntry`/`createEntriesBulk`), or an already-resolved
 * `ResolvedGeometry` (the bulk-import path, whose `import_prep.ts` action
 * already validated + resolved it before this ever runs in a mutation).
 */
type PendingGeometry = string | ResolvedGeometry;

function isResolvedGeometry(value: PendingGeometry): value is ResolvedGeometry {
  return typeof value !== "string";
}

/** Re-validates just the cheap part (dataset-kind/geometry-type compatibility) for an already-resolved geometry. The expensive structural validation already happened in `import_prep.ts`. */
function checkResolvedGeometryCompatible(
  resolved: ResolvedGeometry,
  schemaDoc: { kind?: "standard" | "geospatial"; geometryType?: GeometryTypeArg },
): void {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError("Cannot attach geometry to a standard dataset.");
  }
  if (!isGeometryCompatibleWithDatasetType(resolved.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Geometry type "${resolved.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
}

/**
 * Inserts a batch of `{data, geometry?}` rows as entries, attaching a
 * `geometries` row for any row that has one, and folds the whole batch's
 * count-added/bbox-expansion into a single `schemas` patch at the end
 * (not one patch per row). Every row's geometry is validated up front, so
 * the whole batch fails atomically before any inserts happen if one is bad.
 * Returns the inserted entry ids in the same order as `rows`.
 */
async function insertEntryBatch(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: {
    schema: unknown;
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
    featureCount?: number;
    entryCount?: number;
    boundingBox?: number[];
  },
  rows: Array<{ data: unknown; geometry?: PendingGeometry }>,
): Promise<Array<Id<"entries">>> {
  const resolvedGeometries = rows.map((row) => {
    if (row.geometry === undefined) {
      return undefined;
    }
    if (isResolvedGeometry(row.geometry)) {
      checkResolvedGeometryCompatible(row.geometry, schemaDoc);
      return row.geometry;
    }
    return validateEntryGeometry(row.geometry, schemaDoc);
  });

  let addedCount = 0,
    unionedBbox: BoundingBox | undefined;

  const ids = await Promise.all(
    rows.map(async ({ data }, i) => {
      const entryId = await ctx.db.insert("entries", { data, schemaId }),
        resolved = resolvedGeometries[i];
      if (resolved !== undefined) {
        const bbox = await attachGeometry(ctx, entryId, schemaId, resolved);
        addedCount += 1;
        unionedBbox = unionBbox(unionedBbox, bbox);
      }
      await syncEntryReferences(ctx, entryId, schemaId, schemaDoc, data);
      return entryId;
    }),
  );

  if (addedCount > 0) {
    await applyGeometryStatsDelta(ctx, schemaId, schemaDoc, addedCount, unionedBbox);
  }
  // Every inserted row counts toward `entryCount`, geometry or not.
  await applyEntryCountDelta(ctx, schemaId, schemaDoc, rows.length);

  return ids;
}

/**
 * Deletes an entry and, if it has one, its associated `geometries` row (and
 * that row's external storage blob, if any) — decrementing the owning
 * schema's `featureCount` (bbox left untouched, see its doc comment).
 * Silently no-ops if the entry doesn't exist.
 */
async function deleteEntryCascading(ctx: MutationCtx, entryId: Id<"entries">): Promise<void> {
  const existing = await ctx.db.get(entryId);
  if (!existing) {
    return;
  }
  const [schemaDoc, geometryDoc] = await Promise.all([
    ctx.db.get(existing.schemaId),
    existing.geometryId !== undefined ? ctx.db.get(existing.geometryId) : Promise.resolve(null),
  ]);
  if (schemaDoc) {
    await applyEntryCountDelta(ctx, existing.schemaId, schemaDoc, -1);
  }
  if (existing.geometryId !== undefined) {
    await ctx.db.delete(existing.geometryId);
    await deleteGeometryStorageIfAny(ctx, geometryDoc);
    if (schemaDoc) {
      await applyGeometryStatsDelta(ctx, existing.schemaId, schemaDoc, -1, undefined);
    }
  }
  await deleteReferencesForEntry(ctx, entryId);
  await ctx.db.delete(entryId);
}

/**
 * Deletes the entry's existing `geometries` row (if any, and its external
 * storage blob, if any), clears its pointer fields, and decrements the
 * schema's `featureCount`. No-ops if the entry has no geometry. Bbox is left
 * untouched (see its doc comment).
 */
async function clearEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
): Promise<void> {
  if (entry.geometryId === undefined) {
    return;
  }
  const existing = await ctx.db.get(entry.geometryId);
  await ctx.db.delete(entry.geometryId);
  await deleteGeometryStorageIfAny(ctx, existing);
  await ctx.db.patch(entry._id, { geometryId: undefined, geometryType: undefined });
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, -1, undefined);
}

/**
 * Replaces (or newly attaches) an entry's geometry with `resolved`. Patches
 * the existing `geometries` row in place when the entry already had one
 * (no `featureCount` change, since this is a replace, not an add) —
 * clearing whichever of `geometryJson`/`geometryStorageId` the new value
 * *doesn't* use, and deleting the old row's external storage blob (if it had
 * one) now that it's no longer referenced; otherwise attaches a new row and
 * increments `featureCount`. Either way expands the schema's `boundingBox`.
 */
async function replaceEntryGeometry(
  ctx: MutationCtx,
  entry: { _id: Id<"entries">; schemaId: Id<"schemas">; geometryId?: Id<"geometries"> },
  schemaDoc: { featureCount?: number; boundingBox?: number[] },
  resolved: ResolvedGeometry,
): Promise<void> {
  if (entry.geometryId !== undefined) {
    const existing = await ctx.db.get(entry.geometryId);
    await ctx.db.patch(entry.geometryId, {
      bbox: resolved.bbox,
      geometry: undefined,
      geometryJson: resolved.geometryJson,
      geometryStorageId: resolved.geometryStorageId,
      type: resolved.type,
    });
    await ctx.db.patch(entry._id, { geometryType: resolved.type });
    await deleteGeometryStorageIfAny(ctx, existing);
    await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 0, resolved.bbox);
    return;
  }
  const bbox = await attachGeometry(ctx, entry._id, entry.schemaId, resolved);
  await applyGeometryStatsDelta(ctx, entry.schemaId, schemaDoc, 1, bbox);
}

export const createEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    data: v.any(),
    geometry: v.optional(v.string()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    // Verify schema exists
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    const [entryId] = await insertEntryBatch(ctx, args.schemaId, schemaDoc, [
      { data: args.data, geometry: args.geometry },
    ]);

    return entryId;
  },
  returns: v.id("entries"),
});

export const createEntriesBulk = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    entries: v.array(v.object({ data: v.any(), geometry: v.optional(v.string()) })),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    return insertEntryBatch(ctx, args.schemaId, schemaDoc, args.entries);
  },
  returns: v.array(v.id("entries")),
});

export const updateEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    data: v.any(),
    entryId: v.id("entries"),
    geometry: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    // Checked before any write so a rejected call leaves the entry untouched
    // (the transaction would roll back anyway; failing fast is clearer).
    assertDataWritable(schemaDoc, args.boundWrite);

    await ctx.db.patch(args.entryId, { data: args.data });

    await syncEntryReferences(ctx, args.entryId, existing.schemaId, schemaDoc, args.data);

    if (args.geometry === undefined) {
      return;
    }

    if (args.geometry === null) {
      await clearEntryGeometry(ctx, existing, schemaDoc);
      return;
    }

    const resolved = validateEntryGeometry(args.geometry, schemaDoc);
    if (resolved !== undefined) {
      await replaceEntryGeometry(ctx, existing, schemaDoc, resolved);
    }
  },
});

export const deleteEntry = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    if (!existing) {
      throw new ConvexError("Entry not found");
    }

    // The schema doc is normally present; an orphaned entry (its dataset
    // already gone) may still be cleaned up.
    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (schemaDoc !== null) {
      assertDataWritable(schemaDoc, args.boundWrite);
    }

    await deleteEntryCascading(ctx, args.entryId);
  },
});

export const deleteEntriesBySchema = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);

    const [entries, geometries] = await Promise.all([
      ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
      ctx.db
        .query("geometries")
        .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
        .collect(),
    ]);

    await Promise.all([
      ...entries.map(async (entry) => ctx.db.delete(entry._id)),
      ...geometries.map(async (geometry) => {
        await ctx.db.delete(geometry._id);
        await deleteGeometryStorageIfAny(ctx, geometry);
      }),
      deleteReferencesForSchema(ctx, args.schemaId),
      // The tile archive's blob goes with the dataset too — like the
      // source-file blob below, nothing outside the schema doc references it.
      schemaDoc.mapTileArchiveStorageId !== undefined
        ? ctx.storage.delete(schemaDoc.mapTileArchiveStorageId)
        : undefined,
    ]);

    // The whole dataset's entries/geometries are gone, so — unlike a single
    // entry delete — the exact reset (rather than only-grow) is safe here.
    // The tile archive goes with the data: its blob is deleted (nothing else
    // references a schema's own archive) and all five cache fields reset, so
    // a fresh import starts from a clean version-0 slate.
    await ctx.db.patch(args.schemaId, {
      boundingBox: undefined,
      entryCount: 0,
      featureCount: schemaDoc.kind === "geospatial" ? 0 : undefined,
      mapTileArchiveBuiltVersion: undefined,
      mapTileArchiveBytes: undefined,
      mapTileArchiveMaxZoom: undefined,
      mapTileArchiveStorageId: undefined,
      mapTileCacheVersion: undefined,
    });

    return entries.length;
  },
  returns: v.number(),
});

// Internal mutations for advanced use cases

export const insertEntryInternal = internalMutation({
  args: {
    data: v.any(),
    geometry: v.optional(v.string()),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const [entryId] = await insertEntryBatch(ctx, args.schemaId, schemaDoc, [
      { data: args.data, geometry: args.geometry },
    ]);

    return entryId;
  },
  returns: v.id("entries"),
});

export const patchEntryInternal = internalMutation({
  args: {
    data: v.any(),
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.entryId);
    await ctx.db.patch(args.entryId, { data: args.data });
    if (!existing) {
      return;
    }
    const schemaDoc = await ctx.db.get(existing.schemaId);
    if (schemaDoc) {
      await syncEntryReferences(ctx, args.entryId, existing.schemaId, schemaDoc, args.data);
    }
  },
});

export const deleteEntryInternal = internalMutation({
  args: {
    entryId: v.id("entries"),
  },
  handler: async (ctx, args) => {
    await deleteEntryCascading(ctx, args.entryId);
  },
});

/**
 * One-off maintenance for the denormalized summaries (issue #54): stamps
 * `entryCount` onto every dataset and `kind` onto every collection-membership
 * row that predates the fields. Idempotent — counts are recomputed from the
 * entries themselves, so re-running also repairs any drift (the incremental
 * maintainers keep it exact; this is the bootstrap/repair path).
 *
 * Bounds: membership rows are a small table, and per-dataset counting
 * iterates that dataset's entries via async iteration (never `.collect()` of
 * everything at once — but the whole mutation still reads every entry doc
 * once, so a dataset beyond Convex's ~16 MiB per-execution read budget would
 * need a sliced variant rather than this one).
 *
 * Public (not internal) so a host app can wrap it — component internals are
 * only reachable inside the component. Hosts should put their own auth gate
 * in front, as `app/convex/schemas.ts` does.
 */
export const backfillDatasetSummaries = mutation({
  args: {},
  handler: async (ctx) => {
    const stats = { membershipsPatched: 0, schemasPatched: 0 };

    const memberships = await ctx.db.query("schemaCollections").collect();
    await Promise.all(
      memberships.map(async (row) => {
        if (row.kind !== undefined) {
          return;
        }
        const schemaDoc = await ctx.db.get(row.schemaId);
        if (!schemaDoc) {
          return;
        }
        await ctx.db.patch(row._id, { kind: schemaDoc.kind ?? "standard" });
        stats.membershipsPatched += 1;
      }),
    );

    for await (const schemaDoc of ctx.db.query("schemas")) {
      let total = 0;
      for await (const _entry of ctx.db
        .query("entries")
        .withIndex("by_schema", (q) => q.eq("schemaId", schemaDoc._id))) {
        total += 1;
      }
      if (schemaDoc.entryCount !== total) {
        await ctx.db.patch(schemaDoc._id, { entryCount: total });
        stats.schemasPatched += 1;
      }
    }

    return stats;
  },
  returns: v.object({ membershipsPatched: v.number(), schemasPatched: v.number() }),
});

// ---------------------------------------------------------------------------
// Batched, monitored dataset import
//
// Convex COMPONENTS cannot use the Node.js runtime (`"use node"` is an
// app-layer-only capability — components must stay portable/sandboxable),
// so no step running inside this component can ever safely download +
// `JSON.parse` a multi-tens-of-MB upload in one shot (the default action
// runtime caps out around 64 MB). Rather than doing that parse on the
// server at all, the CLIENT — which already fully parses the entire file
// in the browser for schema inference/validation before it ever calls
// `startImport` — splits the row payload into several already-small chunks
// itself (see `chunkRowsForImport` in the `react` package) and uploads each
// to its own storage blob via repeated `generateUploadUrl` + `fetch` POSTs.
//
// `startImport` then just records the resulting list of chunk storage ids
// and kicks off a durable workflow that, for each one, runs
// `insertChunkFromStorage` — an action that downloads ONE already-small
// chunk (safe in the default runtime), validates + resolves each row's
// geometry (inline vs. file storage — see `geometry_storage.ts`), and
// inserts it. No step ever holds more than one chunk's worth of data, and
// no geometry's coordinate payload ever crosses a Convex value boundary (a
// mutation argument or a document field) as a nested array larger than
// Convex's 8192-elements-per-array limit — it's always JSON text.
//
// Trade-off versus a single-pass, whole-import validation: since chunks are
// inserted as their step runs (not validated-then-committed atomically
// across the whole import), a bad row in a later chunk can leave earlier
// chunks already committed. This matches the pre-existing behavior before
// this file's `geometryJson`/`geometryStorageId` rework and is an accepted,
// documented trade-off of components being unable to use Node.
// ---------------------------------------------------------------------------

const importValidator = schema.tables.imports.validator.extend({
  _creationTime: v.number(),
  _id: v.id("imports"),
});

/** Generate a short-lived URL the client POSTs one chunk of serialized rows to. Called once per chunk. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
  returns: v.string(),
});

/** Read the import status doc (client subscribes to this for progress). */
export const getImportStatus = query({
  args: { importId: v.id("imports") },
  handler: async (ctx, args) => ctx.db.get(args.importId),
  returns: v.union(importValidator, v.null()),
});

/**
 * Create the status doc and start the durable import workflow. `storageIds`
 * is the ordered list of already-small, client-uploaded chunk blobs (see the
 * doc comment above) — each one gets its own `insertChunkFromStorage` step.
 */
export const startImport = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    // The exact file this import came from, already uploaded by the client to
    // its own storage blob — retained on the schema doc so the original
    // (un-simplified) data stays re-downloadable even when geometry is being
    // simplified on write. Absent for imports that didn't provide one.
    sourceFile: v.optional(
      v.object({ name: v.string(), size: v.number(), storageId: v.id("_storage") }),
    ),
    schemaId: v.id("schemas"),
    storageIds: v.array(v.id("_storage")),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const targetSchema = await ctx.db.get(args.schemaId);
    if (!targetSchema) {
      throw new ConvexError("Schema not found");
    }
    // An import writes entries, so a bound dataset only accepts one from its
    // host's tag-ingest flow.
    assertDataWritable(targetSchema, args.boundWrite);

    if (args.sourceFile !== undefined) {
      await ctx.db.patch(args.schemaId, {
        sourceFileName: args.sourceFile.name,
        sourceFileStorageId: args.sourceFile.storageId,
        sourceFileSize: args.sourceFile.size,
      });
    }

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        storageIds: args.storageIds,
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.importWorkflow,
        {
          importId,
          schemaId: args.schemaId,
          storageIds: args.storageIds,
          total: args.total,
        },
        {
          // Carried through to `handleImportComplete` so a failed/canceled
          // import's not-yet-processed chunk blobs get cleaned up too (each
          // chunk deletes its own blob on success, inside the loop below).
          context: { importId, storageIds: args.storageIds },
          onComplete: internal.lib.handleImportComplete,
          startAsync: true,
        },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});

/**
 * Best-effort delete of a storage blob referenced by a plain string id (the
 * form workflow steps pass storage ids in — see `insertChunkFromStorage`).
 * Swallows "already gone" rather than failing an otherwise-successful import
 * over cleanup.
 */
async function tryDeleteStorage(ctx: MutationCtx, storageId: string): Promise<void> {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see callers for why storage ids travel as plain strings here.
    await ctx.storage.delete(storageId as Id<"_storage">);
  } catch {
    // Already deleted, or never existed — fine, this is best-effort cleanup.
  }
}

/**
 * Runs after the import workflow finishes. On success every chunk already
 * deleted its own blob as it was consumed; here we only need to record
 * failures/cancels, and best-effort delete any chunk blobs the workflow
 * never got to (a failed/canceled import may have stopped partway through
 * `storageIds`) — deleting an already-consumed blob is a harmless no-op
 * (see `tryDeleteStorage`).
 */
/** Unpacks the context the import workflow stored: the import row id and the chunk blob ids. */
function unpackImportContext(context: unknown): { importId: unknown; storageIds: unknown } {
  const isObject = context !== null && typeof context === "object";
  return {
    importId:
      isObject && "importId" in context ? (context as { importId?: unknown }).importId : undefined,
    storageIds:
      isObject && "storageIds" in context
        ? (context as { storageIds?: unknown }).storageIds
        : undefined,
  };
}

/** Best-effort delete any chunk blobs the workflow never got to (a failed/canceled import may have stopped partway through `storageIds`) — deleting an already-consumed blob is a harmless no-op (see `tryDeleteStorage`). */
async function deleteLeftoverChunks(ctx: MutationCtx, storageIds: unknown): Promise<void> {
  if (!Array.isArray(storageIds)) {
    return;
  }
  await Promise.all(
    storageIds.map(async (id: unknown) => {
      if (typeof id === "string") {
        await tryDeleteStorage(ctx, id);
      }
    }),
  );
}

export const handleImportComplete = internalMutation({
  args: {
    context: v.any(),
    result: v.any(),
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    const result = args.result,
      { importId, storageIds } = unpackImportContext(args.context);

    if (result && result.kind === "success") {
      return;
    }
    await deleteLeftoverChunks(ctx, storageIds);

    if (typeof importId !== "string") {
      return;
    }
    let error = "Import failed.";
    if (result && result.kind === "canceled") {
      error = "Import was canceled.";
    } else if (result && typeof result.error === "string") {
      error = result.error;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a string above; it's always the `Id<"imports">` `startImport` put into `context`.
    await ctx.db.patch(importId as Id<"imports">, { error, status: "failed" });
  },
});

/** Patch import progress/status. Called between workflow steps. */
export const updateImportProgress = internalMutation({
  args: {
    error: v.optional(v.string()),
    importId: v.id("imports"),
    processed: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.processed !== undefined) {
      patch.processed = args.processed;
    }
    if (args.status !== undefined) {
      patch.status = args.status;
    }
    if (args.error !== undefined) {
      patch.error = args.error;
    }
    await ctx.db.patch(args.importId, patch);
  },
});

/**
 * Validates one row's geometry (if any) against the schema's locked
 * `kind`/`geometryType`, and resolves it to inline-vs-storage form (see
 * `resolveGeometryStorage`). Shared by `insertChunkFromStorage`'s per-row
 * loop; extracted so that loop's own complexity stays manageable.
 */
async function resolveImportRowGeometry(
  ctx: { storage: { store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">> } },
  rowIndex: number,
  geometry: unknown,
  schemaDoc: {
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
  },
): Promise<ResolvedGeometry> {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError(`Row ${rowIndex}: cannot attach geometry to a standard dataset.`);
  }
  let geometryJson = JSON.stringify(geometry);
  let parsedGeometry: Geometry;
  try {
    parsedGeometry = parseAndValidateGeometry(geometryJson);
  } catch (err) {
    const message =
      err instanceof GeometryError || err instanceof GeoParseError
        ? err.message
        : "Invalid geometry.";
    throw new ConvexError(`Row ${rowIndex}: ${message}`);
  }
  if (!isGeometryCompatibleWithDatasetType(parsedGeometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Row ${rowIndex}: geometry type "${parsedGeometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  const simplified = simplifyGeometryPayload(parsedGeometry, geometryJson, schemaDoc);
  return resolveGeometryStorage(ctx, simplified.geometry, simplified.geometryJson);
}

/**
 * Reads ONE already-small, client-uploaded chunk blob (raw `{data,
 * geometry?}[]` rows — see the module doc comment above for why chunking
 * happens client-side), validates + resolves each row's geometry, and
 * inserts the batch. Runs entirely in Convex's default action runtime — a
 * chunk is small enough by construction (see `chunkRowsForImport`) that this
 * never needs Node. Deletes its own chunk blob once the insert succeeds.
 * Runs as a workflow step so a failed chunk is retried in isolation.
 * Returns the number of rows inserted.
 */
export const insertChunkFromStorage = internalAction({
  args: {
    schemaId: v.id("schemas"),
    // A `_storage` id — passed as a plain string because system-table ids can't
    // Be journaled/validated as `v.id("_storage")` through the workflow engine.
    storageId: v.string(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.runQuery(internal.lib.getSchemaInternal, {
      schemaId: args.schemaId,
    });
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- actions have no `normalizeId`; `storageId` is always a real `_storage` id, just untyped over the workflow boundary.
    const blob = await ctx.storage.get(args.storageId as Id<"_storage">);
    if (!blob) {
      throw new ConvexError("Import chunk not found in storage");
    }
    const parsed: unknown = JSON.parse(await blob.text()),
      rawRows = Array.isArray(parsed) ? parsed : [];

    const resolvedRows: Array<{ data: unknown; resolvedGeometry?: ResolvedGeometry }> = [];
    for (let i = 0; i < rawRows.length; i += 1) {
      const row = rawRows[i];
      if (typeof row !== "object" || row === null) {
        throw new ConvexError(`Row ${i} is not an object.`);
      }
      // The uploaded chunk is always `{ data, geometry? }[]` — validated below.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const { data, geometry } = row as { data: unknown; geometry?: unknown };
      if (geometry === undefined) {
        resolvedRows.push({ data });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- storage writes must land in row order; this loop is inherently sequential.
      const resolvedGeometry = await resolveImportRowGeometry(ctx, i, geometry, schemaDoc);
      resolvedRows.push({ data, resolvedGeometry });
    }

    if (resolvedRows.length > 0) {
      await ctx.runMutation(internal.lib.insertEntriesChunkInternal, {
        dataArray: resolvedRows,
        schemaId: args.schemaId,
      });
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await ctx.storage.delete(args.storageId as Id<"_storage">);
    return resolvedRows.length;
  },
  returns: v.number(),
});

/**
 * Insert one pre-resolved batch of entries in a single transaction. Each
 * row's geometry was already structurally validated and resolved (inline
 * vs. file storage) by `insertChunkFromStorage` — this only re-checks the
 * cheap dataset-type-compatibility rule before writing.
 */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    dataArray: v.array(
      v.object({ data: v.any(), resolvedGeometry: v.optional(resolvedGeometryValidator) }),
    ),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    await insertEntryBatch(
      ctx,
      args.schemaId,
      schemaDoc,
      args.dataArray.map((row) => ({
        data: row.data,
        geometry:
          row.resolvedGeometry === undefined ? undefined : asResolvedGeometry(row.resolvedGeometry),
      })),
    );
    return null;
  },
  returns: v.null(),
});

/** Durable workflow: insert each client-uploaded chunk in turn, updating progress as it goes. */
export const importWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
    storageIds: v.array(v.string()), // `_storage` ids as strings (see insertChunkFromStorage)
    total: v.number(),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0;
    // Chunks run sequentially so memory stays bounded and progress lands
    // incrementally; parallelizing the steps would defeat both.
    for (const storageId of args.storageIds) {
      // oxlint-disable-next-line no-await-in-loop
      const inserted = await step.runAction(internal.lib.insertChunkFromStorage, {
        schemaId: args.schemaId,
        storageId,
      });
      processed += inserted;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.lib.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

// ---------------------------------------------------------------------------
// Convert an already-imported "standard" dataset to geospatial in place,
// backfilling a Point geometry for every existing entry from two of its own
// data fields (e.g. "Latitude"/"Longitude" columns) — for a dataset like a
// TIGER export that already has coordinate columns but wasn't imported as
// GeoJSON. Reuses the same `imports` status doc / workflow-monitoring
// machinery as a fresh import (see the module doc comment above) so the
// client can show the same progress UI, even though no file upload is
// involved here — the coordinates already live in the entries' own `data`.
//
// A Point geometry's JSON text is always a few dozen bytes, nowhere near
// `INLINE_GEOMETRY_BYTE_LIMIT` — so unlike the general import path, this
// never needs file-storage fallback, which means every step here can be a
// plain mutation (no action needed just to reach `ctx.storage.store`).
// ---------------------------------------------------------------------------

const CONVERSION_BATCH_SIZE = 100; // Entries are thin (no geometry payload) — safe to read in one pass, unlike geometry pages which need the byte budget.

/** One `entries` row, as read directly off `ctx.db`. */
interface EntryDbRow {
  _creationTime: number;
  _id: Id<"entries">;
  data: unknown;
  geometryId?: Id<"geometries">;
  geometryType?: GeometryTypeArg;
  schemaId: Id<"schemas">;
}

/**
 * Manual cursor-based pagination over one schema's `entries` rows — the same
 * hand-rolled approach as `paginateGeometriesBySchema` (components can't call
 * `.paginate()`), sized for entries instead of geometries. `order` selects
 * oldest-first (the conversion workflow's resume order) or newest-first
 * (`listEntriesPage`, matching the pre-pagination table); the cursor is the
 * last-returned row's `_creationTime` either way, resumed against the same
 * index range's trailing sort key.
 */
async function paginateEntriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  cursor: string | null,
  limit: number,
  order: "asc" | "desc" = "asc",
): Promise<{ continueCursor: string; isDone: boolean; page: EntryDbRow[] }> {
  const atCreationTime = parseCreationTimeCursor(cursor);

  const page = await ctx.db
    .query("entries")
    .withIndex("by_schema", (q) => {
      if (atCreationTime === undefined) {
        return q.eq("schemaId", schemaId);
      }
      return order === "desc"
        ? q.eq("schemaId", schemaId).lt("_creationTime", atCreationTime)
        : q.eq("schemaId", schemaId).gt("_creationTime", atCreationTime);
    })
    .order(order)
    .take(limit);

  const lastRow = page[page.length - 1];
  return {
    continueCursor: lastRow === undefined ? (cursor ?? "") : String(lastRow._creationTime),
    isDone: page.length < limit,
    page,
  };
}

/**
 * Converts one page of a schema's entries: builds a Point geometry from
 * `data[latField]`/`data[lonField]` for each (via `extractPointGeometry`,
 * shared with the client-side coordinate-column picker), skipping any row
 * whose coordinates are missing/invalid rather than failing the whole batch
 * — a dataset backfilled this way commonly has some ungeocodable rows.
 * Reuses `replaceEntryGeometry` per row so `featureCount`/`boundingBox` stay
 * correct; re-reads the schema doc each time since it's patched every
 * iteration this same execution (reads see this transaction's own writes).
 */
export const convertEntriesBatchInternal = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await paginateEntriesBySchema(
      ctx,
      args.schemaId,
      args.cursor,
      CONVERSION_BATCH_SIZE,
    );

    let geocoded = 0;
    for (const entry of page) {
      const point = extractPointGeometry(entry.data, args.latField, args.lonField);
      if (point === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each iteration depends on the previous one's featureCount/boundingBox patch.
      const schemaDoc = await ctx.db.get(args.schemaId);
      if (!schemaDoc) {
        throw new ConvexError("Schema not found");
      }
      const simplifiedPoint = simplifyGeometryPayload(point, JSON.stringify(point), schemaDoc),
        resolved = inlineGeometryFieldsOrThrow(
          simplifiedPoint.geometryJson,
          simplifiedPoint.geometry,
        );
      // oxlint-disable-next-line no-await-in-loop
      await replaceEntryGeometry(ctx, entry, schemaDoc, resolved);
      geocoded += 1;
    }

    return { continueCursor, examined: page.length, geocoded, isDone };
  },
  returns: v.object({
    continueCursor: v.string(),
    examined: v.number(),
    geocoded: v.number(),
    isDone: v.boolean(),
  }),
});

/** Durable workflow: convert a standard dataset's entries page by page, updating progress as it goes. */
export const geospatialConversionWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0,
      cursor: string | null = null,
      isDone = false;
    // Sequential for the same reason `importWorkflow` is: memory stays
    // bounded and progress lands incrementally as each page completes.
    while (!isDone) {
      // Explicitly typed (rather than inferred from the call) to avoid a
      // circular type reference: `internal.lib` is typed from this same
      // module, and `geospatialConversionWorkflow` — currently being
      // type-checked — is one of its exports.
      const result: {
        continueCursor: string;
        examined: number;
        geocoded: number;
        isDone: boolean;
      } =
        // oxlint-disable-next-line no-await-in-loop
        await step.runMutation(internal.lib.convertEntriesBatchInternal, {
          cursor,
          latField: args.latField,
          lonField: args.lonField,
          schemaId: args.schemaId,
        });
      processed += result.examined;
      cursor = result.continueCursor;
      isDone = result.isDone;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.lib.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

/** The property names declared on a schema doc's JSON Schema, or `{}` if it's malformed/propertyless. */
function schemaPropertyNames(schemaDoc: { schema: unknown }): Record<string, unknown> {
  const { schema: jsonSchema } = schemaDoc;
  if (
    jsonSchema &&
    typeof jsonSchema === "object" &&
    "properties" in jsonSchema &&
    typeof jsonSchema.properties === "object" &&
    jsonSchema.properties !== null
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the `typeof === "object"` check above; a JSON Schema's `properties` is always a plain object.
    return jsonSchema.properties as Record<string, unknown>;
  }
  return {};
}

/** Throws unless `latField`/`lonField` are a usable, distinct pair of this schema's own properties. */
function assertConversionFieldsValid(
  schemaDoc: { kind?: "standard" | "geospatial"; schema: unknown },
  latField: string,
  lonField: string,
): void {
  if (schemaDoc.kind === "geospatial") {
    throw new ConvexError("This dataset is already geospatial.");
  }
  if (!latField.trim() || !lonField.trim()) {
    throw new ConvexError("Choose latitude and longitude columns.");
  }
  if (latField === lonField) {
    throw new ConvexError("Latitude and longitude must be different columns.");
  }
  const properties = schemaPropertyNames(schemaDoc);
  if (!(latField in properties) || !(lonField in properties)) {
    throw new ConvexError("Latitude/longitude fields must be properties of this dataset's schema.");
  }
}

/**
 * Flips a "standard" dataset to "geospatial" (locked to Point) and starts a
 * durable workflow that backfills a Point geometry for every existing entry
 * from its own `latField`/`lonField` data columns. The schema's `kind`
 * changes immediately (so the map tab/entry form appear right away); entries
 * without valid coordinates in those columns are simply left without
 * geometry, same as any other geometry-less row.
 */
export const startGeospatialConversion = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    // Conversion rewrites every entry's geometry payload, so it is a data
    // mutation even though it shares the organization ops' operation shape in
    // exposeApi — component-level enforcement is what blocks it on bound
    // datasets (docs/bound-datasets-design.md §9, phase 1 remainder).
    boundWrite: boundWriteValidator,
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);
    assertConversionFieldsValid(schemaDoc, args.latField, args.lonField);

    await ctx.db.patch(args.schemaId, {
      boundingBox: undefined,
      featureCount: 0,
      geometryType: "Point",
      kind: "geospatial",
    });
    // Membership rows cache `kind` (see `schemaCollections` in schema.ts) —
    // rewrite this dataset's rows in the same transaction so collection
    // views see the flip immediately.
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    await Promise.all(
      memberships.map(async (row) => {
        if (row.kind !== "geospatial") {
          await ctx.db.patch(row._id, { kind: "geospatial" });
        }
      }),
    );

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.geospatialConversionWorkflow,
        { importId, latField: args.latField, lonField: args.lonField, schemaId: args.schemaId },
        { context: { importId }, onComplete: internal.lib.handleImportComplete, startAsync: true },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});

// ---------------------------------------------------------------------------
// Simplify an existing geospatial dataset's geometries: round every stored
// coordinate payload to GEOMETRY_SIMPLIFY_DECIMAL_PLACES. Launched from the
// dataset page's action menu (the importer's "Simplify geometry" checkbox
// covers new datasets at creation; existing data is deliberately NOT migrated
// automatically). Reuses the `imports` status doc + progress/completion
// machinery (`updateImportProgress`/`handleImportComplete`) so the UI can
// monitor it exactly like an import or geospatial conversion.
//
// The batch step must be an action (not a mutation) because storage-backed
// geometries' payloads are only readable via `ctx.storage.get`. Each batch
// is one durable workflow step; rounding is idempotent, so a retried step
// that already wrote some rows before failing simply re-rounds them.
//
// Like the import path, each row's post-rounding storage form is re-decided
// (rounding only ever shrinks a payload, so a row can move from a storage
// blob back inline, never the reverse) and the replaced blob is deleted.
// ---------------------------------------------------------------------------

/**
 * One batch of a dataset's geometry rows as the simplify action needs them:
 * pointers plus payload (inline text here, or the action reads the blob
 * itself). Paged through `paginateGeometriesBySchema`'s shared cursor — the
 * cursor is `_creationTime`, which a patch never changes, so rows rewritten
 * by earlier batches are never revisited.
 */
export const listSimplifyBatchInternal = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const result = await paginateGeometriesBySchema(ctx, args.schemaId, {
      cursor: args.cursor,
      numItems: args.numItems,
    });
    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      page: result.page.map((row) => ({
        geometryJson: row.geometryJson,
        geometryStorageId: row.geometryStorageId,
        id: row._id,
      })),
    };
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    page: v.array(
      v.object({
        geometryJson: v.optional(v.string()),
        geometryStorageId: v.optional(v.id("_storage")),
        id: v.id("geometries"),
      }),
    ),
  }),
});

/** Writes one batch of already-rounded payloads back onto their `geometries` rows, clearing whichever storage form each row no longer uses and deleting the blob it replaced. */
export const applySimplifiedGeometriesInternal = internalMutation({
  args: {
    updates: v.array(
      v.object({
        bbox: v.optional(v.array(v.number())),
        geometryJson: v.optional(v.string()),
        geometryStorageId: v.optional(v.id("_storage")),
        id: v.id("geometries"),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let touchedSchemaId: Id<"schemas"> | undefined;
    for (const update of args.updates) {
      // oxlint-disable-next-line no-await-in-loop -- the batch is one transaction; row writes land in order under its write budget.
      const existing = await ctx.db.get(update.id);
      if (existing === null) {
        continue; // Deleted (or its whole dataset went) mid-run — nothing to round.
      }
      touchedSchemaId ??= existing.schemaId;
      // The row's old blob is always superseded by this write: either the
      // rounded payload moved back inline, or it was re-stored as a NEW blob
      // (storage blobs are immutable), so the old one is unreferenced now.
      // oxlint-disable-next-line no-await-in-loop
      await deleteGeometryStorageIfAny(ctx, existing);
      // oxlint-disable-next-line no-await-in-loop
      await ctx.db.patch(update.id, {
        bbox: update.bbox,
        geometry: undefined,
        geometryJson: update.geometryJson,
        geometryStorageId: update.geometryStorageId,
      });
    }
    // One bump per batch write, not per row — the batch is one transaction,
    // so consumers only need to know the data changed at all (and the
    // simplify workflow's batches land back-to-back; per-row bumps would
    // just inflate the counter meaninglessly). Read fresh: earlier batches
    // in the same workflow already bumped this same doc.
    if (touchedSchemaId !== undefined) {
      const schemaDoc = await ctx.db.get(touchedSchemaId);
      if (schemaDoc) {
        await bumpMapTileCacheVersion(ctx, touchedSchemaId, schemaDoc);
      }
    }
    return null;
  },
  returns: v.null(),
});

// Rows per simplify batch: the same ceiling `listGeometries` honors — the
// shared paginator's byte budget (not this number) is what actually bounds
// how much payload one batch reads (each row's payload can be up to
// INLINE_GEOMETRY_BYTE_LIMIT).
const SIMPLIFY_BATCH_ROWS = MAX_GEOMETRY_PAGE_ROWS,
  // Payload bytes handed to `applySimplifiedGeometriesInternal` per call —
  // matched to the bulk import path, whose 4 MB chunk-per-mutation precedent
  // is proven against Convex's per-transaction write budget.
  SIMPLIFY_WRITE_CHUNK_BYTES = 4_000_000;

/**
 * Rounds ONE batch of the schema's geometry payloads and writes them back.
 * Runs as a workflow step (see the module comment above for why an action is
 * required). Malformed payloads — which current write paths never produce —
 * are skipped rather than failing the batch. Returns how many rows were
 * rewritten (for progress) plus the pagination cursor.
 */
export const simplifyGeometryBatchInternal = internalAction({
  args: {
    cursor: v.union(v.string(), v.null()),
    schemaId: v.id("schemas"),
  },
  // Explicit return type — the inferred one would flow back through this
  // handler's own `internal.lib` references and circularly reference the
  // export being defined (same reason `geospatialConversionWorkflow` types
  // its step result explicitly).
  handler: async (
    ctx,
    args,
  ): Promise<{ continueCursor: string; isDone: boolean; simplified: number }> => {
    const { continueCursor, isDone, page } = await ctx.runQuery(
      internal.lib.listSimplifyBatchInternal,
      {
        cursor: args.cursor,
        numItems: SIMPLIFY_BATCH_ROWS,
        schemaId: args.schemaId,
      },
    );

    let simplified = 0,
      pendingBytes = 0;
    const pending: Array<{
      bbox?: number[];
      geometryJson?: string;
      geometryStorageId?: Id<"_storage">;
      id: Id<"geometries">;
    }> = [];
    // Flushes `pending` to the write mutation, chunked by payload bytes so a
    // full batch of near-limit geometries never exceeds the per-transaction
    // write budget the import path has already proven (see
    // SIMPLIFY_WRITE_CHUNK_BYTES).
    const flush = async () => {
      if (pending.length === 0) {
        return;
      }
      await ctx.runMutation(internal.lib.applySimplifiedGeometriesInternal, {
        updates: pending.splice(0),
      });
      pendingBytes = 0;
    };

    for (const row of page) {
      try {
        let raw: string;
        if (row.geometryJson !== undefined) {
          raw = row.geometryJson;
        } else {
          // oxlint-disable-next-line no-await-in-loop -- per-row payload reads; the batch is bounded by the shared paginator's byte budget.
          const blob =
            row.geometryStorageId !== undefined
              ? // oxlint-disable-next-line no-await-in-loop
                await ctx.storage.get(row.geometryStorageId)
              : null;
          if (blob === null) {
            throw new Error("Geometry payload blob is missing.");
          }
          // oxlint-disable-next-line no-await-in-loop
          raw = await blob.text();
        }
        const parsedGeometry = parseAndValidateGeometry(raw);
        // oxlint-disable-next-line no-await-in-loop -- storage-form resolution writes per row, chunked into the pending flush below.
        const rounded = roundGeometryCoordinates(parsedGeometry, GEOMETRY_SIMPLIFY_DECIMAL_PLACES),
          roundedJson = JSON.stringify(rounded);
        // oxlint-disable-next-line no-await-in-loop
        const resolved = await resolveGeometryStorage(ctx, rounded, roundedJson);
        // `resolved` also carries `type` (unchanged by rounding) — only the
        // fields this write actually touches travel to the mutation.
        pending.push({
          bbox: resolved.bbox,
          geometryJson: resolved.geometryJson,
          geometryStorageId: resolved.geometryStorageId,
          id: row.id,
        });
        pendingBytes += byteLength(roundedJson);
        simplified += 1;
      } catch {
        // Unreadable/unparseable payload — leave the row as-is and keep the
        // batch moving; everything else still simplifies.
      }
      if (pendingBytes >= SIMPLIFY_WRITE_CHUNK_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- chunked writes must land in payload order; inherently sequential.
        await flush();
      }
    }
    await flush();

    return { continueCursor, isDone, simplified };
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    simplified: v.number(),
  }),
});

/** Durable workflow: round a dataset's geometry payloads batch by batch, updating progress as it goes. */
export const simplifyGeometryWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0,
      cursor: string | null = null,
      isDone = false;
    // Sequential for the same reason `importWorkflow` is: memory stays
    // bounded and progress lands incrementally as each batch completes.
    while (!isDone) {
      // Explicitly typed to avoid a circular type reference — see the same
      // pattern in `geospatialConversionWorkflow` above.
      const result: { continueCursor: string; isDone: boolean; simplified: number } =
        // oxlint-disable-next-line no-await-in-loop
        await step.runAction(internal.lib.simplifyGeometryBatchInternal, {
          cursor,
          schemaId: args.schemaId,
        });
      processed += result.simplified;
      cursor = result.continueCursor;
      isDone = result.isDone;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.lib.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    await step.runMutation(internal.lib.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

/**
 * Rounds every stored geometry payload of a geospatial dataset to
 * GEOMETRY_SIMPLIFY_DECIMAL_PLACES via `simplifyGeometryWorkflow`, and flips
 * the dataset's `simplifyGeometry` flag so all future writes match. Reuses
 * the `imports` status doc (see the module comment above) — the returned id
 * feeds `getImportStatus` for live progress.
 */
export const startSimplification = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    // Simplification rewrites every stored geometry payload, so it is a data
    // mutation even though it shares the organization ops' operation shape in
    // exposeApi — component-level enforcement is what blocks it on bound
    // datasets (docs/bound-datasets-design.md §9, phase 1 remainder).
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);
    if (schemaDoc.kind !== "geospatial") {
      throw new ConvexError("Only a geospatial dataset can simplify geometry.");
    }

    // Future writes (entry creates/updates, imports) simplify from now on,
    // matching the data this run is about to normalize.
    await ctx.db.patch(args.schemaId, { simplifyGeometry: true });

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.lib.simplifyGeometryWorkflow,
        { importId, schemaId: args.schemaId },
        { context: { importId }, onComplete: internal.lib.handleImportComplete, startAsync: true },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});
