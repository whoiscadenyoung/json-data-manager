# 1. `react/ui` stays backend-agnostic

- Status: accepted
- Date: 2026-08

## Context

The `@caden/json-cms` component ships two React entrypoints:

- `@caden/json-cms/react` — a Convex adapter: `JsonCmsProvider` + typed hooks
  over a host app's exposed functions.
- `@caden/json-cms/react/ui` — styled components (the `SchemaEditor` family,
  `EntryForm`, `SchemaList`, and shadcn/base-ui primitives).

Most of the UI is already free of any backend dependency — the `SchemaEditor`
family, `EntryForm`, the primitives, and the `infer-schema` / `ui-schema`
utilities are purely prop-driven. Only `SchemaList` reached into the hooks layer
by calling `useSchemas()`.

We considered splitting the UI into its own backend-agnostic package
(`@caden/json-schema-ui`), with `@caden/json-cms` as the Convex integration on
top of it.

## Decision

Keep everything in one package **for now**, but enforce a hard boundary:
**`react/ui` never imports the backend** (Convex, the hooks layer, the client,
or generated code). UI components take data + callbacks as props; anything that
fetches lives in the consumer or a thin container built on the hooks layer.

Concretely:

- `SchemaList` is now prop-driven (`schemas`, `onSelect`) instead of calling
  `useSchemas()`. It accepts any `{ _id, title, description }[]`.
- A `no-restricted-imports` ESLint rule scoped to `src/react/ui/**` enforces the
  boundary so it cannot regress silently.

We defer the actual package split until there is real demand (a second,
non-Convex consumer, or external users), to avoid multi-package versioning and
release overhead before it pays for itself.

## Consequences

- The UI is usable with any backend (or none), and the lightweight `react` hooks
  entry does not drag in the heavy UI dependencies (CodeMirror, RJSF, base-ui).
- The `react` → `react/ui` dependency only ever points one way (a container may
  import both; `react/ui` imports neither the hooks nor the client).
- If a second consumer appears, extracting `react/ui` into a standalone package
  is a mechanical file move rather than a refactor, because the seam is already
  clean and machine-enforced.
