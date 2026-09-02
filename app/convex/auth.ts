import type { Auth } from "convex/server";

// TODO(auth): the app has no authentication yet, so allow anonymous access
// For every operation to preserve current open behavior. Tighten this once
// The app gains real auth.
export async function auth(_ctx: { auth: Auth }): Promise<string> {
  return "anonymous";
}
