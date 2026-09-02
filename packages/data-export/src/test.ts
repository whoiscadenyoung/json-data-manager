import workflow from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 *
 * This also registers the nested workflow component (and its workpool) under
 * this component's namespace, so exports can run end-to-end in `convex-test`.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "dataExport",
) {
  t.registerComponent(name, schema, modules);
  // Registers `${name}/workflow` and `${name}/workflow/workpool`.
  workflow.register(t, `${name}/workflow`);
}
export default { register, schema, modules };
