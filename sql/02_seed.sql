-- ============================================================================
-- COMMISSION CONSOLE — seed data
-- Transcribed from:
--   Commission_Rate_Tables.xlsx        (sheet "Comp Rates")
--   01_January_2026_Bookings_File.xlsx (sheet "Bookings January 2026")
--   March_2026_Revenue_File.xlsx       (sheet "March 2026 Revenue")
-- Run this AFTER 01_schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------- people ---
insert into people (id, name, role_label, manager_id) values
  ('brian', 'Brian Paula',  'Finance Admin', null),
  ('mike',  'Mike',         'Manager',       'brian'),
  ('randy', 'Randy',        'Rep',           'mike'),
  ('jane',  'Jane Smith',   'Rep',           'mike'),
  ('doug',  'Doug Low',     'Rep',           'mike'),
  ('sam',   'Sam Williams', 'Rep',           'mike');

-- --------------------------------------------------------------- periods ---
insert into periods (period, status, posted, paid_on, closed_by) values
  ('2026-01', 'Paid',   true,  date '2026-02-13', 'Brian Paula'),
  ('2026-02', 'Closed', true,  null,              'Brian Paula'),
  ('2026-03', 'Open',   false, null,              null);

-- ------------------------------------------------------------ rate table ---
-- Only Randy is populated on the Comp Rates sheet. The other three reps and
-- Mike are listed with a manager and role but carry no targets or rates, so
-- they are deliberately absent here rather than given invented numbers.
insert into plan_components (id, person_id, type, target, target_comp, accounting, source, note) values
  ('randy:New Subscription',      'randy', 'New Subscription',      875000,  70000.00,    'Capitalize', 'bookings',
     'Target compensation on the sheet is struck at a blended 8% of target bookings.'),
  ('randy:Renewal',               'randy', 'Renewal',               1000000, 20000.00,    'Capitalize', 'bookings', null),
  ('randy:Revenue',               'randy', 'Revenue',               764646,  15292.92,    'Expense',    'revenue',  null),
  ('randy:Professional Services', 'randy', 'Professional Services', 312500,  9375.00,     'Capitalize', 'bookings', null);

-- New Subscription carries two rates under the one shared 875,000 target.
insert into component_rates (component_id, logo, label, rate) values
  ('randy:New Subscription',      'No',  'New logo',           0.10000),
  ('randy:New Subscription',      'Yes', 'Existing logo',      0.06000),
  ('randy:Renewal',               'N/A', 'All renewals',       0.02000),
  ('randy:Revenue',               'N/A', 'Recognised revenue', 0.02000),
  ('randy:Professional Services', 'N/A', 'All services',       0.03000);

-- -------------------------------------------------------------- bookings ---
insert into bookings
  (deal_id, person_id, date, client, agreement, existing, term, type, amount, s1, s1_by, s2, s2_by) values
  (1, 'randy', date '2026-01-12', 'Google', 'MSA',   'No', '3 Years',  'New Subscription',
      150000, 'Approved', 'Mike', 'Approved', 'Brian Paula'),
  (2, 'randy', date '2026-01-12', 'Google', 'SOW#1', 'No', '6 Months', 'Professional Services',
      100000, 'Approved', 'Mike', 'Approved', 'Brian Paula');

-- --------------------------------------------------------------- revenue ---
insert into revenue (id, period, client, amount) values
  ('REV-1', '2026-03', 'Google', 74000);

-- ------------------------------------------------------------- audit seed ---
insert into audit_log (ts, actor, actor_role, action, entity, detail) values
  ('2026-01-31 16:40+00', 'Brian Paula', 'finance', 'Bookings loaded',
     '01_January_2026_Bookings_File.xlsx',
     '2 bookings imported for January 2026, $250,000 total. Deal ID is the unique key.'),
  ('2026-02-02 09:05+00', 'Mike', 'manager', 'Approved (stage 1)', '2026-01',
     'Both January lines approved at stage 1.'),
  ('2026-02-02 15:22+00', 'Brian Paula', 'finance', 'Journals posted', 'JE-2026-01',
     'January commission $18,000 capitalised over the 60-month customer life.'),
  ('2026-02-13 11:00+00', 'Brian Paula', 'finance', 'Payment released', '2026-01',
     'January commissions released to payroll.'),
  ('2026-02-28 17:30+00', 'Brian Paula', 'finance', 'Period closed', '2026-02',
     'February closed with no booking or revenue activity. Amortisation only.'),
  ('2026-03-30 08:47+00', 'Brian Paula', 'finance', 'Revenue loaded',
     'March_2026_Revenue_File.xlsx',
     '1 revenue row imported for March 2026, Google $74,000. Attributed by client ownership.');

-- ============================================================================
-- LINK YOUR LOGINS
-- After you create users under Authentication > Users, run one line each,
-- pasting the user's UUID from that screen:
--
--   insert into app_users (user_id, person_id, role) values
--     ('00000000-0000-0000-0000-000000000000', 'brian', 'finance');
--   insert into app_users (user_id, person_id, role) values
--     ('11111111-1111-1111-1111-111111111111', 'mike',  'manager');
--   insert into app_users (user_id, person_id, role) values
--     ('22222222-2222-2222-2222-222222222222', 'randy', 'rep');
--
-- Until a login is linked here it can sign in but will see nothing, because
-- every policy keys off app_users.
-- ============================================================================
