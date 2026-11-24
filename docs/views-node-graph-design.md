# Design: views as a graph of named nodes

Status: **accepted 2026-11-17 and implemented** (commits `5b8120d`, `bb70aac`,
`cf4f661`, follow-ups after). Decisions, deviations and what is deferred or not
built are recorded in ADR 0028 addendum d ("Decisions and deviations"). Replaces the linear
step-list model in [ADR 0028](decisions/0028-views.md) and
[`views-design.md`](views-design.md) §4 (write ADR 0028 addendum "d" and update
that section as part of the work). Builds on the shipped Stack, column mapping,
Related (links) tab and Inputs panel.

## Principle (the owner's)

Every processing step produces a new, independent dataset-like **node**. Later
steps reference nodes by name. There are no sub-steps inside any step, no
per-input pipelines and no "steps before/after the base". Users arrange
transformations however they want:

```
d1 → clean → d1c ┐
d2 → clean → d2c ├→ stack1 → clean → stack1c ┐
d3 ──────────────┘                             ├→ join (state_id) → out
d4 ────────────────────────────────────────────┘
```

Nodes may be **larger** than one operation: one node can rename several
columns, or create several calculated fields. Nodes are flexible; the graph is
the structure.

## Decisions (the owner's, final)

1. **Clean break, no compatibility.** No `version` field, no `normalize`, no
   legacy linear shape, no `right.steps`, no `AppendSource.steps`, no
   `ViewInput.steps`. The graph is the only definition format. Existing view
   definitions are not converted: wipe them (and anything that depends on them)
   and recreate. The SS4A grant data may be wiped and recreated if needed.
2. **Holistic, not incremental.** Replace the old types, compiler, validator,
   editor, canvas, reuse features and tests with graph-native ones. Do not keep
   dual code paths.
3. **Text cleanup:** add a text `replace` to the calculate language **and**
   keep the SQL node; either is acceptable for normalizing values.
4. **Stack nesting, cycles:** any node may read any other node. Cycles are an
   error. No "shared pre-step" shortcut is needed (a node is shared by being
   read twice).

## 1. Stored shape

```ts
type ViewDefinition = {
  nodes: Record<string, ViewNode>;   // key = stable node id (slug)
  result: { node: string; output: OutputSchema }; // the node the view saves
};

type ViewNode = { label?: string } & (
  | { kind: "source"; ref: ViewInputRef }                 // a dataset or view (ref, optional pinned version)
  | { kind: "filter"; from: string; where: Condition }
  | { kind: "columns"; from: string; edits: ColumnEdit[]; only?: string[] } // rename / drop many; `only` = optional keep list (no ordering; display order is the Output card's) applied after edits
  | { kind: "calculate"; from: string; fields: { field: string; expr: Expr }[] } // several new fields, evaluated in order (later ones may read earlier ones)
  | { kind: "groupBy"; from: string; by: string[]; measures: Measure[] }
  | { kind: "sql"; from: string; reads?: string[]; query: string }          // `d` = from rows; `in_<id>` for each of `reads`
  | { kind: "join"; left: string; right: string; /* on, matching, type, multiMatch, fields, prefix as today */ }
  | { kind: "stack"; inputs: StackInput[]; tagField?: string }
);

type StackInput = { node: string; tag?: AppendTag; columns?: ColumnEdit[] }; // tag and column edits belong to the edge
```

Notes:

- `ColumnEdit` (`{from, as}` | `{from, exclude: true}`) is the type already
  shipped for Stack; `columns` nodes and stack edges share it and its
  validation/compile helper.
- `columns` replaces today's `select`; `calculate` now carries a list. Add
  further bigger nodes the same way later (unpivot, dedupe, …); the union stays
  open.
- Node ids are stable slugs generated from the label, never uuids and never
  dataset ids (existing rule: names are readable). Renaming a label never
  changes an id, so references never break.
- Geometry and `row_id` travel as today (rows are `{row_id, d, geom}`; a stack
  keeps each row's geometry; groupBy drops it). Keep each node kind's current
  SQL semantics; this redesign changes structure, not step behavior.
- Unreachable nodes (not an ancestor of `result.node`) do not compile and show
  an "Unused" hint, like unused inputs do today.

## 2. Compiler (`packages/data-core/src/views/`)

- CTE per node, named from the node id. Order: depth-first from
  `result.node`, dependencies first, ties by `nodes` key order. A `source`
  node emits the dataset CTE as today (including pinned versions and the
  parameter bag rules in `sql-util.ts`: every value and key is a bind
  parameter, nothing user-supplied is spliced).
- Cycle detection in both validator and compiler with a readable message
  (`Node "a" reads itself: a → b → a`).
- Preview/diagnostics generalize `uptoStep` to `uptoNode` (compile the
  ancestors of one node, read its CTE). Diagnostics paths become
  `nodes.<id>`; per-node row counts come from the existing diagnostics query.
- Reuse the existing per-kind SQL builders (`compileFilter`, join, append,
  groupBy, calculate, sql step analysis) behind the new node dispatch.

## 3. Validator and field scope

`fieldsOf(node)` is memoized and per node (cycle ⇒ unknown). Join keys, stack
edge edits, calculate expressions, column edits, group keys and SQL reads are
checked against the **referenced node's** fields. Structural errors: unknown
node id, missing reference, empty `result`, cycles. Error paths are
`nodes.<id>.<field path>`. Keep the existing "skip checks once a shape is
unknown" rule (bare-`d` SQL nodes).

## 4. Calculate language

Add `replace(text, find, with)` (literal replacement, text in → text out, null
stays null) to the allowlist in `calc-sql.ts` with parser/coercion tests.
Check numeric coercion so `replace(Round, "Round ", "")` and
`replace(Activity_A_Amount, "$", "")` can feed a numeric result (an explicit
number conversion such as a `number(x)`/cast function may be needed; add it
if so). `if(x = "N", "No", x)` already works. A multi-field `calculate` node
holds all three normalizations for a dataset.

## 5. Editor and canvas (`app/src/features/views`, `view-graphs`)

- **Canvas is the structure editor.** It already draws input → step → output.
  Support: add a node (pick kind), "insert a step on this edge" (clean a
  dataset = insert a node between a source and its reader), branch from any
  node, remove a node (reconnect when it has one input and one reader),
  choose a node's inputs with pickers (no free-form drag wiring required in
  the first cut), mark the result node.
- **Right panel = selected node's form.** Reuse the existing forms (filter,
  columns, calculate list, groupBy, join, stack with the Columns table, SQL),
  adapted to node references instead of aliases. Stack member fields come from
  `fieldsOf(inputNode)`, so the Columns table shows cleaned fields.
- **Left list** shows nodes in dependency order (an outline), selecting syncs
  with the canvas. Remove the linear step-list/sub-pipeline editor and the
  join `SubPipeline` UI; nothing nests.
- **Sources** (formerly the Inputs panel): datasets/views declared as source
  nodes, with who reads each and the "Unused" badge.
- **Preview** any selected node (rows, count, columns).
- **New view page**: pick one or more datasets → source nodes; start from the
  graph canvas.
- **Reuse features** rebuilt on nodes: remap = change a source `ref`
  (with the existing compatibility report); duplicate = clone; prune = drop
  unreachable nodes; **extract to view** = any node's ancestor subgraph
  becomes its own view and the node is replaced by a source reading it.
- Keep the Related (links) tab, output/export settings, refresh and runs
  behavior; update the code that reads definitions (refresh worker, run
  server functions in `app/src/server/views`, store/layer/map/app code that
  inspects dependencies, `view_inputs` dependency tracking: rename or
  regenerate it from source nodes).

## 6. Data reset

No conversion. Add a migration (next number after `0035`) or a documented
reset step that deletes existing view datasets and their runs/queue/dependency
rows and anything that cannot survive without them, or clears and recreates
the local database; decide the least risky mechanism after surveying consumers
(`rg "definition"`, `view_inputs`, `view_refresh_queue`, layers/maps/apps that
reference views). Then **rebuild the SS4A IG Awards stacked view as a graph**.
Local accounts and seed data: `docs/local-test-accounts.md`.

## 7. Phases (each ends green and committed with `/commit`)

1. **data-core:** new types, validator + field scope, node compiler,
   diagnostics, `replace` (and number conversion if needed), column/stack
   helpers. Rewrite the view tests (golden snapshots regenerate; PGlite tests
   cover: the owner's d1…d4 example, per-source clean before stack with tags,
   stack → clean → join, multi-field calculate, multi-edit columns node,
   cycles, unused nodes, geometry through stack). Delete the legacy types and
   code. `bun run build` the package.
2. **App:** definition consumers, server functions, refresh path, reset
   migration, view-model, node forms, canvas editing, outline, Sources panel,
   preview of any node, new-view page, reuse features. Component and unit
   tests.
3. **Docs and acceptance:** ADR 0028 addendum "d", update `views-design.md`
   (§3 decisions, §4 format, §6 compiler, §9 UX, §10 data model, §11 tests),
   delete obsolete text about linear steps and sub-pipelines. Rebuild the SS4A
   view in the browser as a graph and verify.

## 8. Acceptance (SS4A IG Awards, rebuilt)

Project "Traffic Safety Grants" (`b5adaaaa-0a3e-40f5-910b-a2da8136ba16`);
datasets "SS4A FY22/FY23/FY24 Implementation Grant Awards" (ids in
`datasets`; FY22 `583ff017-…`, FY23 `d905a629-…`, FY24 `35040f71-…`). Build, in
the editor: a source per dataset; a **calculate** node per year that
normalizes `Round`/`FY2x_Round` to a number, `Activity_A_Amount` to a number
and `Needs_Action_Plan_Update_as_Con` to Yes/No style; a **columns** node per
year dropping internal columns and renaming into the common names (earlier
choices: rename `Population`→`Jurisdiction_Population`,
`Funds_to_Underserved`→`Funds_to_Underserved_Communitie`,
`F__Underserved`→`F__Funds_to_Underserved_Communi`, `FY2x_Round`→`Round`; drop
`SAMUEI`, `UEI_1`, empty `Activity_Type`, `Shape__Area`, `Shape__Length`,
`Source_Notes`, `Match_Check`, `Flags___Internal_Notes`,
`Flags_for_FHWA_Post_award_Admin`, `Missing_Map_`); a **stack** node with
`fiscal_year` tags 2022/2023/2024. Save, refresh and verify in the database
(`docker exec jdm-db psql -U supabase_admin -d app`): 155 rows, `fiscal_year`
intact, 144 geometries (the sources have 30/44/70), each merged column holds
one consistent type across the three years, no dropped column appears.

## 9. Conventions and gotchas

- Use **bun**, not node. After changing data-core types run
  `cd packages/data-core && bun run build` (the app typechecks against
  `dist`).
- Lint/format from the repo root: `bunx oxlint --type-aware <files>` (paths
  with `..` are rejected) and `bunx oxfmt <files>`. The ruleset bans `?.`, `!`,
  `++`; complexity over 10 is a warning, so split functions/components.
  Tests use `must()` (`test-fixtures-pglite.ts`), `vi.fn<(…) => void>()` needs
  a type parameter, component tests need `// @vitest-environment jsdom`.
- Tests: `cd packages/data-core && bunx vitest run src/views`;
  `cd app && bunx vitest run src/features/views src/features/view-graphs`;
  `cd app && bunx tsc --noEmit`. DB-backed tests: see
  `docs/memory/int-test-db-split-ri-teardown.md`.
- Commits: always the `/commit` skill (`AGENTS.md`); read
  `docs/memory/MEMORY.md` first.
- Browser: `preview_start` name `dev` (port 3000), signed in as
  `demo@jdm.test`. In the browser pane, scripted focus/blur does not commit
  text inputs that commit on blur; use real `triple_click` + `type` + Enter or
  dispatch a keydown Enter. base-ui selects: click the combobox, then click the
  `[role="option"]`.
- No local `psql`: `docker exec jdm-db psql -U supabase_admin -d app -c "…"`.
  Entries are `entries(dataset_id, data jsonb)`, geometry is
  `geometries(entry_id, geom)`.
- This is a large change. Work in phases, keep each commit green, and report
  at each phase boundary what is done, what remains and anything you decided.
  Decide small details yourself and note them in the ADR addendum.
