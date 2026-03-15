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
      createEntriesBulk: FunctionReference<
        "mutation",
        "internal",
        { dataArray: Array<any>; schemaId: string },
        Array<string>,
        Name
      >;
      createEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; schemaId: string },
        string,
        Name
      >;
      createSchema: FunctionReference<
        "mutation",
        "internal",
        { schema: any },
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
      deleteEntry: FunctionReference<
        "mutation",
        "internal",
        { entryId: string },
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
      getEntry: FunctionReference<
        "query",
        "internal",
        { entryId: string },
        null | {
          _creationTime: number;
          _id: string;
          data: any;
          schemaId: string;
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
          description: string;
          schema: any;
          title: string;
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
          description: string;
          schema: any;
          title: string;
        }>,
        Name
      >;
      updateEntry: FunctionReference<
        "mutation",
        "internal",
        { data: any; entryId: string },
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
        },
        any,
        Name
      >;
    };
  };
