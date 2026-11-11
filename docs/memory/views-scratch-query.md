---
name: views-scratch-query
description: "#306 gotchas — server Scratch query (Postgres) + Save as view, DuckDB-WASM retired: in_<slug> naming, user SQL wrapped as a subquery, set_config is the escape a read-only tx does not stop, sql step vs prunedInputs, what was deleted"
metadata:
  type: project
---

2026-11-10, #306 (`app/src/server/views/scratch*.ts`, `app/src/features/scratch`,
`packages/ui` `sql-editor`). Replaces the Analysis tab.

- **Naming:** each readable project dataset/view is a CTE `in_<slug>` (slugified
  title, de-duplicated `_2`, `_3`, ordered by lower(title), id) with the compiler's
  input layout `(row_id, d, geom)`. `<slug>` is also the input ALIAS on Save as view,
  so the query is stored UNCHANGED as the one `sql` step. Tables the user cannot
  read are simply not listed; naming one errors ("relation does not exist").
- **The user's SQL is wrapped** `with <prelude> select * from (<sql>) as scratch`
  inside the runner's `readAs` (claims + `authenticated` + read-only + always
  rolled back + statement_timeout). The subquery makes `a; b` a syntax error and
  keeps a user `WITH` legal. A trailing `-- comment` is safe (newline before `)`).
  Column ORDER comes from a `limit 0` run (`to_jsonb` sorts keys); rows come back as
  `to_jsonb(q)`; fetch cap+1 for the truncated flag. Failures return `ok:false` with
  Postgres's message (timeout 57014 and read-only 25006 get friendly copy).
- **A read-only tx does NOT stop `set_config`:** a query could rewrite
  `request.jwt.claims` mid-statement and RLS (`auth.uid()`) reads it per row.
  `scratch-guard.ts` text-scans for the compiler's `DENIED_FUNCTIONS` (copied) and
  `U&"..."` identifiers. When `analyzeSqlStep` (feat/views-4-compiler) lands, call
  it instead and delete the copy.
- **`prunedInputs` must know the `sql` step reads `in_<alias>`** (`sqlReadsTable`),
  otherwise the view editor's Save drops the inputs a saved scratch query needs.
- On the views-3 base the compiler does not compile `sql` steps yet
  (`ViewStepNotSupportedError`): a saved scratch view's first run fails until
  feat/views-4-compiler is merged. The int test uses a stand-in compiler that wraps
  the step the same way.
- Save as view = `createProjectView` then `runView` once (toast on failure) then
  navigate; the view page itself does not auto-run.
- **Retired:** `packages/analysis` (duckdb-wasm, apache-arrow), `features/analysis`,
  `@caden/data-core/transform` (+ json-cms re-exports), the Analyze dataset tab and
  `?view=analyze`, the `/analysis` project route (now `/scratch`).
- The SQL editor is CodeMirror (`@codemirror/lang-sql`), lazy + `useIsClient` gated
  like the JSON editor.

Related: [[views-server-runner]], [[views-editor-and-derived-retire]], [[analysis-layer-design]].
