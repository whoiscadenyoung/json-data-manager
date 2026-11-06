import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, queryScalar, type StoreOptions } from "./client";
import { CATALOG_READ_LIMIT } from "./datasets";

/**
 * The project-members store (issue #255 — the project-centric train's
 * phase 1; ADR 0017, the PG re-issue of the preserved branch's ADR 0011) —
 * the collaborative-projects domain over `public.project_members`.
 *
 * The membership row IS the grant (ADR 0017): `owner | editor | viewer`,
 * checks ask "at least" down the total order, and RLS does the enforcement
 * — every helper below is a thin, honest shape over one table read/write.
 * Non-members keep the no-existence-leak posture: a foreign project's
 * membership rows are invisible, and its writes answer null / 0 exactly
 * like the not-found read (the 0009 silent-denial rule this module's
 * returns follow). The creator's owner row is permanent (the DB guard
 * trigger refuses it) — `updateRole`/`remove` answer 0 for it, and the UI
 * renders the control disabled with that reason rather than relying on the
 * denial.
 *
 * The invite resolves an email through the `project_invite_resolve` definer
 * RPC — 0002 keeps `profiles.email` column-locked server-side, so no client
 * query can look an email up (ADR 0017). Unknown emails throw (client-side
 * validation, distinct from an access denial); a non-manager caller raises
 * at the RPC's gate (the honest denial — the UI only shows the control to
 * owners, so a raise here means a crafted call).
 *
 * NOTE: narrow local interfaces typed from the migration 0018 DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** The role vocabulary (ADR 0017's total order: owner > editor > viewer). */
export type ProjectRole = "owner" | "editor" | "viewer";

/** The publicly readable profile projection a member row embeds (0002's column grant set — never email). */
export interface MemberProfile {
  id: string;
  name: string | null;
  image: string | null;
}

/** One project membership row (the grant), with the member's public profile embedded. */
export interface ProjectMemberRow {
  id: string;
  projectId: string;
  /** The member's profile id (= auth uid = the `created_by` stamp space). */
  userId: string;
  role: ProjectRole;
  /** The inviter's profile id (attribution; not a permission). */
  addedBy: string;
  createdAt: string;
  profile: MemberProfile;
  /** The membership's project (FK embed — one FK to projects, unambiguous), for the surfaces that name projects (the add-to-project picker). */
  project: { id: string; title: string };
}

// The profile embed is FK-disambiguated (!project_members_user_id_fkey):
// the table carries TWO profile FKs (user_id the member, added_by the
// inviter) and a bare `profiles(...)` embed fails with PGRST201's ambiguity
// error (verified live).
const MEMBER_SELECT =
  "id,projectId:project_id,userId:user_id,role,addedBy:added_by,createdAt:created_at," +
  "profile:profiles!project_members_user_id_fkey(id,name,image)," +
  "project:projects(id,title)";

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function)
// ---------------------------------------------------------------------------

/** One project's membership rows, oldest first (the creator's owner row leads). */
export function listMembersQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:project-members", "list", args],
    queryFn: async () =>
      await queryRows<ProjectMemberRow>(
        clientOf(options)
          .from("project_members")
          .select(MEMBER_SELECT)
          .eq("project_id", args.projectId)
          .order("created_at", { ascending: true })
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

/** The caller's memberships across every visible project — the browser's per-project role badges. RLS answers only rows whose project admits the caller. */
export function listMineQueryOptions(args: { userId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:project-members", "mine", args],
    queryFn: async () =>
      await queryRows<ProjectMemberRow>(
        clientOf(options)
          .from("project_members")
          .select(MEMBER_SELECT)
          .eq("user_id", args.userId)
          .limit(CATALOG_READ_LIMIT),
      ),
  });
}

// ---------------------------------------------------------------------------
// Writes — the silent-denial rule (null / 0 rows = RLS-filtered, not thrown)
// ---------------------------------------------------------------------------

/** The inviteable roles: owners are born, never invited (ADR 0017 — the creator's owner row is permanent and ownership transfer is future work). */
export type InviteableRole = "editor" | "viewer";

/** The UI's role labels, in the total order (the members dialog's select + badge text). */
export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};

/**
 * The seat's role for one project (ADR 0017): the membership row is the
 * grant; a missing row falls back to the creator anchor (owner for the
 * creator, viewer for anyone else) — the DB's birth trigger guarantees the
 * row, so this only covers the fetch's race window, and the fallback is
 * read-only, never a silent write.
 */
export function resolveMyRole(
  memberships: ReadonlyArray<{ projectId: string; role: ProjectRole }> | undefined,
  projectId: string,
  createdBy: string,
  userId: string,
): ProjectRole {
  const membership = (memberships ?? []).find((member) => member.projectId === projectId);
  if (membership !== undefined) {
    return membership.role;
  }
  return createdBy === userId ? "owner" : "viewer";
}

/**
 * Invites one account by email. The RPC resolves the email to a profile id
 * (definer — the column-grant posture above): null means no account
 * carries that email (thrown — the invite form's validation), and a
 * non-manager caller raises at the RPC's gate (ADR 0017). An owner's
 * invite returns the new membership row.
 */
export async function invite(
  args: { projectId: string; email: string; role: InviteableRole },
  options?: StoreOptions,
): Promise<ProjectMemberRow | null> {
  const client = clientOf(options);
  const userId = await queryScalar<string | null>(
    client.rpc("project_invite_resolve", {
      p_email: args.email,
      p_project: args.projectId,
    }),
  );
  if (userId === null) {
    throw new Error("No account was found with that email.");
  }
  return await queryRow<ProjectMemberRow>(
    client
      .from("project_members")
      .insert({ project_id: args.projectId, role: args.role, user_id: userId })
      .select(MEMBER_SELECT)
      .single(),
  );
}

/** Changes one member's role (owner-only at RLS). The creator's owner row answers 0 — the guard trigger refuses it. */
export async function updateRole(
  args: { memberId: string; role: ProjectRole },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("project_members")
      .update({ role: args.role })
      .eq("id", args.memberId)
      .select("id"),
  );
  return rows.length;
}

/** Removes one member (owner-only at RLS). The creator's owner row answers 0 — the guard trigger refuses it. */
export async function remove(args: { memberId: string }, options?: StoreOptions): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("project_members").delete().eq("id", args.memberId).select("id"),
  );
  return rows.length;
}
