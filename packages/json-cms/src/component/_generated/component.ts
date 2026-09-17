/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      addMapLayer: FunctionReference<
        "mutation",
        "internal",
        {
          mapId: string;
          targetId: string;
          targetType: "collection" | "group" | "dataset";
        },
        any,
        Name
      >;
      addSchemaToCollection: FunctionReference<
        "mutation",
        "internal",
        { collectionId: string; schemaId: string },
        any,
        Name
      >;
      createCollection: FunctionReference<
        "mutation",
        "internal",
        { description?: string; name: string },
        string,
        Name
      >;
      createEntriesBulk: FunctionReference<
        "mutation",
        "internal",
        { entries: Array<{ data: any; geometry?: string }>; schemaId: string },
        Array<string>,
        Name
      >;
      createEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; geometry?: string; schemaId: string },
        string,
        Name
      >;
      createGroup: FunctionReference<
        "mutation",
        "internal",
        { collectionId?: string; description?: string; name: string },
        string,
        Name
      >;
      createMap: FunctionReference<
        "mutation",
        "internal",
        { description?: string; name: string },
        string,
        Name
      >;
      createSchema: FunctionReference<
        "mutation",
        "internal",
        {
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          kind?: "standard" | "geospatial";
          schema: any;
          simplifyGeometry?: boolean;
          uiSchema?: any;
        },
        string,
        Name
      >;
      deleteCollection: FunctionReference<
        "mutation",
        "internal",
        { collectionId: string },
        any,
        Name
      >;
      deleteEntriesBySchema: FunctionReference<
        "mutation",
        "internal",
        { schemaId: string },
        number,
        Name
      >;
      deleteEntry: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
        any,
        Name
      >;
      deleteGroup: FunctionReference<
        "mutation",
        "internal",
        { groupId: string },
        any,
        Name
      >;
      deleteMap: FunctionReference<
        "mutation",
        "internal",
        { mapId: string },
        any,
        Name
      >;
      deleteSchema: FunctionReference<
        "mutation",
        "internal",
        { schemaId: string },
        any,
        Name
      >;
      generateUploadUrl: FunctionReference<
        "mutation",
        "internal",
        {},
        string,
        Name
      >;
      getCollection: FunctionReference<
        "query",
        "internal",
        { collectionId: string },
        null | {
          _creationTime: number;
          _id: string;
          description?: string;
          name: string;
        },
        Name
      >;
      getEntry: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        null | {
          _creationTime: number;
          _id: string;
          data: any;
          geometryId?: string;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          schemaId: string;
        },
        Name
      >;
      getEntryGeometry: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        null | {
          _creationTime: number;
          _id: string;
          bbox?: Array<number>;
          entryId: string;
          geometryJson?: string;
          geometryUrl?: string;
          schemaId: string;
          type:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
        },
        Name
      >;
      getGroup: FunctionReference<
        "query",
        "internal",
        { groupId: string },
        null | {
          _creationTime: number;
          _id: string;
          collectionId?: string;
          description?: string;
          name: string;
        },
        Name
      >;
      getImportStatus: FunctionReference<
        "query",
        "internal",
        { importId: string },
        {
          _creationTime: number;
          _id: string;
          error?: string;
          processed: number;
          schemaId: string;
          status: "pending" | "processing" | "completed" | "failed";
          storageId?: string;
          storageIds?: Array<string>;
          total: number;
          workflowId?: string;
        } | null,
        Name
      >;
      getMap: FunctionReference<
        "query",
        "internal",
        { mapId: string },
        null | {
          _creationTime: number;
          _id: string;
          description?: string;
          name: string;
        },
        Name
      >;
      getMapTileArchiveMeta: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        null | {
          bytes?: number;
          maxZoom?: number;
          storageId: string;
          url: string;
          version: number;
        },
        Name
      >;
      getSchema: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        null | {
          _creationTime: number;
          _id: string;
          boundingBox?: Array<number>;
          description?: string;
          featureCount?: number;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          groupId?: string;
          kind?: "standard" | "geospatial";
          mapTileArchiveBytes?: number;
          mapTileArchiveMaxZoom?: number;
          mapTileArchiveStorageId?: string;
          mapTileCacheVersion?: number;
          schema: any;
          simplifyGeometry?: boolean;
          sourceFileName?: string;
          sourceFileSize?: number;
          sourceFileStorageId?: string;
          title: string;
          uiSchema?: any;
        },
        Name
      >;
      getSourceFileUrl: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        null | string,
        Name
      >;
      listAllMapLayerOverrides: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          childKey: string;
          layerId: string;
          visible: boolean;
        }>,
        Name
      >;
      listCollections: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          description?: string;
          name: string;
        }>,
        Name
      >;
      listCollectionsBySchema: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        Array<{
          _creationTime: number;
          _id: string;
          description?: string;
          name: string;
        }>,
        Name
      >;
      listEntries: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        Array<{
          _creationTime: number;
          _id: string;
          data: any;
          geometryId?: string;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          schemaId: string;
        }>,
        Name
      >;
      listEntriesByCollection: FunctionReference<
        "query",
        "internal",
        { collectionId: string },
        Array<{
          _creationTime: number;
          _id: string;
          data: any;
          geometryId?: string;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          schemaId: string;
        }>,
        Name
      >;
      listEntriesForSchemas: FunctionReference<
        "query",
        "internal",
        { schemaIds: Array<string> },
        Array<{
          _creationTime: number;
          _id: string;
          data: any;
          geometryId?: string;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          schemaId: string;
        }>,
        Name
      >;
      listGeometries: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          schemaId: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            bbox?: Array<number>;
            entryId: string;
            geometryJson?: string;
            geometryUrl?: string;
            schemaId: string;
            type:
              | "Point"
              | "MultiPoint"
              | "LineString"
              | "MultiLineString"
              | "Polygon"
              | "MultiPolygon";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      listGroups: FunctionReference<
        "query",
        "internal",
        { collectionId?: string },
        Array<{
          _creationTime: number;
          _id: string;
          collectionId?: string;
          description?: string;
          name: string;
        }>,
        Name
      >;
      listMapLayerOverrides: FunctionReference<
        "query",
        "internal",
        { layerId: string },
        Array<{
          _creationTime: number;
          _id: string;
          childKey: string;
          layerId: string;
          visible: boolean;
        }>,
        Name
      >;
      listMapLayers: FunctionReference<
        "query",
        "internal",
        { mapId?: string },
        Array<{
          _creationTime: number;
          _id: string;
          mapId: string;
          order: number;
          targetId: string | string | string;
          targetType: "collection" | "group" | "dataset";
          visible: boolean;
        }>,
        Name
      >;
      listMaps: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          description?: string;
          name: string;
        }>,
        Name
      >;
      listReferencingEntries: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        Array<{
          fieldName: string;
          sourceEntry: {
            _creationTime: number;
            _id: string;
            data: any;
            geometryId?: string;
            geometryType?:
              | "Point"
              | "MultiPoint"
              | "LineString"
              | "MultiLineString"
              | "Polygon"
              | "MultiPolygon";
            schemaId: string;
          };
          sourceSchemaId: string;
        }>,
        Name
      >;
      listSchemaCollections: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          collectionId: string;
          schemaId: string;
        }>,
        Name
      >;
      listSchemas: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          boundingBox?: Array<number>;
          description?: string;
          featureCount?: number;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          groupId?: string;
          kind?: "standard" | "geospatial";
          mapTileArchiveBytes?: number;
          mapTileArchiveMaxZoom?: number;
          mapTileArchiveStorageId?: string;
          mapTileCacheVersion?: number;
          schema: any;
          simplifyGeometry?: boolean;
          sourceFileName?: string;
          sourceFileSize?: number;
          sourceFileStorageId?: string;
          title: string;
          uiSchema?: any;
        }>,
        Name
      >;
      listSchemasByCollection: FunctionReference<
        "query",
        "internal",
        { collectionId: string },
        Array<{
          _creationTime: number;
          _id: string;
          boundingBox?: Array<number>;
          description?: string;
          featureCount?: number;
          geometryType?:
            | "Point"
            | "MultiPoint"
            | "LineString"
            | "MultiLineString"
            | "Polygon"
            | "MultiPolygon";
          groupId?: string;
          kind?: "standard" | "geospatial";
          mapTileArchiveBytes?: number;
          mapTileArchiveMaxZoom?: number;
          mapTileArchiveStorageId?: string;
          mapTileCacheVersion?: number;
          schema: any;
          simplifyGeometry?: boolean;
          sourceFileName?: string;
          sourceFileSize?: number;
          sourceFileStorageId?: string;
          title: string;
          uiSchema?: any;
        }>,
        Name
      >;
      moveMapLayer: FunctionReference<
        "mutation",
        "internal",
        { direction: "up" | "down"; layerId: string },
        any,
        Name
      >;
      removeMapLayer: FunctionReference<
        "mutation",
        "internal",
        { layerId: string },
        any,
        Name
      >;
      removeSchemaFromCollection: FunctionReference<
        "mutation",
        "internal",
        { collectionId: string; schemaId: string },
        any,
        Name
      >;
      setGroupCollection: FunctionReference<
        "mutation",
        "internal",
        { collectionId: string | null; groupId: string },
        any,
        Name
      >;
      setMapLayerOverride: FunctionReference<
        "mutation",
        "internal",
        { childKey: string; layerId: string; visible?: boolean },
        any,
        Name
      >;
      setMapLayerVisibility: FunctionReference<
        "mutation",
        "internal",
        { layerId: string; visible: boolean },
        any,
        Name
      >;
      setMapTileArchive: FunctionReference<
        "mutation",
        "internal",
        {
          bytes: number;
          expectedVersion: number;
          maxZoom: number;
          schemaId: string;
          storageId: string;
        },
        any,
        Name
      >;
      setSchemaGroup: FunctionReference<
        "mutation",
        "internal",
        { groupId: string | null; schemaId: string },
        any,
        Name
      >;
      startGeospatialConversion: FunctionReference<
        "mutation",
        "internal",
        { latField: string; lonField: string; schemaId: string; total: number },
        string,
        Name
      >;
      startImport: FunctionReference<
        "mutation",
        "internal",
        {
          schemaId: string;
          sourceFile?: { name: string; size: number; storageId: string };
          storageIds: Array<string>;
          total: number;
        },
        string,
        Name
      >;
      startSimplification: FunctionReference<
        "mutation",
        "internal",
        { schemaId: string; total: number },
        string,
        Name
      >;
      updateCollection: FunctionReference<
        "mutation",
        "internal",
        { collectionId: string; description?: string; name?: string },
        any,
        Name
      >;
      updateEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; entryId: string; geometry?: string | null },
        any,
        Name
      >;
      updateGroup: FunctionReference<
        "mutation",
        "internal",
        { description?: string; groupId: string; name?: string },
        any,
        Name
      >;
      updateMap: FunctionReference<
        "mutation",
        "internal",
        { description?: string; mapId: string; name?: string },
        any,
        Name
      >;
      updateSchema: FunctionReference<
        "mutation",
        "internal",
        {
          description?: string;
          schema?: any;
          schemaId: string;
          title?: string;
          uiSchema?: any;
        },
        any,
        Name
      >;
    };
  };
