-- ============================================================================
-- COMMISSION CONSOLE — file import
-- Run this AFTER 01_schema.sql. Safe to re-run.
--
-- The browser parses the spreadsheet and hands the rows here as JSON. All
-- validation happens in the database so a malformed file cannot get in, and
-- the whole load is one transaction: it either all lands or none of it does.
-- ============================================================================

create table if not exists import_batches (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  actor       text not null,
  kind        text not null,               -- 'bookings' | 'revenue'
  filename    text,
  rows_seen   integer not null default 0,
  rows_loaded integer not null default 0,
  rows_skipped integer not null default 0,
  notes       text
);
alter table import_batches enable row level security;
drop policy if exists read_batches on import_batches;
create policy read_batches on import_batches for select to authenticated using (true);
revoke insert, update, delete on import_batches from authenticated;

-- A period must exist before anything can be booked into it.
create or replace function ensure_period(p text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into periods (period, status) values (p, 'Open')
  on conflict (period) do nothing;
end; $$;

-- ----------------------------------------------------------------------------
-- import_bookings
-- Expects a JSON array of objects with these keys, taken straight from the
-- column headers in the bookings file:
--   deal_id, rep, date, client, agreement, existing, term, type, amount
-- Returns {loaded, skipped, seen, errors[], warnings[]}
-- ----------------------------------------------------------------------------
create or replace function import_bookings(p_rows jsonb, p_filename text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r            jsonb;
  v_errors     text[] := '{}';
  v_warnings   text[] := '{}';
  v_loaded     integer := 0;
  v_skipped    integer := 0;
  v_seen       integer := 0;
  v_deal       integer;
  v_person     text;
  v_period     text;
  v_amount     numeric;
  v_date       date;
  v_existing   text;
  v_type       text;
  v_line       integer := 0;
begin
  if my_role() <> 'finance' then
    raise exception 'Only the Finance Admin can load source files';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected an array of rows';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_seen := v_seen + 1;

    -- Deal ID is the unique key
    begin
      v_deal := (r->>'deal_id')::integer;
    exception when others then
      v_errors := v_errors || format('Row %s: Deal ID "%s" is not a whole number', v_line, r->>'deal_id');
      continue;
    end;
    if v_deal is null then
      v_errors := v_errors || format('Row %s: Deal ID is blank', v_line);
      continue;
    end if;

    -- Rep must exist by name
    select id into v_person from people where lower(name) = lower(trim(r->>'rep'));
    if v_person is null then
      v_errors := v_errors || format('Row %s (deal %s): no person called "%s"', v_line, v_deal, r->>'rep');
      continue;
    end if;

    -- Date
    begin
      v_date := (r->>'date')::date;
    exception when others then
      v_errors := v_errors || format('Row %s (deal %s): date "%s" not understood', v_line, v_deal, r->>'date');
      continue;
    end;
    v_period := extract(year from v_date)::text || '-' ||
                lpad(extract(month from v_date)::text, 2, '0');

    -- Amount
    begin
      v_amount := (replace(replace(r->>'amount', ',', ''), '$', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (deal %s): amount "%s" is not a number', v_line, v_deal, r->>'amount');
      continue;
    end;
    if v_amount is null or v_amount < 0 then
      v_errors := v_errors || format('Row %s (deal %s): amount must be zero or more', v_line, v_deal);
      continue;
    end if;

    -- Existing logo flag
    v_existing := upper(coalesce(trim(r->>'existing'), 'N/A'));
    v_existing := case
      when v_existing in ('Y','YES','TRUE') then 'Yes'
      when v_existing in ('N','NO','FALSE') then 'No'
      when v_existing in ('N/A','NA','') then 'N/A'
      else null end;
    if v_existing is null then
      v_errors := v_errors || format('Row %s (deal %s): "%s" is not Yes, No or N/A',
                                     v_line, v_deal, r->>'existing');
      continue;
    end if;

    v_type := trim(r->>'type');
    if coalesce(v_type,'') = '' then
      v_errors := v_errors || format('Row %s (deal %s): booking type is blank', v_line, v_deal);
      continue;
    end if;

    -- Already loaded? Never silently overwrite an approved line.
    if exists (select 1 from bookings where deal_id = v_deal) then
      v_skipped := v_skipped + 1;
      v_warnings := v_warnings || format('Deal %s is already loaded and was left alone', v_deal);
      continue;
    end if;

    -- Refuse to book into a period that has been closed.
    perform ensure_period(v_period);
    if not period_is_open(v_period) then
      v_skipped := v_skipped + 1;
      v_warnings := v_warnings || format('Deal %s falls in %s, which is closed', v_deal, v_period);
      continue;
    end if;

    -- Warn, but still load, when there is no rate to price it with.
    if not exists (select 1 from plan_components where person_id = v_person and type = v_type) then
      v_warnings := v_warnings ||
        format('Deal %s: %s has no %s rates on file, so it will show as unpriced',
               v_deal, r->>'rep', v_type);
    end if;

    insert into bookings (deal_id, person_id, date, client, agreement, existing, term, type, amount)
    values (v_deal, v_person, v_date, trim(r->>'client'), nullif(trim(r->>'agreement'),''),
            v_existing, nullif(trim(r->>'term'),''), v_type, v_amount);
    v_loaded := v_loaded + 1;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Nothing was loaded. % problem(s): %',
      array_length(v_errors, 1), array_to_string(v_errors[1:8], ' | ');
  end if;

  insert into import_batches (actor, kind, filename, rows_seen, rows_loaded, rows_skipped, notes)
  values (my_name(), 'bookings', p_filename, v_seen, v_loaded, v_skipped,
          nullif(array_to_string(v_warnings, ' | '), ''));

  perform write_audit('Bookings loaded', coalesce(p_filename, 'bookings upload'),
    format('%s row(s) read, %s loaded, %s skipped.', v_seen, v_loaded, v_skipped));

  return jsonb_build_object('seen', v_seen, 'loaded', v_loaded, 'skipped', v_skipped,
                            'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings));
end; $$;

-- ----------------------------------------------------------------------------
-- import_revenue
-- Expects: period (a date or YYYY-MM), client, amount
-- Revenue has no rep column; attribution is by client ownership at calc time.
-- ----------------------------------------------------------------------------
create or replace function import_revenue(p_rows jsonb, p_filename text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r          jsonb;
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_loaded   integer := 0;
  v_skipped  integer := 0;
  v_seen     integer := 0;
  v_period   text;
  v_client   text;
  v_amount   numeric;
  v_id       text;
  v_line     integer := 0;
  v_raw      text;
begin
  if my_role() <> 'finance' then
    raise exception 'Only the Finance Admin can load source files';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected an array of rows';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_seen := v_seen + 1;

    v_raw := trim(r->>'period');
    if v_raw ~ '^\d{4}-\d{2}$' then
      v_period := v_raw;
    else
      begin
        v_period := extract(year from v_raw::date)::text || '-' ||
                    lpad(extract(month from v_raw::date)::text, 2, '0');
      exception when others then
        v_errors := v_errors || format('Row %s: period "%s" not understood', v_line, v_raw);
        continue;
      end;
    end if;

    v_client := trim(r->>'client');
    if coalesce(v_client,'') = '' then
      v_errors := v_errors || format('Row %s: client is blank', v_line);
      continue;
    end if;

    begin
      v_amount := (replace(replace(r->>'amount', ',', ''), '$', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (%s): revenue "%s" is not a number',
                                     v_line, v_client, r->>'amount');
      continue;
    end;
    if v_amount is null or v_amount < 0 then
      v_errors := v_errors || format('Row %s (%s): revenue must be zero or more', v_line, v_client);
      continue;
    end if;

    if exists (select 1 from revenue where period = v_period and client = v_client) then
      v_skipped := v_skipped + 1;
      v_warnings := v_warnings || format('%s for %s is already loaded and was left alone', v_client, v_period);
      continue;
    end if;

    perform ensure_period(v_period);
    if not period_is_open(v_period) then
      v_skipped := v_skipped + 1;
      v_warnings := v_warnings || format('%s falls in %s, which is closed', v_client, v_period);
      continue;
    end if;

    -- Revenue is attributed by client ownership, so an unknown client cannot be priced.
    if client_owner(v_client) is null then
      v_warnings := v_warnings ||
        format('No booking on file for %s, so its revenue cannot be attributed to a rep yet', v_client);
    end if;

    v_id := 'REV-' || v_period || '-' || regexp_replace(v_client, '[^a-zA-Z0-9]+', '', 'g');
    insert into revenue (id, period, client, amount) values (v_id, v_period, v_client, v_amount);
    v_loaded := v_loaded + 1;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Nothing was loaded. % problem(s): %',
      array_length(v_errors, 1), array_to_string(v_errors[1:8], ' | ');
  end if;

  insert into import_batches (actor, kind, filename, rows_seen, rows_loaded, rows_skipped, notes)
  values (my_name(), 'revenue', p_filename, v_seen, v_loaded, v_skipped,
          nullif(array_to_string(v_warnings, ' | '), ''));

  perform write_audit('Revenue loaded', coalesce(p_filename, 'revenue upload'),
    format('%s row(s) read, %s loaded, %s skipped.', v_seen, v_loaded, v_skipped));

  return jsonb_build_object('seen', v_seen, 'loaded', v_loaded, 'skipped', v_skipped,
                            'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings));
end; $$;

revoke all on function import_bookings(jsonb, text) from public;
revoke all on function import_revenue(jsonb, text)  from public;
revoke all on function ensure_period(text)          from public;
grant execute on function import_bookings(jsonb, text) to authenticated;
grant execute on function import_revenue(jsonb, text)  to authenticated;
