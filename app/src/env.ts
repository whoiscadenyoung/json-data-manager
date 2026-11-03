import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
    VITE_CONVEX_URL: z.url(),
    // The deployment's .site counterpart — the auth server proxy forwards
    // Better Auth requests here (src/lib/auth-server.ts).
    VITE_CONVEX_SITE_URL: z.url(),
    // Supabase (stage 0, design doc §2): the stack's API URL and the
    // RLS-scoped anon key. Both stay validated alongside the Convex vars —
    // they only leave env.ts at the stage-7 disconnect, like the Convex pair.
    VITE_SUPABASE_URL: z.url(),
    VITE_SUPABASE_ANON_KEY: z.string().min(1),
  },

  /**
   * The prefix that client-side variables must have. This is enforced both at
   * a type-level and at runtime.
   */
  clientPrefix: "VITE_",

  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,

  /**
   * What object holds the environment variables at runtime. This is usually
   * `process.env` or `import.meta.env`.
   */
  runtimeEnv: import.meta.env,

  server: {
    SERVER_URL: z.url().optional(),
  },
});
