/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as appBuilder_apps from "../appBuilder/apps.js";
import type * as appBuilder_exampleData from "../appBuilder/exampleData.js";
import type * as appBuilder_examples from "../appBuilder/examples.js";
import type * as appBuilder_tables from "../appBuilder/tables.js";
import type * as appBuilder_validators from "../appBuilder/validators.js";
import type * as auth from "../auth.js";
import type * as bindings from "../bindings.js";
import type * as bundles from "../bundles.js";
import type * as collections from "../collections.js";
import type * as consumption from "../consumption.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as derivedDatasets from "../derivedDatasets.js";
import type * as derivedSpec from "../derivedSpec.js";
import type * as entries from "../entries.js";
import type * as geometries from "../geometries.js";
import type * as groups from "../groups.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as layerStyles_icons from "../layerStyles/icons.js";
import type * as layerStyles_styles from "../layerStyles/styles.js";
import type * as layerStyles_tables from "../layerStyles/tables.js";
import type * as layerStyles_validators from "../layerStyles/validators.js";
import type * as maps from "../maps.js";
import type * as projects from "../projects.js";
import type * as publish from "../publish.js";
import type * as schemas from "../schemas.js";
import type * as seed from "../seed.js";
import type * as sources from "../sources.js";
import type * as sync from "../sync.js";
import type * as tags from "../tags.js";
import type * as tile_archives from "../tile_archives.js";
import type * as uploads from "../uploads.js";
import type * as users from "../users.js";
import type * as versioning from "../versioning.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "appBuilder/apps": typeof appBuilder_apps;
  "appBuilder/exampleData": typeof appBuilder_exampleData;
  "appBuilder/examples": typeof appBuilder_examples;
  "appBuilder/tables": typeof appBuilder_tables;
  "appBuilder/validators": typeof appBuilder_validators;
  auth: typeof auth;
  bindings: typeof bindings;
  bundles: typeof bundles;
  collections: typeof collections;
  consumption: typeof consumption;
  crons: typeof crons;
  dashboard: typeof dashboard;
  derivedDatasets: typeof derivedDatasets;
  derivedSpec: typeof derivedSpec;
  entries: typeof entries;
  geometries: typeof geometries;
  groups: typeof groups;
  http: typeof http;
  imports: typeof imports;
  "layerStyles/icons": typeof layerStyles_icons;
  "layerStyles/styles": typeof layerStyles_styles;
  "layerStyles/tables": typeof layerStyles_tables;
  "layerStyles/validators": typeof layerStyles_validators;
  maps: typeof maps;
  projects: typeof projects;
  publish: typeof publish;
  schemas: typeof schemas;
  seed: typeof seed;
  sources: typeof sources;
  sync: typeof sync;
  tags: typeof tags;
  tile_archives: typeof tile_archives;
  uploads: typeof uploads;
  users: typeof users;
  versioning: typeof versioning;
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
