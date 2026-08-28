import { exposeApi } from "@caden/json-cms";
import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listEntries: list,
  getEntry: get,
  createEntry: create,
  createEntriesBulk: createBulk,
} = exposeApi(components.jsonCms, { auth });
