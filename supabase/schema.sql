-- Run this in the Supabase SQL editor.
-- Schema for church-alert PoC: churches + per-team chats + church-wide ("everyone") alerts.

-- Rename legacy `groups` → `churches` if needed.
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

-- Rename legacy alerts.group_id → church_id if needed.
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
-- GPS coordinates captured at send time (e.g. from panic button). Nullable.

create index if not exists alerts_church_id_created_at_idx
  on public.alerts (church_id, created_at desc);
create index if not exists alerts_church_team_created_at_idx
  on public.alerts (church_id, team_slug, created_at desc);

insert into public.churches (name, join_code)
values ('Demo Church', 'CHURCH1')
on conflict (join_code) do nothing;

-- Realtime: only add to publication if not already there (re-adding errors).
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

-- Row-level security: PoC only — open read/insert to anon.
-- DO NOT use this policy in production.
alter table public.churches enable row level security;
alter table public.alerts enable row level security;

drop policy if exists "poc_groups_select" on public.churches;
drop policy if exists "poc_churches_select" on public.churches;
create policy "poc_churches_select" on public.churches
  for select to anon, authenticated using (true);

drop policy if exists "poc_alerts_select" on public.alerts;
create policy "poc_alerts_select" on public.alerts
  for select to anon, authenticated using (true);

drop policy if exists "poc_alerts_insert" on public.alerts;
create policy "poc_alerts_insert" on public.alerts
  for insert to anon, authenticated with check (true);
