-- Run this once in the Supabase SQL editor for the church-alert PoC.
-- Creates the minimum schema + seeds one demo group + enables Realtime on alerts.

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.alerts
  add column if not exists sender_name text not null default 'Anonymous';

alter table public.alerts
  add column if not exists is_alert boolean not null default false;

create index if not exists alerts_group_id_created_at_idx
  on public.alerts (group_id, created_at desc);

insert into public.groups (name, join_code)
values ('Demo Church', 'CHURCH1')
on conflict (join_code) do nothing;

-- Realtime: broadcast new rows in public.alerts to subscribed clients.
alter publication supabase_realtime add table public.alerts;

-- Row-level security: PoC only — open read/insert to anon.
-- DO NOT use this policy in production.
alter table public.groups enable row level security;
alter table public.alerts enable row level security;

drop policy if exists "poc_groups_select" on public.groups;
create policy "poc_groups_select" on public.groups
  for select to anon, authenticated using (true);

drop policy if exists "poc_alerts_select" on public.alerts;
create policy "poc_alerts_select" on public.alerts
  for select to anon, authenticated using (true);

drop policy if exists "poc_alerts_insert" on public.alerts;
create policy "poc_alerts_insert" on public.alerts
  for insert to anon, authenticated with check (true);
