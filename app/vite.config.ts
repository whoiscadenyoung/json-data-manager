import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// react-family stays EXTERNAL through the prod server pipeline — see the
// ssr note below. Kept in sync with EXTERNAL_RUNTIME_PACKAGES in
// scripts/finalize-ssr-output.ts, which ships the real packages and guards
// the invariant.
const SSR_EXTERNALS = [/^react(-dom)?($|\/)/, /^scheduler($|\/)/];

const config = defineConfig({
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    nitro({
      preset: "bun",
      // The `auto` view-refresh drain (issue #305) starts with the server.
      plugins: ["./src/server/views/refresh-plugin.ts"],
      rolldownConfig: {
        external: SSR_EXTERNALS,
        output: {
          codeSplitting: {
            groups: [
              // Fold the ENTIRE vite-service output — the SSR build's prebuilt
              // chunks under node_modules/.nitro/vite/services — into ONE
              // server chunk. Nitro re-bundles those files, and its default
              // splitting can slice them into mutually-importing pieces whose
              // evaluation order hands out uninitialized bindings
              // (`require_shim is not a function` at SSR boot, deterministic
              // in the linux container — #243's second layer). A single chunk
              // cannot self-cycle, so the failure class dies no matter how
              // the service build splits its own output. (defu APPENDS these
              // to nitro's own groups, and a vite-level advancedChunks option
              // never reaches this build at all — nitro's groups win. The
              // .nitro segment is dot-prefixed, so nitro's node_modules group
              // doesn't capture these first; ordering keeps real dependencies
              // in _libs chunks.)
              { name: "ssr-services", test: /\.nitro[/\\]vite[/\\]services[/\\]/ },
            ],
          },
        },
      },
    }),
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  // @convex-dev/better-auth ships untranspiled — it must stay in the SSR
  // bundle for Vite to process it.
  //
  // react stays EXTERNAL end to end on purpose. The SSR service env
  // externalizes node_modules by default; the nitro env is pinned above.
  // That yields exactly ONE react instance per process — the real packages —
  // regardless of which interop flavor rolldown's platform build picks for
  // CJS consumers: an ESM `import "react"` and a bare `__require("react")`
  // shim both resolve at runtime from the copies
  // scripts/finalize-ssr-output.ts materializes into
  // .output/server/node_modules (the image ships .output alone — Dockerfile).
  // The 2026-11-05 arrangement this replaces counted on rolldown INLINING
  // react into a `_libs` chunk, whose existence silently depended on the
  // platform build's codegen flavor; the linux container lost the copy and
  // served ResolveMessage JSON on every route (#243). An unresolvable
  // external now fails the build in that script instead of at first render.
  // (The former route-tree advancedChunks pin is gone: nitro's own
  // codeSplitting.groups take precedence over user chunk options in this
  // nitro build, so the pin had stopped applying entirely — it protected
  // nothing while claiming to.)
  ssr: { noExternal: ["@convex-dev/better-auth"] },
  // Module workers (maplibre's, `tile-archive.worker.ts`) must build as ES —
  // the default iife wrap breaks `new Worker(url, { type: "module" })`.
  worker: { format: "es" },
});

export default config;
