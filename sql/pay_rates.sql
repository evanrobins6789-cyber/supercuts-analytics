-- One-time setup for employee hourly pay rates (Homepage pay tracker,
-- api/_pay-rates.js). Run in Supabase → SQL Editor. Safe to re-run.
-- RLS on with no policies = the public anon key can't read or write it;
-- only the server's service-role key (used by the API endpoint) can.
create table if not exists public.pay_rates (
  emp_number text primary key,   -- "Employee Number" = Master Salon List Emp ID
  name text not null,            -- as "First Last" (from "Last, First M.")
  raw_name text,                 -- as the report spells it
  rate numeric,                  -- hourly $, null if the report had none
  updated_at timestamptz not null default now()
);
alter table public.pay_rates enable row level security;
revoke all on public.pay_rates from anon, authenticated;
grant all on public.pay_rates to service_role;
