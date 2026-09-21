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
import type * as bindings from "../bindings.js";
import type * as collections from "../collections.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as entries from "../entries.js";
import type * as geometries from "../geometries.js";
import type * as groups from "../groups.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as maps from "../maps.js";
import type * as schemas from "../schemas.js";
import type * as seed from "../seed.js";
import type * as sources from "../sources.js";
import type * as sync from "../sync.js";
import type * as tags from "../tags.js";
import type * as tile_archives from "../tile_archives.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  bindings: typeof bindings;
  collections: typeof collections;
  crons: typeof crons;
  dashboard: typeof dashboard;
  entries: typeof entries;
  geometries: typeof geometries;
  groups: typeof groups;
  http: typeof http;
  imports: typeof imports;
  maps: typeof maps;
  schemas: typeof schemas;
  seed: typeof seed;
  sources: typeof sources;
  sync: typeof sync;
  tags: typeof tags;
  tile_archives: typeof tile_archives;
  users: typeof users;
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
  jsonCms: import("@caden/json-cms/_generated/component.js").ComponentApi<"jsonCms">;
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
