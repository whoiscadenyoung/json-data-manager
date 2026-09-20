import { mutationGeneric, paginationOptsValidator, queryGeneric } from "convex/server";
import type { Auth } from "convex/server";
import { v } from "convex/values";

import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";

/**
 * Branded ID types for the component's tables, re-exported for consumers.
 *
 * Because the component owns the `schemas`, `entries`, and `geometries`
 * tables (not the host app), consuming apps don't get `Id<"schemas">` /
 * `Id<"entries">` / `Id<"geometries">` from their own generated `dataModel`.
 * Import these instead.
 */
export type SchemaId = Id<"schemas">;
export type EntryId = Id<"entries">;
export type GeometryId = Id<"geometries">;
export type CollectionId = Id<"collections">;
export type GroupId = Id<"groups">;

// See the example/convex/example.ts file for how to use this component.

/**
 * For re-exporting of an API accessible from React clients.
 * This exposes the full JSON CMS API with authentication.
 *
 * Example usage:
 * ```ts
 * export const {
 *   listSchemas,
 *   listSchemaSummaries,
 *   getSchema,
 *   createSchema,
 *   updateSchema,
 *   deleteSchema,
 *   listEntries,
 *   getEntry,
 *   listEntriesForSchemas,
 *   listReferencingEntries,
 *   listGeometries,
 *   createEntry,
 *   createEntriesBulk,
 *   updateEntry,
 *   deleteEntry,
 *   deleteEntriesBySchema,
 *   listCollections,
 *   getCollection,
 *   createCollection,
 *   updateCollection,
 *   deleteCollection,
 *   listGroups,
 *   getGroup,
 *   createGroup,
 *   updateGroup,
 *   deleteGroup,
 *   listSchemasByCollection,
 *   listEntriesByCollection,
 *   listSchemaCollections,
 *   listCollectionsBySchema,
 *   addSchemaToCollection,
 *   removeSchemaFromCollection,
 *   setSchemaGroup,
 *   setGroupCollection,
 *   listMaps,
 *   getMap,
 *   createMap,
 *   updateMap,
 *   deleteMap,
 *   listMapLayers,
 *   addMapLayer,
 *   removeMapLayer,
 *   setMapLayerVisibility,
 *   moveMapLayer,
 * } = exposeApi(components.jsonCms, {
 *   auth: async (ctx, operation) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (!userId) throw new Error("Unauthorized");
 *     return userId;
 *   },
 * });
 * ```
 */
export function exposeApi(
  component: ComponentApi,
  options: {
    /**
     * It's very important to authenticate any functions that users will export.
     * This function should return the authorized user's ID.
     * For read operations, you may want to allow anonymous access.
     */
    auth: (
      ctx: { auth: Auth },
      operation:
        | {
            type: "read";
            schemaId?: string;
            entryId?: string;
            collectionId?: string;
            groupId?: string;
            mapId?: string;
          }
        | {
            type: "create";
            schemaId?: string;
            collectionId?: string;
            groupId?: string;
            mapId?: string;
          }
        | {
            type: "update";
            schemaId?: string;
            entryId?: string;
            collectionId?: string;
            groupId?: string;
            mapId?: string;
          }
        | {
            type: "delete";
            schemaId?: string;
            entryId?: string;
            collectionId?: string;
            groupId?: string;
            mapId?: string;
          },
    ) => Promise<string>;
  },
) {
  // Note: id arguments are validated as `v.string()`, not `v.id(...)`.
  // These ids reference the component's own tables, which do not exist in
  // The host app's schema, so `v.id("schemas")`/`v.id("entries")` would be
  // Rejected by the host deployment. The component's `lib` functions
  // Re-validate them as real ids internally.
  return {
    // Schema operations
    listSchemas: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listSchemas, {});
      },
    }),
    // List-page projection — no `schema`/`uiSchema` payloads (issue #53).
    // Structure/editor surfaces keep using `getSchema`.
    listSchemaSummaries: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listSchemaSummaries, {});
      },
    }),
    getSchema: queryGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.getSchema, {
          schemaId: args.schemaId,
        });
      },
    }),
    createSchema: mutationGeneric({
      args: {
        geometryType: v.optional(
          v.union(
            v.literal("Point"),
            v.literal("MultiPoint"),
            v.literal("LineString"),
            v.literal("MultiLineString"),
            v.literal("Polygon"),
            v.literal("MultiPolygon"),
          ),
        ),
        kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
        schema: v.any(),
        simplifyGeometry: v.optional(v.boolean()),
        uiSchema: v.optional(v.any()),
        // Deliberately NO `source`/`lineage` here: the read-only markers are
        // host-flow-only (set by the host's sync/tag-ingest code invoking the
        // component directly). Convex validators are exact, so clients can't
        // smuggle them in — see `assertDataWritable` in the component.
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create" });
        return ctx.runMutation(component.lib.createSchema, {
          geometryType: args.geometryType,
          kind: args.kind,
          schema: args.schema,
          simplifyGeometry: args.simplifyGeometry,
          uiSchema: args.uiSchema,
        });
      },
    }),
    updateSchema: mutationGeneric({
      args: {
        description: v.optional(v.string()),
        schema: v.optional(v.any()),
        schemaId: v.string(),
        title: v.optional(v.string()),
        uiSchema: v.optional(v.any()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.updateSchema, args);
      },
    }),
    deleteSchema: mutationGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "delete" });
        return ctx.runMutation(component.lib.deleteSchema, args);
      },
    }),

    // Collection operations
    listCollections: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listCollections, {});
      },
    }),
    getCollection: queryGeneric({
      args: { collectionId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "read" });
        return ctx.runQuery(component.lib.getCollection, {
          collectionId: args.collectionId,
        });
      },
    }),
    createCollection: mutationGeneric({
      args: { description: v.optional(v.string()), name: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create" });
        return ctx.runMutation(component.lib.createCollection, args);
      },
    }),
    updateCollection: mutationGeneric({
      args: {
        collectionId: v.string(),
        description: v.optional(v.string()),
        name: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "update" });
        return ctx.runMutation(component.lib.updateCollection, args);
      },
    }),
    deleteCollection: mutationGeneric({
      args: { collectionId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "delete" });
        return ctx.runMutation(component.lib.deleteCollection, args);
      },
    }),

    // Group operations
    listGroups: queryGeneric({
      args: { collectionId: v.optional(v.string()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, {
          collectionId: args.collectionId,
          type: "read",
        });
        return ctx.runQuery(component.lib.listGroups, {
          collectionId: args.collectionId,
        });
      },
    }),
    getGroup: queryGeneric({
      args: { groupId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { groupId: args.groupId, type: "read" });
        return ctx.runQuery(component.lib.getGroup, { groupId: args.groupId });
      },
    }),
    createGroup: mutationGeneric({
      args: {
        collectionId: v.optional(v.string()),
        description: v.optional(v.string()),
        name: v.string(),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "create" });
        return ctx.runMutation(component.lib.createGroup, args);
      },
    }),
    updateGroup: mutationGeneric({
      args: {
        description: v.optional(v.string()),
        groupId: v.string(),
        name: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { groupId: args.groupId, type: "update" });
        return ctx.runMutation(component.lib.updateGroup, args);
      },
    }),
    deleteGroup: mutationGeneric({
      args: { groupId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { groupId: args.groupId, type: "delete" });
        return ctx.runMutation(component.lib.deleteGroup, args);
      },
    }),

    // Dataset <-> collection/group association. Collections are many-to-many
    // (a dataset can sit in any number of them, via the `schemaCollections`
    // join table); a dataset has at most one group. The two relationships are
    // independent.
    listSchemasByCollection: queryGeneric({
      args: { collectionId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "read" });
        return ctx.runQuery(component.lib.listSchemasByCollection, {
          collectionId: args.collectionId,
        });
      },
    }),
    // NOTE: there is deliberately no `listGeometriesByCollection` here.
    // Convex allows at most one `.paginate()` call per query execution, and
    // a collection's geometries are spread across several independently
    // indexed schemas — aggregating them server-side in one paginated query
    // isn't possible without a denormalized `collectionId` on every
    // `geometries` row (an expensive cascading update on every schema
    // re-org). Powering the collection-level map view is instead the
    // caller's job: fetch the collection's geospatial schema ids (already
    // available from `listSchemasByCollection`) and call the paginated
    // `listGeometries` once per schema, merging client-side — see
    // `useAllPaginated` in the `react` package.
    listEntriesByCollection: queryGeneric({
      args: { collectionId: v.string(), limit: v.optional(v.number()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "read" });
        return ctx.runQuery(component.lib.listEntriesByCollection, {
          collectionId: args.collectionId,
          limit: args.limit,
        });
      },
    }),
    // Every `{dataset, collection}` membership row — lets clients count or
    // filter memberships without one query per collection.
    listSchemaCollections: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listSchemaCollections, {});
      },
    }),
    // The collections a dataset currently belongs to.
    listCollectionsBySchema: queryGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.listCollectionsBySchema, {
          schemaId: args.schemaId,
        });
      },
    }),
    // Adds a dataset to a collection (a no-op if already a member).
    addSchemaToCollection: mutationGeneric({
      args: { collectionId: v.string(), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.addSchemaToCollection, args);
      },
    }),
    // Removes one of a dataset's collection memberships — its other
    // memberships and its group are untouched.
    removeSchemaFromCollection: mutationGeneric({
      args: { collectionId: v.string(), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.removeSchemaFromCollection, args);
      },
    }),
    setSchemaGroup: mutationGeneric({
      args: { groupId: v.union(v.string(), v.null()), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.setSchemaGroup, args);
      },
    }),
    // Sets (or clears, via `null`) which collection a group lives in —
    // "adding" a group to a collection as a single unit (a group lives in at
    // most one collection). Mirrors setSchemaGroup.
    setGroupCollection: mutationGeneric({
      args: { collectionId: v.union(v.string(), v.null()), groupId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { groupId: args.groupId, type: "update" });
        return ctx.runMutation(component.lib.setGroupCollection, args);
      },
    }),

    // Map operations — a saved arrangement of layers (collections, groups,
    // or datasets) rendered together on one map. Layer mutations carry
    // `mapId` for auth and travel as plain strings, re-validated inside the
    // component (see the id-validation note above).
    listMaps: queryGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listMaps, {});
      },
    }),
    getMap: queryGeneric({
      args: { mapId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "read" });
        return ctx.runQuery(component.lib.getMap, { mapId: args.mapId });
      },
    }),
    createMap: mutationGeneric({
      args: { description: v.optional(v.string()), name: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create" });
        return ctx.runMutation(component.lib.createMap, args);
      },
    }),
    updateMap: mutationGeneric({
      args: {
        description: v.optional(v.string()),
        mapId: v.string(),
        name: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "update" });
        return ctx.runMutation(component.lib.updateMap, args);
      },
    }),
    deleteMap: mutationGeneric({
      args: { mapId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "delete" });
        return ctx.runMutation(component.lib.deleteMap, args);
      },
    }),
    // A map's layers in draw order; every layer across all maps when `mapId`
    // is omitted (one query lets a client count layers per map).
    listMapLayers: queryGeneric({
      args: { mapId: v.optional(v.string()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "read" });
        return ctx.runQuery(component.lib.listMapLayers, { mapId: args.mapId });
      },
    }),
    // Appends a layer (a no-op when the target is already a layer of the map).
    addMapLayer: mutationGeneric({
      args: {
        mapId: v.string(),
        targetId: v.string(),
        targetType: v.union(v.literal("collection"), v.literal("group"), v.literal("dataset")),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "update" });
        return ctx.runMutation(component.lib.addMapLayer, args);
      },
    }),
    removeMapLayer: mutationGeneric({
      args: { layerId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update" });
        return ctx.runMutation(component.lib.removeMapLayer, args);
      },
    }),
    setMapLayerVisibility: mutationGeneric({
      args: { layerId: v.string(), visible: v.boolean() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update" });
        return ctx.runMutation(component.lib.setMapLayerVisibility, args);
      },
    }),
    // Swaps a layer with its neighbor in draw order.
    moveMapLayer: mutationGeneric({
      args: { direction: v.union(v.literal("up"), v.literal("down")), layerId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update" });
        return ctx.runMutation(component.lib.moveMapLayer, args);
      },
    }),
    // Every layer's per-child visibility overrides in one query (only
    // explicitly-toggled children have rows — clients match them against the
    // layers' live children and ignore stale ones).
    listMapLayerOverrides: queryGeneric({
      args: { mapId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { mapId: args.mapId, type: "read" });
        return ctx.runQuery(component.lib.listMapLayerOverridesForMap, {
          mapId: args.mapId,
        });
      },
    }),
    // Sets (or clears, via `visible: undefined`) a child's visibility
    // override within one layer. `childKey` is `group:<id>`/`dataset:<id>`.
    setMapLayerOverride: mutationGeneric({
      args: {
        childKey: v.string(),
        layerId: v.string(),
        visible: v.optional(v.boolean()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "update" });
        return ctx.runMutation(component.lib.setMapLayerOverride, args);
      },
    }),

    // Entry operations
    listEntries: queryGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.listEntries, {
          schemaId: args.schemaId,
        });
      },
    }),
    // Server-side paginated view of one dataset's entries (issue #54) — the
    // entries-table counterpart of `listGeometries`. Prefer this over
    // `listEntries` for anything rendered per page: it keeps every query
    // execution bounded no matter how big the dataset grows.
    listEntriesPage: queryGeneric({
      args: { paginationOpts: paginationOptsValidator, schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.listEntriesPage, {
          paginationOpts: args.paginationOpts,
          schemaId: args.schemaId,
        });
      },
    }),
    // Entries by id — the reference-field label lookup (issue #54): fetch
    // exactly the entries some loaded rows reference instead of every row of
    // every referenced dataset.
    listEntriesForIds: queryGeneric({
      args: { entryIds: v.array(v.string()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listEntriesForIds, {
          entryIds: args.entryIds,
        });
      },
    }),
    getEntry: queryGeneric({
      args: { entryId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { entryId: args.entryId, type: "read" });
        return ctx.runQuery(component.lib.getEntry, {
          entryId: args.entryId,
        });
      },
    }),
    // Entries from several datasets at once — e.g. building a reference
    // field's candidate picker without one round trip per dataset. `limit`
    // optionally caps rows taken per dataset (issue #54).
    listEntriesForSchemas: queryGeneric({
      args: { limit: v.optional(v.number()), schemaIds: v.array(v.string()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listEntriesForSchemas, {
          limit: args.limit,
          schemaIds: args.schemaIds,
        });
      },
    }),
    // Reverse lookup: every other dataset's entry that currently references
    // `entryId` via a foreign-reference field.
    listReferencingEntries: queryGeneric({
      args: { entryId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { entryId: args.entryId, type: "read" });
        return ctx.runQuery(component.lib.listReferencingEntries, {
          entryId: args.entryId,
        });
      },
    }),
    // The only read path that pulls full geometry coordinates — reserved for
    // map rendering. `listEntries` never touches this table.
    // Paginated — a dataset's geometry rows can cumulatively exceed Convex's
    // per-execution read budget even though each individual row is safely
    // under its own document-size limit. Use `useAllPaginated` (in
    // the `react` package) to fetch every page.
    listGeometries: queryGeneric({
      args: { paginationOpts: paginationOptsValidator, schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.listGeometries, {
          paginationOpts: args.paginationOpts,
          schemaId: args.schemaId,
        });
      },
    }),
    // The single geometry attached to one entry — for entry-level views that
    // shouldn't drag in the whole dataset's paginated geometry set.
    getEntryGeometry: queryGeneric({
      args: { entryId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { entryId: args.entryId, type: "read" });
        return ctx.runQuery(component.lib.getEntryGeometry, {
          entryId: args.entryId,
        });
      },
    }),
    // The dataset's tile-archive rendering cache metadata — `{storageId,
    // version, bytes, maxZoom, url}`, or `null` when no current archive is
    // installed (read the row-based path instead). `version` is what
    // clients compare against the schema's `mapTileCacheVersion` to decide
    // staleness; installing archives happens server-side (the rebuild
    // worker), so there is deliberately no client-facing install mutation.
    getMapTileArchiveMeta: queryGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.getMapTileArchiveMeta, {
          schemaId: args.schemaId,
        });
      },
    }),
    // `geometry` travels as a JSON *string*, not the nested-array `Geometry`
    // shape — see `geometry_storage.ts` in the component for why (Convex's
    // 8192-elements-per-array limit, which real-world GIS rings routinely
    // exceed; a string has no such limit).
    //
    // Every mutation below (and `startSimplification`/`startGeospatialConversion`
    // further down) deliberately omits the component's `boundWrite`
    // attestation: it is host-flow-only, and its absence here is what makes
    // the component's bound-dataset read-only enforcement hold no matter
    // which wrapper a client calls through. Never add it to these args.
    createEntry: mutationGeneric({
      args: { data: v.any(), geometry: v.optional(v.string()), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "create" });
        return ctx.runMutation(component.lib.createEntry, args);
      },
    }),
    createEntriesBulk: mutationGeneric({
      args: {
        entries: v.array(v.object({ data: v.any(), geometry: v.optional(v.string()) })),
        schemaId: v.string(),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "create" });
        return ctx.runMutation(component.lib.createEntriesBulk, args);
      },
    }),
    updateEntry: mutationGeneric({
      args: {
        data: v.any(),
        entryId: v.string(),
        geometry: v.optional(v.union(v.string(), v.null())),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { entryId: args.entryId, type: "update" });
        return ctx.runMutation(component.lib.updateEntry, args);
      },
    }),
    deleteEntry: mutationGeneric({
      args: { entryId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { entryId: args.entryId, type: "delete" });
        return ctx.runMutation(component.lib.deleteEntry, args);
      },
    }),
    deleteEntriesBySchema: mutationGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "delete" });
        return ctx.runMutation(component.lib.deleteEntriesBySchema, args);
      },
    }),

    // Batched dataset import operations
    generateImportUploadUrl: mutationGeneric({
      args: {},
      handler: async (ctx) => {
        await options.auth(ctx, { type: "create" });
        return ctx.runMutation(component.lib.generateUploadUrl, {});
      },
    }),
    startImport: mutationGeneric({
      args: {
        // The original uploaded file, retained on the dataset so the
        // un-simplified source stays re-downloadable after geometry
        // simplification. Already uploaded by the client to its own blob.
        sourceFile: v.optional(
          v.object({ name: v.string(), size: v.number(), storageId: v.string() }),
        ),
        schemaId: v.string(),
        // One already-small, client-uploaded chunk blob per entry — see
        // `chunkRowsForImport` in the `react` package for why chunking
        // happens client-side (Convex components can't use the Node
        // runtime, so no server-side step can safely parse one giant upload).
        storageIds: v.array(v.string()),
        total: v.number(),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "create" });
        return ctx.runMutation(component.lib.startImport, {
          sourceFile: args.sourceFile,
          schemaId: args.schemaId,
          storageIds: args.storageIds,
          total: args.total,
        });
      },
    }),
    getImportStatus: queryGeneric({
      args: { importId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.getImportStatus, {
          importId: args.importId,
        });
      },
    }),

    // Re-download the exact file a dataset was imported from (see
    // `startImport`'s `sourceFile`). `null` when the dataset has no retained
    // source file.
    getSourceFileUrl: queryGeneric({
      args: { schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "read" });
        return ctx.runQuery(component.lib.getSourceFileUrl, { schemaId: args.schemaId });
      },
    }),

    // Round an existing geospatial dataset's stored geometry payloads to
    // GEOMETRY_SIMPLIFY_DECIMAL_PLACES via a durable workflow, and flip the
    // dataset's `simplifyGeometry` flag so future writes match. Reuses the
    // `imports` status doc — poll with `getImportStatus`.
    startSimplification: mutationGeneric({
      args: { schemaId: v.string(), total: v.number() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.startSimplification, {
          schemaId: args.schemaId,
          total: args.total,
        });
      },
    }),

    // Convert an already-imported "standard" dataset to geospatial in place,
    // backfilling a Point geometry for every existing entry from two of its
    // own data columns (e.g. "Latitude"/"Longitude"). Reuses the same
    // `imports` status doc/workflow monitoring as a fresh import.
    startGeospatialConversion: mutationGeneric({
      args: {
        latField: v.string(),
        lonField: v.string(),
        schemaId: v.string(),
        total: v.number(),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.startGeospatialConversion, {
          latField: args.latField,
          lonField: args.lonField,
          schemaId: args.schemaId,
          total: args.total,
        });
      },
    }),
  };
}
