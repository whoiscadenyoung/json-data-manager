---
name: app-vitest-config
description: app/vitest.config.ts must stay split from vite.config.ts — the
  app's TanStack Start/nitro/devtools plugins fork React under vitest (null
  dispatcher on every hook call); jsdom tests opt in per file via
  `// @vitest-environment jsdom`
metadata:
  node_type: memory
  type: project
  originSessionId: sess_3b-derived-map-layers-popups
---

`app/vitest.config.ts` exists (since issue #97's reactive-layer tests) so
vitest does NOT load `vite.config.ts`: with the app's
`tanstackStart()`/`nitro()`/`devtools()` plugins active, rendering a React
component under jsdom resolved a second React instance and every hook call
threw "Cannot read properties of null (reading 'useRef')" (React 19's
`ReactSharedInternals.H` unset — verified 2026-09-28: same test file passes
plugin-free, crashes with the app config). The config carries only the
tsconfig path aliases and `environment: "node"`; DOM tests opt in per file
with the `// @vitest-environment jsdom` pragma (jsdom + @testing-library/react
were already devDependencies). Two mock-fidelity rules those tests taught:
vi.mock-ed hook stubs must return REFERENCE-STABLE states (the seam's
bail-out dedupe loops forever on fresh arrays — it OOMs the vitest worker),
and assertions about "reads after X" must slice `mock.calls` from a recorded
offset, since history accumulates across rerenders.
