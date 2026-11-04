import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";

/**
 * The projects store (design doc §8.1 "projects.ts # projects/artifacts";
 * stage 4, issue #203) — the PG counterpart of the Convex
 * `api.publishing.projects.*` domain over `public.projects` +
 * `public.project_artifacts` (DDL §3.5, migration 0009).
 *
 * Parity notes (each traces to `app/convex/publishing/projects.ts`):
 *   - Projects are per-creator PRIVATE (stage-8 ownership, #104 — "the one
 *     shared-artifact exception"): RLS is creator-only, so every read below
 *     is the caller's own rows and a foreign id reads as not-found — the
 *     same answer `projects.get` gave everyone else.
 *   - `artifact_count` is denormalized and kept in lockstep by the database
 *     (the migration's statement triggers — the component's same-transaction
 *     patch, enforced for every writer); this module never sends it.
 *   - Membership rows, never an array field (the component's recorded
 *     reason: membership grows unbounded and every add would rewrite the
 *     project).
 *   - A dataset membership mints its fork's version-reference edge with the
 *     membership — one float `consumer_references` row, consumer_id = the
 *     membership row id (addArtifact's fork leg, projects.ts:385-393); the
 *     edge dies with the membership (removeArtifact's edge walk). "Fork =
 *     add-to-project": references, never copies.
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): RLS-filtered writes answer 0 rows instead of
 * throwing — a foreign project's write reads as not-found, exactly like the
 * creator check answered.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One project (the virtual working layer — always draft-side; no lifecycle field on purpose). */
export interface ProjectRow {
  id: string;
  title: string;
  description: string | null;
  /** Denormalized membership total — trigger-maintained, never client-sent. */
  artifactCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One project ↔ artifact membership row (references, never containment). */
export interface ProjectArtifactRow {
  id: string;
  projectId: string;
  /** The referenced artifact — one text id space across kinds; `artifactKind` says which table answers. */
  artifactId: string;
  artifactKind: "dataset" | "derived" | "map";
  addedBy: string;
}

const PROJECT_SELECT =
  "id,title,description,artifactCount:artifact_count,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";
const ARTIFACT_SELECT =
  "id,projectId:project_id,artifactId:artifact_id,artifactKind:artifact_kind,addedBy:added_by";

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function, design §8.1)
// ---------------------------------------------------------------------------

/** The caller's own projects, newest first — `projects.list` parity (RLS scopes to the creator). */
export function listQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:projects", "list"],
    queryFn: async () =>
      await queryRows<ProjectRow>(
        clientOf(options)
          .from("projects")
          .select(PROJECT_SELECT)
          .order("created_at", { ascending: false })
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

/** One project by id, or null when it isn't the caller's (invisible reads as not-found). */
export function getQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:projects", "get", args],
    queryFn: async () =>
      await queryRow<ProjectRow>(
        clientOf(options).from("projects").select(PROJECT_SELECT).eq("id", args.projectId).limit(1),
      ),
  });
}

/** One project's membership rows — the workspace read. */
export function listArtifactsQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:projects", "listArtifacts", args],
    queryFn: async () =>
      await queryRows<ProjectArtifactRow>(
        clientOf(options)
          .from("project_artifacts")
          .select(ARTIFACT_SELECT)
          .eq("project_id", args.projectId)
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

// ---------------------------------------------------------------------------
// Writes — rows-affected returns (the stage-4 silent-denial rule)
// ---------------------------------------------------------------------------

/** The project write may set — the component `create`/update arg set (title is the only required field, the UI rule). */
export interface ProjectArgs {
  title: string;
  description?: string;
}

/** The component's create/update validation ("Project must have a name" — projects.ts:248-260's create; the collections rule everywhere). */
function assertNamed(args: { title: string }): void {
  if (!args.title.trim()) {
    throw new Error("Project must have a name");
  }
}

/** Creates a project. Returns the new row's id. */
export async function create(args: ProjectArgs, options?: StoreOptions): Promise<string> {
  assertNamed(args);
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("projects")
      .insert({
        ...(args.description === undefined ? {} : { description: args.description }),
        title: args.title,
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Project insert returned no row.");
  }
  return row.id;
}

/** Updates the project's title/description (absent fields stay untouched; artifact_count is trigger-only). Returns the affected row count. */
export async function update(
  args: { projectId: string } & Partial<ProjectArgs>,
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) {
    assertNamed({ title: args.title });
    patch.title = args.title;
  }
  if (args.description !== undefined) {
    patch.description = args.description;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Project update needs a field to set.");
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("projects").update(patch).eq("id", args.projectId).select("id"),
  );
  return rows.length;
}

/**
 * Deletes the project; memberships cascade with it (and their fork edges go
 * first — see removeArtifact). Returns the affected row count.
 *
 * The membership walk PAGINATES (the stage-7 parity fix for the tranche-3
 * finding): CATALOG_READ_LIMIT is a read cap, not a membership bound — a
 * project past 1000 artifacts used to leave its tail's fork edges dangling
 * (consumer_id is the membership row's id, a text column with no FK, so the
 * project cascade cannot reach them). Keyset by membership id; each page's
 * edges die before the next page is read.
 */
export async function remove(args: { projectId: string }, options?: StoreOptions): Promise<number> {
  const client = clientOf(options);
  let cursorId: string | undefined;
  for (;;) {
    const pageQuery = client
      .from("project_artifacts")
      .select("id")
      .eq("project_id", args.projectId)
      .order("id")
      .limit(CATALOG_READ_LIMIT);
    // oxlint-disable-next-line no-await-in-loop -- the walk paginates: each page's edges must die before the next page is read (the dangling-edge fix is the point).
    const members = await queryRows<{ id: string }>(
      cursorId === undefined ? pageQuery : pageQuery.gt("id", cursorId),
    );
    if (members.length === 0) {
      break;
    }
    // The fork edges minted with each membership die with it (the
    // removeArtifact walk). Independent deletes: parallel.
    // oxlint-disable-next-line no-await-in-loop -- each page's edge deletes settle before the next page (the cascade cannot reach these rows; see the doc comment).
    await Promise.all(
      members.map(
        async (member) =>
          await queryRows<{ id: string }>(
            client
              .from("consumer_references")
              .delete()
              .eq("consumer_id", member.id)
              .eq("consumer_kind", "fork")
              .select("id"),
          ),
      ),
    );
    const last = members[members.length - 1];
    if (last === undefined) {
      break;
    }
    cursorId = last.id;
    if (members.length < CATALOG_READ_LIMIT) {
      break;
    }
  }
  const rows = await queryRows<{ id: string }>(
    client.from("projects").delete().eq("id", args.projectId).select("id"),
  );
  return rows.length;
}

export interface AddArtifactResult {
  artifact: ProjectArtifactRow | null;
  /** Rows written for the fork's float reference edge (dataset members only; 0 when denied). */
  edgeRows: number;
}

/**
 * Adds one artifact to a project — the `addArtifact` parity: references,
 * never copies; a dataset membership mints its fork's FLOAT reference edge
 * in the same flow (consumer_id = the membership row id; pin later through
 * versions.setReferenceMode). A duplicate (project, kind, artifact) raises
 * the 23505 constraint (the DB PK/UQ enforces what the Convex in-transaction
 * re-check did). Returns the membership row (null = denied — not the
 * project's owner) and the edge rows written.
 */
export async function addArtifact(
  args: { projectId: string; artifactId: string; artifactKind: "dataset" | "derived" | "map" },
  options?: StoreOptions,
): Promise<AddArtifactResult> {
  const client = clientOf(options);
  const artifact = await queryRow<ProjectArtifactRow>(
    client
      .from("project_artifacts")
      .insert({
        artifact_id: args.artifactId,
        artifact_kind: args.artifactKind,
        project_id: args.projectId,
      })
      .select(ARTIFACT_SELECT)
      .single(),
  );
  if (artifact === null) {
    return { artifact: null, edgeRows: 0 };
  }
  if (args.artifactKind !== "dataset") {
    return { artifact, edgeRows: 0 };
  }
  // The fork's version-reference edge, born with the membership — float by
  // default (the registry save path's precedent; pin later).
  const edgeRows = await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .insert({
        consumer_id: artifact.id,
        consumer_kind: "fork",
        mode: "float",
        source_dataset_id: args.artifactId,
      })
      .select("id"),
  );
  return { artifact, edgeRows: edgeRows.length };
}

export interface RemoveArtifactResult {
  /** Rows deleted from project_artifacts (0 = denied/gone). */
  affected: number;
  /** Fork reference edges removed with the membership. */
  edgeRows: number;
}

/**
 * Removes one membership row — and the fork's consumer edges minted with it
 * (a reference's version leg lives and dies with the membership).
 * Deliberately touches NOTHING else: the referenced artifact stays exactly
 * as it was (references, not containment — removing a dataset from a
 * project never deletes the dataset).
 */
export async function removeArtifact(
  args: { artifactId: string; projectId: string },
  options?: StoreOptions,
): Promise<RemoveArtifactResult> {
  const client = clientOf(options);
  const membership = await queryRow<ProjectArtifactRow>(
    client
      .from("project_artifacts")
      .select(ARTIFACT_SELECT)
      .eq("artifact_id", args.artifactId)
      .eq("project_id", args.projectId)
      .limit(1),
  );
  if (membership === null) {
    return { affected: 0, edgeRows: 0 };
  }
  const edgeRows = await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .delete()
      .eq("consumer_id", membership.id)
      .eq("consumer_kind", "fork")
      .select("id"),
  );
  const rows = await queryRows<{ id: string }>(
    client.from("project_artifacts").delete().eq("id", membership.id).select("id"),
  );
  return { affected: rows.length, edgeRows: edgeRows.length };
}
