import dataExport from "@caden/data-export/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(dataExport);

export default app;
