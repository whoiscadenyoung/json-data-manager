import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listEntries: list,
  listEntriesPage: listPage,
  listEntriesForIds: listForIds,
  getEntry: get,
  listEntriesForSchemas,
  listReferencingEntries,
  createEntry: create,
  createEntriesBulk: createBulk,
  updateEntry: update,
} = exposeApi(components.jsonCms, { auth });
