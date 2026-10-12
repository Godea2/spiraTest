-- =====================================================================================================
-- Spira Test Set Reconciler: data saved in Supabase.
--
-- Run once in Supabase: SQL Editor → New query → paste this file → Run. Running it again is safe, and it
-- replaces the earlier one-table version (items saved with that version stay readable).
--
-- Only the app's server reads and writes these tables, with the secret (service role) key, through the
-- two functions at the end. The browser never talks to Supabase. Row level security is on with no
-- policies, so Supabase's public keys (anon, authenticated) can read and change nothing.
--
-- Each table keeps the full record as the app saved it in `data`, so nothing is lost, plus columns for
-- what is worth querying: drafts with their board counts and execution progress, every test run the app
-- recorded in Spira, defects and the cases they affect, the activity log, settings with module
-- mappings, and report setups and history.
-- =====================================================================================================

-- ---- Team settings ----------------------------------------------------------------------------------

create table if not exists public.settings (
  id text primary key default 'team' check (id = 'team'),
  project_id integer,
  release_id integer,
  release_label text,
  plan_release_id integer,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.settings is 'The team''s Spira project, Phase 1 release and total test plan release (one row).';

create table if not exists public.module_mappings (
  id bigint generated always as identity primary key,
  module text not null,
  test_set_id integer not null,
  test_set_name text,
  platform text,
  excel_alias text
);
comment on table public.module_mappings is 'Modules pinned to Spira test sets in Settings.';

-- ---- Drafts (one per module comparison) and the test runs recorded from them ------------------------

create table if not exists public.drafts (
  id text primary key,
  project_id integer not null,
  module text not null,
  name text not null,
  -- draft | applied | appliedWithErrors
  status text not null,
  -- review | completed
  stage text not null,
  release_id integer,
  release_label text,
  workbook text,
  test_set_ids integer[] not null default '{}',
  platforms text[] not null default '{}',
  total_cases integer,
  in_scope integer,
  defects integer,
  blocked integer,
  out_of_scope integer,
  needs_review integer,
  missing_from_spira integer,
  executed integer,
  execution_total integer,
  completed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null,
  synced_at timestamptz not null default now(),
  -- Deleted drafts are kept for the record; the app no longer shows them.
  deleted_at timestamptz
);
comment on table public.drafts is 'Module comparisons: board counts, completion and execution progress. Full draft in data.';
create index if not exists drafts_project_module on public.drafts (project_id, module);
create index if not exists drafts_stage on public.drafts (stage) where deleted_at is null;

create table if not exists public.test_runs (
  id bigint generated always as identity primary key,
  draft_id text not null references public.drafts (id) on delete cascade,
  test_run_id bigint not null,
  project_id integer not null,
  module text not null,
  test_set_id integer not null,
  test_case_id integer not null,
  test_set_test_case_id integer not null,
  -- Passed, Failed, Blocked, Caution, ...
  status text not null,
  tester text,
  comment text,
  executed_at timestamptz not null,
  -- execution (the execute page) | sign-off (bulk result on completion)
  recorded_by text not null
);
comment on table public.test_runs is 'Every test run this app recorded in Spira (TR ids), with result, tester and time.';
create index if not exists test_runs_draft on public.test_runs (draft_id);
create index if not exists test_runs_case on public.test_runs (project_id, test_case_id);
create index if not exists test_runs_executed on public.test_runs (executed_at desc);

-- ---- Defects and the cases they affect --------------------------------------------------------------

create table if not exists public.defects (
  id text primary key,
  project_id integer not null,
  incident_id integer,
  title text not null,
  description text,
  tester text,
  logged_at timestamptz not null,
  linked_steps integer not null default 0,
  case_count integer not null default 0,
  created_test_case_id integer,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.defects is 'Defects found with the app and logged in Spira as incidents (IN ids).';
create index if not exists defects_project on public.defects (project_id, logged_at desc);

create table if not exists public.defect_cases (
  id bigint generated always as identity primary key,
  defect_id text not null references public.defects (id) on delete cascade,
  draft_id text,
  module text,
  test_set_id integer,
  test_case_id integer,
  test_set_test_case_id integer,
  test_run_id bigint,
  name text,
  step_label text,
  moved_from text
);
comment on table public.defect_cases is 'Test cases failed for each defect, with the run and step it is linked to.';
create index if not exists defect_cases_defect on public.defect_cases (defect_id);

-- ---- Activity log -----------------------------------------------------------------------------------

create table if not exists public.activity_log (
  id text primary key,
  at timestamptz not null,
  type text not null,
  message text not null,
  draft_id text,
  module text,
  details jsonb,
  data jsonb not null
);
comment on table public.activity_log is 'Everything done in the app, from every browser. Never trimmed here.';
create index if not exists activity_log_at on public.activity_log (at desc);

-- ---- Reports ----------------------------------------------------------------------------------------

create table if not exists public.report_setups (
  key text primary key,
  project_id integer not null,
  kind text,
  title text,
  prepared_by text,
  go_live date,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.report_setups is 'Report type, header and defect notes per project.';

create table if not exists public.report_history (
  key text primary key,
  project_id integer not null,
  release_id integer,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.report_history is 'Daily report figures, used for "change since the last report".';

-- ---- Other small items, and what changed when -------------------------------------------------------

create table if not exists public.app_store (
  key text primary key check (key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  value jsonb,
  deleted boolean not null default false,
  size integer not null default 0,
  updated_at timestamptz not null default now()
);
comment on table public.app_store is 'Small app choices (for example modules left out of defect searches).';

create table if not exists public.sync_keys (
  key text primary key check (key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  updated_at timestamptz not null,
  -- A deleted item keeps its row, so an older copy in another browser cannot bring it back.
  deleted boolean not null default false,
  size integer not null default 0
);
comment on table public.sync_keys is 'When each saved item last changed, so browsers load only what changed.';

-- Items saved by an earlier version of this script stay readable.
insert into public.sync_keys (key, updated_at, deleted, size)
select key, updated_at, deleted, size from public.app_store
on conflict (key) do nothing;

-- ---- Access: the server's secret key only -----------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['settings', 'module_mappings', 'drafts', 'test_runs', 'defects', 'defect_cases',
                           'activity_log', 'report_setups', 'report_history', 'app_store', 'sync_keys']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ---- Saving: one call per batch, all or nothing -----------------------------------------------------
-- items: [{ key, kind, deleted, size, value?, row?, rows?, children? }], prepared by the app's server.

create or replace function public.store_write(items jsonb, written_at timestamptz)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  k text;
  item_kind text;
  gone boolean;
  ids text[];
begin
  for item in select value from jsonb_array_elements(items) loop
    k := item->>'key';
    item_kind := item->>'kind';
    gone := coalesce((item->>'deleted')::boolean, false);

    if item_kind = 'settings' then
      delete from module_mappings;
      delete from settings;
      if not gone then
        insert into settings
        select (jsonb_populate_record(null::settings, item->'row' || jsonb_build_object('id', 'team', 'data', item->'value', 'updated_at', written_at))).*;
        insert into module_mappings (module, test_set_id, test_set_name, platform, excel_alias)
        select m.module, m.test_set_id, m.test_set_name, m.platform, m.excel_alias
        from jsonb_populate_recordset(null::module_mappings, coalesce(item->'children', '[]'::jsonb)) m;
      end if;

    elsif item_kind = 'draft' then
      if gone then
        update drafts set deleted_at = written_at where id = substr(k, 7);
      else
        delete from drafts where id = item->'row'->>'id';
        insert into drafts
        select (jsonb_populate_record(null::drafts, item->'row' || jsonb_build_object('data', item->'value', 'synced_at', written_at, 'deleted_at', null))).*;
        insert into test_runs (draft_id, test_run_id, project_id, module, test_set_id, test_case_id, test_set_test_case_id, status, tester, comment, executed_at, recorded_by)
        select r.draft_id, r.test_run_id, r.project_id, r.module, r.test_set_id, r.test_case_id, r.test_set_test_case_id, r.status, r.tester, r.comment, r.executed_at, r.recorded_by
        from jsonb_populate_recordset(null::test_runs, coalesce(item->'children', '[]'::jsonb)) r;
      end if;

    elsif item_kind = 'defects' then
      if gone then
        update defects set deleted_at = written_at where deleted_at is null;
      else
        select coalesce(array_agg(r->>'id'), '{}') into ids from jsonb_array_elements(coalesce(item->'rows', '[]'::jsonb)) r;
        delete from defects where id = any(ids);
        insert into defects
        select (jsonb_populate_record(null::defects, r || jsonb_build_object('updated_at', written_at, 'deleted_at', null))).*
        from jsonb_array_elements(coalesce(item->'rows', '[]'::jsonb)) r;
        insert into defect_cases (defect_id, draft_id, module, test_set_id, test_case_id, test_set_test_case_id, test_run_id, name, step_label, moved_from)
        select c.defect_id, c.draft_id, c.module, c.test_set_id, c.test_case_id, c.test_set_test_case_id, c.test_run_id, c.name, c.step_label, c.moved_from
        from jsonb_populate_recordset(null::defect_cases, coalesce(item->'children', '[]'::jsonb)) c;
        update defects set deleted_at = written_at where deleted_at is null and not (id = any(ids));
      end if;

    elsif item_kind = 'activity' then
      if not gone then
        insert into activity_log
        select * from jsonb_populate_recordset(null::activity_log, coalesce(item->'rows', '[]'::jsonb))
        on conflict (id) do nothing;
      end if;

    elsif item_kind = 'report_setup' then
      delete from report_setups where key = k;
      if not gone then
        insert into report_setups
        select (jsonb_populate_record(null::report_setups, item->'row' || jsonb_build_object('key', k, 'data', item->'value', 'updated_at', written_at))).*;
      end if;

    elsif item_kind = 'report_history' then
      delete from report_history where key = k;
      if not gone then
        insert into report_history
        select (jsonb_populate_record(null::report_history, item->'row' || jsonb_build_object('key', k, 'data', item->'value', 'updated_at', written_at))).*;
      end if;

    else
      delete from app_store where key = k;
      if not gone then
        insert into app_store (key, value, deleted, size, updated_at)
        values (k, item->'value', false, coalesce((item->>'size')::integer, 0), written_at);
      end if;
    end if;

    if item_kind is distinct from 'other' then
      delete from app_store where key = k;
    end if;

    insert into sync_keys (key, updated_at, deleted, size)
    values (k, written_at, gone, coalesce((item->>'size')::integer, 0))
    on conflict (key) do update set updated_at = excluded.updated_at, deleted = excluded.deleted, size = excluded.size;
  end loop;
end;
$$;

-- ---- Loading: the saved value of each key, as the app keeps it --------------------------------------

create or replace function public.store_read(keys text[])
returns table (key text, value jsonb, updated_at timestamptz, deleted boolean)
language sql
stable
set search_path = public
as $$
  select
    s.key,
    case when s.deleted then null else coalesce(
      case
        when s.key = 'settings' then (select t.data from settings t where t.id = 'team')
        when s.key like 'draft:%' then (select t.data from drafts t where t.id = substr(s.key, 7) and t.deleted_at is null)
        when s.key = 'defects' then (select coalesce(jsonb_agg(t.data order by t.logged_at), '[]'::jsonb) from defects t where t.deleted_at is null)
        when s.key = 'activity' then (
          select coalesce(jsonb_agg(x.data order by x.at desc), '[]'::jsonb)
          from (select a.data, a.at from activity_log a order by a.at desc limit 1000) x
        )
        when s.key like 'report-options:%' then (select t.data from report_setups t where t.key = s.key)
        when s.key like 'report-snapshots:%' then (select t.data from report_history t where t.key = s.key)
      end,
      (select a.value from app_store a where a.key = s.key)
    ) end,
    s.updated_at,
    s.deleted
  from sync_keys s
  where s.key = any(keys);
$$;

revoke execute on function public.store_write(jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.store_read(text[]) from public, anon, authenticated;
grant execute on function public.store_write(jsonb, timestamptz) to service_role;
grant execute on function public.store_read(text[]) to service_role;

-- Let the API see the new tables and functions straight away.
notify pgrst, 'reload schema';
