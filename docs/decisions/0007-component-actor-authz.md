# 7. The component's authorization contract: a host-supplied `auth` hook, with actor identity flowing in

- Status: accepted
- Date: 2026-09

## Context

Authentication lives at the app level (ADR 0006: Better Auth issues the
identity), but the json-cms component's public surface is the `exposeApi`
wrapper, and integrators — not the component — decide who may call what.
Two gaps remained: the hook only saw a coarse CRUD `type` plus target ids
(no way to write per-function policy), and the identity string it returned
was discarded, so the component couldn't record who created a dataset.

A survey of official Convex components shows two callback shapes:

- **Plain host-side functions** in the client-library options —
  `@convex-dev/agent`'s `usageHandler` — executed inside the host's own
  function context, because every entry into the component flows through
  the host wrapper.
- **Convex function references** the component invokes via
  `ctx.runMutation` (e.g. `@convex-dev/better-auth`'s `authFunctions`) —
  needed only when the component initiates flows itself (its own HTTP
  routes, crons, workflows) where no host code is on the stack.

json-cms's public surface is exclusively the `exposeApi` wrappers; the
component's internals are host-only (and bound-dataset writes are
additionally gated by the `boundWrite` attestation inside the component).
There are no component-initiated flows that need authorization, so the
first shape is the correct one — no registration machinery required.

## Decision

- **The `auth` hook stays a plain host-supplied function**, but its
  operation argument now carries `fn` — the name of the exposed wrapper
  being called (`"createSchema"`, `"listGeometries"`, …) — alongside the
  CRUD `type` and target ids. Per-function policy (e.g. gate
  `deleteSchema` behind a role) is now expressible directly. The type is
  exported as `ExposeApiOperation` so hosts don't hand-maintain the shape.
- **Actor identity flows into the component.** The hook's return value is
  forwarded by the `createSchema` wrapper as `actorId`, stored on the
  dataset as `createdBy` (an optional string, opaque to the component).
  Host flows that call the component directly may pass their own `actorId`
  or omit it. Other entities (collections, groups, maps) deliberately
  don't stamp yet — extend the same pattern when a surface needs it.
- **Display is the host's job.** The app resolves `createdBy` through its
  `users` mirror (`users:profileByAuthId`) and renders "Created by" in the
  dataset overview's Details card, falling back to the raw id for actors
  without a profile.
- `exposeApi`'s options are exported as `ExposeApiOptions`.

## Consequences

- Existing integrators' `auth` callbacks must accept the widened operation
  (a structural type, so most just work; ours was retyped to
  `ExposeApiOperation`).
- Datasets created before this change (or without an actor) simply have no
  `createdBy` — the UI hides the row.
- If a future component-initiated flow ever needs authorization, that is
  the point to introduce a function-reference registration mechanism (the
  better-auth pattern) — not before.
