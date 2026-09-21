---
name: component-actor-authz
description: 2026-09-21 json-cms exposeApi authz contract enhanced — auth hook now receives fn (per-function policy) and its return flows into the component as actorId → schemas.createdBy; survey verdict on Convex component callback patterns in ADR 0007
metadata:
  node_type: memory
  type: project
---

The json-cms component's authorization contract (ADR 0007, branch
feat/component-actor-authz): `exposeApi(components.jsonCms, { auth })` is
the component's whole authorization boundary — component internals are
host-only (plus the `boundWrite` attestation), so a plain host-side hook is
the right pattern (same family as `@convex-dev/agent`'s `usageHandler`).
Function-reference registration (better-auth's `authFunctions`) is only for
component-INITIATED flows — don't reach for it here unless one appears.

- The hook's operation arg now carries `fn` (the exposed wrapper name,
  e.g. "deleteSchema") — that's what enables per-function policy; the type
  is exported as `ExposeApiOperation` (hosts should retype rather than
  hand-roll, or structural contravariance breaks their callback signature).
- The hook's return value now flows into the component: `createSchema` gets
  `actorId` (wrapper-injected, clients can't set it) stored as
  `schemas.createdBy` (optional string, opaque to the component). Host
  flows calling the component directly can pass their own actorId or omit.
- Display is host-side: app resolves `createdBy` via `users:profileByAuthId`
  (the users mirror from [[better-auth-setup]]) → "Created by" in the
  dataset overview Details card.
- App consumes `@caden/json-cms` from dist — after editing the package run
  `bun run build:codegen` there (tsc + component codegen) or the app
  typechecks against stale component arg types.
