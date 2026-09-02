# Commission Console

A sales commission administration tool: calculates commission from booking and
revenue files, runs a two-stage approval, produces month-end statements, posts
accrual and amortisation journals, and keeps an audit trail.

Data lives in Supabase (Postgres). The interface is a single self-contained HTML
page — no server to run.

---

## Live page

Once GitHub Pages is switched on, every push to `main` rebuilds and publishes to:

```
https://<your-username>.github.io/commission-console/
```

## Working on it locally

```bash
npm install
npm run build
```

That writes `dist/index.html`. Open it directly in a browser — it needs no
server, though it does need internet to reach Supabase.

---

## Layout

```
src/commission-console.jsx    the whole application: engine and interface
sql/                          database scripts, run in numeric order
build/build.mjs               bundles the app and inlines its libraries
.github/workflows/deploy.yml  rebuilds and publishes on push
```

`dist/index.html` is a build artifact. Edit `src/`, never `dist/`.

---

## Database

Run these in the Supabase SQL editor, in order, each in its own query tab.

| Script | What it adds |
|---|---|
| `01_schema.sql` | tables, row-level security, the approval function |
| `02_seed.sql` | people, the FY26 rate table, January bookings, March revenue |
| `03_verify.sql` | read-only check that everything landed |
| `04_import.sql` | bookings and revenue file import |
| `05_rates_and_override.sql` | manager override, rate table import |
| `06_rate_effective_dates.sql` | effective-dated rates |
| `07_prototype_switcher.sql` | acting-as-another-person, for prototyping |

`01_schema.sql` begins by dropping the commission tables, so re-running it wipes
your data. The rest are safe to re-run.

After running them, create a login under **Authentication → Users**, then link it:

```sql
insert into app_users (user_id, person_id, role)
select id, 'brian', 'finance'
from auth.users
where lower(email) = lower('your.email@example.com');
```

Nothing is visible until a login is linked here — every policy keys off
`app_users`.

---

## How commission is calculated

**Components.** Each rep has one component per commission type — New
Subscription, Renewal, Revenue, Professional Services — and each carries its own
target and its own accelerator. A rep can be over on services and under on new
business at the same time.

**Attainment** is cumulative from 1 January against the component's target. It
does not reset at period end.

**Rates** are effective-dated. A booking is priced at the version in force on the
date it was signed, so revising a rate never changes what an earlier period
already paid.

**New Subscription** carries two rates under one shared target: a new-logo rate
and an existing-logo rate.

**Accelerators** pay 1.2× the base rate on volume booked *after* the target is
reached. Nothing earlier is repriced, so a deal that crosses the target is split
— the portion up to target at base, the remainder accelerated.

**Manager override.** A manager earns a share of what their reports earned at
*base* rates, on every commission type. Managers earn no accelerator: any uplift
a rep earned for passing their own target stays with that rep. A manager's
targets are the reports' combined targets, which produces a reported attainment
but no second pay lever.

**Revenue** has no rep column in the source file, so it is attributed by client
ownership — whoever signed the earliest agreement with that client.

**Accounting.** Four components capitalise to a contract asset and amortise
straight-line over a 60-month average customer life, beginning the month the
agreement was signed. The Revenue component is expensed as earned.

---

## Who can do what

The rules live in Postgres, not the browser, so they hold even if someone calls
the API directly.

- **Rep** — sees only their own lines. Cannot approve anything.
- **Manager** — sees their team, approves at stage 1. Cannot do the finance step,
  cannot approve their own line.
- **Finance Admin** — approves at stage 2 (only after a manager has cleared
  stage 1), maintains rates, loads files, posts journals, closes periods.

Approvals go through `approve_line()`; direct `UPDATE` on `bookings` and
`revenue` is revoked for everyone. The audit log cannot be edited, deleted or
written to directly by anyone holding the anon key, including finance.

### Prototype switching

`07_prototype_switcher.sql` lets a finance login act as another person from a
dropdown, so the approval flow can be walked without creating five logins. The
rules are still evaluated against whoever is selected, and the audit records
both accounts — "Brian Paula acting as Mike". For real use, give each person
their own login; the original checks then apply unchanged.

---

## Loading data

The **Import files** tab reads Excel or CSV for bookings, revenue, and the rate
table. Column names are matched automatically and can be corrected by hand.
Nothing is written until you commit, and the database validates everything
again on the way in.

- The whole file is one transaction — a single bad row loads nothing.
- Rows already present are skipped, so re-uploading is safe.
- On the rate sheet, merged targets and repeated rep names carry down the block.
- A booking dated into a closed period is held back and reported.

---

## About the anon key

`src/commission-console.jsx` contains the Supabase project URL and the **anon**
key. That key is designed to be public — it grants nothing on its own, because
row-level security decides what each signed-in user may do.

The **service_role** key is the opposite: it bypasses every rule in the schema.
It must never appear in this repository or in any built page.

---

## Known limitations

**Targets are not effective-dated.** Rates are, but changing a target applies to
the whole year, including closed periods.

**Commission is calculated in the browser.** The source data is safe in Postgres,
but statement figures are computed by whichever machine renders them. For a real
close the engine should move into a Postgres function so numbers are computed
once and snapshotted at approval.

**No live updates.** Each person loads independently; use Refresh to pick up
someone else's approvals.
