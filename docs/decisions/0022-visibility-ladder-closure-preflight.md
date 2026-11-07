# ADR 0022: Unified visibility ladder + publish closure preflight/promotion

Date: 2026-11-06 · Status: accepted · Issue: [#260](https://github.com/whoiscadenyoung/json-data-manager/issues/260) ·
Train: [project-centric umbrella #254], phase 6 · Design: `docs/project-centric-experience-design.md` §6, §7 D4

## Context

Visibility was fragmented across four vocabularies: datasets
(`published_visibility everyone|author`), apps (`sharing private|link`),
maps implicitly authenticated-open, projects creator-private. Nothing
validated a share against the artifacts it references — sharing an app
publicly said nothing about the datasets its maps draw. D4 resolves the
direction (one ladder, built complete, no adoption steps); this ADR records
the model's concrete shape.

## Decision

1. **One enum on every published artifact.** `visibility` with the check
   domain `members | signed-in | link | public` lands on `datasets`,
   `layers`, `maps`, `apps`, and the project itself (`projects`). The
   ladder order is total (`members < signed-in < link < public`,
   `visibility_ladder_rank`); widening = moving up, narrowing = a plain
   RLS'd column write. The fragments die: `datasets.published_visibility`
   maps author→members, everyone→signed-in; `apps.sharing` maps
   private→members, link→signed-in (the old "link" granted any SIGNED IN
   user with the URL — the anon rungs are new and never silently granted).
   `layers`/`maps`/`projects` arrive at `members` (exactly today's
   posture).
2. **The rungs are gates, not labels.** `members` = the project-membership
   gate (for a global dataset: ANY project holding it as an OWNED
   artifact, any seat role; for project-owned rows: `can_view_project`).
   `signed-in` = every authenticated user (ADR 0009's trusted-collaborator
   posture stays the default for published work). `link`/`public` = anon
   SELECT gates written NOW on the FROZEN rows only — dataset_versions +
   version_entries, layer_versions, app_versions — each gated on its
   parent artifact sitting at link/public; live tables get no anon
   policies, and [project 7] serves the published viewer from exactly
   these frozen rows. The anon parent checks live in SECURITY DEFINER
   helpers (`published_*_anon_visible`), not policy subqueries: policy
   subqueries evaluate under the invoking role, and the live tables carry
   no anon policies — an inline `exists (… from datasets …)` would read
   zero rows and be vacuously closed forever.
3. **The wider arms are published-scoped.** A dataset's non-member arm
   requires lifecycle past draft (the ADR 0018 owned-draft clause stays
   member-scoped); a layer's requires `lifecycle = 'published'` (a draft
   layer is the working definition — project-visible only). Maps and apps
   have no lifecycle column; the row IS the shared artifact. A widened
   project row shares title/description/chips, never its artifact list
   (project_artifacts stays member-only), and never its artifacts (each
   rides its own rung).
4. **The closure rule is automatic and widen-only (§6.2).** Two SECURITY
   DEFINER RPCs walk the reference closure — app → its maps + datasets →
   each map's placements → each layer's dataset (linked foreign pins
   INCLUDED: a pinned foreign member caps the share; P5, effective
   consumer access = min over the closure):
   - `visibility_preflight(kind, id, target)` — read-only; returns the
     diff-style report: every promotion (a member below the target the
     caller can edit), every blocker (a member below the target the
     caller CANNOT edit — named, never widened, never silent), and the
     effective level (`min(closure)` after promotions).
   - `visibility_apply(kind, id, target)` — ONE transaction that widens
     exactly the promotions the walk names (re-walked server-side, each
     member's edit right re-checked as the definer), leaves blockers
     untouched, and returns what it did. The root artifact is a closure
     member, so the confirm widens it too. Both refuse a caller who
     cannot edit the root; both are widening-only (a target at or below
     the current rung answers an empty plan — narrowing needs no closure
     walk). Execute is granted to `authenticated` only.
5. **The bundle press learns the ladder.** `publish_bundles.visibility` is
   the press's target rung; `publish_bundle_members.visibility_from/to`
   record the confirmed promotion plan per member (stamped at mint from a
   SERVER-derived preflight — the dialog's report is a preview); the press
   applies the widening through `visibility_apply` AFTER the freeze legs,
   so every newly-widened dataset has frozen rows behind it. Blockers ride
   home in the press outcome (`visibilityCappedBy`) and the workspace
   surfaces them.
6. **Leaf datasets share without a walk.** A dataset references nothing,
   so its share dialog writes every rung through the plain RLS'd
   `setVisibility`; preflight/apply exist for the composite roots (app,
   map, layer, project). Maps/layers carry the column and the gates; their
   dedicated share surfaces arrive with their viewers ([project 7]/[project 8]).

## Consequences

- `published_visibility` and `apps.sharing` no longer exist anywhere
  (single vocabulary — the issue's first acceptance criterion).
- A foreign author-only pin blocks a wider share with a surfaced decision
  (the report names it; effective stays capped at `min(closure)`; nothing
  is ever silently widened or leaked).
- The ADR 0009 trusted-collaborator posture survives as the `signed-in`
  rung and the default for published work; `members` gives collaborative
  projects their private tier.
- [project 7] inherits: the anon gates exist, the serving paths (public
  app/map routes, tile-archive anon read) plug into the same frozen-row
  policies.

## Alternatives considered

- **Per-artifact vocabularies kept** — rejected (D4): four dialects is the
  bug this phase fixes.
- **Client-supplied promotion plans to `visibility_apply`** — rejected:
  the apply re-walks the closure server-side so a report and its confirm
  cannot disagree, and a crafted payload could never widen past the
  per-member edit gates.
- **Anon policies on live tables** — rejected: #261's rule ("anon sees
  ONLY frozen published rows; never drafts, never live tables") starts
  here.
