import workflow from "@convex-dev/workflow/convex.config";
import { defineComponent } from "convex/server";

const component = defineComponent("jsonCms");

// Nested component: the durable-workflow engine that drives batched imports.
// Nesting it here means apps that install @caden/json-cms don't have to install
// The workflow component themselves — it's bundled transitively.
component.use(workflow);

export default component;
