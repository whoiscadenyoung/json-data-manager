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

type GeometryTypeLiteral =
  | "Point"
  | "MultiPoint"
  | "LineString"
  | "MultiLineString"
  | "Polygon"
  | "MultiPolygon";

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
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  lib: {
    createEntriesBulk: FunctionReference<
      "mutation",
      "internal",
      { entries: Array<{ data: any; geometry?: any }>; schemaId: string },
      Array<string>,
      Name
    >;
    createEntry: FunctionReference<
      "mutation",
      "internal",
      { data: any; geometry?: any; schemaId: string },
      string,
      Name
    >;
    createSchema: FunctionReference<
      "mutation",
      "internal",
      {
        geometryType?: GeometryTypeLiteral;
        kind?: "standard" | "geospatial";
        schema: any;
        uiSchema?: any;
      },
      string,
      Name
    >;
    deleteEntriesBySchema: FunctionReference<
      "mutation",
      "internal",
      { schemaId: string },
      number,
      Name
    >;
    deleteEntry: FunctionReference<"mutation", "internal", { entryId: string }, any, Name>;
    deleteSchema: FunctionReference<"mutation", "internal", { schemaId: string }, any, Name>;
    generateUploadUrl: FunctionReference<"mutation", "internal", {}, string, Name>;
    getEntry: FunctionReference<
      "query",
      "internal",
      { entryId: string },
      null | {
        _creationTime: number;
        _id: string;
        data: any;
        geometryId?: string;
        geometryType?: GeometryTypeLiteral;
        schemaId: string;
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
        storageId: string;
        total: number;
        workflowId?: string;
      } | null,
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
        description: string;
        featureCount?: number;
        geometryType?: GeometryTypeLiteral;
        kind?: "standard" | "geospatial";
        schema: any;
        title: string;
        uiSchema?: any;
      },
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
        geometryType?: GeometryTypeLiteral;
        schemaId: string;
      }>,
      Name
    >;
    listGeometries: FunctionReference<
      "query",
      "internal",
      { schemaId: string },
      Array<{
        _creationTime: number;
        _id: string;
        bbox?: Array<number>;
        entryId: string;
        geometry: any;
        schemaId: string;
        type: GeometryTypeLiteral;
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
        description: string;
        featureCount?: number;
        geometryType?: GeometryTypeLiteral;
        kind?: "standard" | "geospatial";
        schema: any;
        title: string;
        uiSchema?: any;
      }>,
      Name
    >;
    startImport: FunctionReference<
      "mutation",
      "internal",
      { schemaId: string; storageId: string; total: number },
      string,
      Name
    >;
    updateEntry: FunctionReference<
      "mutation",
      "internal",
      { data: any; entryId: string; geometry?: any },
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
