# 11. Project collaboration: `projectMembers` roles, and project-held drafts are member-visible

- Status: accepted
- Date: 2026-10-08
- Supersedes stage 8's per-creator project privacy decision (the recorded D1
  on #104) **for projects only**; every other clause of
  [ADR 0009](./0009-trusted-collaborator-catalog.md) (trusted collaborators,
  shared maps/collections/groups, absolute read-only guarantees, signup
  gating) and of [ADR 0010](./0010-dataset-edit-policy.md) (dataset
  `editPolicy`) stands unchanged.
- Phase 1 of the project-workspace design
  (`docs/project-workspace-design.md`, §1).

## Context

A project was per-creator private: `projectForWrite` checked the creator
stamp, `projects.get` answered null to anyone else, and `projects.list`
walked the creator index. The design's goal is a project as a thin
**collaborative** workspace — datasets → layers → maps built by several
people — which the creator-only grant makes impossible: there was no way to
let a second person into a project at all.

The thing a project holds that made this decision non-trivial is **drafts**.
Since stage 8, a component dataset flagged `lifecycle: "draft"` is readable
and writable by its creator alone — the isolation rule enforced at the
`auth()` choke point (ADR 0007) and mirrored app-side in the old
`datasetVisibleTo` predicate. A project is exactly where drafts live
(`projects.createDraftDataset`), so opening projects to members means
saying precisely who may see and touch a project-held draft, without
reopening the gap stage 8 closed (a foreign draft reading as visible
anywhere outside the project that holds it).

## Decision

- **One new app-side table: `projectMembers` (`projectId`, `userId`, `role:
"owner" | "editor" | "viewer"`; indexes `by_project`, `by_user`).** The
  row is the whole grant — not an array on the project doc (the
  membership-rows-not-an-array rule), not a field on the component's rows
  (the component never learns projects exist). `userId` is the `auth()`
  hook's identity string, the same string `schemas.createdBy` holds.
- **The role order is total and checks ask "at least"** (owner > editor >
  viewer):
  - **owner** — everything an editor can do, plus member management
    (`addMember`/`setRole`/`removeMember`) and project deletion
    (`projects.remove`);
  - **editor** — every content write in the project: create/import drafts,
    add/remove artifact references, fork-as-spec, edit the project's
    title/description, press the bundle (`bundles.start` and its legs via
    `runningRun`);
  - **viewer** — read the workspace, its members, and the project-held
    drafts; never write.
- **The creator's owner row is born with the project** — inserted in the
  same transaction as the project row — and `setRole`/`removeMember` refuse
  to touch it. That one carve-out is what keeps "a project always has an
  owner" true with no last-owner election logic. `createdBy` on the project
  row stays as attribution and as the anchor that check reads; it is no
  longer the ownership key. (Greenfield, no migration: the design says no
  back-compat.)
- **Project-held rows become member-visible; project-held drafts become
  member-editable.** The stage-8 rule gains one exception, shaped by the
  `projectArtifacts` membership row: a row named by a membership row is
  READABLE by every member of a project holding it — draft,
  `publishedVisibility: "author"`, or ordinary published alike, because
  adding a row to a shared project IS the act of sharing it with that
  project (an author who wants a row private simply doesn't add it; the
  author-visibility flag keeps its full force on every row that is not in
  a shared project). A DRAFT is additionally writable by its creator plus
  that project's owner/editor members — a viewer-role member reads the
  workspace's drafts and never writes them (the role matrix's whole
  point). Non-draft rows keep the trusted-collaborator write rules (ADR
  0009 co-editable; ADR 0010 locked = creator-only). And the catalog
  enumeration reads stay component-scoped by `viewerId` — held rows reach
  members through the project workspace and by-id reads, **never the
  catalog**. The rule lives in one place (`app/convex/projectAccess.ts`:
  `datasetVisibleTo`/`datasetWritableBy`) so the choke point
  (`auth.ts`) and projects.ts answer identically and cannot drift.
- **Adding a draft to a project IS the act of sharing it.** A membership
  row makes the draft visible to that project's members — including drafts
  added by reference from another project. Members see them in the
  workspace read (resolved through a host-flow by-ids component read,
  `getSchemaSummaries` — public-in-component, unexposed, the
  `listEntriesForSchemaBounded` pattern; the scoping duty stays with the
  host, which feeds it only membership-row ids).
- **Denial shapes keep the leak rules.** At the project level, anyone below
  the minimum role gets the same answer a missing project gives — an id's
  existence never leaks through a denied write. One level down, a
  viewer-role member who writes a project-held DATASET gets the honest
  view-only denial ("You have view-only access…"), because the workspace
  read already told them they belong; the denial fires only for callers who
  can see the row, so it never leaks an invisible row's existence.
  Outsider drafts read exactly as missing, as before.
- **`projects.update` is editor-and-up; `projects.remove` is owner-only.**
  Shaping the workspace (title/description) is a content write; deleting
  the project is the destructive act. **Member management is owner-only**;
  invites name an account by Better Auth user id **or** email, resolved
  through the `users` mirror (`authIdForUser` in users.ts).
- **The cascade deletes the collaboration, never the data.**
  `projects.remove` (one transaction) deletes the project row, every
  `projectArtifacts` membership row, the fork `consumerReferences` edges
  minted with them, and every `projectMembers` row. The referenced
  artifacts survive — references, not containment (the `removeArtifact`
  rule, unchanged): a draft created in the project survives as its
  creator's draft (still in their drafts toggle, publishable on its own);
  published rows never notice. The UI's confirm copy says exactly this.
- **Registry draft rows stay creator-only.** A derivedDatasets row with
  `status: "draft"` (a builder autosave) is resolved as "missing" for
  everyone but its creator even inside a shared project. The design's
  member-visibility clause names datasets/layers/maps; a registry autosave
  is not a project artifact in any meaningful sense (only its creator can
  add one), and widening it would leak titles/specs of half-written work.
  Revisit when phase 2/3 give artifacts real roles.

## Consequences

- The role access matrix (owner/editor/viewer/outsider) is pinned by
  convex-tests in `app/convex/projects.test.ts`: reads, content writes,
  member management, draft visibility/editability (viewer read-only,
  outsider blind, catalog still excludes), cascade deletion, and the
  editor-presses-the-bundle flow.
- bundles.ts's project-scoped reads (`plan`, `run`, `latestForProject`)
  are member-scoped; its press writes are editor-and-up; an editor's press
  walks the closure with the project CREATOR as the component reads'
  `viewerId` — the same identity `plan` uses, so the preview and the press
  it started can never disagree about which drafts are in.
- Trust still rests on controlled sign-in (ADR 0009 addendum): inviting by
  email assumes emails resolve to real, admin-created accounts. The invite
  dialog offers raw user ids for exactly the case the mirror can't resolve.
- Per-member pin/sync preferences (`syncMode`, "keep in sync") are phase 2
  and land as fields on `projectArtifacts`; nothing in the role model
  changes first.
- UI: the browser cards and the workspace header badge the viewer's own
  role (`projects.list` and `projects.get` carry it, so no second query);
  the members dialog lists members with profiles (email only when the
  viewer is that user — the ADR 0009 addendum PII line) and gives owners
  the invite/role/remove controls; write controls are disabled with the
  reason for viewers, never silent no-ops (the UI-polish rule).
