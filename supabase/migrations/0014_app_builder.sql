-- Stage 7 addendum — the app builder (docs/supabase-migration-design.md §3.6
-- `apps` block, §4; GitHub issue #216). 0012 carried the bound-datasets half
-- of §3.6 and deliberately left `apps` to "a separate stage-7 surface's
-- migration" — this is that migration. The deferred module ports with it:
-- every /apps route stops rendering its archived empty-state (PR #215's
-- deviation, commit 846980c).
--
-- TABLE: public.apps — field-for-field with the Convex table it mirrors
-- (app/convex/appBuilder/tables.ts; the sketch is §3.6's `apps` block):
--   title / description / sharing   — the app's metadata
--   dataset_ids uuid[]              — data REFERENCES only (the recorded
--     rule: apps store dataset refs, never data or grants — every widget
--     read rides the normal dataset visibility as the current viewer).
--     Plain array, NO FK, by design: the component parity keeps dangling
--     refs tolerated (apps.ts saveContent "datasets already in the app are
--     kept even if they have since gone away, so a deleted dataset never
--     wedges the editor").
--   pages jsonb                     — the tabs, INLINE as a bounded array
--     (validators.ts pageValidator: {id, title, layout: 'contained'|
--     'fullscreen', widgets[]}, each widget carrying its order+span grid
--     footprint {w, h} on the 12-column grid). jsonb, never widened here —
--     the widget payload is the feature's registry shape (the
--     layer_styles.style posture). NOT NULL default '[]': no legacy rows
--     exist on PG (the backend swap was a rewrite, data disposable), so the
--     Convex-era pre-pages `widgets` fallback (appPages()) has no surface
--     and is not carried.
--   example boolean                 — seeded examples flag (examples.ts)
--   revision integer                — the optimistic-concurrency counter
--     saveContent compares (two editor tabs can't silently overwrite).
--   created_by / created_at / updated_at — the §3 attribution shape.
-- Deviations from the sketch, each the house precedent:
--   * sharing is `text not null check (sharing in ('private','link'))` —
--     the sketch wrote jsonb, but the Convex validator is a two-literal
--     union and the literal-union-to-text-check mapping is the established
--     one (0005's map_layers.target_type).
--   * `example` is `not null default false` — every nullable-with-meaning
--     flag in the tree carries an explicit default (0005's visible).
--   * apps_by_creator extends the sketch's (created_by) with the list sort
--     column: `order by created_at desc` scans the index directly (the
--     datasets_by_lifecycle / sync_runs_by_binding precedent).
--
-- ACCESS MODEL (the delta from Convex, deliberate — the ask's rule): reads
-- are the maps-domain shape, flat `using (true)` for authenticated (shared
-- catalog posture, ADR 0009's trusted collaborator); writes answer ONLY to
-- the creator, and NEVER to the system identity. The Convex model hid
-- `sharing = 'private'` apps from non-creators (the null answer, no
-- existence leak); on PG every /apps-surface read is authenticated-open,
-- exactly like maps/map_layers/layer_styles, and `sharing` stays a field
-- for parity and any future tightening. Two consequences recorded here:
--   * the 0008 RETURNING hazard has no surface — the SELECT policy reads
--     nothing but `true` on the new row, so the shipped
--     `.insert(...).select(...)` create path cannot fail the read-back;
--   * the seeded examples are readable the same way as everything else;
--     what makes them read-only is the WRITE side, below.
--
-- WRITE POLICIES (creator-gated + the explicit system guard, the ask's
-- rule — the guard is not redundant belt-and-braces: a JWT minted with the
-- system uuid as `sub` would authenticate to that profile and pass the
-- bare creator gate):
--   insert : created_by = auth.uid() (stamped, never claimable — the §3
--            trigger + the column grants) AND example is not true (a human
--            can never mint an "example"; only the seed writes the flag)
--            AND created_by <> system_examples_owner()
--   update : creator AND not the system identity (both sides)
--   delete : creator AND not the system identity
-- Column grants pin the client-writable set (the 0003 datasets pattern):
-- created_by/created_at/example are server-owned; revision IS client-set —
-- it is the CAS value saveContent writes.
--
-- SEED (examples.ts parity): the Convex era seeded two sample datasets and
-- two example apps owned by the 'system:examples' identity — "so a fresh
-- deployment has something to open, learn from, and copy". On PG the
-- identity is a FIXED uuid profile row (profiles.id → auth.users, so the
-- identity carries a real auth.users row — inserted directly with the same
-- confirmed_at/email_confirmed_at column probe the int-test fixtures use,
-- because the baked auth schema of the bare image and the CLI-3.x GoTrue
-- stack differ; handle_new_user then mirrors the profile, and the direct
-- profile upsert below makes the seed not depend on the trigger). The
-- sample datasets are created the ADR 0010 way: published, everyone-visible,
-- edit_policy 'locked' with created_by = the system identity — so
-- can_edit_dataset is false for every human (locked = creator-only, and the
-- creator is no one's session; the explicit apps guard covers the apps'
-- own rows). Entries/geometries are inserted as admin: their created_by is
-- nullable and stamps to null — provenance-free sample rows, exactly like
-- the superuser-created fixtures everywhere else.
-- GUARDS: every seed row has a fixed uuid; the block no-ops when the
-- example apps already exist (re-apply safe). The app-row insert runs
-- BEFORE the created_by stamp trigger is created (last statement of this
-- file): the shared stamp would overwrite the system attribution with
-- auth.uid() = null for the admin-run seed, and no browser path can run
-- mid-migration — every later insert goes through the trigger.
--
-- NOT carried here (the issue's "optional"): adding apps to the
-- supabase_realtime publication — stage 6's matrix (0013) is untouched;
-- the builder's autosave is its own client flow and needs no channel yet.

-- ---------------------------------------------------------------------------
-- The system identity ('system:examples' PG edition) — one function so the
-- policies, the seed and the tests share one literal (0012's
-- constants-as-functions pattern: "never divergent copies in policy
-- bodies").
-- ---------------------------------------------------------------------------

create function public.system_examples_owner() returns uuid
language sql immutable as $$
  select 'e0000000-0000-4000-8000-000000000000'::uuid
$$;

-- ---------------------------------------------------------------------------
-- §3.6 — apps
-- ---------------------------------------------------------------------------

create table public.apps (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  -- The two-literal sharing union (validators.ts), as text + check.
  sharing     text not null default 'private' check (sharing in ('private','link')),
  -- Data REFERENCES only (see the header); uuid as the one PG dataset id space.
  dataset_ids uuid[] not null default '{}',
  -- The tabs, inline (pageValidator shape); the widget payload is the
  -- feature's shape, never widened here.
  pages       jsonb not null default '[]'::jsonb,
  -- Seeded examples: readable by everyone signed in, editable by no one.
  example     boolean not null default false,
  -- saveContent's optimistic-concurrency counter (client writes it; the
  -- grant below keeps it writable for exactly that CAS flow).
  revision    integer not null default 0,
  created_by  uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- The sketch's two indexes; by_creator carries the list sort (header note).
create index apps_by_creator on public.apps (created_by, created_at desc);
create index apps_by_example on public.apps (example);

-- §3 shared updated_at maintenance (the store stamps it per write too —
-- the maps.ts posture; the trigger is the last line of defense).
create trigger apps_set_updated_at before update on public.apps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- §4 — RLS: authenticated reads (flat, the maps-domain row), creator-gated
-- writes with the explicit system guard (see the header for both rules).
-- ---------------------------------------------------------------------------

alter table public.apps enable row level security;

create policy "apps select: authenticated"
  on public.apps for select to authenticated using (true);

-- created_by is STAMPED to the invoker before this check runs (the trigger
-- at the end of this file), so the check reads the stamped identity, and
-- `example is not true` keeps the seeded-examples flag seed-only.
create policy "apps insert: creator, never the system identity"
  on public.apps for insert to authenticated
  with check (
    created_by = auth.uid()
    and created_by <> public.system_examples_owner()
    and example is not true
  );

create policy "apps update: creator, never the system identity"
  on public.apps for update to authenticated
  using (created_by = auth.uid() and created_by <> public.system_examples_owner())
  with check (created_by = auth.uid() and created_by <> public.system_examples_owner());

create policy "apps delete: creator, never the system identity"
  on public.apps for delete to authenticated
  using (created_by = auth.uid() and created_by <> public.system_examples_owner());

-- The 0003 datasets pattern, literally: the client-writable column set is
-- granted; created_by / created_at / example are server-owned (stamp /
-- default / seed-only). revision IS granted — it is the CAS value
-- saveContent writes (the tables.ts doc line).
revoke update on public.apps from authenticated;
grant update (title, description, sharing, dataset_ids, pages, revision, updated_at)
  on public.apps to authenticated;

-- ---------------------------------------------------------------------------
-- The seed (examples.ts + exampleData.ts parity). Runs as the migration's
-- admin connection: superuser bypasses the RLS above, and the created_by
-- stamp trigger does not exist yet (created as the file's last statement —
-- see the header).
-- ---------------------------------------------------------------------------

do $seed$
declare
  v_system   uuid := public.system_examples_owner();
  v_parks    uuid := 'e0000000-0000-4000-8000-000000000001'::uuid;
  v_visits   uuid := 'e0000000-0000-4000-8000-000000000002'::uuid;
  v_explorer uuid := 'e0000000-0000-4000-8000-000000000003'::uuid;
  v_atlas    uuid := 'e0000000-0000-4000-8000-000000000004'::uuid;
  v_email    text := 'system-examples@system.jdm.local';
  v_confirmed text;
  v_seed_rows integer;
begin
  -- The identity's auth.users row (profiles.id → auth.users, so the profile
  -- FK needs it). Column probe, the ensureUsers lesson verbatim: the baked
  -- auth schema carries confirmed_at only; CLI-3.x GoTrue stacks carry
  -- email_confirmed_at (with confirmed_at GENERATED ALWAYS, refusing the
  -- explicit write). handle_new_user mirrors the profile row; the direct
  -- profile upsert under it makes the seed independent of the trigger.
  select case when exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users'
      and column_name = 'email_confirmed_at'
  ) then 'email_confirmed_at' else 'confirmed_at' end
  into v_confirmed;

  execute format(
    $fmt$insert into auth.users (id, email, encrypted_password, aud, role, %I, created_at, updated_at)
     values (%L, %L, '', 'authenticated', 'authenticated', now(), now(), now())
     on conflict (id) do nothing$fmt$,
    v_confirmed, v_system, v_email);

  -- The trigger's mirror row (if it fired) carries no name; the upsert below
  -- keeps the display name without clobbering one already set.
  insert into public.profiles (id, email, email_verified, name)
  values (v_system, v_email, true, 'App builder examples')
  on conflict (id) do update
    set name = coalesce(public.profiles.name, excluded.name),
        email_verified = true;

  -- Re-apply guard: the example apps are the seed's identity marker.
  if exists (select 1 from public.apps where id in (v_explorer, v_atlas)) then
    raise notice '0014: example apps already seeded — seed block skipped';
    return;
  end if;

  -- The sample datasets: published, everyone-visible, LOCKED with the
  -- system creator — can_edit_dataset answers false for every human
  -- session (examples.ts's ADR 0010 shape, "with no creator" PG edition).
  insert into public.datasets
    (id, title, description, json_schema, properties, is_geospatial, geometry_type,
     edit_policy, published_visibility, lifecycle, created_by)
  values
    (v_parks,
     'Example: National Parks',
     'U.S. national parks with size, founding year and 2023 recreation visits. Sample data with rounded, approximate values — for exploring the app builder.',
     $js${
       "type": "object",
       "title": "Example: National Parks",
       "description": "U.S. national parks with size, founding year and 2023 recreation visits. Sample data with rounded, approximate values — for exploring the app builder.",
       "properties": {
         "name": {"type": "string"},
         "state": {"type": "string"},
         "region": {"type": "string"},
         "established": {"type": "integer"},
         "area_acres": {"type": "number"},
         "visitors_millions": {"type": "number"}
       }
     }$js$::jsonb,
     '["name","state","region","established","area_acres","visitors_millions"]'::jsonb,
     true, 'Point', 'locked', 'everyone', 'published', v_system),
    (v_visits,
     'Example: Park System Visits by Year',
     'Total National Park System recreation visits per year. Sample data with rounded, approximate values — for exploring the app builder.',
     $js${
       "type": "object",
       "title": "Example: Park System Visits by Year",
       "description": "Total National Park System recreation visits per year. Sample data with rounded, approximate values — for exploring the app builder.",
       "properties": {
         "year": {"type": "integer"},
         "visitors_millions": {"type": "number"}
       }
     }$js$::jsonb,
     '["year","visitors_millions"]'::jsonb,
     false, null, 'locked', 'everyone', 'published', v_system);

  -- Parks rows + their Point geometries (exampleData.ts NATIONAL_PARKS,
  -- verbatim: [name, state, region, established, area, 2023 visits, lng, lat]).
  -- Pre-generated ids pair each entry with its geometry in one pass — the
  -- 0003 import_entries with_ids shape.
  with src as (
    select gen_random_uuid() as entry_id, r
    from jsonb_array_elements($parks$[
      ["Great Smoky Mountains", "TN", "Southeast", 1934, 522427, 13.3, -83.51, 35.61],
      ["Grand Canyon", "AZ", "Southwest", 1919, 1201647, 4.7, -112.14, 36.06],
      ["Zion", "UT", "Southwest", 1919, 147243, 4.6, -113.03, 37.3],
      ["Rocky Mountain", "CO", "Mountain West", 1915, 265807, 4.1, -105.68, 40.34],
      ["Yellowstone", "WY", "Mountain West", 1872, 2219791, 4.5, -110.59, 44.43],
      ["Yosemite", "CA", "Pacific West", 1890, 761748, 3.9, -119.54, 37.86],
      ["Acadia", "ME", "Northeast", 1916, 49075, 3.9, -68.21, 44.34],
      ["Grand Teton", "WY", "Mountain West", 1929, 310044, 3.4, -110.8, 43.79],
      ["Joshua Tree", "CA", "Pacific West", 1994, 795156, 2.9, -115.9, 33.87],
      ["Olympic", "WA", "Pacific West", 1938, 922650, 2.9, -123.5, 47.8],
      ["Glacier", "MT", "Mountain West", 1910, 1013126, 3.0, -113.79, 48.7],
      ["Cuyahoga Valley", "OH", "Midwest", 2000, 32571, 2.9, -81.57, 41.24],
      ["Indiana Dunes", "IN", "Midwest", 2019, 15349, 2.8, -87.05, 41.65],
      ["Bryce Canyon", "UT", "Southwest", 1928, 35835, 2.5, -112.18, 37.59],
      ["Arches", "UT", "Southwest", 1971, 76679, 1.5, -109.59, 38.73],
      ["Hot Springs", "AR", "Southeast", 1921, 5554, 2.6, -93.05, 34.52],
      ["Shenandoah", "VA", "Southeast", 1935, 200192, 1.4, -78.32, 38.53],
      ["Mount Rainier", "WA", "Pacific West", 1899, 236381, 1.7, -121.73, 46.88],
      ["Sequoia", "CA", "Pacific West", 1890, 404064, 1.3, -118.57, 36.49],
      ["Everglades", "FL", "Southeast", 1934, 1508938, 1.1, -80.9, 25.29],
      ["Badlands", "SD", "Midwest", 1978, 242756, 1.0, -102.34, 43.86],
      ["Death Valley", "CA", "Pacific West", 1994, 3408407, 1.1, -116.82, 36.51],
      ["Denali", "AK", "Alaska", 1917, 4740911, 0.5, -150.5, 63.33],
      ["Haleakalā", "HI", "Pacific West", 1916, 33265, 0.9, -156.15, 20.72],
      ["Big Bend", "TX", "Southwest", 1944, 801163, 0.6, -103.25, 29.25],
      ["Mammoth Cave", "KY", "Southeast", 1941, 54016, 0.7, -86.1, 37.19],
      ["Voyageurs", "MN", "Midwest", 1975, 218200, 0.2, -92.84, 48.48],
      ["Gates of the Arctic", "AK", "Alaska", 1980, 7523897, 0.01, -153.3, 67.78]
    ]$parks$::jsonb) as r
  ),
  ins_entries as (
    insert into public.entries (id, dataset_id, data, geometry_type)
    select s.entry_id, v_parks,
           jsonb_build_object(
             'name', r ->> 0,
             'state', r ->> 1,
             'region', r ->> 2,
             'established', (r ->> 3)::integer,
             'area_acres', (r ->> 4)::double precision,
             'visitors_millions', (r ->> 5)::double precision),
           'Point'
    from src s
    returning id
  ),
  ins_geometries as (
    insert into public.geometries (dataset_id, entry_id, source, type)
    select v_parks, s.entry_id,
           jsonb_build_object(
             'type', 'Point',
             'coordinates', jsonb_build_array(
               (r ->> 6)::double precision, (r ->> 7)::double precision)),
           'Point'
    from src s
  )
  -- plpgsql needs a destination (the 0003 import_entries shape verbatim —
  -- referencing ins_entries executes the whole WITH, geometry leg included).
  select count(*) into v_seed_rows from ins_entries;

  -- Visit totals per year (exampleData.ts SYSTEM_VISITS: [year, millions]).
  insert into public.entries (id, dataset_id, data)
  select gen_random_uuid(), v_visits,
         jsonb_build_object('year', (r ->> 0)::integer,
                            'visitors_millions', (r ->> 1)::double precision)
  from jsonb_array_elements($visits$[
    [2010, 281.3], [2011, 278.9], [2012, 282.8], [2013, 273.6],
    [2014, 292.8], [2015, 307.2], [2016, 330.9], [2017, 330.9],
    [2018, 318.2], [2019, 327.5], [2020, 237.1], [2021, 297.1],
    [2022, 311.9], [2023, 325.5]
  ]$visits$::jsonb) as r;

  -- The two example apps (examples.ts explorerPages/atlasPages,
  -- widget-for-widget with ONE deliberate repair: the visits charts'
  -- valueField reads `visitors_millions` — the seeded schema's field —
  -- where examples.ts still said `visits_millions`; the seed is the
  -- source of truth for the field name). The page JSON's dataset tokens
  -- are swapped for the seeded ids — uuid text is JSON-safe, so the
  -- nested replace() composes the literal.
  insert into public.apps
    (id, title, description, sharing, dataset_ids, pages, example, revision, created_by)
  values
    (v_explorer,
     'National Parks Explorer',
     'A contained, single-page dashboard: headline numbers, a map, charts and a table.',
     'link',
     array[v_parks, v_visits],
     replace(replace(
       $pages$[
         {
           "id": "overview",
           "layout": "contained",
           "title": "Overview",
           "widgets": [
             {"body": "## America's national parks\nTwenty-eight parks from Acadia to Gates of the Arctic. Click a point on the map for details.", "h": 2, "id": "intro", "kind": "text", "w": 12},
             {"aggregate": "count", "datasetId": "__PARKS__", "h": 2, "id": "parks", "kind": "stat", "title": "Parks", "w": 4},
             {"aggregate": "sum", "datasetId": "__PARKS__", "field": "visitors_millions", "h": 2, "id": "visits", "kind": "stat", "title": "2023 visits (millions)", "w": 4},
             {"aggregate": "min", "datasetId": "__PARKS__", "field": "established", "h": 2, "id": "oldest", "kind": "stat", "title": "Oldest park founded", "w": 4},
             {"datasetIds": ["__PARKS__"], "h": 6, "id": "map", "kind": "map", "title": "Where the parks are", "w": 8},
             {"aggregate": "sum", "chartType": "donut", "datasetId": "__PARKS__", "groupBy": "region", "h": 6, "id": "regions", "kind": "chart", "limit": 7, "sort": "value-desc", "title": "2023 visits by region (millions)", "valueField": "visitors_millions", "w": 4},
             {"aggregate": "sum", "chartType": "line", "datasetId": "__VISITS__", "groupBy": "year", "h": 5, "id": "per-year", "kind": "chart", "limit": 20, "sort": "label-asc", "title": "Park system visits per year (millions)", "valueField": "visitors_millions", "w": 6},
             {"columns": ["name", "state", "region", "established", "visitors_millions"], "datasetId": "__PARKS__", "h": 5, "id": "table", "kind": "table", "title": "All parks", "w": 6}
           ]
         }
       ]$pages$::text,
       '__PARKS__', v_parks::text), '__VISITS__', v_visits::text)::jsonb,
     true, 0, v_system),
    (v_atlas,
     'Park Visits Atlas',
     'A full-screen map on the first page and a dashboard on the second.',
     'link',
     array[v_parks, v_visits],
     replace(replace(
       $pages$[
         {
           "id": "map",
           "layout": "fullscreen",
           "title": "Map",
           "widgets": [
             {"datasetIds": ["__PARKS__"], "h": 12, "id": "atlas-map", "kind": "map", "w": 12}
           ]
         },
         {
           "id": "dashboard",
           "layout": "contained",
           "title": "Dashboard",
           "widgets": [
             {"aggregate": "sum", "datasetId": "__PARKS__", "field": "visitors_millions", "h": 2, "id": "atlas-visits", "kind": "stat", "title": "2023 visits (millions)", "w": 3},
             {"aggregate": "sum", "datasetId": "__PARKS__", "field": "area_acres", "h": 2, "id": "atlas-area", "kind": "stat", "title": "Protected acres", "w": 3},
             {"aggregate": "max", "datasetId": "__PARKS__", "field": "established", "h": 2, "id": "atlas-newest", "kind": "stat", "title": "Newest park founded", "w": 3},
             {"aggregate": "count", "datasetId": "__PARKS__", "h": 2, "id": "atlas-count", "kind": "stat", "title": "Parks", "w": 3},
             {"aggregate": "sum", "chartType": "bar", "datasetId": "__PARKS__", "groupBy": "region", "h": 6, "id": "atlas-regions", "kind": "chart", "limit": 10, "sort": "value-desc", "title": "2023 visits by region (millions)", "valueField": "visitors_millions", "w": 6},
             {"aggregate": "sum", "chartType": "area", "datasetId": "__VISITS__", "groupBy": "year", "h": 6, "id": "atlas-trend", "kind": "chart", "limit": 20, "sort": "label-asc", "title": "Park system visits per year (millions)", "valueField": "visitors_millions", "w": 6}
           ]
         }
       ]$pages$::text,
       '__PARKS__', v_parks::text), '__VISITS__', v_visits::text)::jsonb,
     true, 0, v_system);
end
$seed$;

-- ---------------------------------------------------------------------------
-- §3 attribution — LAST, after the seed (header note): created_by is
-- stamped from the request, never claimed from a client payload.
-- ---------------------------------------------------------------------------

create trigger apps_stamp_created_by before insert on public.apps
  for each row execute function public.stamp_created_by();
