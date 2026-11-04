import { createFileRoute } from "@tanstack/react-router";

/**
 * RETIRED at stage 7 (issue #206, design doc §9 "Token plumbing retired"):
 * this route used to proxy every Better Auth request to the Convex
 * component's HTTP routes (the Better-Auth→Convex JWT feed's server half,
 * `#/lib/auth-server`). The Convex provider is unmounted and sign-in writes
 * only the Supabase session now, so the app never calls this surface —
 * anything that still reaches it gets a definitive 410 rather than a proxy
 * error against a deployment the shell no longer wires.
 *
 * The route file stays on disk (never deleted); `#/lib/auth-server` remains
 * beside it as the preserved reference for the revert path.
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async () => {
        return new Response(
          "Better Auth was retired with the Convex disconnect (stage 7) — the app signs in through Supabase Auth only.",
          { status: 410 },
        );
      },
      POST: async () => {
        return new Response(
          "Better Auth was retired with the Convex disconnect (stage 7) — the app signs in through Supabase Auth only.",
          { status: 410 },
        );
      },
    },
  },
});
