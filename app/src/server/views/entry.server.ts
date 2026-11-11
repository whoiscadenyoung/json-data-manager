import postgres, { type Sql } from "postgres";

import { defaultViewCompiler } from "#/lib/views/view-compiler-wiring";

import { verifyAccessToken } from "./claims";
import { jsonPassthroughTypes } from "./pg-types";
import {
  DEFAULT_TIMEOUT_MS,
  previewAs,
  runReadOnlyAsUser,
  runViewAs,
  type PreviewResult,
  type PreviewTarget,
  type RunOutcome,
  type RunnerDeps,
} from "./runner";
import { scratchAs, type ScratchResult } from "./scratch";

/**
 * Server-only wiring for the view runner: the environment, the Postgres
 * connection, token verification. Imported ONLY from inside server-function
 * handlers (`functions.ts`), never statically, so none of it reaches the
 * client bundle.
 *
 * Environment (server-only; never VITE_-prefixed):
 * - `DATABASE_URL`  Postgres connection for the runner. A login role that is
 *   a member of `view_runner` (compose: `jdm_server`; dev/CI: the superuser).
 * - `JWT_SECRET`    the stack's JWT secret (GoTrue signs user tokens with it).
 * - `VIEW_RUN_TIMEOUT_MS`  phase-1 `statement_timeout` (default 60000).
 */

let shared: Sql | undefined;

/** The runner's connection factory (also used by the int tests). */
export function connect(url: string, max = 5): Sql {
  return postgres(url, { max, onnotice: () => undefined, types: jsonPassthroughTypes });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set: the view runner needs it (see .env.example).`);
  }
  return value;
}

function sqlConnection(): Sql {
  if (shared === undefined) {
    shared = connect(requireEnv("DATABASE_URL"));
  }
  return shared;
}

function depsFromEnv(): RunnerDeps {
  const raw = process.env["VIEW_RUN_TIMEOUT_MS"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return {
    sql: sqlConnection(),
    compiler: defaultViewCompiler,
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS,
  };
}

export async function runViewForToken(accessToken: string, viewId: string): Promise<RunOutcome> {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  return await runViewAs(depsFromEnv(), who, viewId);
}

export async function previewForToken(
  accessToken: string,
  target: PreviewTarget,
): Promise<PreviewResult> {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  return await previewAs(depsFromEnv(), who, target);
}

/** Raw read-only SELECT as the token's user (Scratch query, #306): same guards as a run's read phase. */
export async function readOnlyForToken(
  accessToken: string,
  sql: string,
  params: unknown[],
  maxRows?: number,
) {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  return await runReadOnlyAsUser(depsFromEnv(), who, sql, params, { maxRows });
}

/** The project's scratch tables, and (when `sql` is given) the result of running it, as the token's user (#306). */
export async function scratchForToken(
  accessToken: string,
  projectId: string,
  sql: string | undefined,
): Promise<ScratchResult> {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  return await scratchAs(depsFromEnv(), who, projectId, sql);
}
