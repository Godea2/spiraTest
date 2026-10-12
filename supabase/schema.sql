-- Shared storage for the Spira Test Set Reconciler.
-- Run once in Supabase: SQL Editor → New query → paste → Run. Running it again is safe.
--
-- Every saved item (settings, drafts, activity, defects, report setups) is one row, keyed like the
-- browser keeps it ("settings", "draft:<id>", "activity", ...). Only the app's server reads and writes
-- it, with the secret (service role) key; the browser never talks to Supabase.

create table if not exists public.app_store (
  key text primary key check (key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  value jsonb,
  -- A deleted item keeps its row, so another browser's older copy cannot bring it back.
  deleted boolean not null default false,
  -- Length of the value as JSON text, so the app can fetch large items in small batches.
  size integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Row level security with no policies: the public (anon) and signed-in (authenticated) API keys
-- can neither read nor write. The service role key used by the server bypasses it.
alter table public.app_store enable row level security;
revoke all on table public.app_store from anon, authenticated;
grant select, insert, update, delete on table public.app_store to service_role;
