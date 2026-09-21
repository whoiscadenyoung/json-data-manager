import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client. Base URL defaults to same-origin
 * `/api/auth`, which the Start server route proxies to the Convex
 * component — so no auth endpoint URL is baked in here. The convexClient
 * plugin pairs this client with ConvexBetterAuthProvider, which feeds the
 * session's Convex JWT to the WebSocket client.
 */
export const authClient = createAuthClient({
  plugins: [convexClient()],
});
