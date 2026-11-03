-- Stage 0 / 0002 — profiles (design doc §3.1).
--
-- The stage-0 contract (§13) names "extensions postgis/pg_trgm + profiles +
-- helper functions"; 0001 shipped the extensions, this is the profiles
-- half: the table, the handle_new_user trigger, and the RLS projection.
--
-- The trigger is INSERT-time on auth.users, so every account the §9 recipe
-- admin-creates during stage 0 (service-role key / local Studio) lands with
-- a profiles row. It must ship WITH stage 0 for exactly that reason: the
-- trigger never replays history, so any account created before it lands
-- would permanently lack a profiles row and force a backfill. It mirrors
-- the component's user mirror (app/convex/schema.ts "users", maintained by
-- the Better Auth component triggers today).
--
-- SECURITY DEFINER with a pinned search_path: the insert runs as the
-- migration owner regardless of which role inserted into auth.users (the
-- GoTrue role holds no grants on public), and the pinned search_path keeps
-- the definer body from being re-pointed by a hostile search_path.

create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  email_verified boolean not null default false,
  name           text,
  image          text,
  created_at     timestamptz not null default now()
);

create index profiles_by_email on public.profiles (email);

create function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, email_verified, name, image)
  values (
    new.id,
    new.email,
    -- confirmed_at, not email_confirmed_at: §3.1's sketch names
    -- email_confirmed_at, but the pinned CI image (supabase/postgres
    -- 15.8.1.049) carries only confirmed_at, while the local CLI 3.0.0
    -- stack has both — confirmed_at exists everywhere in this stack and is
    -- set whenever GoTrue marks the account confirmed (the §9 recipe
    -- creates users with email_confirm: true), so it is the portable
    -- signal for email_verified.
    coalesce(new.confirmed_at is not null, false),
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The ADR 0009 addendum's public projection (authId/name/image public to
-- the signed-in app, email only ever reaching its own row's owner through
-- the self-scoped read): SELECT for all authenticated, UPDATE only the row
-- owner. No INSERT/DELETE policies — rows are born only from the trigger
-- above and die with their auth.users row (on delete cascade).
alter table public.profiles enable row level security;

create policy "profiles readable by any authenticated user"
  on public.profiles for select
  to authenticated
  using (true);

create policy "profiles updatable by the row owner only"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
