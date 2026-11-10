---
name: views-server-runner
description: "#300 gotchas — the server-side view runner: in-function statement_timeout is impossible, postgres.js double-encodes jsonb params, committed fixtures for int tests, EXECUTE defaults on functions, read-only+rollback, now() ties"
metadata:
  type: project
---

2026-11-10, #300 (0027_views.sql + `app/src/server/views`). The owner moved
view runs to a SERVER-SIDE runner (browser sends a view id, never SQL/rows).
Facts caught live:

- **`statement_timeout` set from inside a plpgsql function (set_config or a
  function-level SET) does NOT apply** — the timer is armed once per
  top-level statement. That is why a SQL-taking RPC could not enforce a
  timeout and why the runner issues `set_config('statement_timeout', …,
true)` as its OWN statement in the read transaction.
- **supabase default privileges grant EXECUTE on new public functions to
  anon/authenticated/service_role.** `revoke … from anon, public` is NOT
  enough: internals (`view_set_inputs`, apply/record) must be revoked from
  `authenticated` and `service_role` explicitly, then granted to the
  dedicated `view_runner` role. The int test asserts the denials.
- **postgres.js double-encodes pre-serialized JSON** when the server reports a
  `$n::jsonb` parameter: a string is JSON.stringify'd into a JSON string
  scalar ("cannot extract elements from a scalar"). The compiler passes jsonb
  params as JSON strings, so the runner's connection uses a passthrough
  json/jsonb serializer (`pg-types.ts`).
- **Phase 1 is `begin read only` and ALWAYS rolled back** (a sentinel throw),
  so even a stray plain `SET` dies with the transaction; the compiled SQL is
  wrapped in a subquery (`select … from (<sql>) q`) so a stacked statement is
  a syntax error. Geometry leaves as `st_asgeojson(...)::jsonb`.
- **The runner opens its own connections, so int-test fixtures must be
  COMMITTED** (autocommit admin session + explicit cleanup in afterEach,
  newest view first — `view_inputs.input_dataset_id` is NO ACTION), unlike
  the other pg-*.int tests' rolled-back single transaction.
- **A statement-level INSERT trigger cannot reference `old_rows`** even in a
  dead `case` branch: one loop per `tg_op`.
- **`now()` is transaction-constant**: two runs in one transaction tie on
  `finished_at`; use `clock_timestamp()` for "latest" orderings.
- Dropping a view dataset cascades through the row-write guard because the
  parent datasets row is already invisible in the cascade statement.
- Prod build: `postgres` is a pure-JS dep, inlined into
  `.output/server/_libs/postgres.mjs`; the finalize-ssr guard passes and the
  client bundle contains none of it (grep `.output/public` for
  `view_apply_run` / `DATABASE_URL`). Server fns are only included when
  something imports them (the UI in #301). A server fn is POSTed with seroval
  JSON plus `Origin` / `Sec-Fetch-Site` headers (the CSRF middleware).

Related: [[views-initiative]], [[prod-ssr-build-invariants]],
[[supabase-stage1-sql-gotchas]], [[int-test-db-split-ri-teardown]].
