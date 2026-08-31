import { defineApp } from "convex/server";
import dataExport from "@caden/data-export/convex.config.js";

const app = defineApp();
app.use(dataExport);

export default app;
