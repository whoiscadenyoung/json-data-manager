import workflow from "@convex-dev/workflow/convex.config.js";
import { defineComponent } from "convex/server";

const component = defineComponent("dataExport");

// The export component orchestrates multi-table, batched exports durably using
// the official workflow component (which itself uses workpool).
component.use(workflow);

export default component;
