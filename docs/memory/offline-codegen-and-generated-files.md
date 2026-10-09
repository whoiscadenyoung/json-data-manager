---
name: offline-codegen-and-generated-files
description: >
  2026-10-09 (project-workspace phase 4): Convex return-type changes need no
  codegen — api.d.ts re-exports `typeof module`; the route tree regenerates
  only through the vite build; `bun --cwd app run build` prints the script
  menu instead of running.
type: workflow
---

# Offline codegen and generated files (phase 4 lesson, 2026-10-09)

- **Convex `api.d.ts` types flow through `typeof module`** — the generated
  file declares `fullApi: ApiFromModules<{ layers: typeof layers; ... }>`,
  so changing a query's RETURN TYPE (or its `returns` validator) typechecks
  client-side with NO codegen. Codegen is only needed when modules are
  ADDED/REMOVED (phase 3 committed `layerDrift.ts`/`layerTeardown.ts`/
  `projectAccess.ts` without regenerating — `api.d.ts` was stale until the
  phase-4 run rewrote it).
- **`bunx convex codegen` fails offline** ("No CONVEX_DEPLOYMENT set") — but
  it still rewrote `api.d.ts` correctly before failing, so a failing run can
  leave a real diff. Check `git status` after it.
- **The route tree regenerates ONLY through the vite build** — no `tsr` CLI
  is installed (`@tanstack/router-plugin` wraps the generator as a library;
  `bunx tsr` downloads an unrelated broken package). `cd app && bun run
build` regenerates `routeTree.gen.ts` — note `bun --cwd app run build`
  just prints the script menu and runs nothing from the repo root; cd in.

## How to apply

After backend projection/validator edits: run the app tests — no codegen
step. After adding/removing/moving route files: `cd app && bun run build`,
then grep `routeTree.gen.ts` for the new route id to confirm the pick-up.
