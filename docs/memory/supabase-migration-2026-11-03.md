---
name: supabase-migration-2026-11-03
description: Approved 2026-11-03 — backend fully rewritten on self-hosted
  Supabase (Postgres+PostGIS), NO Convex interop and no data migration (data
  disposable); ADR 0015 + docs/supabase-migration-design.md are the binding
  contract; Convex code stays in-tree untouched
metadata:
  type: project
---

The Convex→Supabase migration decision (2026-11-03), superseding the
"do not adopt a Postgres rewrite yet" direction in
[[published-load-direction]] — its revisit trigger fired (archive-build
option built and dropped, snapshot shelved, per-document cost stays):

- **The contract is two docs:** `docs/decisions/0015-supabase-postgres-backend.md`
  (the decision) and `docs/supabase-migration-design.md` (schema DDL, RLS +
  `can_edit_dataset()`, the five SECURITY INVOKER RPCs, frontend layout,
  auth swap, CI, stages 0–7 with acceptance criteria, verification).
  Implementers work from the design doc, not from this memory.
- **Binding constraints:** full rewrite, no Convex interop, data wiped not
  migrated; self-hosted Supabase in local Docker for now; `supabase/` at
  repo root; nothing under `app/convex/` or `packages/json-cms/` is ever
  edited (reference + revert path); the Convex provider stays mounted until
  stage 7; from stage 1 new datasets are Postgres-native while existing
  Convex datasets stay frozen until their surface migrates.
- **The perf case it answers:** ~1 ms per document read, linear, no
  parallel throughput — 20k rows ≈ 12 s of row read, import ≈ 17 s
  ([[map-performance-audit-2026-10]], `docs/published-map-load-options-2026-10-29.md`);
  all table sort/search/filter is client-side because the component entries
  table has only a `by_schema` index.
- Carried-over packages (`@caden/data-core`, `importers`,
  `geometry-archive`, `maps`, `ui`, `layer-styles`, `analysis`) never learn
  about Supabase (ADR 0014 direction). Pushes touching
  `.github/workflows/` need the SSH-alias workaround
  ([[gh-push-workflow-scope]]) once the CI stage lands.

Related: [[published-load-direction]], [[map-performance-audit-2026-10]],
[[component-actor-authz]], [[feature-folders]].
