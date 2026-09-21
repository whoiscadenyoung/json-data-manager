import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexProvider } from "convex/react";

import { env } from "#/env";
import { authClient } from "#/lib/auth-client";

/**
 * The bridge between Convex subscriptions and the TanStack Query cache. The
 * `ConvexProvider` half keeps `convex/react` hooks working as always; the
 * TanStack half (`hashFn`/`queryFn`/`connect`, wired in
 * `#/integrations/tanstack-query/root-provider.tsx`) is what lets the light
 * queries render from — and persist through — the query cache (issue #58
 * part 5).
 */
export const convexQueryClient = new ConvexQueryClient(env.VITE_CONVEX_URL);

/**
 * The Better Auth wrapper feeds the session's Convex JWT to the same Convex
 * client (setAuth/clearAuth as the session changes), so `useConvexAuth` and
 * any authenticated function calls share the WebSocket the app already uses.
 */
export function AppConvexProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConvexBetterAuthProvider authClient={authClient} client={convexQueryClient.convexClient}>
      <ConvexProvider client={convexQueryClient.convexClient}>{children}</ConvexProvider>
    </ConvexBetterAuthProvider>
  );
}
