/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as entries from "../entries.js";
import type * as schemas from "../schemas.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  entries: typeof entries;
  schemas: typeof schemas;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  jsonCms: {
    lib: {
      createEntriesBulk: FunctionReference<
        "mutation",
        "internal",
        { dataArray: Array<any>; schemaId: string },
        Array<string>
      >;
      createEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; schemaId: string },
        string
      >;
      createSchema: FunctionReference<
        "mutation",
        "internal",
        { schema: any; uiSchema?: any },
        string
      >;
      deleteEntriesBySchema: FunctionReference<
        "mutation",
        "internal",
        { schemaId: string },
        number
      >;
      deleteEntry: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
        any
      >;
      deleteSchema: FunctionReference<
        "mutation",
        "internal",
        { schemaId: string },
        any
      >;
      getEntry: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        null | {
          _creationTime: number;
          _id: string;
          data: any;
          schemaId: string;
        }
      >;
      getSchema: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        null | {
          _creationTime: number;
          _id: string;
          description: string;
          schema: any;
          title: string;
          uiSchema?: any;
        }
      >;
      listEntries: FunctionReference<
        "query",
        "internal",
        { schemaId: string },
        Array<{
          _creationTime: number;
          _id: string;
          data: any;
          schemaId: string;
        }>
      >;
      listSchemas: FunctionReference<
        "query",
        "internal",
        {},
        Array<{
          _creationTime: number;
          _id: string;
          description: string;
          schema: any;
          title: string;
          uiSchema?: any;
        }>
      >;
      updateEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; entryId: string },
        any
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
        any
      >;
    };
  };
};
