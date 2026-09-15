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
 *   setSchemaCollection,
 *   setSchemaGroup,
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
          }
        | { type: "create"; schemaId?: string; collectionId?: string; groupId?: string }
        | {
            type: "update";
            schemaId?: string;
            entryId?: string;
            collectionId?: string;
            groupId?: string;
          }
        | {
            type: "delete";
            schemaId?: string;
            entryId?: string;
            collectionId?: string;
            groupId?: string;
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
        uiSchema: v.optional(v.any()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "create" });
        return ctx.runMutation(component.lib.createSchema, {
          geometryType: args.geometryType,
          kind: args.kind,
          schema: args.schema,
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
      args: { collectionId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "read" });
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
        collectionId: v.string(),
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

    // Dataset <-> collection/group association
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
      args: { collectionId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { collectionId: args.collectionId, type: "read" });
        return ctx.runQuery(component.lib.listEntriesByCollection, {
          collectionId: args.collectionId,
        });
      },
    }),
    setSchemaCollection: mutationGeneric({
      args: { collectionId: v.union(v.string(), v.null()), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.setSchemaCollection, args);
      },
    }),
    setSchemaGroup: mutationGeneric({
      args: { groupId: v.union(v.string(), v.null()), schemaId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { schemaId: args.schemaId, type: "update" });
        return ctx.runMutation(component.lib.setSchemaGroup, args);
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
    // field's candidate picker without one round trip per dataset.
    listEntriesForSchemas: queryGeneric({
      args: { schemaIds: v.array(v.string()) },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read" });
        return ctx.runQuery(component.lib.listEntriesForSchemas, {
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
    // `geometry` travels as a JSON *string*, not the nested-array `Geometry`
    // shape — see `geometry_storage.ts` in the component for why (Convex's
    // 8192-elements-per-array limit, which real-world GIS rings routinely
    // exceed; a string has no such limit).
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
