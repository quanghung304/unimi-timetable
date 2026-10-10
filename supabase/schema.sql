-- University Timetable — database schema for Supabase.
-- Run once in Supabase Dashboard → SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Profiles: one row per user, created automatically on sign-up.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  full_name       text not null default '' check (char_length(full_name) <= 120),
  course_of_study text not null default '' check (char_length(course_of_study) <= 300),
  academic_year   text not null default '' check (char_length(academic_year) <= 20),
  year_of_study   text not null default '' check (char_length(year_of_study) <= 60),
  updated_at      timestamptz not null default now()
);
-- Set once the user has seen the how-to guide (shown automatically on first sign-in).
alter table public.profiles add column if not exists guide_seen boolean not null default false;
-- When the user last imported each file (drives the "timetables can change" reminder).
alter table public.profiles add column if not exists last_import_lessons timestamptz;
alter table public.profiles add column if not exists last_import_exams timestamptz;
-- Optional: name of the university (for students outside UniMi).
alter table public.profiles add column if not exists university text not null default '' check (char_length(university) <= 200);

-- ---------------------------------------------------------------------------
-- Sessions: one row per lesson slot (a 4h block from the export is stored as two 2h rows).
-- source_key = "<date>_<HHMM>_<course-slug>" for imported rows; it lets a re-import
-- match existing rows so user edits and notes survive.
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  date        date not null,
  start_time  time not null,
  end_time    time not null,
  course      text not null check (char_length(course) between 1 and 200),
  lecturer    text not null default '' check (char_length(lecturer) <= 300),
  room        text not null default '' check (char_length(room) <= 200),
  type        text not null default '' check (char_length(type) <= 50),
  note        text not null default '' check (char_length(note) <= 2000),
  source      text not null default 'manual' check (source in ('import', 'manual')),
  source_key  text check (char_length(source_key) <= 120),
  modified    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_time > start_time),
  unique (user_id, source_key)
);
create index if not exists sessions_user_date_idx on public.sessions (user_id, date);

-- Weekly recurring lessons added by hand share a series_id, so the whole series
-- (or "this and following") can be edited or deleted at once.
alter table public.sessions add column if not exists series_id uuid;
create index if not exists sessions_series_idx on public.sessions (series_id) where series_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security: every user sees and edits only their own rows.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.sessions enable row level security;

drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Users may not change their stored email through the API.
revoke update (email) on public.profiles from authenticated;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- 1) Sign-up is open to any email address (students of other universities too).
--    Removes the earlier @studenti.unimi.it-only guard if it was installed.
drop trigger if exists enforce_email_domain on auth.users;
drop function if exists public.enforce_email_domain();

-- 2) Create the profile row for each new user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Keep updated_at current.
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch before update on public.sessions
  for each row execute function public.touch_updated_at();

-- 4) Cap rows per user so one account cannot fill the free-tier database.
create or replace function public.limit_sessions_per_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.sessions where user_id = new.user_id) >= 3000 then
    raise exception 'Session limit reached (3000 per user)';
  end if;
  return new;
end $$;

drop trigger if exists sessions_limit on public.sessions;
create trigger sessions_limit before insert on public.sessions
  for each row execute function public.limit_sessions_per_user();

-- ---------------------------------------------------------------------------
-- GDPR: let a signed-in user delete their own account (profile + sessions cascade).
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Admins: no emails are sent, so a user who forgets their password asks an admin,
-- who sets a temporary one. Admins are listed by user id (not email), so someone
-- who later signs up with the same address cannot inherit the role.
-- Add yourself after creating your account:
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'hung.cao@studenti.unimi.it';
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.admins enable row level security;  -- no policies: invisible to the API

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.admin_reset_password(target_email text, new_password text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
begin
  if not public.is_admin() then
    raise exception 'Not allowed';
  end if;
  if char_length(coalesce(new_password, '')) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  select id into target from auth.users where lower(email) = lower(trim(target_email));
  if target is null then
    raise exception 'No account with that email';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = target;
end $$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.admin_reset_password(text, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_reset_password(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Feedback: reviews, bug reports and feature requests.
-- Users insert and read their own; admins read all and set status / reply.
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email       text not null default '',
  kind        text not null check (kind in ('review', 'bug', 'feature')),
  rating      smallint check (rating between 1 and 5),
  message     text not null check (char_length(message) between 1 and 4000),
  context     jsonb not null default '{}'::jsonb,          -- browser / screen info for bug reports
  status      text not null default 'new' check (status in ('new', 'in_progress', 'done', 'wont_fix')),
  admin_reply text not null default '' check (char_length(admin_reply) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_user_idx on public.feedback (user_id);
alter table public.feedback enable row level security;

drop policy if exists "feedback insert own" on public.feedback;
drop policy if exists "feedback read own or admin" on public.feedback;
drop policy if exists "feedback admin update" on public.feedback;
create policy "feedback insert own" on public.feedback for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "feedback read own or admin" on public.feedback for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy "feedback admin update" on public.feedback for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- On insert: fill the sender's email, reset admin-only fields, and allow at most
-- 20 messages per user per 24 hours.
create or replace function public.feedback_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.feedback
       where user_id = new.user_id and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'Too many feedback messages today. Please try again tomorrow.';
  end if;
  new.email := coalesce((select email from auth.users where id = new.user_id), '');
  new.status := 'new';
  new.admin_reply := '';
  if new.kind <> 'review' then new.rating := null; end if;
  return new;
end $$;

drop trigger if exists feedback_before_insert on public.feedback;
create trigger feedback_before_insert before insert on public.feedback
  for each row execute function public.feedback_before_insert();
drop trigger if exists feedback_touch on public.feedback;
create trigger feedback_touch before update on public.feedback
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Admin: user management (list, admin role, disable, delete).
-- Every function checks public.is_admin(); none of them can target the caller.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  id uuid, email text, full_name text, university text, course_of_study text,
  created_at timestamptz, last_sign_in_at timestamptz,
  banned boolean, is_admin boolean, sessions bigint, feedback bigint
)
language sql stable security definer set search_path = '' as $$
  select u.id, u.email::text, coalesce(p.full_name, ''), coalesce(p.university, ''), coalesce(p.course_of_study, ''),
         u.created_at, u.last_sign_in_at,
         coalesce(u.banned_until > now(), false),
         exists (select 1 from public.admins a where a.user_id = u.id),
         (select count(*) from public.sessions s where s.user_id = u.id),
         (select count(*) from public.feedback f where f.user_id = u.id)
    from auth.users u
    left join public.profiles p on p.id = u.id
   where public.is_admin()
   order by u.created_at desc;
$$;

create or replace function public.admin_set_admin(target uuid, make boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not allowed'; end if;
  if target = auth.uid() then raise exception 'You cannot change your own admin role'; end if;
  if make then
    insert into public.admins (user_id) values (target) on conflict do nothing;
  else
    delete from public.admins where user_id = target;
  end if;
end $$;

-- Disabled users cannot sign in (Supabase Auth refuses users with banned_until in the future).
create or replace function public.admin_set_banned(target uuid, banned boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not allowed'; end if;
  if target = auth.uid() then raise exception 'You cannot disable your own account'; end if;
  update auth.users
     set banned_until = case when banned then now() + interval '100 years' else null end
   where id = target;
end $$;

-- Deletes the account and (via cascades) its profile, sessions, feedback and admin role.
create or replace function public.admin_delete_user(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not allowed'; end if;
  if target = auth.uid() then raise exception 'Use "Delete my account" in Profile to delete yourself'; end if;
  delete from auth.users where id = target;
end $$;

revoke all on function public.admin_list_users() from public, anon;
revoke all on function public.admin_set_admin(uuid, boolean) from public, anon;
revoke all on function public.admin_set_banned(uuid, boolean) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;
grant execute on function public.admin_set_banned(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
