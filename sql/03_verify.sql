select 'tables'    as object, count(*)::text as found, '8 expected'  as expect
  from information_schema.tables
 where table_schema='public'
   and table_name in ('people','app_users','plan_components','component_rates',
                      'periods','bookings','revenue','audit_log')
union all
select 'RLS enabled', count(*)::text, '8 expected'
  from pg_tables where schemaname='public' and rowsecurity
union all
select 'policies', count(*)::text, '13 expected'
  from pg_policies where schemaname='public'
union all
select 'functions', count(*)::text, '10 expected'
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('me','my_role','my_person','my_name','period_is_open',
                     'client_owner','write_audit','approve_line','close_period','reopen_period')
union all
select 'people rows', count(*)::text, '6 after seed'      from people
union all
select 'rate components', count(*)::text, '4 after seed'  from plan_components
union all
select 'rates', count(*)::text, '5 after seed'            from component_rates
union all
select 'bookings', count(*)::text, '2 after seed'         from bookings
union all
select 'revenue rows', count(*)::text, '1 after seed'     from revenue
union all
select 'linked logins', count(*)::text, 'you must add'    from app_users;
