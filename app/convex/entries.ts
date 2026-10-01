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
  // The failed-import recovery path (issue #129): a Retry re-imports into
  // the SAME dataset, so whatever partial rows the failed attempt committed
  // are cleared first. Same wrapper, same delete gate (`type: "delete"`) the
  // component enforces.
  deleteEntriesBySchema: clearDatasetRows,
} = exposeApi(components.jsonCms, { auth });
