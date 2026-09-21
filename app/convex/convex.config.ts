import jsonCms from "@caden/json-cms/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(jsonCms);
app.use(betterAuth);

export default app;
