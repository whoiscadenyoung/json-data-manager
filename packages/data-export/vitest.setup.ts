// The `edge-runtime` test environment omits `process`, but the Convex runtime
// (and the workflow/workpool components running inside `convex-test`) expect a
// minimal `process` global to exist. Provide one for tests.
const g = globalThis as unknown as { process?: { env: Record<string, string> } };
if (typeof g.process === "undefined") {
  g.process = { env: {} };
}
