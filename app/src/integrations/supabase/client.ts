import { createBrowserClient } from "@supabase/ssr";

import { env } from "#/env";

/**
 * The browser Supabase client — PostgREST, Auth, Realtime, and Storage over
 * the RLS-scoped anon key (design doc §2; only the app ever imports
 * supabase-js, never a `@caden/*` package).
 *
 * `@supabase/ssr` persists the session in cookies instead of localStorage so
 * a TanStack Start server request can read the same session from its request
 * cookies once the server client lands (design doc §9) — that cookie ride is
 * the whole reason this is not a plain `createClient`. At stage 0 the browser
 * is the only consumer: on the server this constructor is inert (token
 * auto-refresh and URL detection switch off outside the browser, cookie
 * reads see nothing), and SSR knows nothing of the session, exactly as with
 * the Convex gate.
 *
 * The `Database` generic is unwired until `integrations/supabase/types.ts`
 * is generated from the live stack (`supabase gen types typescript --local`,
 * design doc §15).
 */
export const supabase = createBrowserClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  isSingleton: true,
});
