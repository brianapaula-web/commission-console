-- ============================================================================
-- COMMISSION CONSOLE — manager overrides + rate table import
-- Run AFTER 01_schema.sql and 04_import.sql. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Manager override
-- A manager earns a share of what their reports earn at BASE rates, on every
-- commission type. Targets are the sum of the reports' targets, so attainment
-- reads as the combined team position.
--
-- Managers earn no accelerator. Any uplift a rep earned for passing their own
-- target stays with that rep and is stripped out before the share is taken.
-- ----------------------------------------------------------------------------
create table if not exists override_plans (
  person_id  text primary key references people(id),
  share      numeric(6,5) not null check (share > 0 and share <= 1),
  note       text,
  created_at timestamptz not null default now()
);
alter table override_plans enable row level security;
drop policy if exists read_overrides  on override_plans;
drop policy if exists write_overrides on override_plans;
create policy read_overrides  on override_plans for select to authenticated using (true);
create policy write_overrides on override_plans for all to authenticated
  using (my_role() = 'finance') with check (my_role() = 'finance');

insert into override_plans (person_id, share, note) values
  ('mike', 0.50, '50% of every commission type earned by direct reports, at base rates. No accelerator: uplift stays with the rep. Targets are the reports'' combined targets.')
on conflict (person_id) do update set share = excluded.share, note = excluded.note;

-- ----------------------------------------------------------------------------
-- import_rates
-- Expects a JSON array, one object per rate line, already forward-filled by the
-- browser so blank cells under a merged heading arrive populated:
--   rep, manager, role, type, logo, target, target_comp, rate, accel_rate, accounting
-- A row with a rep but no type registers the person and nothing else.
-- Returns {seen, people_added, components_added, rates_added, rates_changed, warnings[]}
-- ----------------------------------------------------------------------------
create or replace function import_rates(p_rows jsonb, p_filename text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r             jsonb;
  v_errors      text[] := '{}';
  v_warnings    text[] := '{}';
  v_seen        integer := 0;
  v_people      integer := 0;
  v_comps       integer := 0;
  v_rates       integer := 0;
  v_changed     integer := 0;
  v_line        integer := 0;
  v_rep         text;
  v_person      text;
  v_mgr         text;
  v_mgr_id      text;
  v_role        text;
  v_type        text;
  v_logo        text;
  v_target      numeric;
  v_tcomp       numeric;
  v_rate        numeric;
  v_acct        accounting_treatment;
  v_comp_id     text;
  v_old_rate    numeric;
  v_src         text;
  v_closed      integer;
begin
  if my_role() <> 'finance' then
    raise exception 'Only the Finance Admin can load the rate table';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected an array of rows';
  end if;

  -- Pass 1: people, so managers can be linked regardless of row order.
  for r in select * from jsonb_array_elements(p_rows) loop
    v_rep := nullif(trim(r->>'rep'), '');
    continue when v_rep is null;
    if not exists (select 1 from people where lower(name) = lower(v_rep)) then
      v_person := lower(regexp_replace(v_rep, '[^a-zA-Z0-9]', '', 'g'));
      if v_person = '' or exists (select 1 from people where id = v_person) then
        v_person := v_person || '_' || substr(md5(v_rep), 1, 4);
      end if;
      insert into people (id, name, role_label)
      values (v_person, v_rep, coalesce(nullif(trim(r->>'role'), ''), 'Rep'));
      v_people := v_people + 1;
      v_warnings := v_warnings || format('Added %s to the team', v_rep);
    end if;
  end loop;

  -- Pass 2: managers
  for r in select * from jsonb_array_elements(p_rows) loop
    v_rep := nullif(trim(r->>'rep'), '');
    v_mgr := nullif(trim(r->>'manager'), '');
    continue when v_rep is null or v_mgr is null or upper(v_mgr) in ('N/A', 'NA', 'NONE');
    select id into v_person from people where lower(name) = lower(v_rep);
    select id into v_mgr_id from people where lower(name) = lower(v_mgr);
    if v_mgr_id is null then
      v_warnings := v_warnings || format('No person called "%s" to be %s''s manager', v_mgr, v_rep);
    else
      update people set manager_id = v_mgr_id where id = v_person and manager_id is distinct from v_mgr_id;
    end if;
  end loop;

  -- Pass 3: components and rates
  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_rep  := nullif(trim(r->>'rep'), '');
    v_type := nullif(trim(r->>'type'), '');
    if v_rep is null then continue; end if;
    if v_type is null or upper(v_type) = 'N/A' then continue; end if;   -- person-only row
    v_seen := v_seen + 1;

    select id into v_person from people where lower(name) = lower(v_rep);

    begin
      v_target := (replace(replace(coalesce(r->>'target',''), ',', ''), '$', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (%s / %s): target "%s" is not a number',
                                     v_line, v_rep, v_type, r->>'target');
      continue;
    end;
    if v_target is null then
      v_errors := v_errors || format('Row %s (%s / %s): target bookings is blank', v_line, v_rep, v_type);
      continue;
    end if;

    begin
      v_tcomp := coalesce((replace(replace(coalesce(r->>'target_comp',''), ',', ''), '$', ''))::numeric, 0);
    exception when others then v_tcomp := 0;
    end;

    begin
      v_rate := (replace(coalesce(r->>'rate',''), '%', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (%s / %s): rate "%s" is not a number',
                                     v_line, v_rep, v_type, r->>'rate');
      continue;
    end;
    if v_rate is null then
      v_errors := v_errors || format('Row %s (%s / %s): rate is blank', v_line, v_rep, v_type);
      continue;
    end if;
    -- accept 10 or 0.10 for ten percent
    if v_rate > 1 then v_rate := v_rate / 100; end if;
    if v_rate <= 0 or v_rate > 1 then
      v_errors := v_errors || format('Row %s (%s / %s): rate %s is outside 0–100%%',
                                     v_line, v_rep, v_type, r->>'rate');
      continue;
    end if;

    v_logo := upper(coalesce(nullif(trim(r->>'logo'), ''), 'N/A'));
    v_logo := case
      when v_logo in ('Y','YES','TRUE')  then 'Yes'
      when v_logo in ('N','NO','FALSE')  then 'No'
      when v_logo in ('N/A','NA','')     then 'N/A'
      else null end;
    if v_logo is null then
      v_errors := v_errors || format('Row %s (%s / %s): "%s" is not Yes, No or N/A',
                                     v_line, v_rep, v_type, r->>'logo');
      continue;
    end if;

    v_acct := case when upper(coalesce(trim(r->>'accounting'), '')) like 'EXPENSE%'
                   then 'Expense'::accounting_treatment
                   else 'Capitalize'::accounting_treatment end;
    v_src  := case when upper(v_type) = 'REVENUE' then 'revenue' else 'bookings' end;
    v_comp_id := v_person || ':' || v_type;

    insert into plan_components (id, person_id, type, target, target_comp, accounting, source)
    values (v_comp_id, v_person, v_type, v_target, v_tcomp, v_acct, v_src)
    on conflict (id) do update
      set target = excluded.target, target_comp = excluded.target_comp,
          accounting = excluded.accounting, source = excluded.source;
    if not found then null; end if;
    if (select count(*) from plan_components where id = v_comp_id) = 1
       and not exists (select 1 from component_rates where component_id = v_comp_id) then
      v_comps := v_comps + 1;
    end if;

    select rate into v_old_rate from component_rates where component_id = v_comp_id and logo = v_logo;
    if v_old_rate is null then
      insert into component_rates (component_id, logo, label, rate)
      values (v_comp_id, v_logo,
              coalesce(nullif(trim(r->>'label'), ''),
                       case when v_logo = 'No'  then 'New logo'
                            when v_logo = 'Yes' then 'Existing logo'
                            else 'All ' || lower(v_type) end),
              v_rate);
      v_rates := v_rates + 1;
    elsif v_old_rate <> v_rate then
      update component_rates set rate = v_rate where component_id = v_comp_id and logo = v_logo;
      v_changed := v_changed + 1;
      v_warnings := v_warnings || format('%s / %s (%s): rate %s%% → %s%%',
        v_rep, v_type, v_logo, round(v_old_rate * 100, 2), round(v_rate * 100, 2));
      perform write_audit('Rate changed', v_comp_id,
        format('%s %s: %s%% → %s%% via %s', v_type, v_logo,
               round(v_old_rate * 100, 2), round(v_rate * 100, 2), coalesce(p_filename, 'rate upload')));
    end if;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Nothing was loaded. % problem(s): %',
      array_length(v_errors, 1), array_to_string(v_errors[1:8], ' | ');
  end if;

  -- Rates carry no effective date, so a change reaches every period, closed ones included.
  select count(*) into v_closed from periods where status <> 'Open';
  if v_changed > 0 and v_closed > 0 then
    v_warnings := v_warnings || format(
      '%s rate(s) changed. Rates are not effective-dated, so %s closed period(s) will now recalculate at the new rates.',
      v_changed, v_closed);
  end if;

  insert into import_batches (actor, kind, filename, rows_seen, rows_loaded, rows_skipped, notes)
  values (my_name(), 'rates', p_filename, v_seen, v_rates + v_changed, v_seen - v_rates - v_changed,
          nullif(array_to_string(v_warnings, ' | '), ''));

  perform write_audit('Rate table loaded', coalesce(p_filename, 'rate upload'),
    format('%s rate row(s) read. %s person(s) added, %s new rate(s), %s rate(s) changed.',
           v_seen, v_people, v_rates, v_changed));

  return jsonb_build_object(
    'seen', v_seen, 'people_added', v_people, 'components_added', v_comps,
    'rates_added', v_rates, 'rates_changed', v_changed,
    'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings));
end; $$;

revoke all on function import_rates(jsonb, text) from public;
grant execute on function import_rates(jsonb, text) to authenticated;
grant select on override_plans to authenticated;
grant select on import_batches to authenticated;
