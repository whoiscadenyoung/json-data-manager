import { convexTest } from "convex-test";
/// <reference types="vite/client" />
import { expect, test } from "vitest";

import schema from "./schema.js";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  return t;
}
test("initConvexTest builds a harness", () => {
  expect(initConvexTest()).toBeDefined();
});
