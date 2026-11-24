# Seeding a new environment with the grant data

Two scripts in `scripts/seed/` move the app's real data (the "Traffic Safety
Grants" project: datasets, entries, geometries, versions, views, layers, maps,
the explorer app, and the accounts that own them) between stacks. Fixtures and
other projects are left behind.

## Export (from the running stack)

```bash
scripts/seed/export.sh                 # → ./seed-data (gitignored)
scripts/seed/export.sh --project "<title or uuid>" --no-source-files
```

It copies the live db into a scratch database (`seed_build`, dropped on exit),
prunes it to the project(s) via FK cascades (`scripts/seed/prune.sql`), dumps
the rows (`db.dump`: `public.*` + `auth.users`/`auth.identities`), and pulls
the kept storage objects through the storage API (`storage/<bucket>/…`,
selected by dataset-id path prefix). The live db is only read.

## Seed (into a fresh stack)

```bash
docker compose up -d          # wait for migrations + gotrue to finish
scripts/seed/seed.sh          # refuses if the target already has datasets
scripts/seed/seed.sh --reset  # truncates public.* + auth.users first
```

Rows restore data-only with triggers disabled (stamp/version triggers would
otherwise rewrite `added_by` etc.); storage objects upload with the service
key. Target settings come from `.env` (or `SEED_ENV_FILE`): `SERVICE_ROLE_KEY`,
`SITE_ORIGIN`; `SEED_DB_CONTAINER` (default `jdm-db`), `STORAGE_URL` override.

## Notes

- The snapshot carries password hashes for the data owners
  (`reviewer@jdm.test`, `demo@jdm.test`) and ~0.5 GB of files — keep it out of
  git; move it between hosts with rsync/scp.
- `--reset` is destructive; use it only on a fresh environment.
- Verified 2026-11-24 by seeding a schema-only scratch db: row counts match
  live for every data table. The storage upload path (`push`) and a full
  second compose stack were not exercised.
