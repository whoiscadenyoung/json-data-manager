import { authClient } from "#/lib/auth-client";

/**
 * The current session's Convex JWT, for standalone `ConvexClient`s that sit
 * outside the authenticated React provider: the row-resolution seam's
 * imperative client (dataset-rows.ts) and the tile-archive worker's
 * client. Since the sign-in gate (roadmap 0.1) every data call
 * needs identity — without `setAuth` these clients fail the gate even for
 * signed-in users.
 *
 * NEVER rejects: `throw: false` converts non-ok responses into a null-data
 * result, but a transport-level failure (offline, connection reset) still
 * rejects the underlying fetch — and a rejecting fetcher would wedge a
 * `setAuth` caller waiting on it (the worker's token round-trip registers a
 * resolver that only a reply settles). Any failure therefore folds into the
 * signed-out path: null, so the client runs unauthenticated and data calls
 * fail the gate with the sign-in error. Fresh per invocation — the convex
 * plugin's JWTs live only ~15 minutes, and `ConvexClient.setAuth`
 * re-invokes its fetcher when the token nears expiry, so long page streams
 * outlive any single token.
 */
export async function fetchConvexToken(): Promise<string | null> {
  let result: Awaited<ReturnType<typeof authClient.convex.token>>;
  try {
    result = await authClient.convex.token({ fetchOptions: { throw: false } });
  } catch {
    return null;
  }
  const data = result.data;
  if (data === null || data === undefined) {
    return null;
  }
  return typeof data.token === "string" ? data.token : null;
}
