import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
    // Supabase (design doc §2): the stack's API URL and the RLS-scoped anon
    // key. The stage-7 disconnect (issue #206) removed the Convex pair
    // (`VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL`) from this shape entirely —
    // the Convex provider is unmounted and the Better Auth token feed is
    // retired; the preserved reference code under `app/convex/` and
    // `packages/json-cms/` never reads this module.
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
