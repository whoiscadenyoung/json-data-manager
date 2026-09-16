import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  listGroups: list,
  getGroup: get,
  createGroup: create,
  updateGroup: update,
  deleteGroup: remove,
  setGroupCollection: setCollection,
} = exposeApi(components.jsonCms, { auth });
