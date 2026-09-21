import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Convex-side JWT verification for the Better Auth session tokens issued by
 * the better-auth Convex component. With no static JWKS passed, the
 * provider points Convex at the component's own JWKS endpoint
 * (`/api/auth/convex/jwks` on this deployment's site URL), so key rotation
 * needs no env var churn. This file is the #1 silent-always-signed-out
 * footgun: it must exist and stay in sync with the convex() plugin in
 * auth.ts or every request verifies as unauthenticated with no error.
 */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
