-- Project folders — the catalog as a file browser.
--
-- A project's catalog (its dataset memberships: sources and views alike —
-- a view is a dataset) gains folders. A folder is workspace organisation
-- only: it belongs to one project, nests under another folder of the same
-- project, and holds MEMBERSHIP rows (project_artifacts.folder_id), never
-- the artifacts themselves — so the same catalog dataset can sit in a
-- different folder in every project that links it, and nothing about
-- visibility, publishing or lineage reads a folder.
--
-- Access is the membership row (ADR 0017): every member reads the tree,
-- editors and owners change it. Folders ride no realtime channel (the
-- project channel carries projects + project_members only; the catalog's
-- TanStack invalidation covers them, as it does project_artifacts).

-- ---------------------------------------------------------------------------
-- §1 — project_folders
-- ---------------------------------------------------------------------------

create table public.project_folders (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  -- null = the catalog root. SET NULL is only the fallback for a raw delete:
  -- delete_project_folder (below) moves the contents up one level first.
  parent_id  uuid references public.project_folders on delete set null,
  name       text not null check (btrim(name) <> '' and char_length(name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One name per place, case-insensitive (root siblings included — NULLS NOT
-- DISTINCT makes two root folders of one project collide like any others).
create unique index project_folders_sibling_name
  on public.project_folders (project_id, parent_id, lower(btrim(name)))
  nulls not distinct;
create index project_folders_by_parent on public.project_folders (parent_id);

create trigger project_folders_set_updated_at before update on public.project_folders
  for each row execute function public.set_updated_at();

-- Tree integrity: a folder never changes project, its parent lives in the
-- same project, and a move never puts a folder inside itself or one of its
-- own descendants. SECURITY DEFINER: these are integrity reads of the tree,
-- not access checks (RLS on the row being written is the access check).
create function public.project_folders_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  cursor_id uuid;
  parent_project uuid;
  hops integer := 0;
begin
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    raise exception 'A folder cannot move to another project.' using errcode = '23514';
  end if;
  if new.parent_id is null then
    return new;
  end if;
  select f.project_id into parent_project
    from public.project_folders f where f.id = new.parent_id;
  if parent_project is null or parent_project <> new.project_id then
    raise exception 'The parent folder is not in this project.' using errcode = '23514';
  end if;
  cursor_id := new.parent_id;
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'A folder cannot be moved inside itself.' using errcode = '23514';
    end if;
    hops := hops + 1;
    if hops > 32 then
      raise exception 'Folders nest at most 32 levels deep.' using errcode = '23514';
    end if;
    select f.parent_id into cursor_id from public.project_folders f where f.id = cursor_id;
  end loop;
  return new;
end $$;

create trigger project_folders_guard before insert or update on public.project_folders
  for each row execute function public.project_folders_guard();

-- ---------------------------------------------------------------------------
-- §2 — project_artifacts.folder_id (null = the catalog root)
-- ---------------------------------------------------------------------------

alter table public.project_artifacts
  add column folder_id uuid references public.project_folders on delete set null;
create index project_artifacts_by_folder on public.project_artifacts (folder_id);

-- A membership only sits in a folder of its own project.
create function public.project_artifacts_folder_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.folder_id is not null and not exists (
    select 1 from public.project_folders f
    where f.id = new.folder_id and f.project_id = new.project_id
  ) then
    raise exception 'The folder is not in this project.' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger project_artifacts_folder_guard
  before insert or update of folder_id, project_id on public.project_artifacts
  for each row execute function public.project_artifacts_folder_guard();

-- ---------------------------------------------------------------------------
-- §3 — RLS: members read, editors write (the project_artifacts posture)
-- ---------------------------------------------------------------------------

alter table public.project_folders enable row level security;

create policy "project_folders select: project member"
  on public.project_folders for select to authenticated
  using (public.can_view_project(project_id));
create policy "project_folders insert: project editor"
  on public.project_folders for insert to authenticated
  with check (public.can_edit_project(project_id));
create policy "project_folders update: project editor"
  on public.project_folders for update to authenticated
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));
create policy "project_folders delete: project editor"
  on public.project_folders for delete to authenticated
  using (public.can_edit_project(project_id));

-- The supabase default privileges grant ALL on new tables to every role;
-- folders are a signed-in workspace surface (anon has no policy, and gets no
-- table right either).
revoke all on public.project_folders from anon;

-- ---------------------------------------------------------------------------
-- §4 — delete_project_folder: delete ONE folder, keeping what it holds.
-- Its subfolders and memberships move up to its parent in the same
-- transaction; nothing is removed from the project. SECURITY INVOKER — RLS
-- decides: a viewer's (or an outsider's) call moves nothing and answers 0.
-- A subfolder whose name is already taken one level up raises the sibling
-- name constraint (23505) and the whole delete rolls back.
-- ---------------------------------------------------------------------------

create function public.delete_project_folder(p_folder uuid) returns integer
language plpgsql security invoker set search_path = public, extensions as $$
declare
  target public.project_folders%rowtype;
  removed integer;
begin
  select * into target from public.project_folders f where f.id = p_folder;
  if not found or not public.can_edit_project(target.project_id) then
    return 0;
  end if;
  update public.project_folders set parent_id = target.parent_id where parent_id = target.id;
  update public.project_artifacts set folder_id = target.parent_id where folder_id = target.id;
  delete from public.project_folders where id = target.id;
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke execute on function public.delete_project_folder(uuid) from public, anon;
grant execute on function public.delete_project_folder(uuid) to authenticated;
