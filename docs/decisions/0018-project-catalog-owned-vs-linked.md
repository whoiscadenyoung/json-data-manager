# 18. Project catalog: owned vs linked artifacts, pin-at-head links, member-visible owned drafts

- Status: accepted
- Date: 2026-11-05
- Phase 2 of the [project-centric experience train](../../project-centric-experience-design.md)
  (§4.1 data line, §7 D1; issue #256, umbrella #254). Builds directly on
  [ADR 0017](0017-project-membership-roles.md): the role matrix gates every
  write below (viewers read, editors and owners work). Migration
  `0019_project_catalog.sql` carries the schema.

## Context

`project_artifacts` (0009) held one flat membership list — every add was a
reference with a float consumer edge — and nothing could create a dataset
_inside_ a project. The design's data line makes projects hold two kinds of
membership: datasets **created in-project** (owned) and datasets **added from
the global catalog** (linked, "a pin, never a copy"), with per-member
sync/revert over the existing `consumer_references` pin machinery. The ADR
0017 deferred clause — project-held draft member-visibility — now has its
first flow that can put a draft into a project, so it lands with this phase.

## Decision

- **`role owned|linked` and `sync_mode manual|auto` on `project_artifacts`.**
  Owned = the artifact was created in-project and is bound to the workspace
  at birth. Linked = added by reference from the global catalog (D1: datasets
  stay global; projects hold memberships, never copies). `sync_mode` names a
  linked reference's follow intent: `manual` (the default — pinned at the
  add-time chain head) or `auto` (the reference floats on head). The column
  is the intent; the fork edge's `mode` is the mechanism, and the store keeps
  the two in lockstep (`setSyncMode` writes both; every read path shows the
  edge's actual state).
- **Linked add pins at the head; a versionless chain floats honestly.**
  Linked+manual mints the edge pinned to the current head version; linked+auto
  floats. When the source chain has no version yet, the edge floats and the
  catalog shows the floating state — the same honest "nothing to pin to yet"
  posture the versions card already renders — rather than refusing an add of
  a legitimate catalog dataset.
- **Owned memberships carry no consumer edge.** An owned dataset is singly
  owned by its creator and needs no version-reference leg; provenance for
  owned rows reads `role`, not an edge. The pin/float/sync/revert surface
  exists for linked rows only.
- **`artifact_kind` narrows to `dataset|derived`.** Map and app memberships
  arrive with their own phases ([project 3]/[project 5]); pre-0019 map
  memberships and their consumer edges are deleted (breaking — the train's
  no-back-compat posture; PG data disposable).
- **Owned drafts are member-visible — the ADR 0017 deferred clause, scoped
  to owned AND draft.** `can_view_dataset` gains a third reader arm (creator ·
  published-visible · **owned-draft member**), `can_edit_dataset` a third
  writer arm (open policy · creator · **owned-draft editor+**). A dataset
  that is an OWNED DRAFT of a project is readable by that project's
  members and writable by its editors/owner — "adding a draft to a project
  IS sharing" (ADR 0011's rule, re-issued for PG). Both arms are
  draft-scoped in the gate itself: publishing the dataset returns it to the
  catalog's own rules (a published `author` row stays creator-only even
  while owned — the visibility ladder, #260, owns widening published rows).
  Deliberately narrower
  than the clause's letter: **linked drafts are not covered** — D1 makes
  linked a reference to a _catalog-visible_ dataset, and a draft is by
  definition not catalog-visible, so a linked draft stays governed by its
  creator's row alone. The only route to a member-visible draft is
  ownership, which is exactly the flow this phase ships. The published
  `author` visibility gate also stays creator-only: project sharing never
  widens a _published_ row (that is the #260 ladder's job).
- **In-project create/import births owned drafts that stay drafts.** The
  project-bound create flow creates the dataset with `lifecycle: 'draft'`
  and binds it as an owned artifact in the same flow; the import-completion
  flip (`markImportComplete`) is deliberately skipped — the draft publishes
  through the normal publish surfaces (dataset publish dialog, bundle press),
  not by finishing an import. Discarding a failed in-project import removes
  the membership with the dataset (the artifact id is a text reference; no
  FK would clean it up).
- **The catalogs' read model is three store reads merged client-side:**
  memberships, their fork edges, and the source chains' heads —
  "update available" is computed as _pinned & pinned_ref ≠ head ref_ (the
  same decision the versions card's badge makes), sync advances the pin to
  head, revert repins an earlier version, float/pin flips go through
  `setSyncMode`. No new DB machinery: 0009's `consumer_references`
  float/pin, the publish chains, and the badge semantics are reused whole.
- **Duplicate adds stay the 23505 constraint** — the `(project_id,
artifact_kind, artifact_id)` unique answers a double add honestly (the
  message surfaces verbatim; no pre-check, no silent dedupe).

## Consequences

- The pin/float/sync/revert matrix is pinned DB-level by
  `pg-project-catalog.int.test.ts` (RLS arms, kind constraint, 23505, edge
  shapes) and store-level by `projects.test.ts` (pin-at-head minting,
  lockstep, owned-no-edge).
- A project editor pinning a shared project's linked reference works through
  the 0017 editor arm of `consumer_reference_owner`; viewers are refused.
- The bundle press loses its map membership legs until [project 3] re-owns
  maps as project artifacts of their own kind.
- Sync/revert actions are per member _project_ (the edge belongs to the
  membership row): two projects holding the same source dataset pin and
  advance independently.
