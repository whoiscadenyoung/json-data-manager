---
name: seed-snapshot-scripts
description: "2026-11-24 scripts/seed/ export+seed of the grant project into a fresh stack; pg_dump -t overrides -n, prune via FK cascades on a scratch db"
metadata:
  type: project
---

`scripts/seed/export.sh` / `seed.sh` (docs/seeding.md) snapshot the "Traffic
Safety Grants" project (db rows + storage objects) and load it into a fresh
compose stack. Fixtures are excluded by pruning a scratch db copy to the
project's artifacts; the live db is read-only.

**Why:** the user wants new environments to start with the real grant data.

**How to apply:** gotchas — `pg_dump -n` is ignored when `-t` is given (use
`-t 'public.*'`); scratch restore of pg_cron errors non-fatally (cron.database_name
= app); prune must keep triggers on (cascades are triggers); seed.sh without
`SEED_DB_NAME` targets the live db (its non-empty guard saved it once).
Storage push + a second full compose stack are not yet verified.
