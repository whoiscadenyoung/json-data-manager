import { httpRouter } from "convex/server";

import { authComponent, createAuth, siteUrl } from "./auth";

/**
 * Better Auth's HTTP surface: sign-in, sessions, callback handlers and the
 * Convex token/JWKS endpoints the convex() plugin adds (sign-up is disabled
 * on this public surface — accounts are minted through auth.ts's internal
 * `createAccount`, issue #136). All live under the plugin's default basePath
 * `/api/auth`; the Start server proxies the browser's same-origin /api/auth
 * requests here (src/routes/api/auth/$.tsx → src/lib/auth-server.ts), so the
 * browser never talks to the convex.site domain directly. Lazy registration
 * keeps Better Auth from initializing during deploys (the component's OOM
 * guard). `siteUrl` is the fail-closed resolution from auth.ts — it throws
 * at init when SITE_URL is unset on a non-dev deployment.
 */
const http = httpRouter();

authComponent.registerRoutesLazy(http, createAuth, {
  basePath: "/api/auth",
  cors: true,
  trustedOrigins: [siteUrl],
});

export default http;
