"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { JsonCmsApi } from "./types.js";

const JsonCmsContext = createContext<JsonCmsApi | null>(null);

/**
 * Provides the JSON CMS function references to the hooks in this package.
 *
 * Wrap your app (inside your Convex provider) and pass the functions your
 * app exposes for the component:
 *
 * ```tsx
 * import { JsonCmsProvider } from "@caden/json-cms/react";
 * import { api } from "../convex/_generated/api";
 *
 * <JsonCmsProvider
 *   api={{
 *     listSchemas: api.schemas.list,
 *     getSchema: api.schemas.get,
 *     createSchema: api.schemas.create,
 *     updateSchema: api.schemas.update,
 *     deleteSchema: api.schemas.remove,
 *     listEntries: api.entries.list,
 *     getEntry: api.entries.get,
 *     createEntry: api.entries.create,
 *     createEntriesBulk: api.entries.createBulk,
 *     updateEntry: api.entries.update,
 *     deleteEntry: api.entries.remove,
 *     deleteEntriesBySchema: api.entries.removeBySchema,
 *   }}
 * >
 *   {children}
 * </JsonCmsProvider>
 * ```
 */
export function JsonCmsProvider({ api, children }: { api: JsonCmsApi; children: ReactNode }) {
  return <JsonCmsContext.Provider value={api}>{children}</JsonCmsContext.Provider>;
}

/**
 * Access the JSON CMS function references from context. Throws if used
 * outside of a `<JsonCmsProvider>`.
 */
export function useJsonCmsApi(): JsonCmsApi {
  const api = useContext(JsonCmsContext);
  if (!api) {
    throw new Error("useJsonCmsApi must be used within a <JsonCmsProvider>.");
  }
  return api;
}
