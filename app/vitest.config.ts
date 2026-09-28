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
  },
});
