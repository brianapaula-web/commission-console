-- ============================================================================
-- COMMISSION CONSOLE — effective-dated rates
-- Run AFTER 01_schema.sql, 04_import.sql and 05_rates_and_override.sql.
-- Safe to re-run.
--
-- Until now a rate had one value, so revising it rewrote history: change
-- Randy's Renewal rate today and January recalculated at the new rate even
-- though January was closed and paid. Rates are now versioned. A booking is
-- priced at the rate in force on the date it was signed.
-- ============================================================================

-- ---------------------------------------------------------------- migrate ---
alter table component_rates add column if not exists effective_from date;
update component_rates set effective_from = date '2026-01-01' where effective_from is null;
alter table component_rates alter column effective_from set not null;
alter table component_rates alter column effective_from set default date '2026-01-01';

-- one rate per component, logo and start date
alter table component_rates drop constraint if exists component_rates_component_id_logo_key;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'component_rates_version_key'
  ) then
    alter table component_rates
      add constraint component_rates_version_key unique (component_id, logo, effective_from);
  end if;
end $$;

create index if not exists component_rates_lookup
  on component_rates (component_id, logo, effective_from desc);

comment on column component_rates.effective_from is
  'First date this rate applies. A booking uses the latest version on or before its signed date.';

-- ---------------------------------------------------------------- lookup ---
create or replace function rate_in_force(p_component text, p_logo text, p_on date)
returns numeric
language sql stable security definer set search_path = public as $$
  select rate from component_rates
   where component_id = p_component
     and logo = coalesce(
       (select logo from component_rates
         where component_id = p_component and logo = p_logo limit 1), 'N/A')
     and effective_from <= p_on
   order by effective_from desc
   limit 1;
$$;

-- ------------------------------------------------------------ change_rate ---
-- Revising a rate adds a version rather than overwriting the old one.
create or replace function change_rate(
  p_component_id text,
  p_logo         text,
  p_rate         numeric,
  p_effective    date,
  p_reason       text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old   numeric;
  v_label text;
  v_rate  numeric := p_rate;
begin
  if my_role() <> 'finance' then
    raise exception 'Only the Finance Admin can change rates';
  end if;
  if not exists (select 1 from plan_components where id = p_component_id) then
    raise exception 'No component called %', p_component_id;
  end if;
  if v_rate > 1 then v_rate := v_rate / 100; end if;
  if v_rate <= 0 or v_rate > 1 then
    raise exception 'Rate % is outside 0-100%%', p_rate;
  end if;

  select rate, label into v_old, v_label
    from component_rates
   where component_id = p_component_id and logo = p_logo
     and effective_from <= p_effective
   order by effective_from desc limit 1;

  if v_label is null then
    select label into v_label from component_rates
     where component_id = p_component_id and logo = p_logo
     order by effective_from limit 1;
  end if;

  insert into component_rates (component_id, logo, label, rate, effective_from)
  values (p_component_id, p_logo, coalesce(v_label, 'Rate'), v_rate, p_effective)
  on conflict (component_id, logo, effective_from)
    do update set rate = excluded.rate;

  perform write_audit('Rate version added', p_component_id,
    format('%s: %s → %s effective %s%s', p_logo,
           case when v_old is null then 'none' else round(v_old * 100, 3)::text || '%' end,
           round(v_rate * 100, 3)::text || '%', p_effective,
           case when p_reason is not null then ' — ' || p_reason else '' end));

  return jsonb_build_object('old', v_old, 'new', v_rate, 'effective', p_effective);
end; $$;

-- ---------------------------------------------------------- import_rates ---
-- Now takes an effective date. A differing rate is added as a new version;
-- an identical rate is left alone so re-uploading the same sheet is a no-op.
create or replace function import_rates(
  p_rows jsonb, p_filename text default null, p_effective date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r          jsonb;
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_seen     integer := 0;
  v_people   integer := 0;
  v_rates    integer := 0;
  v_versions integer := 0;
  v_line     integer := 0;
  v_eff      date := coalesce(p_effective, date '2026-01-01');
  v_rep      text; v_person text; v_mgr text; v_mgr_id text;
  v_type     text; v_logo text; v_label text;
  v_target   numeric; v_tcomp numeric; v_rate numeric;
  v_acct     accounting_treatment; v_src text;
  v_comp_id  text; v_old numeric;
begin
  if my_role() <> 'finance' then
    raise exception 'Only the Finance Admin can load the rate table';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Expected an array of rows';
  end if;

  -- people
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

  -- managers
  for r in select * from jsonb_array_elements(p_rows) loop
    v_rep := nullif(trim(r->>'rep'), '');
    v_mgr := nullif(trim(r->>'manager'), '');
    continue when v_rep is null or v_mgr is null or upper(v_mgr) in ('N/A','NA','NONE');
    select id into v_person from people where lower(name) = lower(v_rep);
    select id into v_mgr_id from people where lower(name) = lower(v_mgr);
    if v_mgr_id is null then
      v_warnings := v_warnings || format('No person called "%s" to be %s''s manager', v_mgr, v_rep);
    else
      update people set manager_id = v_mgr_id
       where id = v_person and manager_id is distinct from v_mgr_id;
    end if;
  end loop;

  -- components and rate versions
  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_rep  := nullif(trim(r->>'rep'), '');
    v_type := nullif(trim(r->>'type'), '');
    if v_rep is null then continue; end if;
    if v_type is null or upper(v_type) = 'N/A' then continue; end if;
    v_seen := v_seen + 1;
    select id into v_person from people where lower(name) = lower(v_rep);

    begin
      v_target := (replace(replace(coalesce(r->>'target',''), ',', ''), '$', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (%s / %s): target "%s" is not a number',
                                     v_line, v_rep, v_type, r->>'target'); continue;
    end;
    if v_target is null then
      v_errors := v_errors || format('Row %s (%s / %s): target bookings is blank', v_line, v_rep, v_type);
      continue;
    end if;
    begin
      v_tcomp := coalesce((replace(replace(coalesce(r->>'target_comp',''), ',', ''), '$', ''))::numeric, 0);
    exception when others then v_tcomp := 0; end;
    begin
      v_rate := (replace(coalesce(r->>'rate',''), '%', ''))::numeric;
    exception when others then
      v_errors := v_errors || format('Row %s (%s / %s): rate "%s" is not a number',
                                     v_line, v_rep, v_type, r->>'rate'); continue;
    end;
    if v_rate is null then
      v_errors := v_errors || format('Row %s (%s / %s): rate is blank', v_line, v_rep, v_type); continue;
    end if;
    if v_rate > 1 then v_rate := v_rate / 100; end if;
    if v_rate <= 0 or v_rate > 1 then
      v_errors := v_errors || format('Row %s (%s / %s): rate %s is outside 0-100%%',
                                     v_line, v_rep, v_type, r->>'rate'); continue;
    end if;

    v_logo := upper(coalesce(nullif(trim(r->>'logo'), ''), 'N/A'));
    v_logo := case when v_logo in ('Y','YES','TRUE') then 'Yes'
                   when v_logo in ('N','NO','FALSE') then 'No'
                   when v_logo in ('N/A','NA','')    then 'N/A' else null end;
    if v_logo is null then
      v_errors := v_errors || format('Row %s (%s / %s): "%s" is not Yes, No or N/A',
                                     v_line, v_rep, v_type, r->>'logo'); continue;
    end if;

    v_acct := case when upper(coalesce(trim(r->>'accounting'), '')) like 'EXPENSE%'
                   then 'Expense'::accounting_treatment else 'Capitalize'::accounting_treatment end;
    v_src  := case when upper(v_type) = 'REVENUE' then 'revenue' else 'bookings' end;
    v_comp_id := v_person || ':' || v_type;

    insert into plan_components (id, person_id, type, target, target_comp, accounting, source)
    values (v_comp_id, v_person, v_type, v_target, v_tcomp, v_acct, v_src)
    on conflict (id) do update
      set target = excluded.target, target_comp = excluded.target_comp,
          accounting = excluded.accounting, source = excluded.source;

    v_label := coalesce(nullif(trim(r->>'label'), ''),
                 case when v_logo = 'No'  then 'New logo'
                      when v_logo = 'Yes' then 'Existing logo'
                      else 'All ' || lower(v_type) end);

    select rate into v_old from component_rates
     where component_id = v_comp_id and logo = v_logo and effective_from <= v_eff
     order by effective_from desc limit 1;

    if v_old is null then
      insert into component_rates (component_id, logo, label, rate, effective_from)
      values (v_comp_id, v_logo, v_label, v_rate, v_eff)
      on conflict (component_id, logo, effective_from) do update set rate = excluded.rate;
      v_rates := v_rates + 1;
    elsif v_old <> v_rate then
      insert into component_rates (component_id, logo, label, rate, effective_from)
      values (v_comp_id, v_logo, v_label, v_rate, v_eff)
      on conflict (component_id, logo, effective_from) do update set rate = excluded.rate;
      v_versions := v_versions + 1;
      v_warnings := v_warnings || format('%s / %s (%s): %s%% → %s%% from %s',
        v_rep, v_type, v_logo, round(v_old * 100, 2), round(v_rate * 100, 2), v_eff);
      perform write_audit('Rate version added', v_comp_id,
        format('%s %s: %s%% → %s%% effective %s via %s', v_type, v_logo,
               round(v_old * 100, 2), round(v_rate * 100, 2), v_eff,
               coalesce(p_filename, 'rate upload')));
    end if;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Nothing was loaded. % problem(s): %',
      array_length(v_errors, 1), array_to_string(v_errors[1:8], ' | ');
  end if;

  if v_versions > 0 then
    v_warnings := v_warnings || format(
      '%s new rate version(s) start on %s. Anything signed before that date keeps the rate it was priced at.',
      v_versions, v_eff);
  end if;

  insert into import_batches (actor, kind, filename, rows_seen, rows_loaded, rows_skipped, notes)
  values (my_name(), 'rates', p_filename, v_seen, v_rates + v_versions,
          v_seen - v_rates - v_versions, nullif(array_to_string(v_warnings, ' | '), ''));

  perform write_audit('Rate table loaded', coalesce(p_filename, 'rate upload'),
    format('%s rate row(s) read effective %s. %s person(s) added, %s new rate(s), %s new version(s).',
           v_seen, v_eff, v_people, v_rates, v_versions));

  return jsonb_build_object('seen', v_seen, 'people_added', v_people,
    'rates_added', v_rates, 'rates_changed', v_versions, 'effective', v_eff,
    'errors', to_jsonb(v_errors), 'warnings', to_jsonb(v_warnings));
end; $$;

revoke all on function change_rate(text, text, numeric, date, text) from public;
revoke all on function import_rates(jsonb, text, date) from public;
grant execute on function change_rate(text, text, numeric, date, text) to authenticated;
grant execute on function import_rates(jsonb, text, date) to authenticated;
grant execute on function rate_in_force(text, text, date) to authenticated;

-- The two-argument version from 05 would otherwise shadow the new one.
drop function if exists import_rates(jsonb, text);
