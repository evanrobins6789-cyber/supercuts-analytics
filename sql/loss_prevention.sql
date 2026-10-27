-- One-time setup for the owner-only Loss Prevention tab (api/loss-prevention.js).
-- Run in Supabase → SQL Editor. Safe to re-run.
-- RLS on with no policies = the public anon key can't read or write it;
-- only the server's service-role key (used by the API endpoint) can.
create table if not exists public.loss_prevention (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.loss_prevention enable row level security;
revoke all on public.loss_prevention from anon, authenticated;
grant all on public.loss_prevention to service_role;
