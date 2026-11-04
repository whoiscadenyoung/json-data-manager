import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro({ preset: "bun" }), viteReact()],
  resolve: { tsconfigPaths: true },
  // @convex-dev/better-auth ships untranspiled — it must stay in the SSR
  // bundle for Vite to process it. react stays EXTERNAL on purpose: the SSR
  // output's react-dom copy and every hook consumer must resolve the SAME
  // react at runtime (bundling a second copy breaks hooks dispatch —
  // ReactSharedInternals.H null, verified 2026-11-05). The Dockerfile ships
  // the server externals instead.
  ssr: { noExternal: ["@convex-dev/better-auth"] },
  build: {
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            // Keep the generated route tree in its own chunk. Without this,
            // rolldown's small-chunk merging sometimes folds routeTree.gen
            // into a server route-split chunk that the shared server chunk
            // then imports back — a static cycle whose evaluation order can
            // hand out uninitialized bindings (`require_shim is not a
            // function` at SSR boot; deterministic in the linux container
            // build, latent everywhere else until the prod output is served).
            { name: "route-tree", test: /routeTree\.gen/ },
          ],
        },
      },
    },
  },
  // Module workers (maplibre's, `tile-archive.worker.ts`) must build as ES —
  // the default iife wrap breaks `new Worker(url, { type: "module" })`.
  worker: { format: "es" },
});

export default config;
