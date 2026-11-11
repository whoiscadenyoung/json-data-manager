---
name: views-initiative
description: 2026-11-10 Views initiative (umbrella #298, #299–#307, ADR 0028) — derived datasets become views (datasets with saved, Postgres-compiled steps); owner rules: green/disposable, flat output, name joins first-class, no templates
metadata:
  type: project
---

2026-11-10: Derived datasets (ADR 0005/0026/0027) are being replaced by
**Views**: `datasets.kind = 'view'` with a step definition, compiled to one
Postgres SQL statement, and runs saved into the view's own entries and
geometries. Refresh modes are manual/auto/live; exports always use a
snapshot. The Analysis and Transform tabs fold into one View editor, and
React Flow draws the lineage and step graphs.

Start at `docs/views-handoff.md` (order, checklist, status table). The
reference is `docs/views-design.md`; the decision is ADR 0028.

**Why:** the owner's GIS flow ("deployments per state" + "links per state"
→ flat GeoJSON for ArcGIS) needed aggregate-then-join, pivot-joins and real
saved rows, none of which the virtual, browser-computed derived datasets
could provide cleanly.

**How to apply:**

- Treat the app as green and disposable. Retire legacy derived code and
  tables when an issue says to, and never write compatibility shims.
- Flat output by default; arrays only through the opt-in `list` mode.
- Joins on names (with normalization and a manual key map) are a
  requirement, because users often don't have codes.
- Reuse means Duplicate, chaining and Extract to view; no templates.
- One SQL engine: Postgres, through a TanStack Start server function that
  connects directly as the user (RLS). Supabase's REST API can't run the
  compiled SQL. Scratch queries run there too; DuckDB-WASM is retired
  (owner chose this 2026-11-10).
- Remedies 4–8 (#290–#294) are deferred behind Views, not dropped. #290's live requirements (draft inputs, title-based names, visible renames) are on #299/#300/#301/#303; #291–#294 resume after Views.

Related: [[derived-datasets-brainstorm]], [[analysis-layer-design]],
[[int-test-db-split-ri-teardown]].

2026-11-11: the whole train merged via #320. **Next session: start at `docs/views-verification-handoff.md`**, which covers the browser checks, follow-ups to file, and remedies 5–8.
