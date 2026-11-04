-- Stage 1 prerequisite backfill — profiles (docs/supabase-migration-design.md §3.1).
--
-- §13's stage 0 names "first migration: extensions postgis/pg_trgm + profiles
-- + helper functions", but the stage-0 work committed to this tree shipped
-- only `0001_extensions.sql` (verified: migrations/ has no profiles file and
-- `public` was empty — the stage-0 record, §17, shows the same). The stage-1
-- core schema cannot land without it: every attribution column
-- (`created_by ... references public.profiles(id)`, §3) and the §4 helpers
-- assume the table exists. This file implements §3.1 exactly as written;
-- if a later stage-0 completion adds its own copy, keep exactly one.

create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  email_verified boolean not null default false,
  name           text,
  image          text,
  created_at     timestamptz not null default now()
);
create index profiles_by_email on public.profiles (email);

-- Trigger-maintained from auth.users (mirrors app/convex/schema.ts:42-50
-- "users", maintained today by the component's user triggers).
-- The supabase/postgres image bakes the auth schema
-- (/docker-entrypoint-initdb.d/init-scripts/00000000000001-auth-schema.sql),
-- and `postgres` may create triggers on auth.users (verified against the
-- local stack; CI's bare service container of the same image behaves
-- identically), so no DO-block guard is needed here.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, email_verified, name, image)
  values (new.id, new.email, coalesce(new.email_confirmed_at is not null, false),
          new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'avatar_url');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- §3.1 policy note: "SELECT for all authenticated; UPDATE only
-- `id = auth.uid()`". No INSERT/DELETE policies — profiles rows are born
-- from the trigger above (SECURITY DEFINER) and die with auth.users
-- (on delete cascade); clients never create or destroy them directly.
alter table public.profiles enable row level security;

create policy "profiles select: authenticated (public projection)"
  on public.profiles for select
  to authenticated
  using (true);

-- The ADR 0009 addendum's projection is column-level too: whole-row select
-- would hand every authenticated reader every user's email (the policy gates
-- ROWS; privileges gate COLUMNS). The public projection is
-- id/name/image/created_at; email stays server-side — the signed-in user
-- reads their own email from the auth session (the header's
-- `session.user.email`), and a later stage can expose a self-scoped view or
-- definer function if a UI surface ever needs the column.
revoke select on public.profiles from authenticated;
grant select (id, name, image, created_at) on public.profiles to authenticated;

create policy "profiles update: self only"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
