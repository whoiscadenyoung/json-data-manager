import { defineApp } from "convex/server";
import jsonCms from "@caden/json-cms/convex.config.js";

const app = defineApp();
app.use(jsonCms);

export default app;
