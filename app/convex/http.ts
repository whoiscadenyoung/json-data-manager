import { httpRouter } from "convex/server";

import { authComponent, createAuth } from "./auth";

/**
 * Better Auth's HTTP surface: sign-in/sign-up, sessions, callback handlers
 * and the Convex token/JWKS endpoints the convex() plugin adds. All live
 * under the plugin's default basePath `/api/auth`; the Start server proxies
 * the browser's same-origin /api/auth requests here
 * (src/routes/api/auth/$.tsx → src/lib/auth-server.ts), so the browser never
 * talks to the convex.site domain directly. Lazy registration keeps Better
 * Auth from initializing during deploys (the component's OOM guard).
 */
const http = httpRouter();

authComponent.registerRoutesLazy(http, createAuth, {
  basePath: "/api/auth",
  cors: true,
  trustedOrigins: [process.env.SITE_URL ?? "http://localhost:3000"],
});

export default http;
