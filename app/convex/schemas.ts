import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listSchemas: list,
  getSchema: get,
  createSchema: create,
  updateSchema: update,
  deleteSchema: remove,
} = exposeApi(components.jsonCms, { auth });
