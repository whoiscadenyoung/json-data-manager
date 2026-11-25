-- Prunes a scratch copy of the app database down to the seed set.
-- Run by scripts/seed/export.sh against the SCRATCH db only — never the live one.
--
--   psql -v ON_ERROR_STOP=1 -v projects='{uuid,uuid}' -f prune.sql
--
-- Seed set = the given project(s) and everything they own: datasets
-- (project_artifacts rows), layers, maps, apps, versions, relations, plus the
-- accounts those rows reference. Everything else (int fixtures, other
-- projects, scratch collections) goes. Deletes rely on the schema's FK
-- cascades, so triggers must stay enabled.

create temp table seed_projects as
  select id from public.projects where id = any (:'projects'::uuid[]);

do $$
begin
  if (select count(*) from seed_projects) = 0 then
    raise exception 'no matching projects — nothing to seed';
  end if;
end $$;

delete from public.projects where id not in (select id from seed_projects);

delete from public.datasets d
 where not exists (
   select 1 from public.project_artifacts a
    where a.artifact_kind = 'dataset'
      and a.artifact_id = d.id::text
      and a.project_id in (select id from seed_projects));

-- collections/groups: keep only those still holding a kept dataset
delete from public.collections c
 where not exists (select 1 from public.collection_datasets cd where cd.collection_id = c.id);
delete from public.groups g
 where not exists (select 1 from public.datasets d where d.group_id = g.id);

-- accounts: keep every profile still referenced by a surviving row, plus the
-- migration-seeded system user. The reference set is built from the FK catalog
-- so new tables are covered automatically.
do $$
declare
  fk record;
  sql text := 'select ''e0000000-0000-4000-8000-000000000000''::uuid as id';
begin
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass
  loop
    sql := sql || format(' union select %I from %s', fk.col, fk.tbl);
  end loop;
  execute 'create temp table seed_users as ' || sql;
end $$;

delete from auth.users where id not in (select id from seed_users where id is not null);
delete from public.profiles where id not in (select id from seed_users where id is not null);

analyze;
