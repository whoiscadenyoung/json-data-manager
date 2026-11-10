---
name: views-runner-rpc-pair
description: "#300 gotchas — statement_timeout can't be set inside a function, transaction_read_only is flippable only via sub-block rollback, PREPARE multi-statement trap, now() ties inside one txn, transition-table triggers can't name a missing table"
metadata:
  type: project
---

2026-11-10, #300 (0027_views.sql). Facts caught live:

- **`statement_timeout` set from inside a plpgsql function (set_config or a
  function-level SET) does NOT apply**: the timer is armed once per top-level
  statement. The phase-1 timeout is therefore the CALLER's (role setting over
  PostgREST; `set local` on a direct session).
- **`set_config('transaction_read_only','on',true)` cannot be undone** in the
  same transaction ("must be set before any query"), and user SQL cannot
  flip it back. To keep the caller's transaction usable, `view_query` runs in
  a sub-block that ends by raising a sentinel (`JDM01`): the subtransaction
  rollback reverts the SET LOCAL while plpgsql variables survive.
- **`'prepare x as ' || sql` runs a multi-statement string's TAIL outside the
  prepare** (a trailing `set session …` would persist on a pooled
  connection). `view_sql_is_single_statement` (a small lexer) gates it.
  `for r in execute 'execute <prepared>(…)'` is how to read a prepared
  statement's rows in plpgsql, and PREPARE lets Postgres infer param types.
- **`query_canceled` is not caught by `when others`** — name it to deallocate
  the prepared statement.
- **A statement-level trigger on INSERT cannot reference `old_rows`** even in
  a dead `case` branch: one loop per `tg_op`.
- **`now()` is transaction-constant**: two runs in one transaction tie on
  `finished_at`; use `clock_timestamp()` for "latest" orderings.
- Dropping a view dataset cascades through the row-write guard because the
  parent datasets row is already invisible in the cascade statement.
- Int tests: the wire session cannot pipeline, so the test `ViewsRpc` adapter
  serializes the runner's parallel phase-1 reads.

Related: [[views-initiative]], [[supabase-stage1-sql-gotchas]],
[[int-test-db-split-ri-teardown]].
