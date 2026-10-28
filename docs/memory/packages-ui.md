---
name: packages-ui
description: 2026-10-27 restructure step F1 — registry UI moved to source-only
  `@caden/ui` (packages/ui); bun uses the isolated linker so the package must
  declare every dependency; exports wildcards need explicit file extensions
metadata:
  node_type: memory
  type: project
---

Step F1 of the workspace restructure (ADR 0014) moved `app/src/components/ui`,
`components/niko-table`, `lib/utils` (`cn`), `lib/compose-refs`,
`lib/pmtiles-protocol`, `hooks/use-color-scheme`, the vendored basemap styles
and the theme tokens into `packages/ui` (`@caden/ui`, source-only, no build).

- **Bun installs with the isolated linker** (`node_modules/.bun` exists), so a
  workspace package resolves only the dependencies it declares itself. A moved
  file whose dependency stays declared only in `app/package.json` fails to
  resolve. Copy the app's exact ranges so the lockfile resolves the same
  versions (check with a before/after diff of the resolved `name@version` set).
- **`exports` wildcards don't add extensions**: map each folder with its
  extension (`"./components/*": "./src/components/*.tsx"`), and import without
  `.ts`/`.tsx` suffixes from the app. Inside the package, use relative imports
  (the app's `#/` alias does not exist there).
- **CSS**: `packages/ui/src/styles/globals.css` holds the Tailwind imports,
  `@source "../"` and the tokens; `app/src/styles.css` imports
  `@caden/ui/globals.css` and adds `@source` for its own `src` and json-cms's
  dist. Verified: the built CSS was byte-identical to before the move (same
  content hashes).
- niko-table uses `process.env.NODE_ENV`, so the package tsconfig needs
  `node` types.
- `app/components.json` points `ui`/`utils` at `@caden/ui`, and
  `packages/ui/components.json` exists, so `shadcn add` should write into the
  package. Not yet verified with a real `shadcn add`.
- `pmtiles-protocol` lives in `@caden/ui/lib` for now because `map.tsx`
  registers it; step F3 plans to move it to `@caden/maps`.
