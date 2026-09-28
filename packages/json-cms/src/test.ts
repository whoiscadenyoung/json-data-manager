/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import { registerWorkflowComponent } from "./test-support/workflow-register.js";

import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance — including its
 * nested durable-workflow engine (`convex.config.ts` mounts it as `workflow`,
 * so the full path is `<name>/workflow`, plus the workpool it rides). A host
 * testing an import end to end (startImport → chunks inserted) needs the
 * engine registered; tests that never start a workflow are unaffected.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "jsonCms",
) {
  t.registerComponent(name, schema, modules);
  registerWorkflowComponent(t, name);
}
export default { modules, register, schema };
