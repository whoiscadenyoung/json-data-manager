---
name: views-compiler-notes
description: Views SQL compiler (#299) gotchas — unaccent not installed, params, how to sanity-run SQL without docker
metadata:
  type: project
---

`@caden/data-core/views` (packages/data-core/src/views/) compiles a
ViewDefinition to one Postgres statement.

- The `unaccent` extension is **not** installed by any migration, so
  `stripDiacritics` defaults to a `translate()` table; pass
  `{ unaccent: true }` once a migration adds the extension.
- Every value AND jsonb key is a bind param (`$n::type`); jsonb params are
  pre-serialized JSON strings. The int-test wire client has no binding, so
  `pg-views-compiler.int.test.ts` substitutes `$n::` with `sqlLit()`.
- first/last without `orderBy` is deterministic by `row_id`, not insertion
  order (the CTE carries no created_at).
- Quick SQL check without docker: `@electric-sql/pglite` (no PostGIS) after
  replacing `geometry(Geometry,4326)` with `text` in the compiled SQL.

## #302 advanced steps (compiler half)

- **`calculate.expr` is the SOURCE TEXT** (`Expr = string`), not an AST, so
  the editor round-trips what was typed. `parseExpression` (Pratt parser)
  returns `{ok, ast} | {ok:false, errors:[{message,start,end}]}`;
  `analyzeExpression(src, fieldTypeResolver)` also type-checks and gives the
  result type. Literals and field keys are bound; functions are a closed
  allowlist (`EXPRESSION_FUNCTIONS`). Unknown-typed fields are coerced
  leniently where used; `/` is `x / nullif(y, 0)` (never a div-by-zero).
- **Chained `calculate` CTEs need `offset 0`.** Postgres inlines each CTE and
  copies the `d || obj` expression into every reference: 25 chained steps ran
  PGlite out of memory. The fence fixed it. Join CTEs are fenced by their
  grouping; depth-9 join chains were fine.
- **`error` multi-match = pure SQL**: a grouped CTE with
  `case when count(*) > 1 then ('msg' || key)::int` — the failed int cast
  aborts the statement and names the key. Only keys present on the left
  count. Diagnostics compile with `guards: false` and report `multiMatchKeys`.
- **`spread`** uses `(array_agg(d->value order by row_id) filter (where
d->>by = cat))[1]` (jsonb has no max()); first row_id wins per category.
- **`sql` step** (pgsql-ast-parser): output columns are classified by NAME
  (`d`, `row_id`, `geom`; other columns become properties, merged into `d`
  when `d` exists). Wildcards expand only over prev/inputs/own CTEs.
  `prev` is rewritten textually from source offsets. Parser quirks: statement
  `_location.end` is unreliable (cut at the first `;` whose head parses);
  a table span includes `as alias` only when AS is written; no `is distinct
from`, `(a).b`, `tablesample`, `with recursive` without column list.
  Functions allowed except `DENIED_FUNCTIONS` (nested-SQL, file, setting,
  sequence, backend functions).
- Sub-pipeline CTE names are prefixed by the step id (`s2_s0`, `s2_l0`);
  diagnostics steps from a sub-pipeline carry `path`.
- Bundle: `pgsql-ast-parser` is ~300 KB min / ~58 KB gzip (pure CJS bundle,
  works in Node ESM named imports). `analyzeExpression` alone is ~13 KB.
  Lazy-load the views validator in the editor if the cost matters.
- PGlite test harness: `test-fixtures-pglite.ts`; sequential row ids make
  "ordered by row_id" deterministic. PGlite binds jsonb JSON strings fine.
