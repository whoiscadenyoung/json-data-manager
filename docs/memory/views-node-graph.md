---
name: views-node-graph
description: "2026-11-17 views are a graph of named nodes ({nodes, result}), clean break, migration 0036 wipes old views; gotchas for the compiler, editor and browser verification"
metadata:
  type: project
---

Views became `{ nodes: Record<id, ViewNode>, result: { node, output } }` (design
`docs/views-node-graph-design.md`, ADR 0028 addendum d, `views-design.md` §4). No linear
steps, no sub-pipelines, no legacy format. Migration `0036_views_graph_reset.sql` deleted
every old view.

- Node ids are lowercase slugs (`^[a-z0-9_]{1,40}$`); CTE = `in_<id>`; a sql node reads
  `prev` (= `from`) and `in_<id>` for `from` + `reads` only.
- Calculate strings use single quotes (`'x'`); double quotes name a field. New functions:
  `replace(text, find, with)`, `number(value)`.
- `view_inputs.alias` now stores the source node id; `inputsOfDefinition` derives it.
- Diagnostics are `{ nodes: [...] }`; previews send the ancestor subgraph (`subgraphOf`),
  not `uptoNode`.
- Editor: canvas edits structure; `ViewNodeGraph` (view-graphs) + `test-node-graph.tsx` mock
  for page tests; node forms in `features/views/components/node-form(s).tsx`.
- Browser gotchas: real typing needs refs from `find` (queries are literal, short); base-ui
  select options only open via pointerdown+mousedown+click dispatch, options appear twice in
  the DOM (use the second set); keep JS output small (the stack form lists hundreds of inputs).
- SS4A IG Awards acceptance view (FY22-FY24 stacked, 155 rows / 144 geometries) was rebuilt
  by hand in the editor: FY22 columns; FY23/FY24 calculate (number/replace/if) + columns;
  stack with `fiscal_year`. FY24's `Activity_B_C_Only` is a `$` string too, so its calculate
  node converts it as well (the design list missed it).
- `pg-stage7-bindings.int.test.ts` fails with "integration session not connected" when the
  default `postgres` db is the target; unrelated to views.
