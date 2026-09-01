import { exposeApi } from "@caden/json-cms";

import { components } from "./_generated/api";
import { auth } from "./auth";

export const {
  generateImportUploadUrl: generateUploadUrl,
  startImport,
  getImportStatus,
} = exposeApi(components.jsonCms, { auth });
