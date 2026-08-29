import type { Auth } from "convex/server";

// TODO(auth): the app has no authentication yet, so allow anonymous access
// for every operation to preserve current open behavior. Tighten this once
// the app gains real auth.
export async function auth(_ctx: { auth: Auth }): Promise<string> {
  return "anonymous";
}
