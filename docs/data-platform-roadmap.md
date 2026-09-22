# Data platform roadmap — derived datasets → catalog lifecycle → analysis

Umbrella plan for everything designed in the 2026-09 brainstorming arc:
transformation ([`derived-datasets-design.md`](./derived-datasets-design.md),
ADR 0005), the draft/publish lifecycle
([`catalog-lifecycle-design.md`](./catalog-lifecycle-design.md), ADR 0008),
and analytics ([`analysis-layer-design.md`](./analysis-layer-design.md)).
Captured 2026-09-22. **Nothing here is implemented**; this doc fixes the
order, the preparation work, and the checkpoints so the initiative can be
filed as ordered, self-contained issues (one per stage or sub-stage, each
with "Decisions recorded" + acceptance criteria, under a parent tracking
issue).

## 1. Final goal (north star)

Projects are the **virtual working layer**: people import data, define
transform specs (joins, rollups, later SQL), and arrange maps — everything
drafted as durable server-side documents, computed client-side, crash-safe.
**Publish** materializes those drafts into the catalog as ordinary, frozen,
versioned datasets/maps/collections — the existing performance-optimized
surface, unchanged in shape, now append-only with lineage. Consumers pin a
version or float, get in-app change notices, diff, sync, and revert. Auth
gates it all per-user. Later, DuckDB-WASM runs read-only SQL over the same
rows — in projects over drafts, in the catalog over published versions —
and query results publish through the same lifecycle as any derived dataset.

## 2. Principles carried through every stage

- Client-side compute for bulk work (transforms, exports, previews, SQL);
  the server stores and serves rows.
- References, not containment — forks are references or specs, never copies;
  the catalog never nests under a project.
- Append-only catalog; republish = new immutable version; no merge-back.
- One row-resolution seam feeds preview, export, map layers, and analysis.
- Typed structures stay accurate end-to-end (coercion policies shared with
  join key normalization).
- Nothing published knows projects exist — published artifacts are shaped
  exactly like today's.
- Durability by construction: drafts autosave as documents; long jobs
  checkpoint and resume (the `syncRuns` pattern).
- Groups are display folders from day one — they gain no lifecycle powers.

## 3. Phase 0 — prepare the current structure

No new user-facing features. Each item makes today's code match a target
invariant so later stages land on prepared ground.

- **0.1 Auth gating & data scoping.** Gate data access on sign-in (Better
  Auth is in; `schemas.createdBy` attribution is in; the gate is the
  follow-up). Everything multi-user — drafts, ownership, sharing, the fork
  loop — hangs on this, and it is valuable standalone.
  *Done when:* unauthenticated access cannot read or write data; identity
  flows through existing mutations.
- **0.2 The row-resolution seam.** Introduce one client-side interface —
  "resolve this dataset's rows (draft or published, specs applied)" — and
  move the dataset table, export dialogs, and map-layer consumption onto it
  (byte-budget pagination lives inside, with a spec-application stub that is
  identity for now). This is the seam the transform engine, surfacing, and
  the SQL layer all plug into.
  *Done when:* no surface paginates datasets on its own; exports and tables
  behave identically through the seam.
- **0.3 Generalize version-freezing.** Extract the frozen-version machinery
  from the bound-dataset tag path (freeze a dataset state, lineage fields,
  keep-N with pinning) into reusable component utilities with no behavior
  change. Stages 5–6 then *call* it instead of inventing it.
  *Done when:* tag ingest and a generic helper share one implementation.
- **0.4 Key-normalization & coercion utilities.** Pure, unit-tested helpers
  in `@caden/json-cms` (trim/case/number-vs-string coercion, shared by
  future join keys and column typing for analysis).
  *Done when:* utilities exist with tests; nothing else changes.
- **0.5 CI (recommended, from the 2026-09 architecture review).** Typecheck
  + lint + test on PRs. A staged initiative implemented by agents in order
  needs a mechanical green/red signal at every step.

## 4. Implementation stages

Ordered; each stage is 1–3 issues. "Value checkpoint" = what a user gains.

| # | Stage | Implements | Depends on |
| --- | --- | --- | --- |
| 1 | Transform engine: spec types + pure lookup engine in `json-cms`, unit-tested | ADR 0005 §10.1 | 0.4 |
| 2 | Derived-dataset registry (app-side table, `datasetBindings` precedent) + builder/preview UI with match-rate stats | ADR 0005 §10.2 | 1, 0.2 |
| 3 | Surfacing: "include joined fields" in exports, derived datasets as map layers, popup enrichment (popup executor decision: index table vs. client key map) | ADR 0005 §10.3 | 2 |
| 4 | Rollup primitive + join-back composition + `geometrySource` spec field | ADR 0005 §10.4 | 1 |
| 5 | Lifecycle entry: minimal draft/published flag (catalog filters published by default), then **materialized publish** — spec execution written through the existing ingest path, checkpointed | ADR 0008; lifecycle §8.2, §6 | 0.3, 2, 4 |
| 6 | Versioned consumption: pin/float, "source published vN" badges, version-delta diff, sync (re-run + re-freeze) / revert (repin), consumed-by list | ADR 0008; lifecycle §7 | 5 |
| 7 | Projects (auth-gated): the working container, import/create lands in projects, bundle publish (collection + maps + datasets), fork-as-reference/spec, groups/collections take their mapped roles | ADR 0008; lifecycle §3, §5 | 0.1, 5 |
| 8 | Sharing & multi-user isolation: per-user/team projects, permission checks, published-visibility controls | lifecycle §9 open questions | 0.1, 7 |
| 9 | Analysis layer: DuckDB-WASM worker over the seam, saved analyses as project artifacts, SQL escape hatch unifying with rollup; Parquet sidecar only if size demands | analysis-layer-design | 0.2, 6 (catalog side), 7 (draft side) |

**Value checkpoints.** After stage 3 the app is already useful (enriched
tooltips and exports on real data — the SMART and restaurant scenarios
start working). After stage 5 the catalog gains provenance and the
"flatten into a real dataset" story. After stage 6 the consumer contract
(notify/diff/sync/revert) exists. Stages 7–8 are where multi-user arrives;
stage 9 is additive and can interleave after 6 with no rework.

**Sequencing rules.** Never publish anything virtual (the virtual/
materialized line is fixed); engine before registry, registry before any
UI; the seam (0.2) before both surfacing and analysis; auth gating (0.1)
before projects; groups accept no new responsibilities from day one.

## 5. Issue-filing convention

On approval, file a parent tracking issue plus one issue per stage (splitting
3, 5, and 7 into sub-issues where the work naturally halves). Each issue is
self-contained: references this roadmap and the design section it implements,
carries a "Decisions recorded" block and acceptance criteria, and posts
progress comments to the parent. Order is strict within phases 0 → 1–4 →
5–6 → 7–8; stage 9 schedules freely after 6.
