# 6. Authentication rides on Better Auth via the @convex-dev/better-auth hybrid component

- Status: accepted
- Date: 2026-09

## Context

The app had no authentication: `convex/auth.ts` returned the constant
"anonymous" as identity (the MVP gap from the 2026-09-18 assessment), and
the bound-datasets read-only gate was the only real logic in the auth path.
The MVP gap analysis called for real identity; the remaining open work
(gating writes, multi-user) all assumes a signed-in user.

Convex offers two first-party paths: `@convex-dev/auth` (Convex's own
Auth.js-based component) and Better Auth through the official
`@convex-dev/better-auth` component ("hybrid" mode — Better Auth executes
inside Convex actions/components and stores its tables in the component).
Better Auth was chosen for its framework-agnostic session model, its
plugin ecosystem (passkeys, OAuth, 2FA later), and because its Convex
component issues Convex-native JWTs, so the existing WebSocket client and
function context get real identity without a separate auth server.

## Decision

- **Better Auth runs inside Convex through the component.** `convex/auth.ts`
  creates the Better Auth instance (`createAuth`) bound to each function's
  context; HTTP routes are registered lazily in `convex/http.ts` under
  `/api/auth` and proxied same-origin through the Start server route
  (`src/routes/api/auth/$.tsx` → `src/lib/auth-server.ts`). The browser
  never talks to the convex.site domain directly.
- **Convex-side verification via `convex/auth.config.ts`.** The
  `getAuthConfigProvider()` customJwt provider points Convex at the
  component's own JWKS endpoint, so key rotation needs no env var churn.
  This file is the silent-always-signed-out footgun — it must stay in sync
  with the `convex()` plugin.
- **Better Auth's tables stay namespaced inside the component.** The app
  schema only holds an app-side mirror: a `users` table with `authId` (the
  Better Auth user id, which is the component's `user._id`), plus email /
  name / emailVerified / image. Rows are maintained exclusively by the
  component's **user triggers** (`createClient(..., { triggers })` +
  `triggersApi()` exports wired through `authFunctions`) — insert on
  sign-up, patch on profile update, delete on account deletion. Nothing
  else may write the table.
- **Identity flows through the existing choke point.** `auth()` in
  `convex/auth.ts` now returns the signed-in Better Auth user id (the JWT
  subject, equal to `users.authId`), falling back to "anonymous".
  Nothing requires sign-in yet — all reads/writes still work signed out;
  gating is a separate decision layered on this return value.
- **Email + password is the first provider** (`emailAndPassword.enabled`),
  with a `/signin` page and a header user menu (`useConvexAuth` +
  `users:me`). Session changes feed the Convex WebSocket via
  `ConvexBetterAuthProvider`; sign-out reloads the page.

## Consequences

- `better-auth` is pinned to exactly **1.6.15** (the version
  `@convex-dev/better-auth@0.12.5` types are compiled against — 1.6.33
  breaks the `ConvexBetterAuthProvider` authClient type).
- Env vars required per deployment: `BETTER_AUTH_SECRET`, `SITE_URL`
  (the app origin, e.g. http://localhost:3000). `convex/tsconfig.json`
  gained `"types": ["node"]` for `process.env` access in functions.
- The deprecated `auth()` contract is preserved: callers still get a
  string identity, so the json-cms exposeApi surface is untouched.
- Follow-ups (not decided here): requiring sign-in for data access,
  OAuth/passkey providers, authenticated SSR data loading via
  `getToken`/`fetchAuth*` (wiring exists, unused while queries are public).
