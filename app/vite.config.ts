import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [devtools(), tailwindcss(), tanstackStart(), nitro({ preset: "bun" }), viteReact()],
  resolve: { tsconfigPaths: true },
  // Module workers (maplibre's, `tile-archive.worker.ts`) must build as ES —
  // the default iife wrap breaks `new Worker(url, { type: "module" })`.
  worker: { format: "es" },
});

export default config;
