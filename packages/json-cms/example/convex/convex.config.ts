import jsonCms from "@caden/json-cms/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(jsonCms);

export default app;
