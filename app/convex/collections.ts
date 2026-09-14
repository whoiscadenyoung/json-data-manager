import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listCollections: list,
  getCollection: get,
  createCollection: create,
  updateCollection: update,
  deleteCollection: remove,
  listSchemasByCollection: listDatasets,
  listGeometriesByCollection,
  listEntriesByCollection,
  setSchemaCollection,
  setSchemaGroup,
} = exposeApi(components.jsonCms, { auth });
