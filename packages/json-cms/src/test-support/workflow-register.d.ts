import type { TestConvex } from "convex-test";
// Declarations for the JS bridge beside it (see workflow-register.js for why
// the bridge exists). tsc resolves imports of the .js through this file and
// never follows into the workflow/workpool package sources.
import type { GenericSchema, SchemaDefinition } from "convex/server";

export function registerWorkflowComponent(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string,
): void;
