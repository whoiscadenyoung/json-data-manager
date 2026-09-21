---
name: better-auth-setup
description: 2026-09-21 Better Auth via @convex-dev/better-auth component shipped — better-auth must stay pinned to 1.6.15, authFunctions needs the explicit AuthFunctions annotation to avoid a TS7022 self-reference, and the users mirror table is trigger-maintained
metadata:
  node_type: memory
  type: project
---

Better Auth is wired through the `@convex-dev/better-auth` hybrid component
(ADR 0006, branch feat/better-auth). Full round trip verified against the
local backend (sign-up → session cookie → RS256 JWT with `sub` = Better Auth
user id → trigger-created `users` row with `authId` = that id). Gotchas that
cost time:

- **Pin `better-auth` to exactly 1.6.15.** 1.6.33 (satisfies `~1.6.15`)
  breaks `ConvexBetterAuthProvider`'s `AuthClient` type (`useSession().data`
  collapses to `never`). The component's types are compiled against 1.6.15.
- **The `authFunctions` config needs an explicitly-annotated hoisted const**
  (`const authFunctions: AuthFunctions = internal.auth`). An inline literal
  in `createClient(...)` makes `authComponent`'s type self-referential
  (generated `api.d.ts` types `internal.auth.*` via `typeof auth`) →
  TS7022, authComponent silently `any`. The official example uses the same
  hoisted-const shape. Related: `DataModel` imports from
  `./_generated/dataModel` (not `_generated/server`), and `GenericCtx`
  comes from `@convex-dev/better-auth` (convex 1.45 doesn't export it).
- **`convex dev` in CLI 1.45 cannot run the local backend anymore** for this
  account: `--local` is deprecated, `deployment select local` 404s on the
  disabled cloud deployment, and `CONVEX_DEPLOYMENT=local` fails to parse.
  Working recipe: start the binary directly
  (`~/.cache/convex/binaries/<latest>/convex-local-backend --port 3212
  --site-proxy-port 3213 --instance-secret <from .convex/local/default/config.json>
  --instance-name <deploymentName> convex_local_backend.sqlite3`) with cwd =
  `app/.convex/local/default/` (storage paths are cwd-relative — wrong cwd
  = blob errors), then `bunx convex dev --once --url http://127.0.0.1:3212
  --admin-key <adminKey>` and `bunx convex env set ... --url/--admin-key`.
  Vite needs `VITE_CONVEX_URL=http://127.0.0.1:3212`,
  `VITE_CONVEX_SITE_URL=http://127.0.0.1:3213` in `.env.local` BEFORE vite
  starts (a running vite never re-reads env). See
  [[bound-datasets-poc]] for the cloud-disabled context.
- **Better-auth POSTs require an `Origin` header** matching a trusted
  origin (curl: `-H "Origin: http://localhost:3000"`) or the request fails
  with MISSING_OR_NULL_ORIGIN.
- `bun add` in `app/` bumps `@tanstack/react-query` "latest" past the
  5.103.1 persist stack → duplicate query-core breaks
  `root-provider.tsx` typecheck. Restore 5.103.1 after any bun add.
