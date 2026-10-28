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
import type * as cms_collections from "../cms/collections.js";
import type * as cms_entries from "../cms/entries.js";
import type * as cms_geometries from "../cms/geometries.js";
import type * as cms_groups from "../cms/groups.js";
import type * as cms_imports from "../cms/imports.js";
import type * as cms_maps from "../cms/maps.js";
import type * as cms_schemas from "../cms/schemas.js";
import type * as cms_tables from "../cms/tables.js";
import type * as cms_tile_archives from "../cms/tile_archives.js";
import type * as cms_uploads from "../cms/uploads.js";
import type * as crons from "../crons.js";
import type * as demoSources_dashboard from "../demoSources/dashboard.js";
import type * as demoSources_seed from "../demoSources/seed.js";
import type * as demoSources_snapshots from "../demoSources/snapshots.js";
import type * as demoSources_sources from "../demoSources/sources.js";
import type * as demoSources_tables from "../demoSources/tables.js";
import type * as http from "../http.js";
import type * as layerStyles_icons from "../layerStyles/icons.js";
import type * as layerStyles_styles from "../layerStyles/styles.js";
import type * as layerStyles_tables from "../layerStyles/tables.js";
import type * as publishing_bundles from "../publishing/bundles.js";
import type * as publishing_projects from "../publishing/projects.js";
import type * as publishing_publish from "../publishing/publish.js";
import type * as publishing_tables from "../publishing/tables.js";
import type * as sources_bindings from "../sources/bindings.js";
import type * as sources_registry from "../sources/registry.js";
import type * as sources_remoteClient from "../sources/remoteClient.js";
import type * as sources_remoteSources from "../sources/remoteSources.js";
import type * as sources_sourcePaging from "../sources/sourcePaging.js";
import type * as sources_sync from "../sources/sync.js";
import type * as sources_tables from "../sources/tables.js";
import type * as users from "../users.js";
import type * as versions_chain from "../versions/chain.js";
import type * as versions_consumption from "../versions/consumption.js";
import type * as versions_derivedDatasets from "../versions/derivedDatasets.js";
import type * as versions_derivedSpec from "../versions/derivedSpec.js";
import type * as versions_tables from "../versions/tables.js";
import type * as versions_tags from "../versions/tags.js";
import type * as versions_versioning from "../versions/versioning.js";

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
  "cms/collections": typeof cms_collections;
  "cms/entries": typeof cms_entries;
  "cms/geometries": typeof cms_geometries;
  "cms/groups": typeof cms_groups;
  "cms/imports": typeof cms_imports;
  "cms/maps": typeof cms_maps;
  "cms/schemas": typeof cms_schemas;
  "cms/tables": typeof cms_tables;
  "cms/tile_archives": typeof cms_tile_archives;
  "cms/uploads": typeof cms_uploads;
  crons: typeof crons;
  "demoSources/dashboard": typeof demoSources_dashboard;
  "demoSources/seed": typeof demoSources_seed;
  "demoSources/snapshots": typeof demoSources_snapshots;
  "demoSources/sources": typeof demoSources_sources;
  "demoSources/tables": typeof demoSources_tables;
  http: typeof http;
  "layerStyles/icons": typeof layerStyles_icons;
  "layerStyles/styles": typeof layerStyles_styles;
  "layerStyles/tables": typeof layerStyles_tables;
  "publishing/bundles": typeof publishing_bundles;
  "publishing/projects": typeof publishing_projects;
  "publishing/publish": typeof publishing_publish;
  "publishing/tables": typeof publishing_tables;
  "sources/bindings": typeof sources_bindings;
  "sources/registry": typeof sources_registry;
  "sources/remoteClient": typeof sources_remoteClient;
  "sources/remoteSources": typeof sources_remoteSources;
  "sources/sourcePaging": typeof sources_sourcePaging;
  "sources/sync": typeof sources_sync;
  "sources/tables": typeof sources_tables;
  users: typeof users;
  "versions/chain": typeof versions_chain;
  "versions/consumption": typeof versions_consumption;
  "versions/derivedDatasets": typeof versions_derivedDatasets;
  "versions/derivedSpec": typeof versions_derivedSpec;
  "versions/tables": typeof versions_tables;
  "versions/tags": typeof versions_tags;
  "versions/versioning": typeof versions_versioning;
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
