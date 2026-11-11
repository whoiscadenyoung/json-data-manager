import postgres, { type Sql } from "postgres";

import { defaultViewCompiler } from "#/lib/views/view-compiler-wiring";

import { verifyAccessToken } from "./claims";
import { jsonPassthroughTypes } from "./pg-types";
import { drainRefreshQueue, readLiveAs, setRefreshModeAs, type RefreshMode } from "./refresh";
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
    ...positiveEnv("VIEW_LIVE_TIMEOUT_MS", "liveTimeoutMs"),
    ...positiveEnv("VIEW_LIVE_ROW_CAP", "liveRowCap"),
  };
}

function positiveEnv<K extends "liveTimeoutMs" | "liveRowCap">(
  name: string,
  key: K,
): Partial<Record<K, number>> {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a single computed key of K.
  return (Number.isFinite(value) && value > 0 ? { [key]: value } : {}) as Partial<
    Record<K, number>
  >;
}

/** A live view's rows, computed now as the token's user (capped, read-only). */
export async function readLiveForToken(accessToken: string, viewId: string) {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  return await readLiveAs(depsFromEnv(), who, viewId);
}

/** Moves a view to manual/auto/live as the token's user (auto runs as them from now on). */
export async function setRefreshModeForToken(
  accessToken: string,
  viewId: string,
  mode: RefreshMode,
): Promise<void> {
  const who = verifyAccessToken(accessToken, requireEnv("JWT_SECRET"));
  await setRefreshModeAs(depsFromEnv(), who, viewId, mode);
}

let loop: ReturnType<typeof setInterval> | undefined;

/**
 * Starts the `auto` refresh drain (once per process): every
 * `VIEW_REFRESH_POLL_MS` (default 15 s) it claims due queue rows and runs
 * them. A no-op without `DATABASE_URL`; `VIEW_REFRESH_POLL_MS=0` disables it.
 */
export function startRefreshLoop(): void {
  const url = process.env["DATABASE_URL"];
  const raw = process.env["VIEW_REFRESH_POLL_MS"];
  const every = raw === undefined || raw === "" ? 15_000 : Number(raw);
  if (loop !== undefined || url === undefined || url === "" || !(every > 0)) {
    return;
  }
  let busy = false;
  loop = setInterval(() => {
    if (busy) {
      return;
    }
    busy = true;
    drainRefreshQueue(depsFromEnv())
      .catch((error: unknown) => {
        console.error("[view-refresh] drain failed:", error);
      })
      .finally(() => {
        busy = false;
      });
  }, every);
  loop.unref();
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
