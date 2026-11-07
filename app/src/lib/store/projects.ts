import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";
import { REFERENCE_SELECT, VERSIONS_READ_LIMIT, type ConsumerReferenceRow } from "./versions";
import type { VisibilityLevel } from "./visibility";

/**
 * The projects store (design doc §8.1 "projects.ts # projects/artifacts";
 * stage 4, issue #203) — the PG counterpart of the Convex
 * `api.publishing.projects.*` domain over `public.projects` +
 * `public.project_artifacts` (DDL §3.5, migration 0009; catalog columns per
 * migration 0019 / ADR 0018, issue #256).
 *
 * Parity notes (each traces to `app/convex/publishing/projects.ts` unless
 * marked otherwise):
 *   - Projects are collaborative workspaces (0018/ADR 0017): reads are
 *     member-wide, content writes are editor+; a non-member's project reads
 *     as not-found and its writes answer 0 rows (the no-existence-leak
 *     posture — UPDATE/DELETE filter, INSERT raises).
 *   - `artifact_count` is denormalized and kept in lockstep by the database
 *     (the migration's statement triggers — the component's same-transaction
 *     patch, enforced for every writer); this module never sends it.
 *   - Membership rows, never an array field (the component's recorded
 *     reason: membership grows unbounded and every add would rewrite the
 *     project).
 *   - Membership edges (#256/ADR 0018): a LINKED dataset membership mints
 *     its version-reference edge with the membership (consumer_id = the
 *     membership row id) — pinned at the chain head when `sync_mode` is
 *     "manual", floating when "auto"; an OWNED membership mints none (the
 *     artifact is singly owned; its provenance is the role column). The
 *     edge dies with the membership (removeArtifact's edge walk; remove's
 *     paginated walk). "Fork = add-to-project": references, never copies.
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
  /** The project row's own visibility rung (#260, ADR 0022) — widening shares title/description/chips, never the artifacts (each rides its own rung). */
  visibility: VisibilityLevel;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** How a membership follows its source chain (linked datasets; ADR 0018). */
export type ArtifactSyncMode = "manual" | "auto";

/** One project ↔ artifact membership row (references, never containment). */
export interface ProjectArtifactRow {
  id: string;
  projectId: string;
  /** The referenced artifact — one text id space across kinds; `artifactKind` says which table answers. */
  artifactId: string;
  /** Map/app memberships arrive with their phases ([project 3]/[project 5]) — the kind domain is dataset|derived until then (0019). */
  artifactKind: "dataset" | "derived";
  /** Owned = created in-project (an owned draft, bound at birth); linked = added from the global catalog (ADR 0018). */
  role: "owned" | "linked";
  /** The linked reference's follow intent — manual pins at the add-time head, auto floats. Store-kept in lockstep with the edge's mode. */
  syncMode: ArtifactSyncMode;
  addedBy: string;
}

const PROJECT_SELECT =
  "id,title,description,artifactCount:artifact_count,visibility,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";
const ARTIFACT_SELECT =
  "id,projectId:project_id,artifactId:artifact_id,artifactKind:artifact_kind,role,syncMode:sync_mode,addedBy:added_by";

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

/**
 * Every membership row the viewer can see, with each holding project's title
 * embedded — the "used in" back-reference read (issue #262): the datasets
 * explorer's per-dataset "in project X" chips and the dataset overview's
 * Used-in card resolve from this one query (TanStack dedupes the shared key
 * across cards). RLS scopes the rows to the viewer's member projects — a
 * foreign project holding the dataset is invisible here, which is the honest
 * answer (the ladder's project reads widen with visibility, not membership).
 */
export function listVisibleArtifactMembershipsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:projects", "listVisibleArtifactMemberships"],
    queryFn: async () =>
      await queryRows<ArtifactMembershipRow>(
        clientOf(options)
          .from("project_artifacts")
          .select(`${ARTIFACT_SELECT},project:projects(id,title)`)
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

/** A membership row with its holding project's id + title (the chips' link target + label). */
export interface ArtifactMembershipRow extends ProjectArtifactRow {
  project: { id: string; title: string };
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

export interface AddArtifactArgs {
  projectId: string;
  artifactId: string;
  artifactKind: "dataset" | "derived";
  /** Owned = bind a dataset created in-project (no edge minted); linked = add a catalog artifact by reference (ADR 0018). */
  role: "owned" | "linked";
  /** Linked datasets only — manual (the default) pins at the current chain head, auto floats. */
  syncMode?: ArtifactSyncMode;
}

export interface AddArtifactResult {
  artifact: ProjectArtifactRow | null;
  /** Rows written for the membership's fork edge (linked datasets only; 0 for owned, derived, and denied adds). */
  edgeRows: number;
  /** The ref the edge pinned to (manual linked adds whose chain had a head; null otherwise — including the versionless-chain float fallback). */
  pinnedRef: string | null;
}

/**
 * Adds one artifact to a project — the `addArtifact` parity, reshaped by
 * #256/ADR 0018: references, never copies; the membership's `role` decides
 * the edge leg.
 *
 *   - owned  → no edge (the artifact is singly owned; provenance is the
 *     role column).
 *   - linked dataset → one fork edge: `sync_mode` manual pins it at the
 *     chain's current head (a pin, never a copy — the source project is
 *     untouched); auto floats it. A versionless chain (a catalog dataset
 *     that never published a version) floats honestly — the catalog shows
 *     the floating state and the member can pin once a version exists (the
 *     versions card's "nothing to pin to yet" posture). A duplicate
 *     (project, kind, artifact) raises the 23505 constraint (the DB
 *     PK/UQ enforces what the Convex in-transaction re-check did) — the UI
 *     surfaces it verbatim.
 *   - linked derived → no edge (`consumer_references.source_dataset_id`
 *     cannot name a registry row — the 0010 recorded gap).
 *
 * Returns the membership row (null = denied — not an editor of the
 * project), the edge rows written, and the pinned ref.
 */
export async function addArtifact(
  args: AddArtifactArgs,
  options?: StoreOptions,
): Promise<AddArtifactResult> {
  const client = clientOf(options);
  const syncMode = args.syncMode ?? "manual";
  const artifact = await queryRow<ProjectArtifactRow>(
    client
      .from("project_artifacts")
      .insert({
        artifact_id: args.artifactId,
        artifact_kind: args.artifactKind,
        project_id: args.projectId,
        role: args.role,
        sync_mode: syncMode,
      })
      .select(ARTIFACT_SELECT)
      .single(),
  );
  if (artifact === null) {
    return { artifact: null, edgeRows: 0, pinnedRef: null };
  }
  if (args.role !== "linked" || args.artifactKind !== "dataset") {
    return { artifact, edgeRows: 0, pinnedRef: null };
  }
  // The head the manual pin names (newest version — the chain read the
  // versions card uses). Auto never needs the chain; a versionless chain →
  // the float fallback.
  let head: { id: string; ref: string } | null = null;
  if (syncMode === "manual") {
    head = await queryRow<{ id: string; ref: string }>(
      client
        .from("dataset_versions")
        .select("id,ref")
        .eq("dataset_id", args.artifactId)
        .order("created_at", { ascending: false })
        .limit(1),
    );
  }
  if (head === null) {
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
    return { artifact, edgeRows: edgeRows.length, pinnedRef: null };
  }
  const edgeRows = await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .insert({
        consumer_id: artifact.id,
        consumer_kind: "fork",
        mode: "pin",
        pinned_ref: head.ref,
        pinned_version_id: head.id,
        source_dataset_id: args.artifactId,
      })
      .select("id"),
  );
  return { artifact, edgeRows: edgeRows.length, pinnedRef: head.ref };
}

export interface SetSyncModeResult {
  /** The membership rows updated (0 = denied — not an editor, or the row is gone). */
  affected: number;
  /** The ref the manual flip pinned (null for auto, and for the versionless refusal). */
  pinnedRef: string | null;
}

/**
 * Flips a linked membership's follow intent — the lockstep write (ADR
 * 0018): the membership's `sync_mode` column and its fork edge's mode move
 * together, so the stored intent always matches the mechanism.
 *
 *   - manual → the edge pins at the chain's current head; a versionless
 *     chain refuses (throws — the honest "nothing to pin to yet", the same
 *     posture the versions card renders).
 *   - auto   → the edge floats (its pin clears).
 *
 * Sync/revert on a manual membership do NOT run through here — they move
 * the edge alone (versions.syncReference / revertReference) and the intent
 * stays manual.
 */
export async function setSyncMode(
  args: { projectId: string; membershipId: string; mode: ArtifactSyncMode },
  options?: StoreOptions,
): Promise<SetSyncModeResult> {
  const client = clientOf(options);
  const membership = await queryRow<ProjectArtifactRow>(
    client
      .from("project_artifacts")
      .select(ARTIFACT_SELECT)
      .eq("id", args.membershipId)
      .eq("project_id", args.projectId)
      .limit(1),
  );
  if (membership === null) {
    return { affected: 0, pinnedRef: null };
  }
  if (args.mode === "manual") {
    const head = await queryRow<{ id: string; ref: string }>(
      client
        .from("dataset_versions")
        .select("id,ref")
        .eq("dataset_id", membership.artifactId)
        .order("created_at", { ascending: false })
        .limit(1),
    );
    if (head === null) {
      throw new Error("The source has no published version to pin to yet.");
    }
    const rows = await queryRows<{ id: string }>(
      client
        .from("consumer_references")
        .update({ mode: "pin", pinned_ref: head.ref, pinned_version_id: head.id })
        .eq("consumer_id", membership.id)
        .eq("consumer_kind", "fork")
        .select("id"),
    );
    const stamped = await queryRows<{ id: string }>(
      client
        .from("project_artifacts")
        .update({ sync_mode: "manual" })
        .eq("id", membership.id)
        .select("id"),
    );
    return { affected: stamped.length, pinnedRef: rows.length > 0 ? head.ref : null };
  }
  await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .update({ mode: "float", pinned_ref: null, pinned_version_id: null })
      .eq("consumer_id", membership.id)
      .eq("consumer_kind", "fork")
      .select("id"),
  );
  const stamped = await queryRows<{ id: string }>(
    client
      .from("project_artifacts")
      .update({ sync_mode: "auto" })
      .eq("id", membership.id)
      .select("id"),
  );
  return { affected: stamped.length, pinnedRef: null };
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

// ---------------------------------------------------------------------------
// The catalog read (#256/ADR 0018) — memberships joined with their pin
// state and the source chains' heads, so the workspace renders provenance
// and "update available" from one query. "Update available" is the versions
// card's badge decision restated: pinned & the head moved past the pin.
// ---------------------------------------------------------------------------

/** The catalog's one-row merge: the membership, its edge (linked datasets only), and the source chain's head. */
export interface CatalogRow {
  artifact: ProjectArtifactRow;
  /** The membership's fork edge — linked datasets only (owned and derived rows carry none). */
  edge: ConsumerReferenceRow | null;
  /** The source chain's current head (linked datasets; null when the chain is empty — never published a version). */
  head: { ref: string; versionLabel: string } | null;
  /** Pinned and the head moved past the pin — the "update available" badge. */
  updateAvailable: boolean;
}

/**
 * One project's catalog: memberships + their fork edges + per-source chain
 * heads. Edges arrive as one `in` read over the linked memberships' ids
 * (the versions card's per-consumer read, batched); heads arrive as one
 * read per linked source, in parallel — a catalog holds tens of members,
 * and the per-dataset newest-version read is exactly the one the versions
 * card and the bundle press already make. Derived memberships answer no
 * edge (source_dataset_id cannot name a registry row — the 0010 gap), owned
 * memberships answer no edge by design (ADR 0018).
 */
export function listCatalogQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:projects", "catalog", args],
    queryFn: async (): Promise<CatalogRow[]> => {
      const client = clientOf(options);
      const artifacts = await queryRows<ProjectArtifactRow>(
        client
          .from("project_artifacts")
          .select(ARTIFACT_SELECT)
          .eq("project_id", args.projectId)
          .limit(CATALOG_READ_LIMIT),
      );
      const linked = artifacts.filter(
        (artifact) => artifact.role === "linked" && artifact.artifactKind === "dataset",
      );
      if (linked.length === 0) {
        return artifacts.map((artifact) => ({
          artifact,
          edge: null,
          head: null,
          updateAvailable: false,
        }));
      }
      const edges = await queryRows<ConsumerReferenceRow>(
        client
          .from("consumer_references")
          .select(REFERENCE_SELECT)
          .in(
            "consumer_id",
            linked.map((artifact) => artifact.id),
          )
          .eq("consumer_kind", "fork")
          .limit(VERSIONS_READ_LIMIT),
      );
      const edgeByConsumer = new Map<string, ConsumerReferenceRow>();
      for (const edge of edges) {
        edgeByConsumer.set(edge.consumerId, edge);
      }
      const heads = await Promise.all(
        linked.map(async (artifact) => {
          const head = await queryRow<{ ref: string; versionLabel: string }>(
            client
              .from("dataset_versions")
              .select("ref,versionLabel:version_label")
              .eq("dataset_id", artifact.artifactId)
              .order("created_at", { ascending: false })
              .limit(1),
          );
          return [artifact.artifactId, head] as const;
        }),
      );
      const headBySource = new Map(heads);
      return artifacts.map((artifact) => {
        const edge = edgeByConsumer.get(artifact.id) ?? null;
        const head = headBySource.get(artifact.artifactId) ?? null;
        const updateAvailable =
          edge !== null &&
          edge.mode === "pin" &&
          edge.pinnedRef !== null &&
          head !== null &&
          edge.pinnedRef !== head.ref;
        return { artifact, edge, head, updateAvailable };
      });
    },
  });
}
