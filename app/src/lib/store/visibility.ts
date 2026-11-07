import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryScalar, type StoreOptions } from "./client";

/**
 * The unified visibility ladder (issue #260 — the project-centric train's
 * phase 6; docs/project-centric-experience-design.md §6, §7 D4; ADR 0022).
 *
 * ONE vocabulary on every published artifact — datasets, layers, maps,
 * apps and the project itself — replacing the fragments
 * (`datasets.published_visibility everyone|author`, `apps.sharing
 * private|link`). The rungs:
 *
 *   `members`    — the project-membership gate (the [project 1] tables).
 *   `signed-in`  — any authenticated user (ADR 0009's trusted-collaborator
 *                  posture, the default for published work).
 *   `link`       — unauthenticated access by URL (anon gates exist on the
 *                  frozen rows; the serving paths are [project 7]'s).
 *   `public`     — link + discoverable in the explorers.
 *
 * The closure rule (§6.2) lives in the two RPCs below: sharing at level L
 * validates the whole reference closure (app → its maps + datasets → each
 * map's layers → each layer's dataset, linked foreign pins included) and
 * NEVER widens without the caller's explicit confirm — the preflight
 * names every promotion and every blocker (a member below the target the
 * caller cannot edit — a foreign author-only pin caps the share; P5:
 * effective consumer access = min over the closure).
 */

/** The ladder, bottom to top. */
export const VISIBILITY_LEVELS = ["members", "signed-in", "link", "public"] as const;

export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

/** The ladder's total order — a higher rank is a WIDER share. */
export function visibilityRank(level: VisibilityLevel): number {
  return VISIBILITY_LEVELS.indexOf(level);
}

/** True when moving from `from` to `to` widens the share (the preflight's trigger). */
export function isWidening(from: VisibilityLevel, to: VisibilityLevel): boolean {
  return visibilityRank(to) > visibilityRank(from);
}

/** One closure member the preflight offers to widen (the caller can edit it). */
export interface VisibilityPromotion {
  kind: "dataset" | "layer" | "map" | "app" | "project";
  id: string;
  name: string;
  from: VisibilityLevel;
  to: VisibilityLevel;
}

/** One closure member below the target the caller CANNOT edit — named, never widened. */
export interface VisibilityBlocker {
  kind: "dataset" | "layer" | "map" | "app" | "project";
  id: string;
  name: string;
  current: VisibilityLevel;
  /** The blocker's home project (null for global datasets) — the "request access" surface. */
  projectId: string | null;
}

/** The {@link visibilityPreflight} report (the RPC's jsonb, typed). */
export interface PreflightReport {
  target: VisibilityLevel;
  /** min(closure) AFTER the promotions — a blocker caps it below `target`. */
  effective: VisibilityLevel;
  promotions: VisibilityPromotion[];
  blockers: VisibilityBlocker[];
}

/** The {@link visibilityApply} outcome (the RPC's jsonb, typed). */
export interface ApplyReport {
  target: VisibilityLevel;
  effective: VisibilityLevel;
  applied: VisibilityPromotion[];
  blockers: VisibilityBlocker[];
}

/** The closure roots the RPCs accept (a project walks all of its artifacts). */
export type ClosureRootKind = VisibilityPromotion["kind"];

function parseReport<T extends PreflightReport | ApplyReport>(raw: unknown): T {
  if (raw === null || typeof raw !== "object") {
    throw new Error("The visibility RPC returned no report.");
  }
  return raw as T;
}

/**
 * The diff-style report for sharing `artifactId` at `target`: every
 * promotion (caller-editable members below the target) + every blocker +
 * the effective level. Read-only — nothing moves until
 * {@link visibilityApply}. Widening-only: a target at or below the
 * artifact's current rung answers an empty plan (narrowing rides the
 * plain RLS'd column update — no closure to validate).
 *
 * Throws the RPC's gate error when the caller cannot edit the root
 * artifact. The preflight is one of the store's imperative reads — run
 * through {@link preflightQueryOptions}.queryFn in client code (the
 * pg-bundle-publish posture).
 */
export async function visibilityPreflight(
  args: { kind: ClosureRootKind; artifactId: string; target: VisibilityLevel },
  options?: StoreOptions,
): Promise<PreflightReport> {
  const raw = await queryScalar<unknown>(
    clientOf(options).rpc("visibility_preflight", {
      p_artifact_id: args.artifactId,
      p_kind: args.kind,
      p_target: args.target,
    }),
  );
  return parseReport<PreflightReport>(raw);
}

/** The preflight as a TanStack Query read (the dialog's report fetch). */
export function preflightQueryOptions(
  args: { kind: ClosureRootKind; artifactId: string; target: VisibilityLevel },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:visibility", "preflight", args],
    queryFn: async () => await visibilityPreflight(args, options),
  });
}

/**
 * Applies the confirmed promotion plan: ONE transaction that widens
 * exactly the members the preflight named (re-walked server-side, per-
 * member edit rights re-checked as the definer), leaves blockers
 * untouched, and returns what moved + the blockers that remain. The root
 * itself is a closure member, so the confirm widens it too. Widening
 * only — a target at or below the current rung is a no-op.
 */
export async function visibilityApply(
  args: { kind: ClosureRootKind; artifactId: string; target: VisibilityLevel },
  options?: StoreOptions,
): Promise<ApplyReport> {
  const raw = await queryScalar<unknown>(
    clientOf(options).rpc("visibility_apply", {
      p_kind: args.kind,
      p_artifact_id: args.artifactId,
      p_target: args.target,
    }),
  );
  return parseReport<ApplyReport>(raw);
}
