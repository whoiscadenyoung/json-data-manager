// The `edge-runtime` test environment omits `process`, but the Convex runtime
// (and the workflow/workpool components running inside `convex-test`) expect a
// minimal `process` global to exist. Provide one for tests.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the whole point is to poke a hole in the host global; the optional shape below is checked at runtime.
const g = globalThis as unknown as { process?: { env: Record<string, string> } };
if (typeof g.process === "undefined") {
  g.process = { env: {} };
}
