-- ===========================================================================
-- Wheel Desk — Supabase schema, enums, indexes and Row Level Security.
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Every table is owner-scoped: a user can only ever see their own rows.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---- Enums ---------------------------------------------------------------
do $$ begin
  create type wheel_mode as enum ('paper', 'live');
exception when duplicate_object then null; end $$;

do $$ begin
  create type wheel_state as enum ('idle', 'short_put', 'holding', 'short_call', 'recovery', 'complete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type option_type as enum ('put', 'call', 'stock');
exception when duplicate_object then null; end $$;

do $$ begin
  create type trade_action as enum (
    'SELL_PUT_OPEN', 'BUY_PUT_CLOSE', 'PUT_EXPIRE', 'PUT_ASSIGN',
    'SELL_CALL_OPEN', 'BUY_CALL_CLOSE', 'CALL_EXPIRE', 'CALL_ASSIGN',
    'SELL_SHARES', 'BUY_SHARES', 'DIVIDEND'
  );
exception when duplicate_object then null; end $$;

-- ---- Tables --------------------------------------------------------------

-- One JSON row per user: the app's whole local ledger (used by "Sync now").
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Strategy parameters (also kept in the JSON payload; kept normalised for SQL queries).
create table if not exists public.settings (
  owner_id   uuid primary key references auth.users(id) on delete cascade,
  params     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  symbol     text not null,
  notes      text default '',
  checklist  jsonb,
  added_at   timestamptz not null default now(),
  unique (owner_id, symbol)
);

create table if not exists public.wheels (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  symbol       text not null,
  sector       text default '',
  mode         wheel_mode not null default 'paper',
  state        wheel_state not null default 'short_put',
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  plan         jsonb not null default '{}'::jsonb,
  review_date  date,
  lessons      text default ''
);

create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  wheel_id     uuid references public.wheels(id) on delete cascade,
  executed_at  timestamptz not null default now(),
  action       trade_action not null,
  option_type  option_type,
  strike       numeric,
  expiry       date,
  contracts    integer not null default 1 check (contracts >= 1),
  price        numeric not null default 0 check (price >= 0),
  fees         numeric not null default 0 check (fees >= 0),
  cash_flow    numeric not null default 0,
  mode         wheel_mode not null default 'paper',
  notes        text default ''
);

create table if not exists public.dividends (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users(id) on delete cascade,
  wheel_id          uuid references public.wheels(id) on delete cascade,
  symbol            text,
  ex_date           date,
  pay_date          date,
  amount_per_share  numeric not null default 0,
  shares            integer not null default 100
);

create table if not exists public.wheel_events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  wheel_id    uuid references public.wheels(id) on delete cascade,
  event_type  text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.snapshots (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  as_of           date not null default current_date,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (owner_id, as_of)
);

create table if not exists public.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Shared, read-only market data cache the proxy may use in future.
create table if not exists public.market_cache (
  symbol      text primary key,
  provider    text not null,
  payload     jsonb not null,
  as_of       timestamptz not null,
  expires_at  timestamptz not null
);

-- ---- Indexes -------------------------------------------------------------
create index if not exists trades_owner_idx      on public.trades (owner_id, executed_at desc);
create index if not exists trades_wheel_idx      on public.trades (wheel_id);
create index if not exists wheels_owner_idx      on public.wheels (owner_id, state);
create index if not exists watchlist_owner_idx   on public.watchlist (owner_id);
create index if not exists dividends_wheel_idx   on public.dividends (wheel_id);
create index if not exists events_wheel_idx      on public.wheel_events (wheel_id);
create index if not exists snapshots_owner_idx   on public.snapshots (owner_id, as_of desc);

-- ---- Row Level Security --------------------------------------------------
alter table public.user_state      enable row level security;
alter table public.settings        enable row level security;
alter table public.watchlist       enable row level security;
alter table public.wheels          enable row level security;
alter table public.trades          enable row level security;
alter table public.dividends       enable row level security;
alter table public.wheel_events    enable row level security;
alter table public.snapshots       enable row level security;
alter table public.journal_entries enable row level security;
alter table public.market_cache    enable row level security;

-- user_state: owner only.
drop policy if exists "user_state owner" on public.user_state;
create policy "user_state owner" on public.user_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Owner-scoped tables: one policy per table.
do $$
declare t text;
begin
  foreach t in array array[
    'settings','watchlist','wheels','trades','dividends','wheel_events','snapshots','journal_entries'
  ] loop
    execute format('drop policy if exists "owner %1$s" on public.%1$s', t);
    execute format(
      'create policy "owner %1$s" on public.%1$s for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- market_cache: readable by any authenticated user, written only by service role.
drop policy if exists "market_cache read" on public.market_cache;
create policy "market_cache read" on public.market_cache
  for select to authenticated using (true);
