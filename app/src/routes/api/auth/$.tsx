import { createFileRoute } from "@tanstack/react-router";

import { handler } from "#/lib/auth-server";

/**
 * Same-origin proxy for Better Auth: every auth request the browser makes
 * lands here and is forwarded to the Convex component's HTTP routes by the
 * react-start handler, which also forwards cookies both ways. Server-only
 * route — no component.
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => handler(request),
      POST: async ({ request }) => handler(request),
    },
  },
});
