-- Run this in the Supabase SQL editor.
-- Schema for Church Alert: auth-aware churches, alerts, invites, web push.
--
-- Order matters: tables → FK constraints → indexes → realtime/seed →
-- helper functions → RLS policies → RPC functions. Policies and RPCs
-- reference helpers, so helpers must exist before policies are created.

-- ============================================================
-- 1. Tables
-- ============================================================

-- Legacy rename `groups` → `churches` if needed (no-op on fresh DB).
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'groups'
  ) and not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'churches'
  ) then
    alter table public.groups rename to churches;
  end if;
end $$;

create table if not exists public.churches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

-- Legacy rename alerts.group_id → church_id if needed.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'alerts' and column_name = 'group_id'
  ) then
    alter table public.alerts rename column group_id to church_id;
  end if;
end $$;

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references public.churches(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.alerts add column if not exists sender_name text not null default 'Anonymous';
alter table public.alerts add column if not exists is_alert boolean not null default false;
alter table public.alerts add column if not exists team_slug text;
-- team_slug = null  →  church-wide ("everyone") message or alert
alter table public.alerts add column if not exists location text;
-- location = predefined location slug (e.g. "main_sanctuary") or null
alter table public.alerts add column if not exists latitude double precision;
alter table public.alerts add column if not exists longitude double precision;
-- GPS coordinates captured at send time. Nullable.
alter table public.alerts add column if not exists sender_id uuid;
-- Auth user who sent the alert. Nullable for legacy rows. New inserts
-- require sender_id = auth.uid() via RLS. FK to profiles added below.

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references public.churches(id) on delete cascade,
  sender_name text not null,
  joined_teams text[] not null default '{}',
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions
  add column if not exists user_id uuid;
-- Auth user owning this subscription. Nullable for legacy rows.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.church_members (
  user_id uuid not null references public.profiles(id) on delete cascade,
  church_id uuid not null references public.churches(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (user_id, church_id)
);

alter table public.church_members
  add column if not exists joined_teams text[] not null default '{}';
-- joined_teams: which teams (TEAMS slugs) this user is on within the
-- church. The chat lets a user join/leave individual teams without
-- changing church membership.

create table if not exists public.invites (
  token text primary key,
  church_id uuid not null references public.churches(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  redeemed_by uuid references public.profiles(id) on delete set null,
  redeemed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. FK constraints that depend on profiles existing
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'alerts_sender_id_fkey'
  ) then
    alter table public.alerts
      add constraint alerts_sender_id_fkey
      foreign key (sender_id) references public.profiles(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'push_subs_user_id_fkey'
  ) then
    alter table public.push_subscriptions
      add constraint push_subs_user_id_fkey
      foreign key (user_id) references public.profiles(id) on delete cascade;
  end if;
end $$;

-- ============================================================
-- 3. Indexes
-- ============================================================

create index if not exists alerts_church_id_created_at_idx
  on public.alerts (church_id, created_at desc);
create index if not exists alerts_church_team_created_at_idx
  on public.alerts (church_id, team_slug, created_at desc);
create index if not exists push_subs_church_idx
  on public.push_subscriptions (church_id);
create index if not exists push_subs_user_idx
  on public.push_subscriptions (user_id);
create index if not exists church_members_user_idx
  on public.church_members (user_id);
create index if not exists invites_church_idx
  on public.invites (church_id);

-- ============================================================
-- 4. Demo seed + realtime publication
-- ============================================================

insert into public.churches (name, join_code)
values ('Demo Church', 'CHURCH1')
on conflict (join_code) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'alerts'
  ) then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;

-- ============================================================
-- 5. Helper functions (security definer) — referenced by RLS policies.
-- Must exist before any policy that calls them.
-- ============================================================

create or replace function public.is_member_of(p_church_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.church_members
    where user_id = auth.uid() and church_id = p_church_id
  );
$$;

create or replace function public.is_owner_of(p_church_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.church_members
    where user_id = auth.uid()
      and church_id = p_church_id
      and role = 'owner'
  );
$$;

create or replace function public.is_co_member(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.church_members me
    join public.church_members them on me.church_id = them.church_id
    where me.user_id = auth.uid() and them.user_id = p_user_id
  );
$$;

grant execute on function public.is_member_of(uuid) to authenticated;
grant execute on function public.is_owner_of(uuid) to authenticated;
grant execute on function public.is_co_member(uuid) to authenticated;

-- ============================================================
-- 6. Row-Level Security
-- ============================================================

alter table public.churches enable row level security;
alter table public.alerts enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.profiles enable row level security;
alter table public.church_members enable row level security;
alter table public.invites enable row level security;

-- churches: anyone can read church names (used by /join/<token> preview).
drop policy if exists "poc_groups_select" on public.churches;
drop policy if exists "poc_churches_select" on public.churches;
create policy "poc_churches_select" on public.churches
  for select to anon, authenticated using (true);

-- alerts: only members of the church can read or write. The old open
-- PoC policies are dropped explicitly for cutover. The /legacy CHURCH1
-- chat depends on open RLS and stops working after this migration is
-- applied — that's expected on the auth-first branch.
drop policy if exists "poc_alerts_select" on public.alerts;
drop policy if exists "poc_alerts_insert" on public.alerts;

drop policy if exists "alerts_member_select" on public.alerts;
create policy "alerts_member_select" on public.alerts
  for select to authenticated using (public.is_member_of(church_id));

drop policy if exists "alerts_member_insert" on public.alerts;
create policy "alerts_member_insert" on public.alerts
  for insert to authenticated
  with check (public.is_member_of(church_id) and sender_id = auth.uid());

-- Owners (admins) of the church can moderate (delete) any alert in
-- their church. Senders cannot delete their own past messages by
-- design — emergency audit trails matter more than self-redaction.
drop policy if exists "alerts_owner_delete" on public.alerts;
create policy "alerts_owner_delete" on public.alerts
  for delete to authenticated using (public.is_owner_of(church_id));

-- push_subscriptions: owner of the row can manage it; must be a member
-- of the target church.
drop policy if exists "poc_push_subs_rw" on public.push_subscriptions;
drop policy if exists "push_subs_self_rw" on public.push_subscriptions;
create policy "push_subs_self_rw" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_member_of(church_id));

-- profiles: a user reads/writes their own row; can also see profiles of
-- other members of any church they share.
drop policy if exists "profiles_self_rw" on public.profiles;
create policy "profiles_self_rw" on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "profiles_co_members_select" on public.profiles;
create policy "profiles_co_members_select" on public.profiles
  for select to authenticated using (public.is_co_member(profiles.id));

-- church_members: read your own memberships and co-members of your
-- churches. Inserts/deletes go through SECURITY DEFINER RPCs
-- (redeem_invite, create_church). Updates allowed for your own row only
-- — used to toggle joined_teams when you join or leave a team.
drop policy if exists "members_visible" on public.church_members;
create policy "members_visible" on public.church_members
  for select to authenticated using (
    user_id = auth.uid() or public.is_member_of(church_id)
  );

drop policy if exists "members_self_update" on public.church_members;
create policy "members_self_update" on public.church_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- invites: owners read/write invites for their church. Anyone holding
-- the token can SELECT the row to preview the church before signing up
-- (the token itself is the secret).
drop policy if exists "invites_owner_rw" on public.invites;
create policy "invites_owner_rw" on public.invites
  for all to authenticated
  using (public.is_owner_of(invites.church_id))
  with check (public.is_owner_of(invites.church_id));

drop policy if exists "invites_token_preview" on public.invites;
create policy "invites_token_preview" on public.invites
  for select to anon, authenticated using (true);

-- ============================================================
-- 7. RPC functions
-- ============================================================

-- create_church: caller becomes the owner of a freshly-created church.
create or replace function public.create_church(church_name text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_church_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if length(coalesce(trim(church_name), '')) = 0 then
    raise exception 'church name required';
  end if;

  insert into public.churches (name, join_code)
    values (trim(church_name), 'INV-' || encode(extensions.gen_random_bytes(4), 'hex'))
    returning id into v_church_id;

  insert into public.church_members (user_id, church_id, role)
    values (v_user, v_church_id, 'owner');

  return v_church_id;
end;
$$;

grant execute on function public.create_church(text) to authenticated;

-- create_invite: an owner of a church mints a single-use token.
create or replace function public.create_invite(p_church_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_token text;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from public.church_members
    where user_id = v_user and church_id = p_church_id and role = 'owner'
  ) then
    raise exception 'not an owner of this church';
  end if;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');

  insert into public.invites (token, church_id, created_by)
    values (v_token, p_church_id, v_user);

  return v_token;
end;
$$;

grant execute on function public.create_invite(uuid) to authenticated;

-- redeem_invite: caller becomes a member of the church the invite points
-- to. Atomically marks the invite consumed.
create or replace function public.redeem_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_church uuid;
  v_redeemed uuid;
  v_expires timestamptz;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  select church_id, redeemed_by, expires_at
    into v_church, v_redeemed, v_expires
  from public.invites
  where token = invite_token
  for update;

  if v_church is null then
    raise exception 'invite not found';
  end if;
  if v_redeemed is not null then
    raise exception 'invite already used';
  end if;
  if v_expires is not null and v_expires < now() then
    raise exception 'invite expired';
  end if;

  update public.invites
    set redeemed_by = v_user, redeemed_at = now()
    where token = invite_token;

  insert into public.church_members (user_id, church_id, role)
    values (v_user, v_church, 'member')
    on conflict do nothing;

  return v_church;
end;
$$;

grant execute on function public.redeem_invite(text) to authenticated;

-- ============================================================
-- 8. Auto-create a profile row when a new auth user signs up.
-- The client-side /signup page's profile insert can race with session
-- propagation or be blocked by RLS while a confirmation email is
-- pending; the trigger runs in SECURITY DEFINER context so it always
-- wins. Idempotent via on-conflict.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      split_part(new.email, '@', 1),
      'User'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- One-time backfill: every existing auth.users row without a profile
-- gets one. Safe to re-run.
insert into public.profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(trim(u.raw_user_meta_data->>'display_name'), ''),
    split_part(u.email, '@', 1),
    'User'
  )
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;
