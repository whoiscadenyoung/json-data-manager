# ADR 0027: Join outputs are project-owned derived artifacts with a joined-table route

Date: 2026-11-10 · Status: superseded by [ADR 0028](0028-views.md) (views are datasets; the derived registry and route are retired) · Issue: [#289](https://github.com/whoiscadenyoung/json-data-manager/issues/289) ([remedies 3]) ·
Train: [remedies umbrella #286]

## Context

"Join into a table" minted its output into the global derived registry
ONLY: the result was invisible in the project catalog, not owned by the
project, and reachable only by hand-attaching a Linked reference (the
verification pass for [remedies 2] re-confirmed the gap — the minted row
sat outside the project's catalog while the user's mental model is "I
joined two of my project's datasets; the result should be IN my project").

## Decision

1. **Owned artifact at creation.** The relation's one-click join mints the
   registry row AND an OWNED `project_artifacts` membership
   (`artifact_kind: "derived"`, the 0019-narrowed kind — the machinery
   existed; the mint never called it). Same bind-at-birth posture an owned
   draft dataset gets (ADR 0018). Linked stays the manual path (the add
   sheet); RLS denies the insert for non-editors, so a viewer cannot mint
   an owned artifact.
2. **A joined-table route.** `/projects/$projectId/derived/$derivedId`
   renders the registry row's spec as the joined table — the transform
   preview's dataset-wide pass with its per-operation match stats — for
   every dataset-sourced spec. A derived-of-derived row renders its
   composition chain as links; its composed table lands with the analysis
   layer (the preview component is a dataset-row fetcher). The registry
   stays the engine-level store; the route is a project-scoped READER.
3. **Reading follows registry RLS, not catalog ownership.** Saved
   derived rows are authenticated-readable ("saved or creator" policy —
   drafts creator-only), so every project member opens the route; the
   catalog card falls back to the honest "not visible" text when the row
   isn't (the same posture the datasets cards have).
4. **Bundle press unchanged.** The press deliberately re-executes derived
   rows (no freeze of their own — `pg-bundle-publish.ts`'s recorded plan);
   an owned derived membership needs no bundle leg, because its SOURCE
   datasets ride the bundle and the row re-executes on read. Documented
   here so "sensibly included" doesn't get read as "must freeze".

## Consequences

- Joining two project datasets yields a catalog-visible derived artifact
  immediately, and the mint navigates to the joined table.
- Every surface that lists derived rows links to the route: the catalog's
  Derived cards, the Analysis page's Derived cards, and the source
  dataset's Transform tab (saved rows get an "Open" affordance beside
  Edit).
- The editor remains the only write surface; the route never mutates.
