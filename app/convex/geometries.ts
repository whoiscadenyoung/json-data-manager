import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const { listGeometries: list, getEntryGeometry } = exposeApi(components.jsonCms, { auth });
