/**
 * RETIRED at stage 7 (issue #206, design doc §9 "Token plumbing retired").
 *
 * This module was the Start-server half of Better Auth:
 * `convexBetterAuthReactStart` built `handler` (serving /api/auth/*, the
 * browser-facing proxy to the Convex component's HTTP routes, wired in
 * `src/routes/api/auth/$.tsx`) plus `fetchAuthAction`/`fetchAuthMutation`/
 * `fetchAuthQuery`/`getToken` for authenticated SSR data loading. It read
 * `env.VITE_CONVEX_SITE_URL` / `env.VITE_CONVEX_URL`, which left `#/env` at
 * the disconnect.
 *
 * The route now answers 410 directly and the app signs in through Supabase
 * Auth only; the Better-Auth→Convex JWT feed has no live caller. The file
 * is kept on disk (never deleted) as the preserved reference for the revert
 * path — restoring it means re-adding the two env vars and the
 * `convexBetterAuthReactStart` construction above (see the git history of
 * this file for the exact shape).
 */

// oxlint-disable-next-line unicorn/require-module-specifiers -- a comment-only tombstone module; the empty export keeps it a module (no no-empty-file) without reviving any live wiring.
export {};
