import { z } from "zod";

import { assertLiveAllowed, isSpatialStep } from "#/lib/views/spatial";

import type { VerifiedClaims } from "./claims";
import {
  actAs,
  executeCapped,
  LIVE_ROW_CAP,
  LIVE_TIMEOUT_MS,
  loadSaved,
  metaOf,
  readAs,
  refsOf,
  runViewAs,
  validated,
  type Json,
  type RunnerDeps,
} from "./runner";

/**
 * Refresh modes (issue #305; docs/views-design.md §7).
 *
 * - LIVE: {@link readLiveAs} runs the compiled SQL as the READER (phase 1
 *   only: read-only, rolled back, statement timeout, row cap). Nothing is
 *   saved; the previous snapshot rows are ignored in live mode.
 * - AUTO: a trigger queues a run when an input's `data_version` moves
 *   (`view_refresh_queue`, coalescing window 60 s); {@link drainRefreshQueue}
 *   claims due refreshes and runs each through the ordinary two-phase runner
 *   as the user who enabled auto (`datasets.auto_refresh_by`). Phase 2 is the
 *   same definer function a manual run uses, so user SQL never runs in a
 *   writable transaction.
 */

// ---------------------------------------------------------------------------
// Switching modes
// ---------------------------------------------------------------------------

export type RefreshMode = "manual" | "auto" | "live";

/**
 * Moves a view to `mode` as the verified user (the database requires
 * `can_edit_dataset`). `live` is refused here for a view with a spatial step;
 * the check also runs again on every live read, because the definition can
 * change after the mode was set.
 */
export async function setRefreshModeAs(
  deps: RunnerDeps,
  who: VerifiedClaims,
  viewId: string,
  mode: RefreshMode,
): Promise<void> {
  if (mode === "live") {
    await readAs(deps, who, async (tx) => {
      const saved = await loadSaved(tx, viewId);
      const meta = await metaOf(tx, refsOf(saved.inputs));
      assertLiveAllowed(
        validated(deps, saved.definition, meta),
        deps.isSpatialStep ?? isSpatialStep,
      );
    });
  }
  await deps.sql.begin(async (tx) => {
    await actAs(tx, who);
    await tx.unsafe(`select public.set_view_refresh_mode($1::uuid, $2)`, [viewId, mode]);
  });
  if (mode === "live") {
    // Mirror the declared columns / geometry flag now (the table and the map
    // need them before anyone has read the view).
    await readLiveAs(deps, who, viewId).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

export interface LiveRead {
  /** `{row_id, d, geom}` per row; `geom` is GeoJSON or null. */
  rows: Record<string, Json>[];
  /** True when the result was cut at `rowCap`. */
  truncated: boolean;
  rowCap: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared property keys (first-seen order) and geometry types of a result, as `view_apply_run` derives them. */
export function liveShapeOf(rows: readonly Record<string, Json>[]): {
  properties: string[];
  geometryTypes: string[];
} {
  const keys = new Set<string>();
  const types = new Set<string>();
  for (const row of rows) {
    const d = row["d"];
    if (isRecord(d)) {
      for (const key of Object.keys(d)) {
        keys.add(key);
      }
    }
    const geom = row["geom"];
    if (isRecord(geom) && typeof geom["type"] === "string") {
      types.add(geom["type"]);
    }
  }
  return { properties: [...keys], geometryTypes: [...types] };
}

/**
 * A live view's rows, computed now, as the verified reader. RLS applies:
 * a reader who cannot see the view gets "not found", and one who cannot see
 * an input is refused loudly (never silently zero rows). The result is capped
 * at `liveRowCap`; a longer result is truncated and flagged.
 */
export async function readLiveAs(
  deps: RunnerDeps,
  who: VerifiedClaims,
  viewId: string,
): Promise<LiveRead> {
  const rowCap = deps.liveRowCap ?? LIVE_ROW_CAP;
  const liveDeps = { ...deps, timeoutMs: deps.liveTimeoutMs ?? LIVE_TIMEOUT_MS };
  const read = await readAs(liveDeps, who, async (tx) => {
    const saved = await loadSaved(tx, viewId);
    if (saved.refreshMode !== "live") {
      throw new Error(`View ${viewId} is not a live view.`);
    }
    const meta = await metaOf(tx, refsOf(saved.inputs));
    const def = validated(deps, saved.definition, meta);
    assertLiveAllowed(def, deps.isSpatialStep ?? isSpatialStep);
    return await executeCapped(tx, deps.compiler.compileView(def, meta), rowCap, "rows");
  });
  await syncLiveMeta(deps, who, viewId, read.rows);
  return { ...read, rowCap };
}

/** Mirrors the declared columns / geometry flag onto the dataset row (editors only; a silent no-op otherwise and on any error). */
async function syncLiveMeta(
  deps: RunnerDeps,
  who: VerifiedClaims,
  viewId: string,
  rows: readonly Record<string, Json>[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const shape = liveShapeOf(rows);
  try {
    await deps.sql.begin(async (tx) => {
      await actAs(tx, who);
      await tx.unsafe(`select public.view_sync_live_meta($1::uuid, $2::jsonb, $3::text[])`, [
        viewId,
        JSON.stringify(shape.properties),
        // postgres.js sends a JS array as a Postgres array for a text[] cast.
        shape.geometryTypes,
      ]);
    });
  } catch {
    // Metadata is a convenience; the read itself already succeeded.
  }
}

// ---------------------------------------------------------------------------
// The auto drain
// ---------------------------------------------------------------------------

export interface RefreshReport {
  viewId: string;
  runAs: string;
  status: "ok" | "error";
  error?: string;
}

const claimedRows = z.array(z.object({ view_id: z.string(), run_as: z.string() }));

/** The identity an auto run executes as: a claim set for a stored user id (the server trusts its own database). */
export function identityClaims(userId: string): VerifiedClaims {
  return {
    sub: userId,
    role: "authenticated",
    claims: { sub: userId, role: "authenticated", aud: "authenticated" },
  };
}

/**
 * Claims up to `limit` due refreshes and runs them, one at a time, as each
 * view's recorded identity. A run that errors keeps the last good rows and
 * records an errored `view_runs` row; when the identity has lost access (so
 * the normal failure path is refused too) the error is recorded by
 * `view_refresh_record_failure` instead. Every claim is released.
 */
export async function drainRefreshQueue(
  deps: RunnerDeps,
  options: { limit?: number } = {},
): Promise<RefreshReport[]> {
  const rows = await deps.sql.unsafe(`select view_id, run_as from public.view_refresh_claim($1)`, [
    options.limit ?? 5,
  ]);
  const claims = claimedRows.parse(
    rows.map((row) => ({ view_id: row.view_id, run_as: row.run_as })),
  );
  const reports: RefreshReport[] = [];
  for (const claim of claims) {
    // oxlint-disable-next-line no-await-in-loop -- one run at a time keeps the server's load flat; each view is already single-flight.
    reports.push(await refreshOne(deps, claim.view_id, claim.run_as));
  }
  return reports;
}

async function refreshOne(deps: RunnerDeps, viewId: string, runAs: string): Promise<RefreshReport> {
  const startedAt = new Date().toISOString();
  let report: RefreshReport;
  try {
    const outcome = await runViewAs(deps, identityClaims(runAs), viewId);
    if (outcome.status === "ok") {
      report = { viewId, runAs, status: "ok" };
    } else {
      report = { viewId, runAs, status: "error", error: outcome.error };
      if (outcome.runId === null) {
        await recordFailure(deps, viewId, outcome.error, startedAt);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = { viewId, runAs, status: "error", error: message };
    await recordFailure(deps, viewId, `auto refresh as ${runAs} failed: ${message}`, startedAt);
  }
  try {
    await deps.sql.unsafe(`select public.view_refresh_finish($1::uuid)`, [viewId]);
  } catch {
    // The claim expires on its own after 15 minutes.
  }
  return report;
}

async function recordFailure(
  deps: RunnerDeps,
  viewId: string,
  error: string,
  startedAt: string,
): Promise<void> {
  try {
    await deps.sql.unsafe(
      `select public.view_refresh_record_failure($1::uuid, $2, $3::timestamptz)`,
      [viewId, error, startedAt],
    );
  } catch {
    // Nothing more can be done; the next drain retries the view.
  }
}
