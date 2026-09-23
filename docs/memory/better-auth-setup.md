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
- **Changing the deployment's `SITE_URL` env invalidates existing sessions**
  (2026-09-21, found while verifying [[user-profiles]] on :3002): cookies
  signed under the old config stop resolving — `/api/auth/get-session`
  returns `null` and the header silently drops to "Sign in" (looks like a
  client race, it isn't). Sign in again after any `convex env set SITE_URL`.
  The deployment's `SITE_URL` must also match the origin the app is actually
  served on — running vite on a nonstandard port needs
  `SITE_URL=http://localhost:<port>` on the deployment, not just in the vite
  env.
- Running the app when `bun run dev` can't (cloud deployment disabled and
  `convex dev` won't attach): start the local backend (recipe above), push
  once with `convex dev --once`, then start vite directly
  (`SITE_URL=http://localhost:<port> bunx vite dev --port <port>` — port 3000
  is often taken by other projects; vite env comes from `.env.local` which
  the `--once` push rewrites to the local URLs).
- `bun add` in `app/` bumps `@tanstack/react-query` "latest" past the
  5.103.1 persist stack → duplicate query-core breaks
  `root-provider.tsx` typecheck. Restore 5.103.1 after any bun add.
- **Standalone `ConvexClient`s need `setAuth` since the 0.1 sign-in gate**
  (2026-09-23): the export helpers' shared clients (`entries-pages.ts`,
  `geometry-rows.ts`) and the tile-archive worker's client sit outside
  `ConvexBetterAuthProvider`, so without identity every data call fails the
  gate even for a signed-in user. The token endpoint is
  `authClient.convex.token()` (what the react provider's own fetcher
  calls); its JWTs expire in ~15 min, so pass a LIVE fetcher —
  `client.setAuth(fetchConvexToken)` from `#/lib/convex-auth-token` — and
  the client re-invokes it near expiry. The worker has no authClient of its
  own: it round-trips token requests to the main thread over its message
  channel (`tile-archive.ts` ↔ `tile-archive.worker.ts`). `bunx convex run`
  of PUBLIC functions also carries no identity → rejected by the gate; the
  escape hatch for operator/maintenance functions is internalizing them —
  internal functions run via `convex run` with admin auth (the `seed.ts`
  precedent, followed by `schemas.backfillSummaries`).
