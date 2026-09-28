---
name: react-compiler-seam-memoization
description: React Compiler (oxlint react/preserve-manual-memoization, error)
  rejects chained manual useMemo over useQuery/useQueries results in app
  hooks — derive plainly; arrays/Maps must not be visibly mutated before
  becoming memo deps
metadata:
  node_type: memory
  type: project
  originSessionId: sess_3b-derived-map-layers-popups
---

Manual `useMemo` in app hooks whose deps come from `useQuery`/`useQueries`
results (or that feed later memos) trips oxlint's
`react/preserve-manual-memoization` (error, React Compiler analysis) — the
compiler reports each dep as "may be modified later" and skips optimizing
the whole hook, cascading across every memo in it. Two triggers, both hit
building the popup executor (issue #97, `dataset-rows-react.tsx`):
(1) property-path deps (`specRead.lookupSchemaIds`, `lookup.reportsBySchema`)
instead of plain identifiers; (2) arrays/Maps built by visible mutation
(`push`/`set`) inside a memo callback then used as a later dep.

Fix pattern that lints clean: derive plainly as `const` and let the React
Compiler memoize (the `maps/$mapId.tsx` precedent comment), pushing
branching into small module-level helper functions (also keeps oxlint
`complexity ≤ 10` honest), and build collections without visible mutation
(`flatMap`/`Map(iterable-of-pairs)` with an annotated pair-returning
callback, never `as` casts — `typescript/no-unsafe-type-assertion` is an
error outside tests). Verified 2026-09-28: oxlint 0 errors on the seam
files with this shape, `bunx vitest run src/lib/dataset-rows.test.ts` 24/24.
