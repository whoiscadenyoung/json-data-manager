# 17. Project membership & roles on Postgres: `project_members` gates the workspace

- Status: accepted
- Date: 2026-11-05
- Re-issues the preserved Convex-era branch's
  [ADR 0011](https://github.com/whoiscadenyoung/json-data-manager/blob/feat/project-workspace/docs/decisions/0011-project-collaboration.md)
  (`project-collaboration`, 2026-10-08) for the Postgres backend — phase 1 of
  the [project-centric experience train](../../project-centric-experience-design.md)
  (§4.4 membership, §7 D1/D4; issue #255, umbrella #254). The backend
  rewrite (ADR 0015) never carried the branch's roles; this ADR is their PG
  re-issue. Nothing else from ADR 0009 (trusted collaborators) or ADR 0010
  (dataset `editPolicy`) changes.

## Context

`projects` / `project_artifacts` / `publish_bundles` / `publish_bundle_members`
landed on PG (migration 0009) as the stage-8 per-creator-private exception:
RLS was creator-only, nothing could be shared, and a project was an add-only
list of references. The project-centric design makes the project the primary
working context — several people building a catalog, maps, and apps inside
one workspace — which the creator-only grant makes impossible. The Convex
branch had already designed and shipped-locally the answer (members/roles,
ADR 0011); the PG machinery it needs (RLS, policy helpers, definer RPCs) now
exists.

## Decision

- **`project_members (project_id, user_id, role owner|editor|viewer)`** with
  `by_project` / `by_user` indexes and a `(project_id, user_id)` unique. The
  row is the whole grant — not an array on the project row, not a field on
  anything else. `added_by` records the inviter (attribution, not a
  permission).
- **The role order is total and checks ask "at least"** (owner > editor >
  viewer), expressed as three INVOKER helpers the policies share —
  `can_view_project` (member), `can_edit_project` (owner|editor),
  `can_manage_project` (owner):
  - **owner** — everything an editor can do, plus member management
    (invite / set role / remove) and project deletion, plus the project's
    settings writes (title/description);
  - **editor** — every content write on project-held work: artifact
    memberships, the fork `consumer_references` edges minted with them, and
    the bundle press (`publish_bundles` + members rows);
  - **viewer** — read the workspace, its members, and press state; never
    write.
  - **outsider (non-member)** — the no-existence-leak posture stands: a
    foreign project reads as not-found, its writes answer 0 rows
    (UPDATE/DELETE) or an RLS refusal (INSERT), and the UI renders the
    not-found card — never a 403.
- **The creator's owner row is born with the project** — an AFTER INSERT
  trigger on `projects` (security definer) inserts it for every writer, and
  a guard trigger refuses to update or delete that one row (with the
  0009 `tags_guard_retire` cascade-depth carve-out so deleting the project —
  or the user — still cascades cleanly). "A project always has an owner"
  holds with no last-owner election logic; ownership transfer is future
  work that needs a different mechanism precisely because this row cannot
  move.
- **Deviation from Convex ADR 0011, recorded:** `projects.update`
  (title/description) is **owner-level** here, not editor-level. The
  issue's role matrix — the train's contract — lists "edit settings" under
  owner. Content writes stay editor-and-up.
- **Policy helpers keep the 0008/0009 shape split.** `project_member_role`
  is DEFINER + stable (it reads `project_members` for policies on
  `project_members` itself — invoker would recurse; INSERT..RETURNING
  evaluates the SELECT policy on the new row). `can_*_project` and the
  rewritten owner-rule helpers (`project_artifact_owner` — now the editor
  arm; `publish_bundle_owner`; new `publish_bundle_viewable`;
  `consumer_reference_owner`'s fork arm) are INVOKER + stable reading other
  tables. Frozen-table grant revokes and column grants elsewhere are
  untouched.
- **Invite by email resolves through a definer RPC**
  (`project_invite_resolve(project, email) → uuid`), because 0002 keeps
  `profiles.email` column-locked server-side (the ADR 0009 addendum PII
  line): no client query can read the column, so the RPC resolves one exact
  email case-insensitively to a profile id and nothing else, restates the
  owner gate where the definer can enforce it, answers null for an unknown
  email (the store surfaces "no account with that email"), and raises for a
  non-owner caller. The members dialog lists profile names/images from the
  public projection; a member's email shows only for that member (their
  session).
- **The membership writes are RLS-gated owner-only**; the realtime
  publication gains `projects` + `project_members` (guarded, the 0013/0015
  pattern) so member changes broadcast, RLS filtering per subscriber. The
  client opens one project-scoped channel per open workspace surface —
  projects are not dataset-filterable, so they join the per-dataset channel
  matrix as a sibling, not a member.
- **Out of scope, deliberately:** dataset-table RLS is unchanged — ADR
  0011's project-held-draft member-visibility ("adding a draft to a project
  IS sharing") lands with #256, the first flow that can put a draft into a
  project. The visibility ladder vocabulary (`members` as a rung) is #260's.

## Consequences

- The role access matrix (owner/editor/viewer/outsider ×
  read/write/manage) is pinned DB-level by the wire-client int test
  (`pg-project-members.int.test.ts`) and store-level by
  `project-members.test.ts`; the stage-4 creator-only test block still
  holds (its outsider is a non-member — the same answers).
- Editors can press the bundle and manage references; a viewer pressing or
  adding answers 0 rows and the UI disables the controls with the reason
  (the UI-polish rule — never a silent no-op).
- Consumer fork edges follow the membership's project's editor arm, so an
  editor pinning/float a shared project's references works; derived edges
  stay their registry row's creator and map edges stay the shared
  exception.
- Realtime fires on membership changes; the members dialog live-updates
  while open.
