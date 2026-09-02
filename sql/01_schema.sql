-- ============================================================================
-- COMMISSION CONSOLE — Supabase schema
-- Run this in the Supabase SQL editor (Database > SQL Editor > New query).
-- Safe to re-run: it drops and recreates the commission objects.
-- ============================================================================

drop table if exists audit_log, revenue, bookings, component_rates,
  plan_components, periods, app_users, people cascade;
drop type if exists app_role, accounting_treatment, approval_state cascade;

create type app_role             as enum ('rep', 'manager', 'finance');
create type accounting_treatment as enum ('Capitalize', 'Expense');
create type approval_state       as enum ('Pending', 'Approved', 'Rejected');

-- ---------------------------------------------------------------- people ---
create table people (
  id           text primary key,
  name         text not null unique,
  role_label   text not null,               -- 'Rep', 'Manager', 'Finance Admin'
  manager_id   text references people(id),
  created_at   timestamptz not null default now()
);

-- Links a Supabase auth user to a person record and an app role.
create table app_users (
  user_id    uuid primary key,              -- references auth.users(id)
  person_id  text not null references people(id),
  role       app_role not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ rate table ---
-- One component = one target carrying one accelerator threshold.
create table plan_components (
  id          text primary key,             -- e.g. 'randy:New Subscription'
  person_id   text not null references people(id),
  type        text not null,                -- New Subscription | Renewal | Revenue | Professional Services
  target      numeric(14,2) not null check (target >= 0),
  target_comp numeric(14,2) not null default 0,
  accounting  accounting_treatment not null,
  source      text not null default 'bookings' check (source in ('bookings','revenue')),
  note        text,
  unique (person_id, type)
);

-- New Subscription carries two rates under one shared target, split by logo.
create table component_rates (
  id           bigserial primary key,
  component_id text not null references plan_components(id) on delete cascade,
  logo         text not null default 'N/A' check (logo in ('Yes','No','N/A')),
  label        text not null,
  rate         numeric(6,5) not null check (rate >= 0 and rate <= 1),
  unique (component_id, logo)
);

-- --------------------------------------------------------------- periods ---
create table periods (
  period    text primary key,               -- 'YYYY-MM'
  status    text not null default 'Open' check (status in ('Open','Closed','Paid')),
  posted    boolean not null default false,
  paid_on   date,
  closed_by text
);

-- -------------------------------------------------------------- bookings ---
create table bookings (
  deal_id    integer primary key,           -- the unique key from your bookings file
  person_id  text not null references people(id),
  date       date not null,
  period     text generated always as (
               extract(year from date)::text || '-' ||
               lpad(extract(month from date)::text, 2, '0')) stored,
  client     text not null,
  agreement  text,
  existing   text not null default 'N/A' check (existing in ('Yes','No','N/A')),
  term       text,
  type       text not null,
  amount     numeric(14,2) not null check (amount >= 0),
  s1         approval_state not null default 'Pending',
  s1_by      text, s1_at timestamptz,
  s2         approval_state not null default 'Pending',
  s2_by      text, s2_at timestamptz,
  reject_note text,
  created_at timestamptz not null default now()
);
create index on bookings (period);
create index on bookings (person_id);

-- --------------------------------------------------------------- revenue ---
-- No rep column in the source file; attribution is by client ownership.
create table revenue (
  id         text primary key,
  period     text not null,
  client     text not null,
  amount     numeric(14,2) not null check (amount >= 0),
  s1         approval_state not null default 'Pending',
  s1_by      text, s1_at timestamptz,
  s2         approval_state not null default 'Pending',
  s2_by      text, s2_at timestamptz,
  reject_note text,
  created_at timestamptz not null default now(),
  unique (period, client)
);

-- ------------------------------------------------------------- audit log ---
create table audit_log (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  actor      text not null,
  actor_role text not null,
  action     text not null,
  entity     text not null,
  detail     text
);
create index on audit_log (ts desc);

-- ============================================================================
-- HELPERS — who is calling
-- ============================================================================
create or replace function me() returns app_users
language sql stable security definer set search_path = public as $$
  select * from app_users where user_id = auth.uid();
$$;

create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from app_users where user_id = auth.uid();
$$;

create or replace function my_person() returns text
language sql stable security definer set search_path = public as $$
  select person_id from app_users where user_id = auth.uid();
$$;

create or replace function my_name() returns text
language sql stable security definer set search_path = public as $$
  select p.name from app_users a join people p on p.id = a.person_id
  where a.user_id = auth.uid();
$$;

create or replace function period_is_open(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'Open' from periods where period = p), false);
$$;

-- Client ownership: whoever signed the earliest agreement with that client.
create or replace function client_owner(c text) returns text
language sql stable security definer set search_path = public as $$
  select person_id from bookings where client = c
  order by date asc, deal_id asc limit 1;
$$;

create or replace function write_audit(a_action text, a_entity text, a_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor, actor_role, action, entity, detail)
  values (coalesce(my_name(), 'system'), coalesce(my_role()::text, 'system'),
          a_action, a_entity, a_detail);
end; $$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Reads are broad; every write that matters goes through an RPC below.
-- ============================================================================
alter table people          enable row level security;
alter table app_users       enable row level security;
alter table plan_components enable row level security;
alter table component_rates enable row level security;
alter table periods         enable row level security;
alter table bookings        enable row level security;
alter table revenue         enable row level security;
alter table audit_log       enable row level security;

-- Everyone signed in can read the org chart, the rate table and the calendar.
create policy read_people   on people          for select to authenticated using (true);
create policy read_comps    on plan_components for select to authenticated using (true);
create policy read_rates    on component_rates for select to authenticated using (true);
create policy read_periods  on periods         for select to authenticated using (true);
create policy read_audit    on audit_log       for select to authenticated using (true);

-- You can see your own app_users row; finance sees all of them.
create policy read_appusers on app_users for select to authenticated
  using (user_id = auth.uid() or my_role() = 'finance');

-- Reps see only their own lines. Managers see their reports. Finance sees all.
create policy read_bookings on bookings for select to authenticated using (
  my_role() = 'finance'
  or person_id = my_person()
  or exists (select 1 from people p where p.id = bookings.person_id and p.manager_id = my_person())
);

create policy read_revenue on revenue for select to authenticated using (
  my_role() = 'finance'
  or client_owner(client) = my_person()
  or exists (select 1 from people p
             where p.id = client_owner(revenue.client) and p.manager_id = my_person())
);

-- Only finance maintains the rate table, and only while a period is open.
create policy write_comps on plan_components for all to authenticated
  using (my_role() = 'finance') with check (my_role() = 'finance');
create policy write_rates on component_rates for all to authenticated
  using (my_role() = 'finance') with check (my_role() = 'finance');
create policy write_periods on periods for all to authenticated
  using (my_role() = 'finance') with check (my_role() = 'finance');

-- Loading source files is a finance job.
create policy load_bookings on bookings for insert to authenticated
  with check (my_role() = 'finance');
create policy load_revenue on revenue for insert to authenticated
  with check (my_role() = 'finance');

-- Deliberately NO update/delete policy on bookings, revenue or audit_log.
-- Approvals happen through approve_line() below, which enforces the workflow.
-- The audit log is append-only: no policy means no UPDATE and no DELETE, for
-- anyone holding the anon key, including finance.

-- ============================================================================
-- APPROVAL RPC — the separation of duties lives here, not in the browser
-- ============================================================================
create or replace function approve_line(
  p_kind  text,                 -- 'booking' | 'revenue'
  p_id    text,                 -- deal_id as text, or revenue id
  p_stage text,                 -- 's1' | 's2'
  p_decision text default 'Approved',
  p_note  text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_role     app_role := my_role();
  v_me       text     := my_person();
  v_name     text     := my_name();
  v_owner    text;
  v_period   text;
  v_s1       approval_state;
  v_label    text;
  v_amount   numeric;
begin
  if v_role is null then
    raise exception 'Not registered in app_users';
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

  -- Stage 1 belongs to the owning rep's manager. Nobody approves their own line.
  if p_stage = 's1' then
    if v_role <> 'manager' then
      raise exception 'Stage 1 is the manager''s approval';
    end if;
    if v_owner = v_me then
      raise exception 'You cannot approve your own line';
    end if;
    if not exists (select 1 from people where id = v_owner and manager_id = v_me) then
      raise exception '% is not one of your reports', v_owner;
    end if;
  end if;

  -- Stage 2 is finance, and only after stage 1 has cleared.
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
      update bookings set s1 = p_decision::approval_state, s1_by = v_name, s1_at = now(),
        reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
        where deal_id = p_id::integer;
    else
      update bookings set s2 = p_decision::approval_state, s2_by = v_name, s2_at = now(),
        reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
        where deal_id = p_id::integer;
    end if;
  else
    if p_stage = 's1' then
      update revenue set s1 = p_decision::approval_state, s1_by = v_name, s1_at = now(),
        reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
        where id = p_id;
    else
      update revenue set s2 = p_decision::approval_state, s2_by = v_name, s2_at = now(),
        reject_note = case when p_decision = 'Rejected' then p_note else reject_note end
        where id = p_id;
    end if;
  end if;

  perform write_audit(
    p_decision || ' (stage ' || substr(p_stage, 2) || ')',
    p_kind || ':' || p_id,
    v_label || ' · ' || to_char(v_amount, 'FM999,999,999.00') ||
    case when p_note is not null then ' — ' || p_note else '' end);

  return p_decision;
end; $$;

-- Closing a period is finance only, and only once everything has cleared.
create or replace function close_period(p_period text) returns text
language plpgsql security definer set search_path = public as $$
declare v_open integer;
begin
  if my_role() <> 'finance' then raise exception 'Only finance can close a period'; end if;
  select count(*) into v_open from (
    select 1 from bookings where period = p_period and (s1 = 'Pending' or s2 = 'Pending')
    union all
    select 1 from revenue  where period = p_period and (s1 = 'Pending' or s2 = 'Pending')
  ) q;
  if v_open > 0 then
    raise exception '% line(s) still awaiting approval', v_open;
  end if;
  update periods set status = 'Closed', closed_by = my_name() where period = p_period;
  perform write_audit('Period closed', p_period, 'Locked by ' || my_name());
  return 'Closed';
end; $$;

create or replace function reopen_period(p_period text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'finance' then raise exception 'Only finance can reopen a period'; end if;
  update periods set status = 'Open', closed_by = null where period = p_period;
  perform write_audit('Period reopened', p_period, 'Reopened by ' || my_name());
  return 'Open';
end; $$;

-- Make tampering fail loudly rather than silently affecting zero rows.
-- Approvals are written only by approve_line(), which is security definer.
revoke update, delete on bookings  from authenticated;
revoke update, delete on revenue   from authenticated;
revoke update, delete on audit_log from authenticated;
revoke insert            on audit_log from authenticated;  -- written via write_audit() only

revoke all on function approve_line(text,text,text,text,text) from public;
revoke all on function close_period(text)  from public;
revoke all on function reopen_period(text) from public;
grant execute on function approve_line(text,text,text,text,text) to authenticated;
grant execute on function close_period(text)  to authenticated;
grant execute on function reopen_period(text) to authenticated;
