-- ============================================================================
-- COMMISSION CONSOLE — prototype user switching
-- Run AFTER 01, 04, 05 and 06. Safe to re-run.
--
-- One login drives the app, and a dropdown chooses which person you are acting
-- as. Only the Finance Admin may do this, and the audit trail records BOTH the
-- real account and the person acted for — so "Mike approved it" never appears
-- when Brian actually clicked the button.
--
-- This is a prototype convenience. For a real close, give each person their own
-- login and stop passing p_as; the original checks then apply unchanged.
-- ============================================================================

-- Role implied by a person's title on the Comp Rates sheet.
create or replace function role_of(p_person text) returns app_role
language sql stable security definer set search_path = public as $$
  select case
           when lower(role_label) like '%finance%' then 'finance'::app_role
           when lower(role_label) like '%manager%' then 'manager'::app_role
           else 'rep'::app_role
         end
    from people where id = p_person;
$$;

create or replace function approve_line(
  p_kind     text,
  p_id       text,
  p_stage    text,
  p_decision text default 'Approved',
  p_note     text default null,
  p_as       text default null      -- act as this person; finance only
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_real_role app_role := my_role();
  v_real_name text     := my_name();
  v_role      app_role;
  v_me        text;
  v_as_name   text;
  v_owner     text;
  v_period    text;
  v_s1        approval_state;
  v_label     text;
  v_amount    numeric;
begin
  if v_real_role is null then
    raise exception 'Not registered in app_users';
  end if;

  if p_as is null then
    v_role := v_real_role;
    v_me   := my_person();
  else
    if v_real_role <> 'finance' then
      raise exception 'Only the Finance Admin can act on behalf of another person';
    end if;
    select name into v_as_name from people where id = p_as;
    if v_as_name is null then
      raise exception 'No person called %', p_as;
    end if;
    v_role := role_of(p_as);
    v_me   := p_as;
  end if;

  if p_stage not in ('s1','s2') then
    raise exception 'Stage must be s1 or s2';
  end if;
  if p_decision not in ('Approved','Rejected') then
    raise exception 'Decision must be Approved or Rejected';
  end if;
  if p_decision = 'Rejected' and coalesce(length(trim(p_note)), 0) < 5 then
    raise exception 'A rejection needs a reason of at least five characters';
  end if;

  if p_kind = 'booking' then
    select person_id, period, s1, client || ' / ' || coalesce(agreement,''), amount
      into v_owner, v_period, v_s1, v_label, v_amount
      from bookings where deal_id = p_id::integer;
  elsif p_kind = 'revenue' then
    select client_owner(client), period, s1, client, amount
      into v_owner, v_period, v_s1, v_label, v_amount
      from revenue where id = p_id;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;

  if v_owner is null then
    raise exception 'Line % not found, or it has no owning rep', p_id;
  end if;
  if not period_is_open(v_period) then
    raise exception 'Period % is locked', v_period;
  end if;

  -- The same rules as before, evaluated against whoever is being acted as.
  if p_stage = 's1' then
    if v_role <> 'manager' then
      raise exception 'Stage 1 is the manager''s approval';
    end if;
    if v_owner = v_me then
      raise exception 'You cannot approve your own line';
    end if;
    if not exists (select 1 from people where id = v_owner and manager_id = v_me) then
      raise exception '% is not one of %''s reports', v_owner, coalesce(v_as_name, v_real_name);
    end if;
  end if;

  if p_stage = 's2' then
    if v_role <> 'finance' then
      raise exception 'Stage 2 is the finance approval';
    end if;
    if v_s1 <> 'Approved' then
      raise exception 'Stage 1 has not been approved yet';
    end if;
  end if;

  if p_kind = 'booking' then
    if p_stage = 's1' then
      update bookings set s1 = p_decision::approval_state,
             s1_by = coalesce(v_as_name, v_real_name), s1_at = now(),
             reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
       where deal_id = p_id::integer;
    else
      update bookings set s2 = p_decision::approval_state,
             s2_by = coalesce(v_as_name, v_real_name), s2_at = now(),
             reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
       where deal_id = p_id::integer;
    end if;
  else
    if p_stage = 's1' then
      update revenue set s1 = p_decision::approval_state,
             s1_by = coalesce(v_as_name, v_real_name), s1_at = now(),
             reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
       where id = p_id;
    else
      update revenue set s2 = p_decision::approval_state,
             s2_by = coalesce(v_as_name, v_real_name), s2_at = now(),
             reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
       where id = p_id;
    end if;
  end if;

  -- The audit names the real account first, then who it was acting as.
  perform write_audit(
    p_decision || ' (stage ' || substr(p_stage, 2) || ')',
    p_kind || ':' || p_id,
    v_label || ' · ' || to_char(v_amount, 'FM999,999,999.00')
      || case when p_as is null then ''
              else format(' — %s acting as %s', v_real_name, v_as_name) end
      || case when p_note is not null then ' — ' || p_note else '' end);

  return p_decision;
end; $$;

-- The five-argument version from 01_schema would otherwise shadow this one.
drop function if exists approve_line(text, text, text, text, text);

revoke all on function approve_line(text, text, text, text, text, text) from public;
grant execute on function approve_line(text, text, text, text, text, text) to authenticated;
grant execute on function role_of(text) to authenticated;
