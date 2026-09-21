import { convexBetterAuthReactStart } from "@convex-dev/better-auth/react-start";

import { env } from "#/env";

/**
 * The Start-server half of Better Auth: `handler` serves /api/auth/* (the
 * browser-facing proxy to the Convex component's HTTP routes, wired in
 * src/routes/api/auth/$.tsx) and `getToken` reads the session's Convex JWT
 * from cookies for authenticated SSR data loading (unused while all app
 * queries are public, but the wiring the guide expects).
 */
export const { fetchAuthAction, fetchAuthMutation, fetchAuthQuery, getToken, handler } =
  convexBetterAuthReactStart({
    convexSiteUrl: env.VITE_CONVEX_SITE_URL,
    convexUrl: env.VITE_CONVEX_URL,
  });
