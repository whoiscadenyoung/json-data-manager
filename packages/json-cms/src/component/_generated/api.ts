/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as collections from "../collections.js";
import type * as deletes from "../deletes.js";
import type * as entries from "../entries.js";
import type * as geometry_storage from "../geometry_storage.js";
import type * as geospatial from "../geospatial.js";
import type * as groups from "../groups.js";
import type * as host_support from "../host_support.js";
import type * as imports from "../imports.js";
import type * as internal_deleteBudget from "../internal/deleteBudget.js";
import type * as internal_entryPages from "../internal/entryPages.js";
import type * as internal_entryWrites from "../internal/entryWrites.js";
import type * as internal_geometryPages from "../internal/geometryPages.js";
import type * as internal_importRuns from "../internal/importRuns.js";
import type * as internal_mapLayers from "../internal/mapLayers.js";
import type * as internal_schemaViews from "../internal/schemaViews.js";
import type * as internal_shared from "../internal/shared.js";
import type * as internal_tileArchive from "../internal/tileArchive.js";
import type * as maps from "../maps.js";
import type * as schemas from "../schemas.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  collections: typeof collections;
  deletes: typeof deletes;
  entries: typeof entries;
  geometry_storage: typeof geometry_storage;
  geospatial: typeof geospatial;
  groups: typeof groups;
  host_support: typeof host_support;
  imports: typeof imports;
  "internal/deleteBudget": typeof internal_deleteBudget;
  "internal/entryPages": typeof internal_entryPages;
  "internal/entryWrites": typeof internal_entryWrites;
  "internal/geometryPages": typeof internal_geometryPages;
  "internal/importRuns": typeof internal_importRuns;
  "internal/mapLayers": typeof internal_mapLayers;
  "internal/schemaViews": typeof internal_schemaViews;
  "internal/shared": typeof internal_shared;
  "internal/tileArchive": typeof internal_tileArchive;
  maps: typeof maps;
  schemas: typeof schemas;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
