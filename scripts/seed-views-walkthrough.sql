-- Seed for the Views browser walkthrough (docs/views-design.md §5).
-- Local stack only. Usage:
--   docker exec -i jdm-db psql -U supabase_admin -d app -v ON_ERROR_STOP=1 \
--     -v owner_email=demo@jdm.test -f - < scripts/seed-views-walkthrough.sql
-- Creates a project "Views walkthrough" owned by :owner_email with four
-- published datasets: states (polygons), deployments (points with stateId),
-- deploymentAgencies, links (stateName/type/url, stray whitespace/casing and
-- one name that matches no state).
\set ON_ERROR_STOP on
begin;

select id as owner_id from auth.users where email = :'owner_email' \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'owner_id', 'role', 'authenticated')::text, false);

insert into public.projects (title, created_by)
values ('Views walkthrough', :'owner_id')
returning id as project_id \gset

create temp table seed_ids (name text primary key, id uuid);

with ins as (
  insert into public.datasets (title, properties, created_by, lifecycle, visibility, is_geospatial, geometry_type)
  values
    ('States', '["id","name"]', :'owner_id', 'published', 'members', true, 'Polygon'),
    ('Deployments', '["id","name","stateId"]', :'owner_id', 'published', 'members', true, 'Point'),
    ('Deployment agencies', '["deploymentId","agencyId"]', :'owner_id', 'published', 'members', false, null),
    ('Links', '["stateName","type","url"]', :'owner_id', 'published', 'members', false, null)
  returning id, title
)
insert into seed_ids select lower(replace(title, ' ', '_')), id from ins;

insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
select :'project_id', id, 'dataset', 'owned', 'manual' from seed_ids;

-- States: four unit squares side by side.
create temp table seed_states (id text, name text, x int);
insert into seed_states values ('KS', 'Kansas', 0), ('MO', 'Missouri', 2), ('NE', 'Nebraska', 4), ('IA', 'Iowa', 6);

with e as (
  insert into public.entries (dataset_id, data)
  select (select id from seed_ids where name = 'states'),
         jsonb_build_object('id', s.id, 'name', s.name)
  from seed_states s returning id, data
)
insert into public.geometries (dataset_id, entry_id, type, bbox, source)
select (select id from seed_ids where name = 'states'), e.id, 'Polygon', array[s.x, 0, s.x + 1.5, 1.5]::float8[],
  json_build_object('type', 'Polygon', 'coordinates', json_build_array(json_build_array(
    json_build_array(s.x, 0), json_build_array(s.x + 1.5, 0), json_build_array(s.x + 1.5, 1.5),
    json_build_array(s.x, 1.5), json_build_array(s.x, 0))))::jsonb
from e join seed_states s on s.id = e.data->>'id';

-- Deployments: points inside their state (KS x3, MO x2, NE x1, IA none).
create temp table seed_dep (id text, name text, state text, x numeric, y numeric);
insert into seed_dep values
  ('d1', 'Main Street', 'KS', 0.3, 0.3), ('d2', 'Safe Streets Wichita', 'KS', 0.8, 0.9),
  ('d3', 'Harbor Crossing', 'KS', 1.2, 0.5), ('d4', 'River Loop', 'MO', 2.3, 0.4),
  ('d5', 'Gateway Corridor', 'MO', 2.9, 1.1), ('d6', 'Platte Trail', 'NE', 4.5, 0.7);

with e as (
  insert into public.entries (dataset_id, data)
  select (select id from seed_ids where name = 'deployments'),
         jsonb_build_object('id', d.id, 'name', d.name, 'stateId', d.state)
  from seed_dep d returning id, data
)
insert into public.geometries (dataset_id, entry_id, type, bbox, source)
select (select id from seed_ids where name = 'deployments'), e.id, 'Point', array[d.x, d.y, d.x, d.y]::float8[],
  json_build_object('type', 'Point', 'coordinates', json_build_array(d.x, d.y))::jsonb
from e join seed_dep d on d.id = e.data->>'id';

-- Agencies per deployment (Main Street has the most collaboration).
insert into public.entries (dataset_id, data)
select (select id from seed_ids where name = 'deployment_agencies'),
       jsonb_build_object('deploymentId', a.dep, 'agencyId', a.agency)
from (values ('d1','a1'),('d1','a2'),('d1','a3'),('d2','a1'),('d3','a4'),('d3','a5'),
             ('d4','a2'),('d5','a2'),('d5','a6'),('d5','a7'),('d5','a8'),('d6','a9')) as a(dep, agency);

-- Links: stray whitespace / casing, 0-3 per state, and one unmatched name.
insert into public.entries (dataset_id, data)
select (select id from seed_ids where name = 'links'),
       jsonb_build_object('stateName', l.state_name, 'type', l.type, 'url', l.url)
from (values
  ('Kansas', 'docs', 'https://example.test/ks/docs'),
  ('  kansas ', 'benefits', 'https://example.test/ks/benefits'),
  ('MISSOURI', 'docs', 'https://example.test/mo/docs'),
  ('Nebraska', 'docs', 'https://example.test/ne/docs'),
  ('Nebraska', 'benefits', 'https://example.test/ne/benefits'),
  ('Nebraska', 'faq', 'https://example.test/ne/faq'),
  ('Narnia', 'docs', 'https://example.test/narnia/docs')
) as l(state_name, type, url);

select 'project' as what, :'project_id' as id
union all select name, id::text from seed_ids order by 1;

commit;
