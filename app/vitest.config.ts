import { defineConfig } from "vitest/config";

/**
 * The test config, split from `vite.config.ts` on purpose: vitest prefers
 * this file, and the app config's TanStack Start / nitro / devtools plugins
 * are build machinery that must not wrap the test module graph — with them
 * active, a React render under jsdom resolved a second React instance and
 * every hook call died on a null dispatcher (the only React-rendering tests
 * live in `dataset-rows-react.test.tsx`, issue #97). Environments default to
 * "node"; a DOM test opts in per file with `// @vitest-environment jsdom`.
 * The path aliases mirror tsconfig.json's `paths`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "#/": new URL("./src/", import.meta.url).pathname,
      "@/": new URL("./src/", import.meta.url).pathname,
      "#convex/": new URL("./convex/", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    // One test file at a time (#234): the int tests share one Postgres
    // service DB per CI job, and under runner load two files' wire-client
    // sessions interleaved against the shared DB — RLS denials on
    // storage.objects that moved between file sets on every rerun, plus the
    // standing load-flaky pair (convex/versions/consumption,
    // pg-realtime). Serializing files makes the class structurally
    // impossible and costs nothing: the suite is setup-dominated
    // (112 s serialized vs 114 s parallel, measured 2026-11-05), so no
    // wall-time is traded for the determinism.
    fileParallelism: false,
  },
});
