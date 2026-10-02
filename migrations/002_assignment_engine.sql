-- ===========================================================================
-- 002_assignment_engine.sql — append-only ledger + recovery check-ins
-- Safe to run on the existing database (idempotent). Uses owner_id to match
-- the existing RLS pattern. Run after supabase/schema.sql.
-- ===========================================================================

-- Append-only event ledger: one row per money event. Never delete; void instead.
create table if not exists public.wheel_events (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users(id) on delete cascade,
  wheel_id      uuid references public.wheels(id) on delete cascade,
  created_at    timestamptz not null default now(),
  event_time    timestamptz not null default now(),   -- fill time, stored UTC
  type          text not null check (type in (
                  'PUT_SOLD','PUT_BOUGHT_TO_CLOSE','PUT_EXPIRED','PUT_ASSIGNED',
                  'CALL_SOLD','CALL_BOUGHT_TO_CLOSE','CALL_EXPIRED','CALL_ASSIGNED',
                  'SHARES_SOLD','SHARES_BOUGHT','DIVIDEND_RECEIVED','FEE_ADJUSTMENT')),
  contracts     integer not null default 0,
  shares        integer not null default 0,
  strike        numeric(14,4),
  expiry        date,
  option_price  numeric(14,4),
  share_price   numeric(14,4),
  commission    numeric(14,4) not null default 0,
  amount        numeric(14,4) not null default 0,     -- signed cash effect
  delta         numeric(8,4),
  bid           numeric(14,4),
  ask           numeric(14,4),
  open_interest integer,
  volume        integer,
  underlying_price numeric(14,4),
  note          text default '',
  mode          text not null default 'PAPER' check (mode in ('PAPER','LIVE')),
  voided        boolean not null default false
);

-- Weekly / monthly recovery check-ins.
create table if not exists public.wheel_checkins (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,
  wheel_id                uuid references public.wheels(id) on delete cascade,
  checkin_date            date not null default current_date,
  stock_price             numeric(14,4),
  gap_pct                 numeric(8,4),
  best_strike             numeric(14,4),
  best_expiry             date,
  best_net_premium_per_share numeric(14,4),
  thesis_ok               boolean,
  would_buy_today         boolean,
  path                    text,
  note                    text default ''
);

-- Extend wheels with stage/path/thesis/dividend fields.
alter table public.wheels add column if not exists stage text;
alter table public.wheels add column if not exists path text;
alter table public.wheels add column if not exists thesis_ok boolean default true;
alter table public.wheels add column if not exists next_earnings date;
alter table public.wheels add column if not exists next_ex_div date;
alter table public.wheels add column if not exists ex_div_amount numeric(14,4);
alter table public.wheels add column if not exists closed_reason text;

create index if not exists wheel_events_owner_idx on public.wheel_events (owner_id, event_time desc);
create index if not exists wheel_events_wheel_idx on public.wheel_events (wheel_id, event_time);
create index if not exists wheel_checkins_wheel_idx on public.wheel_checkins (wheel_id, checkin_date desc);

alter table public.wheel_events  enable row level security;
alter table public.wheel_checkins enable row level security;

drop policy if exists "owner wheel_events" on public.wheel_events;
create policy "owner wheel_events" on public.wheel_events
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owner wheel_checkins" on public.wheel_checkins;
create policy "owner wheel_checkins" on public.wheel_checkins
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
