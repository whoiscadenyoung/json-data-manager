---
name: project-centric-brainstorm-2026-11-05
description: Project-centric experience brainstorm — feat/project-workspace branch is the Convex-era spec, PG-era successor design drafted, awaiting user convergence on D1–D7
metadata:
  type: project
---

2026-11-05 brainstorm kickoff (user): make **projects the primary working
context** — datasets/maps/apps/collections tabs become exploratory views;
inside a project users manage a catalog, relate/join datasets, build maps
from layers, and publish apps; cross-project reuse must be reference-based
(National Parks → State Tourism scenario).

Key finding: **`feat/project-workspace` (unmerged, pushed, Convex-era Oct 2026) already implemented half the vision** — members/roles (ADR 0011),
owned-vs-linked artifacts w/ pin/float, first-class layers, project-owned
maps (standalone retired), in-project editor, bundle closure. It is a SPEC
now, never a merge source (backend was rewritten to Postgres). Design doc:
`docs/project-workspace-design.md` (Convex era).

The PG-era successor draft: `docs/project-centric-experience-design.md` —
adds apps-in-projects (app `map` widget currently embeds ad-hoc datasetIds,
never saved maps — two parallel map stacks), catalog-level
`dataset_relations` (key|spatial; PostGIS runtime click→highlight→popup),
and a unified visibility ladder `members|signed-in|link|public` w/ the
ArcGIS **closure rule** (share validates/widens the whole reference chain;
bundle press already walks versions — must learn visibility promotion).

**Awaiting user decisions D1–D7** (doc §7: dataset global-vs-owned, maps
explorer, relations scope, ladder adoption steps, collections' fate,
publish granularity, app↔map snapshot coupling). After convergence: ADRs +
ordered issue train (user's standard). Sources for comparables research are
in the doc §9.

Related: [[supabase-migration-2026-11-03]], [[derived-datasets-brainstorm]],
[[gis-feature-initiative]].
