/**
 * DISCONNECTED at stage 7 (issue #206, design doc §9/§13/§14 rule 4).
 *
 * This file previously mounted the live Convex half of the shell:
 * `AppConvexProvider` wrapped `ConvexBetterAuthProvider` (the Better Auth
 * session feeding the deployment's Convex JWT) around `ConvexProvider`, and
 * the module-level `convexQueryClient` (`ConvexQueryClient`) bridged Convex
 * subscriptions into the TanStack Query cache — `queryFn`/`hashFn`/
 * `connect` wired in `#/integrations/tanstack-query/root-provider.tsx`, with
 * `useConvexAuth` answering the auth gate and `useQuery(api.cms.*` serving
 * the legacy dataset surfaces.
 *
 * The stage-7 disconnect unmounted all of it: `routes/__root.tsx` no longer
 * renders `AppConvexProvider`, the root provider no longer installs the
 * Convex `queryFn`/`hashFn`, the auth gate reads the Supabase session alone,
 * and `VITE_CONVEX_URL` left `#/env`. The legacy-Convex dataset surfaces
 * render "archived in this build" states instead of live hooks (the recorded
 * stage-7 deviation), so no `convex/react` hook reaches a missing provider.
 *
 * The file is kept on disk (never deleted) with the untouched `app/convex/`
 * and `packages/json-cms/` trees as the migration's revert path (design doc
 * §14 rule 3). Wiring it back means restoring the provider composition
 * above, the env vars, and the surface splits — see
 * `docs/supabase-migration-design.md` §9 for the two-session shape this
 * replaces.
 */

// oxlint-disable-next-line unicorn/require-module-specifiers -- a comment-only tombstone module; the empty export keeps it a module (no no-empty-file) without reviving any live wiring.
export {};
