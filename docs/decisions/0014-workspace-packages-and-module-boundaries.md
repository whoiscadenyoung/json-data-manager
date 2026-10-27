# 14. Workspace packages and module boundaries

- Status: accepted
- Date: 2026-10-27

## Context

ADR 0011 (app builder) and ADR 0012 (layer styles) introduced self-contained
feature modules. The rest of the app grew without that structure: about 30
flat files in `app/convex`, about 50 flat files across `app/src/components`
and `app/src/lib`, a 5.2k-line `json-cms` `component/lib.ts`, and demo-only
source tables wired into core sync and versioning code. Nothing enforced the
boundaries the two feature ADRs describe; routes deep-imported feature
internals.

A restructure (tracked as steps 0, B1–B3, S1 and F1–F3) regroups the
backend by domain, moves the rest of the frontend into feature modules,
moves registry UI into `packages/ui`, and extracts backend-free engines into
workspace packages. This ADR records the conventions those steps follow.

## Decision

- **Feature modules.** A feature lives in `app/src/features/<name>/` and,
  when it has a backend, in `app/convex/<domain>/` with its own `tables.ts`
  spread into `schema.ts` with one line.
  - Code outside the feature imports only its public API,
    `#/features/<name>` (its `index.ts`, named re-exports only, since
    `oxc/no-barrel-file` rejects `export *`).
  - Inside a feature, files import each other with relative paths.
  - Features never import other features. Core exposes extension slots
    (the `LayersMap` `extension` / `MapLayerPanel` `datasetActions` pattern
    from ADR 0012) and only the page that composes them wires both.
  - `.oxlintrc.json` enforces the first and third rules with
    `no-restricted-imports`.
- **Two kinds of workspace package.**
  - _Built_ packages compile to `dist` with `tsc`, like `@caden/json-cms` and
    `@caden/geometry-archive`. Use this for anything imported by Convex
    component code or by another built package. Each one is added to CI's
    "Build workspace dists" step.
  - _Source-only_ packages are `private: true` and point `exports` at
    `./src/*.ts` with no build step. Use this for app-only packages (UI,
    browser engines). Vite, vitest and `tsc` read the TypeScript directly, so
    they never go stale.
- **Packages never import `#convex/_generated/*`.** Anything that needs the
  app's generated Convex `api` stays in the app. A package takes data or
  fetchers as arguments (the ADR 0001 pattern `json-cms/react` already
  uses), so the dependency only ever points from the app to the package.
- **Convex host code is grouped by domain folder, not by package.** Host
  functions must live under `app/convex`, so folders are the unit there. A
  domain becomes a Convex component only when it must be reusable outside
  this app.

## Consequences

- Moving a Convex file changes its function paths (`api.sync.x` →
  `api.sources.sync.x`), so each move is a scripted codemod, updates
  `crons.ts` and workflow step references, and runs with no workflows in
  flight.
- convex-test files in subfolders need root-relative module globs.
- Feature boundaries fail lint instead of drifting, at the cost of an
  `index.ts` to maintain per feature.
- Engines split into a package core and an app-side shell (queries, auth
  token, React hooks), which adds one seam per engine but makes the core
  testable without Convex.
