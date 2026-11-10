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
