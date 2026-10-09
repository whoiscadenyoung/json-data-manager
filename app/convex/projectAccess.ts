import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * The project access rules (phase 1 of the project-workspace design, ADR
 * 0011) as plain helpers, in their own module so the two surfaces that need
 * them — projects.ts (the project's own functions) and auth.ts (the app's
 * identity choke point) — share one implementation without a circular import
 * (projects.ts imports auth.ts; this module imports neither at runtime).
 *
 * The role order is total, owner > editor > viewer, and every check asks
 * "at least": a minimum of "editor" is what a write needs, "viewer" is what
 * a read needs, "owner" is member management and project deletion.
 */

export type ProjectRole = "owner" | "editor" | "viewer";

export const projectRoleValidator = v.union(
  v.literal("owner"),
  v.literal("editor"),
  v.literal("viewer"),
);

/**
 * Upper bound on how many projects may hold ONE artifact — the same
 * sharing-width cap projects.ts uses for its duplicate/removal lookups; the
 * draft-visibility check below answers exactly at any per-project member
 * count (the membership reads are per-project by_project lookups).
 */
const MAX_HOLDERS = 200;

/** True when `role` carries at least the authority of `min` (owner > editor > viewer). */
export function roleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  const rank: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };
  return rank[role] >= rank[min];
}

/**
 * The caller's role in one project, or null when they have none — the one
 * read every access check bottoms out in. Uniqueness of (projectId, userId)
 * is the membership mutations' in-transaction re-check (Convex has no unique
 * indexes — the addArtifact precedent); this read takes the first row the
 * by_project index answers with for the user, so a hypothetical duplicate
 * could only ever widen access, never narrow it.
 */
export async function projectRoleFor(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  userId: string,
): Promise<ProjectRole | null> {
  const row = await ctx.db
    .query("projectMembers")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .filter((q) => q.eq(q.field("userId"), userId))
    .first();
  return row === null ? null : row.role;
}

/** The doc a component getSchema read answers with — the fields the visibility rules read (a structural slice, the datasetVisibleTo precedent). */
type SchemaVisibilityDoc = {
  createdBy?: string;
  lifecycle?: "draft" | "published";
  publishedVisibility?: "author" | "everyone";
};

/**
 * The ids of the projects holding one artifact — a component dataset or a
 * derivedDatasets registry row (the two kinds a press or a write can
 * reach), bounded at MAX_HOLDERS (a membership row is the only thing that
 * makes a foreign row project-visible — no row, no grant).
 */
async function projectsHolding(
  ctx: Pick<QueryCtx, "db">,
  kind: "dataset" | "derived",
  artifactId: string,
): Promise<Id<"projects">[]> {
  const holders = await ctx.db
    .query("projectArtifacts")
    .withIndex("by_artifact", (q) => q.eq("artifactKind", kind).eq("artifactId", artifactId))
    .take(MAX_HOLDERS);
  return holders.map((row) => row.projectId);
}

/**
 * The dataset-visibility rule of ADR 0011, whole: a draft is readable by its
 * creator — OR by any member of a project holding it (any role, viewer
 * included); every other row keeps the catalog rule (creator-only for
 * `publishedVisibility: "author"`, everyone for ordinary published rows).
 * The catalog enumeration reads never consult this (the component scopes
 * them by viewerId — drafts stay out of the catalog); this is the by-id and
 * choke-point rule.
 */
export async function datasetVisibleTo(
  ctx: Pick<QueryCtx, "db">,
  schemaId: string,
  doc: SchemaVisibilityDoc,
  actorId: string,
): Promise<boolean> {
  if (doc.lifecycle !== "draft" && doc.publishedVisibility !== "author") {
    return true;
  }
  if (doc.createdBy === actorId) {
    return true;
  }
  for (const projectId of await projectsHolding(ctx, "dataset", schemaId)) {
    // oxlint-disable-next-line no-await-in-loop -- short-circuit: any single hit grants visibility, so the sequential early return IS the fast path.
    if ((await projectRoleFor(ctx, projectId, actorId)) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * The dataset-write rule of ADR 0011: a draft is writable by its creator —
 * OR by an owner/editor of a project holding it; a viewer-role member reads
 * the project's drafts and never writes them (the role matrix's whole
 * point). Non-draft rows are refused nowhere here — the trusted-collaborator
 * co-editable default (ADR 0009) and the locked editPolicy (ADR 0010) are
 * separate gates the callers already run.
 */
export async function datasetWritableBy(
  ctx: Pick<QueryCtx, "db">,
  schemaId: string,
  doc: SchemaVisibilityDoc,
  actorId: string,
): Promise<boolean> {
  if (doc.lifecycle !== "draft" || doc.createdBy === actorId) {
    return true;
  }
  for (const projectId of await projectsHolding(ctx, "dataset", schemaId)) {
    // oxlint-disable-next-line no-await-in-loop -- short-circuit: any single editor-or-owner hit grants the write, so the sequential early return IS the fast path.
    const role = await projectRoleFor(ctx, projectId, actorId);
    if (role !== null && roleAtLeast(role, "editor")) {
      return true;
    }
  }
  return false;
}

/**
 * The registry-row write rule of ADR 0011 (the derivedDatasets twin of
 * `datasetWritableBy`'s draft leg): a SAVED registry row in a project is
 * publishable by that project's owner/editor members, not its creator
 * alone — an editor pressing the bundle publishes the project's forks, not
 * just their own. Draft (builder-autosave) rows are refused nowhere here:
 * the caller's status check answers first, and a builder autosave is not a
 * project artifact in any meaningful sense (ADR 0011's registry-draft
 * boundary).
 */
export async function registryRowWritableBy(
  ctx: Pick<QueryCtx, "db">,
  rowId: string,
  actorId: string,
): Promise<boolean> {
  for (const projectId of await projectsHolding(ctx, "derived", rowId)) {
    // oxlint-disable-next-line no-await-in-loop -- short-circuit: any single editor-or-owner hit grants the write, so the sequential early return IS the fast path.
    const role = await projectRoleFor(ctx, projectId, actorId);
    if (role !== null && roleAtLeast(role, "editor")) {
      return true;
    }
  }
  return false;
}
