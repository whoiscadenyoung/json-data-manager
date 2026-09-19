# 2. Extract the CMS core into a reusable Convex component

- Status: accepted
- Date: 2026-08 (built from `docs/spec/001-convex-component`, since removed —
  its durable content is this record)

## Context

The app began as a single Convex app owning `schemas`/`entries` tables
directly, with the frontend colocated at the repo root. The goal was to make
the dataset/entry core reusable — installable by other Convex apps as a
CMS-style component — without forking the working app.

The original plan (spec 001) proposed table-name prefixes (`jdm_`) to avoid
collisions with host tables, a pnpm monorepo, and a package under
`packages/json-data-manager/`.

## Decision

Extract the core into a Convex component, `@caden/json-cms`, under
`packages/json-cms/`, in a bun workspace, with the app moved to `app/`:

- **No table prefixes.** Convex components are table-namespace isolated, so
  the component's tables keep plain names (`schemas`, `entries`, …) and
  cannot collide with host tables. The planned prefixes were rejected during
  implementation.
- **The component never knows about the host.** It exposes public functions;
  the host reaches them via `components.jsonCms.lib.*` and re-exports them
  to the browser through one `exposeApi` facade per domain (`app/convex/entries.ts`
  and siblings), each passing the host `auth`. The facade keeps client call
  sites, TanStack Query persist allowlists, and query hashes keyed on stable
  `module:function` names — component refactors that rename internals do not
  ripple into the frontend.
- **Component internals are unreachable from the host** (generated
  ComponentApi carries only public functions). Where the host must call the
  component directly (sync engine, tag ingest, tile install), it does so
  from host-only code paths, and the component's `boundWrite` attestation is
  the privilege marker those flows present.
- The component keeps a minimal internal `example/` app as its dev/codegen
  host; the real reference app is `app/`.

Deferred at the time and since built: the component's React layer
(`src/react` hooks + `src/react/ui` prop-driven components). The UI half is
backend-agnostic by rule — see [decision 1](./0001-backend-agnostic-react-ui.md).

## Consequences

- Other Convex apps can install the component and get the full dataset/
  entry/geometry core without inheriting this app's host concerns.
- The host app is thin by construction: shims, the read-only auth gate, and
  the bound-datasets layer — which is exactly the layer a second consumer
  would replace with its own.
- One indirection cost: API changes touch component + shim together, and the
  app consumes the package's `dist` (component edits need a package rebuild
  before the app sees them).
