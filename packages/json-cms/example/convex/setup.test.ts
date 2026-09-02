/// <reference types="vite/client" />

import component from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import schema from "./schema.js";

const modules = import.meta.glob("./**/*.*s");
// When users want to write tests that use your component, they need to
// Explicitly register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  return t;
}

test("initConvexTest builds a harness", () => {
  expect(initConvexTest()).toBeDefined();
});
