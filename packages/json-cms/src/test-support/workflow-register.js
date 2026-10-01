// Runtime bridge for registering this component's nested workflow engine
// under convex-test. Deliberately a .js file: the workflow/workpool test
// entries point at their packages' SRC, which carries a noUnusedLocals
// violation that would otherwise enter every host's tsc graph through this
// package's ./test types; this module is declared for tsc via the sibling
// .d.ts and only ever executed by vitest.
import { register as registerWorkflow } from "@convex-dev/workflow/test";

/**
 * Registers the workflow component (and its workpool) under
 * `<name>/workflow` — the path this component's convex.config.ts mounts it at.
 * The empty name is the component testing ITS OWN functions: the component's
 * tables are then top-level, so the nested mount is plain `workflow`.
 * @param {import("convex-test").TestConvex<import("convex/server").SchemaDefinition<import("convex/server").GenericSchema, boolean>>} t
 * @param {string} name
 */
export function registerWorkflowComponent(t, name) {
  registerWorkflow(t, name === "" ? "workflow" : `${name}/workflow`);
}
