# ADR 0024: Explorers browse, projects create — cross-project reuse surfaces

Date: 2026-11-07 · Status: accepted · Issue: [#262](https://github.com/whoiscadenyoung/json-data-manager/issues/262) ·
Train: [project-centric umbrella #254], phase 8 (closeout) · Design: `docs/project-centric-experience-design.md` §4.3, §5, §7 D1/D5/D6

## Context

Phases 1–7 built the project-centric machinery — membership, catalog,
layers/maps, relations, app freeze, the visibility ladder, anon serving —
but the app's front door and chrome still told the old story: `/` was a
"View Datasets / View Collections" stub, the datasets explorer linked a
standalone create flow that birthed catalog datasets outside any project,
the maps explorer had no visibility rung or start-here affordance, and a
dataset's page never said which projects or apps used it. The design's §4.3
makes the tabs explorers over everything visible and `/projects` the
default landing, with creation always landing inside project flows; §5's
two-project scenario is the exit test.

## Decision

1. **`/` redirects to `/projects`.** Projects are the working context; the
   explorers (`/datasets`, `/maps`, `/apps`, `/collections`) are browsing
   surfaces, not a home page.
2. **Explorers never create outside projects.** The standalone
   `/datasets/create` flow is retired — its route is gone and
   `PostgresCreateDatasetPage` requires a `projectId` (the owned-draft
   birth, ADR 0018). The datasets and maps explorers offer "start from
   here": a target sheet that picks an editable project (or names a new
   one, created on the spot) and redirects into that project's flow. The
   app-builder's data panel imports into the owning project.
3. **Provenance is visible where the rows live.** The datasets explorer
   shows a publish-state badge (draft/published) plus "in project" chips
   (from one RLS-scoped artifact-memberships read — foreign holdings stay
   invisible, which is the honest answer); the maps explorer shows the
   visibility rung; the collections explorer shows the minting project of
   a bundle-pressed collection (D5's second role, named where it lands).
4. **"Used in" back-references.** A dataset's overview gains a Used-in
   card: the viewer's member projects holding it and the live apps whose
   shared sources include it. A map's explorer card names the live apps
   whose widgets reference it (the `mapId` scan over visible apps). Apps
   already name their owning project. All reads ride RLS — no
   service-role back-references, so the section reads honestly per viewer.
5. **No new data.** Every surface above resolves from existing tables
   (`project_artifacts`, `publish_bundles`, app content) plus two small
   store reads (`listVisibleArtifactMembershipsQueryOptions`,
   `listBundlesForCollectionQueryOptions`); no schema change, no
   migration.

## Consequences

- The front door and the explorers finally match the shipped model; the
  §5 tourism scenario (parks project → tourism project reusing pinned
  data → published app opened signed-out) is exercisable end-to-end in
  the browser UI, closing the umbrella's exit test.
- The datasets explorer's per-card project chips are scoped to the
  viewer's memberships — a signed-in non-member sees the dataset without
  project chips even when other projects hold it. Widening that would
  require exposing membership rows through the visibility ladder, which
  the ladder deliberately does not do (project reads widen with
  visibility, not membership; the artifact chips are member posture).
- The standalone create surface's death means `/datasets/create`
  deep links (bookmarks, old tabs) 404 — accepted; the app is not in
  production and the posture ships its final shape.
