/// <reference types="vite/client" />

import { convexTest } from "convex-test";

export const modules = import.meta.glob("./**/*.*s");

import { defineSchema, componentsGeneric } from "convex/server";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { expect, test } from "vitest";

import type { ComponentApi } from "../component/_generated/component.js";
import { register } from "../test.js";

export function initConvexTest<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  schema?: Schema,
) {
  const t = convexTest(schema ?? defineSchema({}), modules);
  register(t);
  return t;
}
export const components = componentsGeneric() as unknown as {
  jsonCms: ComponentApi;
};

test("initConvexTest builds a harness", () => {
  expect(initConvexTest()).toBeDefined();
});
