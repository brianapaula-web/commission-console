import React, { useState, useMemo, useCallback, useEffect } from "react";

/* ============================================================================
   COMMISSION CONSOLE
   Built on: Commission_Rate_Tables.xlsx  (sheet "Comp Rates")
             01_January_2026_Bookings_File.xlsx
             March_2026_Revenue_File.xlsx
   ========================================================================== */

const usd = (n) =>
  (n < 0 ? "(" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US") + (n < 0 ? ")" : "");
const usd2 = (n) =>
  (n < 0 ? "(" : "") + "$" +
  Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
  (n < 0 ? ")" : "");
const pct = (n, d = 1) => (isFinite(n) ? (n * 100).toFixed(d) : "0.0") + "%";
const rateStr = (r) => (r * 100).toFixed((r * 100) % 1 === 0 ? 0 : 1) + "%";

const PERIODS = ["2026-01", "2026-02", "2026-03"];
const MONTHS = { "2026-01": "January 2026", "2026-02": "February 2026", "2026-03": "March 2026" };
const MSHORT = { "2026-01": "Jan", "2026-02": "Feb", "2026-03": "Mar" };
const shortDate = (iso) => {
  const [, m, d] = iso.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1]} ${+d}`;
};
const NOW = "2026-03-31 09:20";

/* Policy */
const CUSTOMER_LIFE_MONTHS = 60;
const ACCEL_MULTIPLIER = 1.2;

/* ============================================================================
   ENGINE
   ========================================================================== */

/* The revenue file has no rep column, so revenue is attributed to whoever signed
   the earliest agreement with that client. */
function ownershipMap(bookings) {
  const m = {};
  bookings.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((b) => {
    if (!m[b.client]) m[b.client] = b.repName;
  });
  return m;
}

/* Everything up to the component target earns the base rate; everything after
   earns 1.2x. Earlier bookings are never repriced. */
function splitAtTarget(cumBefore, amount, target, rate) {
  const segs = [];
  const below = Math.max(0, Math.min(amount, target - cumBefore));
  const above = amount - below;
  if (below > 0.005) {
    segs.push({ label: "Base rate — to target", base: below, rate: rate * 100,
      amount: below * rate, accelerated: false });
  }
  if (above > 0.005) {
    segs.push({ label: `Accelerated ${ACCEL_MULTIPLIER}× — above target`, base: above,
      rate: rate * ACCEL_MULTIPLIER * 100, amount: above * rate * ACCEL_MULTIPLIER, accelerated: true });
  }
  return segs;
}

/* The rate in force on a given date: the latest version starting on or before
   it. A booking signed in January keeps January's rate even after a revision. */
function rateOn(comp, logo, onDate) {
  const pool = comp.rates.filter((r) => r.logo === logo);
  const use = pool.length ? pool : comp.rates.filter((r) => r.logo === "N/A");
  const eligible = use.filter((r) => (r.from || "2026-01-01") <= onDate);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) =>
    (r.from || "2026-01-01") > (best.from || "2026-01-01") ? r : best);
}

/* Every distinct rate version that applies to a component, newest first. */
function rateHistory(comp) {
  return comp.rates.slice().sort((a, b) =>
    (b.from || "") < (a.from || "") ? -1 : (b.from || "") > (a.from || "") ? 1 : 0);
}

const termMonths = (t) => {
  if (!t) return null;
  const n = parseFloat(t);
  return /year/i.test(t) ? n * 12 : n;
};

function unpriced(src, p, period, why, id) {
  return {
    key: id || `U-${src.dealId || src.client}`, kind: "unpriced", id: id || `Deal ${src.dealId}`,
    period, date: src.date, repId: p ? p.id : null, repName: p ? p.name : src.repName || "—",
    client: src.client, agreement: src.agreement || "—", existing: src.existing || "N/A",
    term: src.term || null, type: src.type, amount: src.amount, componentId: null, component: null,
    rateLabel: "—", baseRate: 0, segments: [], commission: 0, accounting: null,
    attainBefore: 0, attainAfter: 0, s1: "Blocked", s2: "Blocked", approved: false,
    unpriced: true, why,
  };
}

function calcAll(components, bookings, revenue, people, overrides) {
  const person = (id) => people.find((p) => p.id === id);
  const byName = (n) => people.find((p) => p.name === n);
  const owner = ownershipMap(bookings);
  const compFor = (repId, type) => components.find((c) => c.repId === repId && c.type === type);
  const cum = {};
  const results = {};
  const running = [];
  const gaps = [];

  PERIODS.forEach((period) => {
    const lines = [];

    bookings
      .filter((b) => b.date.slice(0, 7) === period)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.dealId - b.dealId))
      .forEach((b) => {
        const p = byName(b.repName);
        const comp = p ? compFor(p.id, b.type) : null;
        if (!comp) {
          lines.push(unpriced(b, p, period, `No ${b.type} rates on file for ${b.repName}`));
          return;
        }
        const rr = rateOn(comp, b.existing, b.date);
        if (!rr) {
          lines.push(unpriced(b, p, period,
            `No ${b.type} rate in force on ${b.date} for ${b.repName}`));
          return;
        }
        const before = cum[comp.id] || 0;
        const segs = splitAtTarget(before, b.amount, comp.target, rr.rate);
        cum[comp.id] = before + b.amount;
        lines.push({
          key: `B-${b.dealId}`, kind: "booking", id: `Deal ${b.dealId}`, dealId: b.dealId,
          period, date: b.date, repId: p.id, repName: b.repName, client: b.client,
          agreement: b.agreement, existing: b.existing, term: b.term, type: b.type,
          amount: b.amount, componentId: comp.id, component: comp, rateLabel: rr.label,
          baseRate: rr.rate, rateFrom: rr.from, segments: segs,
          commission: segs.reduce((s, x) => s + x.amount, 0),
          baseCommission: b.amount * rr.rate,
          uplift: segs.reduce((t, g) => t + (g.accelerated ? g.base * (g.rate / 100 - rr.rate) : 0), 0),
          accounting: comp.accounting, attainBefore: before, attainAfter: before + b.amount,
          s1: b.s1, s2: b.s2, approved: b.s1 === "Approved" && b.s2 === "Approved",
        });
      });

    revenue.filter((r) => r.period === period).forEach((r) => {
      const repName = owner[r.client];
      const p = repName ? byName(repName) : null;
      const comp = p ? compFor(p.id, "Revenue") : null;
      if (!comp) {
        const why = !repName
          ? `No booking on file for ${r.client}, so revenue cannot be attributed to a rep`
          : `No Revenue rates on file for ${repName}`;
        gaps.push(why);
        lines.push(unpriced({ client: r.client, type: "Revenue", amount: r.amount, date: `${period}-01` },
          p, period, why, r.id));
        return;
      }
      const rr = rateOn(comp, "N/A", `${period}-01`);
      if (!rr) {
        const why = `No Revenue rate in force in ${period} for ${repName}`;
        gaps.push(why);
        lines.push(unpriced({ client: r.client, type: "Revenue", amount: r.amount, date: `${period}-01` },
          p, period, why, r.id));
        return;
      }
      const before = cum[comp.id] || 0;
      const segs = splitAtTarget(before, r.amount, comp.target, rr.rate);
      cum[comp.id] = before + r.amount;
      lines.push({
        key: r.id, kind: "revenue", id: r.id, period, date: `${period}-01`,
        repId: p.id, repName, client: r.client, agreement: "—", existing: "N/A", term: null,
        type: "Revenue", amount: r.amount, componentId: comp.id, component: comp,
        rateLabel: rr.label, baseRate: rr.rate, segments: segs,
        commission: segs.reduce((s, x) => s + x.amount, 0), accounting: comp.accounting,
        attainBefore: before, attainAfter: before + r.amount,
        baseCommission: r.amount * rr.rate,
        uplift: segs.reduce((t, g) => t + (g.accelerated ? g.base * (g.rate / 100 - rr.rate) : 0), 0),
        s1: r.s1, s2: r.s2, approved: r.s1 === "Approved" && r.s2 === "Approved",
        attributedVia: `client ownership — ${r.client} belongs to ${repName}`,
      });
    });

    /* Manager override: a share of what the reports earned at base rates, by
       commission type. Accelerators belong to the rep who booked the deal, so
       the uplift is stripped out before the share is applied and a manager
       earns no accelerator of any kind. Targets are the reports' combined
       targets, which drives a reported attainment but no second pay lever. */
    (overrides || []).forEach((ov) => {
      const mgr = person(ov.personId);
      if (!mgr) return;
      const reports = people.filter((p) => p.manager === mgr.name);
      if (reports.length === 0) return;
      const reportIds = reports.map((p) => p.id);
      const types = Array.from(new Set(
        components.filter((c) => reportIds.includes(c.repId)).map((c) => c.type)));
      types.forEach((type) => {
        const src = lines.filter((l) => reportIds.includes(l.repId) && l.type === type && !l.unpriced);
        const earned = src.reduce((t, l) => t + l.commission, 0);
        const base = src.reduce((t, l) => t + (l.baseCommission != null ? l.baseCommission : l.commission), 0);
        const uplift = earned - base;
        if (Math.abs(base) < 0.005) return;
        const comps = components.filter((c) => reportIds.includes(c.repId) && c.type === type);
        const target = comps.reduce((t, c) => t + c.target, 0);
        const acct = comps.length && comps.every((c) => c.accounting === "Expense") ? "Expense" : "Capitalize";
        const volume = src.reduce((t, l) => t + (l.amount || 0), 0);
        lines.push({
          key: `OV-${mgr.id}-${type}-${period}`, kind: "override", id: `OV-${MSHORT[period] || period}`,
          period, date: `${period}-28`, repId: mgr.id, repName: mgr.name,
          client: `${reports.length} report${reports.length === 1 ? "" : "s"} · ${type}`,
          agreement: "—", existing: "N/A", term: null, type,
          amount: volume, componentId: `${mgr.id}:${type}`,
          component: { id: `${mgr.id}:${type}`, repId: mgr.id, type, target,
                       targetComp: comps.reduce((t, c) => t + c.targetComp, 0),
                       accounting: acct, rates: [{ logo: "N/A", label: "Override share", rate: ov.share }] },
          rateLabel: `${pct(ov.share, 0)} of reports' base-rate commission`, baseRate: ov.share,
          segments: [{ label: `${pct(ov.share, 0)} of ${type} at base rates`,
                       base, rate: ov.share * 100, amount: base * ov.share, accelerated: false }],
          commission: base * ov.share, accounting: acct,
          repsEarned: earned, repsBase: base, upliftExcluded: uplift,
          attainBefore: 0, attainAfter: volume,
          s1: "Derived", s2: "Derived",
          approved: src.every((l) => l.approved),
          derived: true, sourceLines: src.map((l) => l.key), share: ov.share,
        });
      });
    });

    lines.forEach((l) => running.push(l));

    const here = PERIODS.indexOf(period);
    const amort = running
      .filter((l) => l.accounting === "Capitalize" && l.commission > 0)
      .map((l) => {
        const elapsed = here - PERIODS.indexOf(l.period);
        const monthly = l.commission / CUSTOMER_LIFE_MONTHS;
        const taken = Math.min(Math.max(elapsed + 1, 0), CUSTOMER_LIFE_MONTHS);
        return {
          line: l, monthly,
          thisPeriod: elapsed >= 0 && elapsed < CUSTOMER_LIFE_MONTHS ? monthly : 0,
          toDate: taken * monthly,
          remaining: l.commission - taken * monthly,
        };
      });

    const earned = lines.reduce((s, l) => s + l.commission, 0);
    const ovComps = [];
    (overrides || []).forEach((ov) => {
      const mgr = person(ov.personId);
      if (!mgr) return;
      const reportIds = people.filter((p) => p.manager === mgr.name).map((p) => p.id);
      const types = Array.from(new Set(components.filter((c) => reportIds.includes(c.repId)).map((c) => c.type)));
      types.forEach((type) => {
        const comps = components.filter((c) => reportIds.includes(c.repId) && c.type === type);
        ovComps.push({
          id: `${mgr.id}:${type}`, repId: mgr.id, type,
          target: comps.reduce((t, c) => t + c.target, 0),
          targetComp: comps.reduce((t, c) => t + c.targetComp, 0),
          accounting: comps.every((c) => c.accounting === "Expense") ? "Expense" : "Capitalize",
          rates: [{ logo: "N/A", label: `${pct(ov.share, 0)} of reports' commission`, rate: ov.share }],
          isOverride: true, share: ov.share,
          sourceIds: comps.map((c) => c.id),
        });
      });
    });
    const allComponents = components.concat(ovComps);

    const attain = allComponents.map((c) => {
      /* An override carries no volume of its own — it inherits the combined
         position of the reports it sits above. */
      const vol = c.isOverride
        ? (c.sourceIds || []).reduce((t, id) => t + (cum[id] || 0), 0)
        : (cum[c.id] || 0);
      return {
        component: c, rep: person(c.repId), volume: vol, target: c.target,
        attainment: c.target > 0 ? vol / c.target : 0,
        accelerated: vol > c.target, headroom: Math.max(c.target - vol, 0),
        commission: running.filter((l) => l.componentId === c.id).reduce((s, l) => s + l.commission, 0),
      };
    });

    const summary = people.map((p) => {
      const rl = lines.filter((l) => l.repId === p.id);
      return {
        person: p, hasPlan: allComponents.some((c) => c.repId === p.id), lines: rl,
        volume: rl.reduce((s, l) => s + (l.amount || 0), 0),
        earned: rl.reduce((s, l) => s + l.commission, 0),
        capitalised: rl.filter((l) => l.accounting === "Capitalize").reduce((s, l) => s + l.commission, 0),
        expensed: rl.filter((l) => l.accounting === "Expense").reduce((s, l) => s + l.commission, 0),
        pendingCount: rl.filter((l) => !l.approved && !l.unpriced).length,
        targetComp: allComponents.filter((c) => c.repId === p.id).reduce((s, c) => s + c.targetComp, 0),
        attain: attain.filter((a) => a.rep && a.rep.id === p.id),
      };
    });

    results[period] = {
      lines, summary, attain, amort,
      totals: {
        volume: lines.reduce((s, l) => s + (l.amount || 0), 0),
        earned,
        capitalised: lines.filter((l) => l.accounting === "Capitalize").reduce((s, l) => s + l.commission, 0),
        expensed: lines.filter((l) => l.accounting === "Expense").reduce((s, l) => s + l.commission, 0),
        amortExpense: amort.reduce((s, a) => s + a.thisPeriod, 0),
        deferredClose: amort.reduce((s, a) => s + Math.max(a.remaining, 0), 0),
        approved: lines.filter((l) => l.approved).reduce((s, l) => s + l.commission, 0),
        pending: lines.filter((l) => !l.approved && !l.unpriced).reduce((s, l) => s + l.commission, 0),
      },
    };
  });

  people.filter((p) => p.role !== "Finance Admin")
    .filter((p) => !components.some((c) => c.repId === p.id))
    .filter((p) => !(overrides || []).some((o) => o.personId === p.id))
    .forEach((p) => gaps.push(`No rate table on file for ${p.name} (${p.role})`));

  return { results, gaps: Array.from(new Set(gaps)), owner };
}

/* ============================================================================
   STYLES
   ========================================================================== */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600;700&display=swap');

.gate, .gate * { box-sizing:border-box; }
.gate {
  --ink:#14201B; --ink2:#2C3B34; --muted:#6B7A72; --paper:#F7F9F5; --panel:#FFFFFF;
  --rule:#D4DCD0; --rule2:#A6B2A1; --green:#1E6B48; --greenSoft:#DCEBE1;
  --red:#9B2A2A; --redSoft:#F5DEDB; --blue:#22506E;
  --mono:'IBM Plex Mono', ui-monospace, monospace;
  --sans:'IBM Plex Sans', system-ui, sans-serif;
  --cond:'IBM Plex Sans Condensed','IBM Plex Sans', system-ui, sans-serif;
  font-size:13px; line-height:1.45;
}
.gate .eyebrow { font-family:var(--cond); font-weight:600; font-size:10px; letter-spacing:.12em;
  text-transform:uppercase; color:var(--muted); }
.gate .mini { font-size:11.5px; color:var(--muted); }
.gate .inp { border:1px solid var(--rule2); border-radius:3px; padding:6px 8px; font-family:var(--sans);
  font-size:13px; background:#fff; color:var(--ink); }
.gate .btn { border:1px solid var(--rule2); background:#fff; color:var(--ink); padding:6px 14px;
  border-radius:3px; font-size:13px; font-weight:500; cursor:pointer; font-family:var(--sans); }
.gate .btn.primary { background:var(--green); border-color:var(--green); color:#F3F9F4; }
.gate .btn:disabled { opacity:.4; cursor:not-allowed; }
.gate .toolbar { display:flex; gap:8px; align-items:center; }
.gate .gapbox { background:var(--redSoft); border:1px solid #D9AEA9; border-radius:4px;
  padding:9px 12px; font-size:12px; color:#7A2020; }
.cc * { box-sizing: border-box; }
.cc {
  --ink:#14201B; --ink2:#2C3B34; --muted:#6B7A72; --faint:#93A199;
  --paper:#F7F9F5; --panel:#FFFFFF; --band:#E9F1E6;
  --rule:#D4DCD0; --rule2:#A6B2A1;
  --green:#1E6B48; --greenSoft:#DCEBE1;
  --amber:#8E5310; --amberSoft:#F7EAD5;
  --red:#9B2A2A; --redSoft:#F5DEDB;
  --blue:#22506E; --blueSoft:#DFE9EF;
  --chrome:#16221D;
  --mono:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans:'IBM Plex Sans', system-ui, -apple-system, Segoe UI, sans-serif;
  --cond:'IBM Plex Sans Condensed','IBM Plex Sans', system-ui, sans-serif;
  font-family: var(--sans); color: var(--ink); background: var(--paper);
  font-size: 13px; line-height: 1.45; min-height: 100vh;
  display: grid; grid-template-columns: 205px 1fr;
  -webkit-font-smoothing: antialiased;
}
.cc button { font-family: inherit; font-size: inherit; cursor: pointer; }
.cc table { border-collapse: collapse; width: 100%; }
.n { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.eyebrow { font-family: var(--cond); font-weight:600; font-size:10px; letter-spacing:.12em; text-transform:uppercase; color: var(--muted); }

.rail { background: var(--chrome); color:#C9D6CD; display:flex; flex-direction:column; position:sticky; top:0; height:100vh; }
.brand { padding:18px 16px 14px; border-bottom:1px solid rgba(255,255,255,.09); }
.brand h1 { font-family: var(--cond); font-size:15px; font-weight:700; color:#F2F7F1; margin:0; line-height:1.15; }
.brand .sub { font-family: var(--mono); font-size:9.5px; letter-spacing:.1em; color:#7B8F83; margin-top:5px; text-transform:uppercase; }
.navlist { padding:10px 8px; flex:1; overflow-y:auto; }
.navbtn { display:flex; align-items:center; gap:9px; width:100%; background:none; border:0; color:#A9BCB1; padding:7px 9px; border-radius:4px; text-align:left; font-size:12.5px; margin-bottom:1px; }
.navbtn:hover { background: rgba(255,255,255,.06); color:#EAF2E8; }
.navbtn.on { background:#25382F; color:#F2F7F1; font-weight:600; box-shadow: inset 2px 0 0 var(--green); }
.navbtn .idx { font-family:var(--mono); font-size:9.5px; color:#5F7268; width:14px; }
.navbtn.on .idx { color:#6FA98A; }
.navbtn .badge { margin-left:auto; font-family:var(--mono); font-size:9.5px; background:#8E5310; color:#FDF3E4; border-radius:8px; padding:1px 6px; }
.railfoot { border-top:1px solid rgba(255,255,255,.09); padding:11px 12px; }
.railfoot .lbl { font-family:var(--cond); font-size:9.5px; letter-spacing:.11em; text-transform:uppercase; color:#6D8176; margin-bottom:6px; }
.usel { width:100%; background:#22332B; color:#E6EFE6; border:1px solid #33473C; border-radius:4px; padding:5px 6px; font-family:var(--sans); font-size:11.5px; }
.railfoot .who { font-family:var(--mono); font-size:9.5px; color:#7B8F83; margin-top:6px; }

.main { min-width:0; display:flex; flex-direction:column; }
.topbar { display:flex; align-items:center; gap:14px; padding:12px 22px; background:var(--panel); border-bottom:1px solid var(--rule); position:sticky; top:0; z-index:20; flex-wrap:wrap; }
.topbar h2 { font-family:var(--cond); font-size:17px; font-weight:700; margin:0; }
.topbar .crumb { font-family:var(--mono); font-size:10.5px; color:var(--muted); }
.pgroup { display:flex; border:1px solid var(--rule2); border-radius:4px; overflow:hidden; margin-left:auto; }
.pgroup button { border:0; background:var(--panel); padding:5px 12px; font-family:var(--mono); font-size:11px; color:var(--ink2); border-left:1px solid var(--rule); }
.pgroup button:first-child { border-left:0; }
.pgroup button.on { background:var(--ink); color:#F2F7F1; }
.chip { display:inline-flex; align-items:center; gap:5px; font-family:var(--cond); font-size:10px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; padding:3px 8px; border-radius:3px; border:1px solid; white-space:nowrap; }
.chip.open { background:var(--amberSoft); color:var(--amber); border-color:#DFC08C; }
.chip.closed { background:var(--blueSoft); color:var(--blue); border-color:#A9C2D2; }
.chip.paid { background:var(--greenSoft); color:var(--green); border-color:#A5C8B2; }
.chip.pend { background:var(--amberSoft); color:var(--amber); border-color:#DFC08C; }
.chip.appr { background:var(--greenSoft); color:var(--green); border-color:#A5C8B2; }
.chip.rej { background:var(--redSoft); color:var(--red); border-color:#D9AEA9; }
.chip.ghost { background:transparent; color:var(--muted); border-color:var(--rule2); }
.chip.cap { background:var(--blueSoft); color:var(--blue); border-color:#A9C2D2; }
.chip.exp { background:#EFEDE4; color:#6B6446; border-color:#CFC9AE; }
.body { padding:20px 22px 60px; }

.panel { background:var(--panel); border:1px solid var(--rule); border-radius:5px; margin-bottom:18px; overflow:hidden; }
.phead { display:flex; align-items:center; gap:10px; padding:11px 14px; border-bottom:1px solid var(--rule); background:#FCFDFB; flex-wrap:wrap; }
.phead h3 { font-family:var(--cond); font-size:13px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; margin:0; }
.phead .note { font-size:11.5px; color:var(--muted); }
.pbody { padding:14px; }

.masthead { background:var(--panel); border:1px solid var(--rule); border-radius:5px; margin-bottom:18px; }
.mfigs { display:grid; grid-template-columns:repeat(auto-fit,minmax(155px,1fr)); }
.mfig { padding:13px 16px; border-left:1px solid var(--rule); }
.mfig:first-child { border-left:0; }
.mfig .k { font-family:var(--cond); font-size:9.5px; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); }
.mfig .v { font-family:var(--mono); font-size:20px; font-weight:500; margin-top:5px; font-variant-numeric:tabular-nums; }
.mfig .s { font-size:11px; color:var(--muted); margin-top:3px; }
.mfig.accent .v { color:var(--green); }
.mfig.warn .v { color:var(--amber); }
.mfig.blue .v { color:var(--blue); }

.led thead th { font-family:var(--cond); font-size:9.5px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);
  text-align:left; padding:7px 10px; border-bottom:1.5px solid var(--rule2); background:#FCFDFB; white-space:nowrap; }
.led thead th.n { text-align:right; }
.led tbody tr { border-bottom:1px solid #EDF1EA; }
.led tbody tr:nth-child(even) { background:var(--band); }
.led tbody tr.click { cursor:pointer; }
.led tbody tr.click:hover { background:#DCE9F0; }
.led tbody tr.blocked { background:var(--redSoft); }
.led td { padding:6px 10px; vertical-align:middle; }
.led tfoot td { padding:8px 10px; border-top:2px solid var(--ink); font-weight:600; background:#FCFDFB; }
.led tfoot td.n { border-bottom:3px double var(--ink); }
.tag { font-family:var(--cond); font-size:9.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:2px 6px; border-radius:2px; border:1px solid var(--rule2); color:var(--ink2); background:#fff; white-space:nowrap; }
.tag.ns { background:#E4EEF4; border-color:#B3CBD8; color:var(--blue); }
.tag.rn { background:#E8F0E4; border-color:#B4C9AC; color:#3D6127; }
.tag.rv { background:#F1EDE2; border-color:#CFC5A8; color:#6B5B2C; }
.tag.ps { background:#EEE9F0; border-color:#C7B8CB; color:#5A4463; }
.mini { font-size:11px; color:var(--muted); }
.scroll { overflow-x:auto; }

.bar { position:relative; height:16px; background:#EDF1EA; border:1px solid var(--rule); border-radius:2px; min-width:110px; overflow:hidden; }
.bar .fill { position:absolute; inset:0 auto 0 0; background:#B9803A; }
.bar .fill.over { background:var(--green); }
.bar .mark { position:absolute; top:-2px; bottom:-2px; left:50%; width:1px; background:var(--ink); }
.bar .txt { position:absolute; inset:0; display:flex; align-items:center; justify-content:flex-end; padding-right:4px; font-family:var(--mono); font-size:9.5px; }

.btn { border:1px solid var(--rule2); background:#fff; color:var(--ink); padding:5px 11px; border-radius:3px; font-size:12px; font-weight:500; }
.btn:hover:not(:disabled) { background:#F1F5EE; border-color:var(--ink2); }
.btn:disabled { opacity:.4; cursor:not-allowed; }
.btn.primary { background:var(--green); border-color:var(--green); color:#F3F9F4; }
.btn.primary:hover:not(:disabled) { background:#175539; }
.btn.sm { padding:3px 8px; font-size:11px; }
.btn.ink { background:var(--ink); border-color:var(--ink); color:#F2F7F1; }

.tape { width:100%; max-width:340px; background:#FFFDF6; margin:0 auto; position:relative; box-shadow:0 1px 3px rgba(20,32,27,.14); }
.tape .edge { height:6px; background-image:
  linear-gradient(45deg, transparent 50%, #FFFDF6 50%), linear-gradient(-45deg, transparent 50%, #FFFDF6 50%);
  background-size:8px 8px; background-repeat:repeat-x; }
.tape .edge.top { transform:scaleY(-1); }
.tape .inner { padding:4px 16px 8px; font-family:var(--mono); font-size:11.5px; color:#2A322B; }
.tape .th { text-align:center; font-size:9.5px; letter-spacing:.14em; color:#8A8F7E; padding:4px 0 8px; }
.tape .row { display:flex; justify-content:space-between; gap:8px; padding:2.5px 0; align-items:baseline; }
.tape .row .l { flex:1; min-width:0; }
.tape .row .l small { display:block; color:#8A8F7E; font-size:9.5px; }
.tape .row.accel .r { color:#1E6B48; font-weight:600; }
.tape .sep { border-top:1px solid #D8D3BE; margin:6px 0; }
.tape .tot { border-top:1px solid #2A322B; border-bottom:3px double #2A322B; display:flex; justify-content:space-between; padding:5px 0; font-weight:600; margin-top:6px; }
.tape .stampbox { text-align:center; margin-top:12px; }
.tape .redstamp { display:inline-block; border:2px solid #9B2A2A; color:#9B2A2A; font-family:var(--cond); font-weight:700; font-size:10.5px; letter-spacing:.18em; padding:3px 10px; transform:rotate(-4deg); opacity:.85; }
.tape .redstamp.pend { border-color:#8E5310; color:#8E5310; }

.scrim { position:fixed; inset:0; background:rgba(20,32,27,.34); z-index:60; }
.drawer { position:fixed; top:0; right:0; bottom:0; width:min(560px,94vw); background:var(--paper); z-index:61;
  border-left:1px solid var(--rule2); display:flex; flex-direction:column; box-shadow:-6px 0 24px rgba(20,32,27,.18); }
.dhead { padding:14px 18px; background:var(--panel); border-bottom:1px solid var(--rule); display:flex; align-items:flex-start; gap:10px; }
.dhead h3 { font-family:var(--cond); font-size:16px; margin:0 0 3px; font-weight:700; }
.dbody { padding:16px 18px 40px; overflow-y:auto; flex:1; }
.x { border:0; background:none; font-size:20px; line-height:1; color:var(--muted); padding:0 2px; margin-left:auto; }

.stmt { background:#fff; border:1px solid var(--rule2); padding:26px 30px; max-width:850px; position:relative; }
.stmt .wm { position:absolute; top:70px; right:34px; font-family:var(--cond); font-size:32px; font-weight:700; letter-spacing:.16em;
  color:rgba(155,42,42,.12); border:4px solid rgba(155,42,42,.12); padding:4px 16px; transform:rotate(-9deg); }
.stmt h4 { font-family:var(--cond); font-size:19px; margin:0; font-weight:700; }
.stmt .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:16px 0 18px; padding:12px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); }
.stmt .meta .k { font-family:var(--cond); font-size:9.5px; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); }
.stmt .meta .v { font-family:var(--mono); font-size:12.5px; margin-top:2px; }
.sig { display:grid; grid-template-columns:1fr 1fr; gap:26px; margin-top:26px; padding-top:14px; }
.sig .box { border-top:1px solid var(--ink); padding-top:5px; font-size:11px; color:var(--muted); }
.sig .box b { display:block; color:var(--ink); font-size:12px; font-family:var(--mono); }

.grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; align-items:start; }
.stmtwrap { display:grid; grid-template-columns:205px 1fr; gap:18px; align-items:start; }
.kv { display:flex; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px dotted var(--rule); font-size:12.5px; }
.kv:last-child { border-bottom:0; }
.kv .k { color:var(--muted); }
.inp { border:1px solid var(--rule2); border-radius:3px; padding:4px 7px; font-family:var(--sans); font-size:12px; background:#fff; color:var(--ink); }
.inp.n { font-family:var(--mono); text-align:right; width:92px; }
.inp:focus, .btn:focus-visible, .navbtn:focus-visible, .usel:focus { outline:2px solid var(--blue); outline-offset:1px; }
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--ink); color:#EFF5EC;
  padding:9px 16px; border-radius:4px; font-size:12.5px; z-index:90; box-shadow:0 4px 16px rgba(20,32,27,.3); max-width:80vw; }
.empty { padding:34px 20px; text-align:center; color:var(--muted); font-size:12.5px; }
.empty b { display:block; color:var(--ink); font-family:var(--cond); font-size:14px; margin-bottom:5px; }
.warnbox { background:var(--amberSoft); border:1px solid #DFC08C; border-radius:4px; padding:9px 12px; font-size:12px; color:#6E4310; margin-bottom:14px; }
.gapbox { background:var(--redSoft); border:1px solid #D9AEA9; border-radius:4px; padding:10px 13px; font-size:12px; color:#7A2020; margin-bottom:18px; }
.gapbox b { font-family:var(--cond); letter-spacing:.03em; }
.gapbox ul { margin:6px 0 6px; padding-left:18px; }
.gapbox li { margin:2px 0; }
.je td { padding:5px 10px; }
.protobanner { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  background:#F1EDE2; border:1px solid #CFC5A8; border-left:3px solid #8E5310;
  border-radius:4px; padding:9px 13px; font-size:12px; color:#5B4A20; margin-bottom:16px; }
.gate { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--paper);
  font-family:var(--sans); color:var(--ink); padding:20px; }
.gatebox { background:var(--panel); border:1px solid var(--rule); border-radius:6px; padding:26px 28px;
  max-width:460px; width:100%; box-shadow:0 2px 10px rgba(20,32,27,.06); }
.gatebox h1 { font-family:var(--cond); font-size:20px; margin:4px 0 12px; font-weight:700; }
.gatebox code { font-family:var(--mono); font-size:11px; background:#F1F5EE; padding:1px 4px; border-radius:2px; }
.gatebox label { display:block; margin-bottom:3px; }
.srcnote { font-family:var(--mono); font-size:10px; color:var(--muted); }
@media (max-width: 900px) {
  .cc { grid-template-columns:1fr; }
  .rail { position:relative; height:auto; flex-direction:row; align-items:center; overflow-x:auto; }
  .brand { border-bottom:0; border-right:1px solid rgba(255,255,255,.09); white-space:nowrap; }
  .navlist { display:flex; gap:2px; padding:8px; }
  .navbtn { white-space:nowrap; } .navbtn .idx { display:none; }
  .railfoot { border-top:0; border-left:1px solid rgba(255,255,255,.09); min-width:170px; }
  .body { padding:14px; }
  .stmtwrap { grid-template-columns:1fr; }
}
@media (prefers-reduced-motion: reduce) { .cc * { transition:none !important; } }
`;

/* ============================================================================
   APP
   ========================================================================== */
/* ============================================================================
   SUPABASE CLIENT
   ========================================================================== */
const SUPABASE_URL = "https://oxjtavkqxdhrdzjyfpjp.supabase.co";
let SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94anRhdmtxeGRocmR6anlmcGpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjg1MTEsImV4cCI6MjEwMzg0NDUxMX0.DwpwjjxfrajUEIohGKo0hAdlZiKoIc51CrVROpbDEDg";

/* A page opened straight from disk has an opaque origin, and several browsers
   refuse localStorage there. supabase-js keeps the session in localStorage by
   default, so hand it something that always works. */
function makeStore() {
  const mem = {};
  let real = null;
  try {
    const probe = "__cc_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    real = window.localStorage;
  } catch (e) { real = null; }
  return {
    usingMemory: real === null,
    getItem: (k) => { try { return real ? real.getItem(k) : (k in mem ? mem[k] : null); }
                      catch (e) { return k in mem ? mem[k] : null; } },
    setItem: (k, v) => { try { if (real) real.setItem(k, v); else mem[k] = String(v); }
                         catch (e) { mem[k] = String(v); } },
    removeItem: (k) => { try { if (real) real.removeItem(k); else delete mem[k]; }
                         catch (e) { delete mem[k]; } },
  };
}
const STORE = makeStore();
try {
  const saved = STORE.getItem("cc_anon_key");
  if (saved) SUPABASE_ANON_KEY = saved;
} catch (e) { /* ignore */ }

const keyMissing = () => !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.indexOf("PASTE_") === 0;
let _sb = null;
function sb() {
  if (!_sb) {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("The Supabase library did not load. Re-download the file — it may have been truncated.");
    }
    _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: STORE, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return _sb;
}

/* Map database rows onto the shapes the engine already expects. */
function shapePeople(rows) {
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return rows.map((r) => ({
    id: r.id, name: r.name, role: r.role_label,
    manager: r.manager_id && byId[r.manager_id] ? byId[r.manager_id].name : null,
  }));
}
function shapeComponents(comps, rates) {
  return comps.map((c) => ({
    id: c.id, repId: c.person_id, type: c.type,
    target: Number(c.target), targetComp: Number(c.target_comp),
    accounting: c.accounting, note: c.note, fromRevenueFile: c.source === "revenue",
    rates: rates.filter((r) => r.component_id === c.id)
      .map((r) => ({ logo: r.logo, label: r.label, rate: Number(r.rate),
                     from: r.effective_from || "2026-01-01" }))
      .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.logo === "No" ? -1 : 1)),
  }));
}
function shapeBookings(rows, people) {
  const nameOf = (id) => { const p = people.find((x) => x.id === id); return p ? p.name : id; };
  return rows.map((b) => ({
    dealId: b.deal_id, repName: nameOf(b.person_id), date: b.date, client: b.client,
    agreement: b.agreement, existing: b.existing, term: b.term, type: b.type,
    amount: Number(b.amount), s1: b.s1, s2: b.s2,
    s1By: b.s1_by, s2By: b.s2_by, rejectNote: b.reject_note,
  }));
}
function shapeRevenue(rows) {
  return rows.map((r) => ({
    id: r.id, period: r.period, client: r.client, amount: Number(r.amount),
    s1: r.s1, s2: r.s2, s1By: r.s1_by, s2By: r.s2_by, rejectNote: r.reject_note,
  }));
}
function shapeAudit(rows) {
  return rows.map((a) => ({
    id: a.id, ts: (a.ts || "").replace("T", " ").slice(0, 16),
    actor: a.actor, role: a.actor_role, action: a.action, entity: a.entity, detail: a.detail,
  }));
}

/* ============================================================================
   ROOT — key check, then sign in, then the console
   ========================================================================== */
export default function CommissionConsole() {
  const [needKey, setNeedKey] = useState(keyMissing());
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(!keyMissing());
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    if (needKey) return;
    let live = true;
    let sub = null;
    try {
      sb().auth.getSession().then(({ data }) => {
        if (!live) return;
        setSession(data.session || null);
        setChecking(false);
      }).catch((e) => { if (live) { setBootError(e); setChecking(false); } });
      sub = sb().auth.onAuthStateChange((_e, s) => setSession(s)).data;
    } catch (e) {
      setBootError(e); setChecking(false);
    }
    return () => { live = false; if (sub) sub.subscription.unsubscribe(); };
  }, [needKey]);

  if (bootError) return <><style>{CSS}</style><BootError err={bootError} /></>;
  if (needKey) return <><style>{CSS}</style><KeyGate onSaved={() => setNeedKey(false)} /></>;
  if (checking) return <><style>{CSS}</style><Splash msg="Connecting to Supabase…" /></>;
  if (!session) return <><style>{CSS}</style><SignIn /></>;
  return <><style>{CSS}</style><Console session={session} /></>;
}

function BootError({ err }) {
  return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">Could not start</div>
      <h1>Something failed on load</h1>
      <div className="gapbox" style={{ marginTop: 10 }}>{String(err && err.message ? err.message : err)}</div>
      <p className="mini" style={{ marginTop: 14 }}>
        Most often this is a truncated download — the file should be about 1.1 MB. Delete it and download it
        again. If it persists, open the browser console (F12) and send me what it says.
      </p>
    </div></div>
  );
}

function Splash({ msg }) {
  return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">Commission Console</div>
      <p style={{ marginTop: 10 }}>{msg}</p>
    </div></div>
  );
}

function KeyGate({ onSaved }) {
  const [k, setK] = useState("");
  const [err, setErr] = useState(null);
  const save = () => {
    const v = k.trim();
    if (!v.startsWith("eyJ")) { setErr("That does not look like an anon key — it should start with “eyJ”."); return; }
    if (v.length > 400) { setErr("That is unusually long. Make sure it is the anon public key, not a service key."); return; }
    STORE.setItem("cc_anon_key", v);
    SUPABASE_ANON_KEY = v;
    onSaved();
  };
  return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">One-time setup</div>
      <h1>Connect to your Supabase project</h1>
      <p className="mini" style={{ marginBottom: 14 }}>
        Project <code>{SUPABASE_URL.replace("https://", "")}</code> is already configured.
        Paste the <b>anon public</b> key from Project Settings → API.
      </p>
      <textarea className="inp" style={{ width: "100%", height: 84, fontFamily: "var(--mono)", fontSize: 11 }}
        placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." value={k}
        onChange={(e) => { setK(e.target.value); setErr(null); }} />
      {err && <div className="gapbox" style={{ marginTop: 10, marginBottom: 0 }}>{err}</div>}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={save}>Connect</button>
      </div>
      <p className="mini" style={{ marginTop: 14 }}>
        The anon key is safe in a browser — it grants nothing on its own, because row-level security decides
        what each signed-in user may do. Never paste the <b>service_role</b> key here; it bypasses every rule.
        To avoid this screen, edit <code>SUPABASE_ANON_KEY</code> at the top of this file.
      </p>
    </div></div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  };
  return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">Commission Console · FY26</div>
      <h1>Sign in</h1>
      <label className="eyebrow" htmlFor="em">Email</label>
      <input id="em" className="inp" style={{ width: "100%", marginBottom: 10 }} type="email"
        value={email} onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()} />
      <label className="eyebrow" htmlFor="pw">Password</label>
      <input id="pw" className="inp" style={{ width: "100%" }} type="password"
        value={pw} onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()} />
      {err && <div className="gapbox" style={{ marginTop: 12, marginBottom: 0 }}>{err}</div>}
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy || !email || !pw} onClick={go}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
      <p className="mini" style={{ marginTop: 16 }}>
        Your role comes from the database, not from this screen. A login that has not been linked in
        <code> app_users</code> can sign in but will see nothing.
      </p>
    </div></div>
  );
}

/* ============================================================================
   CONSOLE
   ========================================================================== */
function Console({ session }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [period, setPeriod] = useState(null);
  const [tab, setTab] = useState("overview");
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState(null);
  const [burden, setBurden] = useState(7.65);
  const [busy, setBusy] = useState(false);
  const [actingAs, setActingAs] = useState(null);   // person id, prototype switcher

  const load = useCallback(async () => {
    setErr(null);
    const c = sb();
    const [me, ppl, comps, rates, bk, rev, per, aud, ovr] = await Promise.all([
      c.from("app_users").select("*").eq("user_id", session.user.id).maybeSingle(),
      c.from("people").select("*").order("name"),
      c.from("plan_components").select("*").order("id"),
      c.from("component_rates").select("*").order("effective_from"),
      c.from("bookings").select("*").order("date").order("deal_id"),
      c.from("revenue").select("*").order("period"),
      c.from("periods").select("*").order("period"),
      c.from("audit_log").select("*").order("ts", { ascending: false }).limit(300),
      c.from("override_plans").select("*"),
    ]);
    const firstErr = [me, ppl, comps, rates, bk, rev, per, aud].find((r) => r.error);
    if (firstErr) { setErr(firstErr.error.message); return; }
    if (!me.data) { setErr("NOT_LINKED"); return; }

    const people = shapePeople(ppl.data);
    const meP = people.find((p) => p.id === me.data.person_id);
    setData({
      role: me.data.role, personId: me.data.person_id,
      user: { id: me.data.person_id, name: meP ? meP.name : session.user.email,
              title: meP ? meP.role : me.data.role, role: me.data.role },
      people,
      components: shapeComponents(comps.data, rates.data),
      bookings: shapeBookings(bk.data, people),
      revenue: shapeRevenue(rev.data),
      periods: Object.fromEntries(per.data.map((p) => [p.period,
        { status: p.status, posted: p.posted, paidOn: p.paid_on, closedBy: p.closed_by }])),
      periodList: per.data.map((p) => p.period),
      audit: shapeAudit(aud.data),
      overrides: (ovr && ovr.data ? ovr.data : []).map((o) => ({
        personId: o.person_id, share: Number(o.share), note: o.note })),
    });
    setPeriod((cur) => cur || (per.data.find((p) => p.status === "Open") || per.data[per.data.length - 1] || {}).period);
  }, [session]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  const engine = useMemo(
    () => (data ? calcAll(data.components, data.bookings, data.revenue, data.people, data.overrides) : null),
    [data]
  );

  if (err === "NOT_LINKED") return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">Signed in, but not recognised</div>
      <h1>{session.user.email}</h1>
      <p className="mini">
        This login is not linked to a person in <code>app_users</code>, so every policy denies it.
        Ask whoever administers the project to run the insert from the setup guide with this user id:
      </p>
      <code style={{ display: "block", marginTop: 8, fontSize: 11, wordBreak: "break-all" }}>{session.user.id}</code>
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => sb().auth.signOut()}>Sign out</button>
      </div>
    </div></div>
  );
  if (err) return (
    <div className="gate"><div className="gatebox">
      <div className="eyebrow">Could not load</div>
      <h1>Something went wrong</h1>
      <p className="mini">{err}</p>
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn" onClick={load}>Retry</button>
        <button className="btn" onClick={() => sb().auth.signOut()}>Sign out</button>
      </div>
    </div></div>
  );
  if (!data || !engine || !period) return <Splash msg="Loading the commission data…" />;

  const calc = engine.results[period];
  if (!calc) return <Splash msg="Preparing periods…" />;
  const locked = data.periods[period].status !== "Open";

  /* Prototype switcher. One login drives the app; the dropdown chooses whose
     seat you are sitting in. Only a finance login may switch, and the database
     records both accounts on every approval. */
  const canSwitch = data.role === "finance";
  const roleOf = (p) => {
    const t = (p.role || "").toLowerCase();
    return t.includes("finance") ? "finance" : t.includes("manager") ? "manager" : "rep";
  };
  const actingPerson = canSwitch && actingAs
    ? data.people.find((p) => p.id === actingAs) : null;
  const user = actingPerson
    ? { id: actingPerson.id, name: actingPerson.name, title: actingPerson.role, role: roleOf(actingPerson) }
    : data.user;
  const impersonating = !!actingPerson && actingPerson.id !== data.personId;

  /* --- mutations: every one of these is checked again by Postgres --- */
  const rpc = async (fn, args, okMsg) => {
    setBusy(true);
    const { error } = await sb().rpc(fn, args);
    setBusy(false);
    if (error) { setToast(error.message); return false; }
    await load();
    if (okMsg) setToast(okMsg);
    return true;
  };

  const asArg = impersonating ? { p_as: actingPerson.id } : {};

  const setApproval = (line, stage, value, note) =>
    rpc("approve_line", {
      p_kind: line.kind === "revenue" ? "revenue" : "booking",
      p_id: String(line.kind === "revenue" ? line.id : line.dealId),
      p_stage: stage, p_decision: value || "Approved", p_note: note || null,
      ...asArg,
    }, `${line.id} ${(value || "Approved").toLowerCase()}${impersonating ? ` as ${actingPerson.name}` : ""}.`);

  const bulkApprove = async (lines, stage) => {
    setBusy(true);
    let done = 0, failed = null;
    for (const l of lines) {
      const { error } = await sb().rpc("approve_line", {
        p_kind: l.kind === "revenue" ? "revenue" : "booking",
        p_id: String(l.kind === "revenue" ? l.id : l.dealId),
        p_stage: stage, p_decision: "Approved", p_note: null,
        ...asArg,
      });
      if (error) { failed = error.message; break; }
      done++;
    }
    setBusy(false);
    await load();
    setToast(failed ? `${done} approved, then stopped: ${failed}` : `${done} line${done === 1 ? "" : "s"} approved.`);
  };

  const saveRate = async (comp, rateRow, value, effective, reason) => {
    setBusy(true);
    const { error } = await sb().rpc("change_rate", {
      p_component_id: comp.id, p_logo: rateRow.logo, p_rate: value,
      p_effective: effective || "2026-01-01", p_reason: reason || null,
    });
    setBusy(false);
    if (error) { setToast(error.message); return; }
    await load();
    setToast(`${comp.type} · ${rateRow.label} is ${rateStr(value)} from ${effective}.`);
  };

  const setPeriods = () => {};
  const closePeriod = () => rpc("close_period", { p_period: period }, `${MONTHS[period] || period} closed.`);
  const reopenPeriod = () => rpc("reopen_period", { p_period: period }, `${MONTHS[period] || period} reopened.`);
  const markPosted = async () => {
    const { data: rows, error } = await sb().from("periods")
      .update({ posted: true }).eq("period", period).select();
    if (error) { setToast(error.message); return; }
    if (!rows || rows.length === 0) { setToast("Only finance can post the journals."); return; }
    await load();
    setToast(`Journals for ${MONTHS[period] || period} marked posted.`);
  };

  const canStage1 = (l) => !locked && user.role === "manager" && !l.unpriced && !!l.repId
    && (data.people.find((p) => p.id === l.repId) || {}).manager === user.name;
  const canStage2 = (l) => !locked && user.role === "finance" && !l.unpriced && l.s1 === "Approved";

  const exportCSV = (name, rows) => {
    const csv = rows
      .map((r) => r.map((c) => (typeof c === "string" && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    try {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      setToast(`Exported ${name}`);
    } catch (e) {
      if (navigator.clipboard) navigator.clipboard.writeText(csv);
      setToast("Download blocked — copied to your clipboard instead.");
    }
  };

  /* Reads are unrestricted for a finance login, so the switcher narrows the
     view client-side to match what that person would actually see. With
     separate logins this filtering happens in the database instead. */
  const visible = (() => {
    if (!impersonating || user.role === "finance") return calc;
    const mine = user.role === "manager"
      ? data.people.filter((p) => p.manager === user.name).map((p) => p.id).concat(user.id)
      : [user.id];
    return {
      ...calc,
      lines: calc.lines.filter((l) => mine.includes(l.repId)),
      summary: calc.summary.filter((s) => mine.includes(s.person.id)),
      attain: calc.attain.filter((a) => a.rep && mine.includes(a.rep.id)),
    };
  })();

  const pendingCount = visible.lines.filter((l) => !l.approved && !l.unpriced && !l.derived).length;
  const NAV = [
    { id: "overview", label: "Overview" },
    { id: "ledger", label: "Commission ledger" },
    { id: "approvals", label: "Approvals", badge: locked ? 0 : pendingCount },
    { id: "statements", label: "Statements" },
    { id: "accrual", label: "Accrual & amortisation" },
    { id: "plans", label: "Plans & rates" },
    { id: "import", label: "Import files" },
    { id: "audit", label: "Audit trail" },
  ];

  const shared = {
    engine, calc: visible, period, periods: data.periods, people: data.people,
    components: data.components, bookings: data.bookings, revenue: data.revenue,
    overrides: data.overrides,
    user, locked, setDrawer, setToast, setTab, audit: data.audit,
    canStage1, canStage2, setApproval, bulkApprove, exportCSV, saveRate,
    burden, setBurden, closePeriod, reopenPeriod, markPosted, setPeriods,
    log: () => {}, refresh: load,
  };

  return (
    <div className="cc">
      <aside className="rail">
        <div className="brand">
          <h1>Commission Console</h1>
          <div className="sub">FY26 · live</div>
        </div>
        <nav className="navlist">
          {NAV.map((n, i) => (
            <button key={n.id} className={"navbtn" + (tab === n.id ? " on" : "")}
              onClick={() => setTab(n.id)} aria-current={tab === n.id ? "page" : undefined}>
              <span className="idx">{String(i + 1).padStart(2, "0")}</span>
              <span>{n.label}</span>
              {n.badge ? <span className="badge">{n.badge}</span> : null}
            </button>
          ))}
        </nav>
        <div className="railfoot">
          <div className="lbl">{canSwitch ? "Acting as" : "Signed in as"}</div>
          {canSwitch ? (
            <>
              <select className="usel" value={actingAs || data.personId}
                onChange={(e) => setActingAs(e.target.value)}>
                {data.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.id === data.personId ? " (you)" : ""}
                  </option>
                ))}
              </select>
              <div className="who">{user.title}</div>
              {impersonating && (
                <div className="who" style={{ color: "#C9A45E", marginTop: 4 }}>
                  signed in as {data.user.name}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: "#E6EFE6" }}>{user.name}</div>
              <div className="who">{user.title}</div>
            </>
          )}
          <div className="toolbar" style={{ marginTop: 9 }}>
            <button className="btn sm" style={{ background: "#22332B", color: "#D6E4D8", borderColor: "#33473C" }}
              onClick={load} disabled={busy}>{busy ? "Working…" : "Refresh"}</button>
            <button className="btn sm" style={{ background: "#22332B", color: "#D6E4D8", borderColor: "#33473C" }}
              onClick={() => sb().auth.signOut()}>Sign out</button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h2>{NAV.find((n) => n.id === tab).label}</h2>
            <div className="crumb">{MONTHS[period] || period} · {calc.lines.length} lines · {data.people.length} participants</div>
          </div>
          <span className={"chip " + (data.periods[period].status === "Open" ? "open"
            : data.periods[period].status === "Paid" ? "paid" : "closed")}>
            {data.periods[period].status === "Open" ? "Period open" : data.periods[period].status}
          </span>
          <div className="pgroup" role="group" aria-label="Period">
            {data.periodList.map((p) => (
              <button key={p} className={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
                {MSHORT[p] || p}
              </button>
            ))}
          </div>
        </header>

        <div className="body">
          {impersonating && (
            <div className="protobanner">
              <b>Prototype mode</b> — you are acting as <b>{user.name}</b> ({user.title}) while signed in as{" "}
              {data.user.name}. Approvals are checked against {user.name}&apos;s role, and the audit trail records
              both accounts.
              <button className="btn sm" style={{ marginLeft: "auto" }}
                onClick={() => setActingAs(data.personId)}>Back to {data.user.name}</button>
            </div>
          )}
          {tab === "overview" && <Overview {...shared} />}
          {tab === "ledger" && <Ledger {...shared} />}
          {tab === "approvals" && <Approvals {...shared} />}
          {tab === "statements" && <Statements {...shared} />}
          {tab === "accrual" && <Accrual {...shared} />}
          {tab === "plans" && <Plans {...shared} />}
          {tab === "import" && <Import {...shared} />}
          {tab === "audit" && <AuditTrail {...shared} />}
        </div>
      </div>

      {drawer && <Drawer drawer={drawer} {...shared} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/* ---------------------------------------------------------- small pieces --- */
function AttBar({ v }) {
  return (
    <div className="bar" title={pct(v)}>
      <div className={"fill " + (v >= 1 ? "over" : "")} style={{ width: Math.min(v / 2, 1) * 100 + "%" }} />
      <div className="mark" />
      <div className="txt">{pct(v)}</div>
    </div>
  );
}

function TypeTag({ t }) {
  const cls = { "New Subscription": "ns", Renewal: "rn", Revenue: "rv", "Professional Services": "ps" }[t] || "";
  return <span className={"tag " + cls}>{t}</span>;
}

function ApprovalChip({ l }) {
  if (l.derived) return <span className="chip cap">{l.approved ? "Derived · settled" : "Derived · provisional"}</span>;
  if (l.unpriced) return <span className="chip rej">Blocked</span>;
  if (l.approved) return <span className="chip appr">Approved</span>;
  if (l.s1 === "Approved") return <span className="chip pend">Finance review</span>;
  return <span className="chip ghost">Manager review</span>;
}

function Check({ done, label, note, onClick }) {
  return (
    <div onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick()) : undefined}
      style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: "1px dotted var(--rule)",
        cursor: onClick ? "pointer" : "default" }}>
      <span style={{ fontFamily: "var(--mono)", width: 18, height: 18, borderRadius: 3, flexShrink: 0,
        border: "1px solid " + (done ? "var(--green)" : "var(--rule2)"), background: done ? "var(--greenSoft)" : "#fff",
        color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>
        {done ? "✓" : ""}
      </span>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: done ? 400 : 600 }}>{label}</div>
        <div className="mini">{note}</div>
      </div>
    </div>
  );
}

/* ============================================================================
   OVERVIEW
   ========================================================================== */
function Overview({ engine, calc, period, periods, setDrawer, setTab, exportCSV }) {
  const t = calc.totals;

  return (
    <>
      {engine.gaps.length > 0 && (
        <div className="gapbox">
          <b>Gaps in the source files</b>
          <ul>{engine.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
          Anything that cannot be priced is held out of the ledger totals and the accrual until rates arrive.
        </div>
      )}

      <div className="masthead">
        <div className="mfigs">
          <div className="mfig">
            <div className="k">Bookings and revenue</div>
            <div className="v">{usd(t.volume)}</div>
            <div className="s">{calc.lines.filter((l) => !l.unpriced).length} priced lines</div>
          </div>
          <div className="mfig accent">
            <div className="k">Commission earned</div>
            <div className="v">{usd2(t.earned)}</div>
            <div className="s">{t.volume > 0 ? pct(t.earned / t.volume, 2) + " effective rate" : "no activity"}</div>
          </div>
          <div className="mfig blue">
            <div className="k">Capitalised</div>
            <div className="v">{usd2(t.capitalised)}</div>
            <div className="s">deferred over {CUSTOMER_LIFE_MONTHS} months</div>
          </div>
          <div className="mfig">
            <div className="k">Expensed as earned</div>
            <div className="v">{usd2(t.expensed)}</div>
            <div className="s">revenue-based component</div>
          </div>
          <div className="mfig warn">
            <div className="k">Awaiting approval</div>
            <div className="v">{usd2(t.pending)}</div>
            <div className="s">{calc.lines.filter((l) => !l.approved && !l.unpriced).length} lines in queue</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="phead">
          <h3>Attainment by plan component</h3>
          <span className="note">year to date through {MONTHS[period]} · each component carries its own target and accelerator</span>
          <div style={{ marginLeft: "auto" }}>
            <button className="btn sm" onClick={() =>
              exportCSV(`attainment-${period}.csv`,
                [["Rep", "Component", "Target", "YTD volume", "Attainment", "Headroom", "Rates", "Accelerating", "Commission YTD", "Accounting"]]
                  .concat(calc.attain.map((a) => [a.rep.name, a.component.type, a.target, Math.round(a.volume),
                    (a.attainment * 100).toFixed(1) + "%", Math.round(a.headroom),
                    a.component.rates.map((r) => rateStr(r.rate)).join(" / "),
                    a.accelerated ? "Yes" : "No", a.commission.toFixed(2), a.component.accounting])))}>
              Export attainment
            </button>
          </div>
        </div>
        <div className="scroll">
          <table className="led">
            <thead>
              <tr>
                <th>Rep</th><th>Component</th><th className="n">Target</th><th className="n">YTD volume</th>
                <th style={{ width: 150 }}>Attainment</th><th className="n">To accelerator</th>
                <th>Rate</th><th>Accounting</th><th className="n">Commission YTD</th>
              </tr>
            </thead>
            <tbody>
              {calc.attain.map((a) => (
                <tr key={a.component.id} className="click" onClick={() => setDrawer({ type: "component", id: a.component.id })}>
                  <td>{a.rep.name}</td>
                  <td><TypeTag t={a.component.type} /></td>
                  <td className="n">{usd(a.target)}</td>
                  <td className="n">{usd(a.volume)}</td>
                  <td><AttBar v={a.attainment} /></td>
                  <td className="n">
                    {a.component.isOverride ? <span className="mini">no accelerator</span>
                      : a.accelerated ? <span className="chip appr">accelerating</span> : usd(a.headroom)}
                  </td>
                  <td className="mini">{a.component.rates.map((r) => `${rateStr(r.rate)} ${r.label.toLowerCase()}`).join(" · ")}</td>
                  <td><span className={"chip " + (a.component.accounting === "Capitalize" ? "cap" : "exp")}>{a.component.accounting}</span></td>
                  <td className="n" style={{ fontWeight: 600 }}>{usd2(a.commission)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total across components</td>
                <td className="n">{usd(calc.attain.reduce((s, a) => s + a.target, 0))}</td>
                <td className="n">{usd(calc.attain.reduce((s, a) => s + a.volume, 0))}</td>
                <td colSpan={4}></td>
                <td className="n">{usd2(calc.attain.reduce((s, a) => s + a.commission, 0))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {calc.attain.length === 0 && <div className="empty"><b>No components defined</b>Load the Comp Rates sheet to price activity.</div>}
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="phead"><h3>Summary by sales rep</h3><span className="note">{MONTHS[period]}</span></div>
          <div className="scroll">
            <table className="led">
              <thead><tr><th>Rep</th><th>Role</th><th className="n">Volume</th><th className="n">Earned</th><th>State</th></tr></thead>
              <tbody>
                {calc.summary.map((s) => (
                  <tr key={s.person.id} className={s.hasPlan ? "click" : ""}
                    onClick={s.hasPlan ? () => setDrawer({ type: "rep", id: s.person.id }) : undefined}>
                    <td>{s.person.name}</td>
                    <td className="mini">{s.person.role}</td>
                    <td className="n">{s.volume ? usd(s.volume) : "—"}</td>
                    <td className="n" style={{ fontWeight: 600 }}>{s.earned ? usd2(s.earned) : "—"}</td>
                    <td>
                      {!s.hasPlan ? <span className="chip rej">No rate table</span>
                        : s.pendingCount > 0 ? <span className="chip pend">{s.pendingCount} pending</span>
                        : s.lines.length === 0 ? <span className="chip ghost">No activity</span>
                        : <span className="chip appr">Approved</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="phead"><h3>Close checklist</h3></div>
          <div className="pbody">
            <Check done label="Bookings file loaded" note="January 2026 · Deal ID as the unique key" />
            <Check done label="Revenue file loaded" note="March 2026 · attributed by client ownership" />
            <Check done={engine.gaps.length === 0} label="Rate table complete"
              note={engine.gaps.length === 0 ? "Every participant priced"
                : `${engine.gaps.length} gap${engine.gaps.length === 1 ? "" : "s"} outstanding`}
              onClick={() => setTab("plans")} />
            <Check done={calc.lines.filter((l) => l.s1 !== "Approved" && !l.unpriced).length === 0}
              label="Manager approval complete"
              note={`${calc.lines.filter((l) => l.s1 === "Pending").length} outstanding at stage 1`}
              onClick={() => setTab("approvals")} />
            <Check done={calc.lines.filter((l) => l.s2 !== "Approved" && !l.unpriced).length === 0}
              label="Finance approval complete"
              note={`${calc.lines.filter((l) => l.s2 === "Pending").length} outstanding at stage 2`}
              onClick={() => setTab("approvals")} />
            <Check done={periods[period].posted} label="Journals posted"
              note={periods[period].posted ? "Posted to GL" : "Not yet posted"} onClick={() => setTab("accrual")} />
            <Check done={periods[period].status !== "Open"} label="Period locked"
              note={periods[period].closedBy ? `Closed by ${periods[period].closedBy}` : "Open for edits"} />
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================================
   LEDGER
   ========================================================================== */
function Ledger({ calc, period, setDrawer, exportCSV }) {
  const [q, setQ] = useState("");
  const [fType, setFType] = useState("all");
  const rows = calc.lines.filter((l) => {
    if (fType !== "all" && l.type !== fType) return false;
    if (q && !`${l.id} ${l.client} ${l.repName} ${l.type} ${l.agreement}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const types = Array.from(new Set(calc.lines.map((l) => l.type)));

  return (
    <div className="panel">
      <div className="phead">
        <h3>Transaction ledger</h3>
        <span className="note">{rows.length} of {calc.lines.length} lines · select a row for the calculation tape</span>
      </div>
      <div className="pbody" style={{ borderBottom: "1px solid var(--rule)" }}>
        <div className="toolbar">
          <input className="inp" style={{ width: 245 }} placeholder="Search client, rep, deal or agreement"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="inp" value={fType} onChange={(e) => setFType(e.target.value)}>
            <option value="all">All commission types</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="btn sm" onClick={() => { setQ(""); setFType("all"); }}>Clear</button>
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={rows.length === 0} onClick={() =>
            exportCSV(`ledger-${period}.csv`,
              [["Line", "Date", "Rep", "Client", "Agreement", "Existing", "Term", "Type", "Amount", "Rate", "Commission", "Accounting", "Stage 1", "Stage 2"]]
                .concat(rows.map((l) => [l.id, l.date, l.repName, l.client, l.agreement, l.existing, l.term || "",
                  l.type, l.amount, l.segments.map((g) => g.rate.toFixed(1) + "%").join(" / "),
                  l.commission.toFixed(2), l.accounting || "", l.s1, l.s2])))}>
            Export ledger
          </button>
        </div>
      </div>
      <div className="scroll">
        <table className="led">
          <thead>
            <tr>
              <th>Line</th><th>Date</th><th>Rep</th><th>Client</th><th>Agreement</th><th>Type</th>
              <th>Logo</th><th className="n">Amount</th><th className="n">Rate</th>
              <th>Accounting</th><th>Approval</th><th className="n">Commission</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.key} className={l.unpriced ? "blocked" : "click"}
                onClick={l.unpriced ? undefined : () => setDrawer({ type: "line", id: l.key })}>
                <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{l.id}</td>
                <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{shortDate(l.date)}</td>
                <td>{l.repName}</td>
                <td>{l.client}</td>
                <td className="mini">{l.agreement}</td>
                <td><TypeTag t={l.type} /></td>
                <td className="mini">{l.existing === "No" ? "New" : l.existing === "Yes" ? "Existing" : "—"}</td>
                <td className="n">{usd(l.amount)}</td>
                <td className="n mini">{l.unpriced ? "—" : l.segments.map((g) => rateStr(g.rate / 100)).join(" / ")}</td>
                <td>{l.accounting
                  ? <span className={"chip " + (l.accounting === "Capitalize" ? "cap" : "exp")}>{l.accounting}</span>
                  : <span className="mini">—</span>}</td>
                <td><ApprovalChip l={l} /></td>
                <td className="n" style={{ fontWeight: 600 }}>{l.unpriced ? "—" : usd2(l.commission)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={7}>{rows.length} line{rows.length === 1 ? "" : "s"}</td>
                <td className="n">{usd(rows.reduce((s, l) => s + (l.amount || 0), 0))}</td>
                <td colSpan={3}></td>
                <td className="n">{usd2(rows.reduce((s, l) => s + l.commission, 0))}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {rows.length === 0 && (
          <div className="empty">
            <b>No activity in this period</b>
            {MONTHS[period]} has no bookings or revenue on file. Amortisation of earlier commission still runs — see the accrual tab.
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   APPROVALS
   ========================================================================== */
function Approvals({ calc, user, locked, canStage1, canStage2, setApproval, bulkApprove, setDrawer, period }) {
  const [sel, setSel] = useState({});
  const stage = user.role === "finance" ? "s2" : "s1";
  const queue = calc.lines.filter((l) => !l.approved && !l.unpriced && !l.derived);
  const actionable = queue.filter((l) => (stage === "s1" ? l.s1 === "Pending" && canStage1(l) : l.s2 === "Pending" && canStage2(l)));
  const selected = actionable.filter((l) => sel[l.key]);
  const blocked = calc.lines.filter((l) => l.unpriced);

  return (
    <>
      {locked && <div className="warnbox">{MONTHS[period]} is locked. Approvals are read-only — reopen the period from the accrual tab to make changes.</div>}
      {!locked && queue.length > 0 && actionable.length === 0 && (
        <div className="warnbox">
          {queue.length} line{queue.length === 1 ? " is" : "s are"} waiting, but none are yours to action as {user.title}.
          {user.role === "finance" && " Finance signs off only after the manager has approved at stage 1."}
          {user.role === "manager" && " Everything on your team has cleared stage 1 — finance signs off next."}
        </div>
      )}
      {blocked.length > 0 && (
        <div className="gapbox">
          <b>{blocked.length} line{blocked.length === 1 ? "" : "s"} cannot be priced</b>
          <ul>{blocked.map((l) => <li key={l.key}>{l.id} · {l.client} · {usd(l.amount)} — {l.why}</li>)}</ul>
        </div>
      )}

      <div className="panel">
        <div className="phead">
          <h3>Approval queue · stage {stage === "s1" ? "1 — manager" : "2 — finance"}</h3>
          <span className="note">{queue.length} pending · {usd2(queue.reduce((s, l) => s + l.commission, 0))} at stake</span>
          <div className="toolbar" style={{ marginLeft: "auto" }}>
            <button className="btn sm" disabled={actionable.length === 0}
              onClick={() => setSel(Object.fromEntries(actionable.map((l) => [l.key, true])))}>
              Select all I can approve ({actionable.length})
            </button>
            <button className="btn sm primary" disabled={selected.length === 0}
              onClick={() => { bulkApprove(selected, stage); setSel({}); }}>
              Approve {selected.length || ""} selected
            </button>
          </div>
        </div>
        {queue.length === 0 ? (
          <div className="empty"><b>Queue is clear</b>Every priced line in {MONTHS[period]} has cleared both stages.</div>
        ) : (
          <div className="scroll">
            <table className="led">
              <thead>
                <tr><th style={{ width: 30 }}></th><th>Line</th><th>Rep</th><th>Client</th><th>Type</th>
                  <th className="n">Amount</th><th>Stages</th><th className="n">Commission</th><th></th></tr>
              </thead>
              <tbody>
                {queue.map((l) => {
                  const mine = stage === "s1" ? canStage1(l) : canStage2(l);
                  return (
                    <tr key={l.key}>
                      <td><input type="checkbox" disabled={!mine} checked={!!sel[l.key]}
                        onChange={(e) => setSel((s) => ({ ...s, [l.key]: e.target.checked }))}
                        aria-label={`Select ${l.id}`} /></td>
                      <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{l.id}</td>
                      <td>{l.repName}</td>
                      <td>{l.client}</td>
                      <td><TypeTag t={l.type} /></td>
                      <td className="n">{usd(l.amount)}</td>
                      <td className="mini">
                        Mgr <b style={{ color: l.s1 === "Approved" ? "var(--green)" : "var(--amber)" }}>{l.s1 === "Approved" ? "✓" : "•"}</b>
                        {"  "}Fin <b style={{ color: l.s2 === "Approved" ? "var(--green)" : "var(--amber)" }}>{l.s2 === "Approved" ? "✓" : "•"}</b>
                      </td>
                      <td className="n" style={{ fontWeight: 600 }}>{usd2(l.commission)}</td>
                      <td>
                        <div className="toolbar" style={{ justifyContent: "flex-end" }}>
                          <button className="btn sm" onClick={() => setDrawer({ type: "line", id: l.key })}>Show calc</button>
                          <button className="btn sm primary" disabled={!mine} onClick={() => setApproval(l, stage, "Approved")}>Approve</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/* ============================================================================
   STATEMENTS
   ========================================================================== */
function Statements({ calc, period, periods, exportCSV, setToast }) {
  const withPlan = calc.summary.filter((s) => s.hasPlan);
  const [repId, setRepId] = useState(withPlan.length ? withPlan[0].person.id : (calc.summary[0] && calc.summary[0].person.id));
  const s = calc.summary.find((x) => x.person.id === repId) || calc.summary[0];
  const st = periods[period];

  return (
    <div className="stmtwrap">
      <div className="panel" style={{ marginBottom: 0 }}>
        <div className="phead"><h3>Participants</h3></div>
        <div>
          {calc.summary.map((x) => (
            <button key={x.person.id} onClick={() => setRepId(x.person.id)}
              style={{ display: "block", width: "100%", textAlign: "left", border: 0,
                borderBottom: "1px solid #EDF1EA", padding: "8px 12px",
                background: x.person.id === repId ? "var(--band)" : "#fff",
                boxShadow: x.person.id === repId ? "inset 3px 0 0 var(--green)" : "none" }}>
              <div style={{ fontSize: 12.5, fontWeight: x.person.id === repId ? 600 : 400 }}>{x.person.name}</div>
              <div className="mini n" style={{ textAlign: "left" }}>{x.hasPlan ? usd2(x.earned) : "no rate table"}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <button className="btn" disabled={!s.hasPlan}
            onClick={() => setToast(`Statement for ${s.person.name} is ready to export.`)}>
            Issue statement
          </button>
          <button className="btn" disabled={!s.lines.length} onClick={() =>
            exportCSV(`statement-${s.person.name.replace(/\W+/g, "-").toLowerCase()}-${period}.csv`,
              [["Line", "Date", "Client", "Agreement", "Type", "Amount", "Rate", "Commission", "Accounting"]]
                .concat(s.lines.map((l) => [l.id, l.date, l.client, l.agreement, l.type, l.amount,
                  l.segments.map((g) => g.rate.toFixed(1) + "%").join(" / "), l.commission.toFixed(2), l.accounting || ""])))}>
            Export detail
          </button>
        </div>

        {!s.hasPlan ? (
          <div className="panel"><div className="empty">
            <b>No rate table on file for {s.person.name}</b>
            The Comp Rates sheet lists {s.person.name} as {s.person.role} reporting to {s.person.manager || "—"},
            but carries no targets or rates. Add those rows and a statement will generate here.
          </div></div>
        ) : (
          <div className="stmt">
            {st.status === "Open" && <div className="wm">DRAFT</div>}
            {st.status === "Paid" && <div className="wm" style={{ color: "rgba(30,107,72,.13)", borderColor: "rgba(30,107,72,.13)" }}>PAID</div>}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 20 }}>
              <div>
                <div className="eyebrow">Month-end commission statement</div>
                <h4>{s.person.name}</h4>
                <div className="mini">{s.person.role} · reports to {s.person.manager}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="eyebrow">Period</div>
                <div className="n" style={{ fontSize: 15 }}>{MONTHS[period]}</div>
                <div className="mini n">Issued {NOW.split(" ")[0]}</div>
              </div>
            </div>

            <div className="meta">
              <div><div className="k">Target bookings</div><div className="v">{usd(s.attain.reduce((a, x) => a + x.target, 0))}</div></div>
              <div><div className="k">Target compensation</div><div className="v">{usd2(s.targetComp)}</div></div>
              <div><div className="k">Volume this period</div><div className="v">{usd(s.volume)}</div></div>
              <div><div className="k">Earned this period</div><div className="v">{usd2(s.earned)}</div></div>
            </div>

            <div className="eyebrow" style={{ marginBottom: 6 }}>Attainment by component — year to date</div>
            <table className="led">
              <thead><tr><th>Component</th><th className="n">Target</th><th className="n">YTD volume</th>
                <th style={{ width: 130 }}>Attainment</th><th className="n">Commission YTD</th></tr></thead>
              <tbody>
                {s.attain.map((a) => (
                  <tr key={a.component.id}>
                    <td>{a.component.type}
                      {a.component.isOverride
                        ? <span className="mini"> · override, no accelerator</span>
                        : a.accelerated && <span className="mini"> · accelerating at {ACCEL_MULTIPLIER}×</span>}</td>
                    <td className="n">{usd(a.target)}</td>
                    <td className="n">{usd(a.volume)}</td>
                    <td><AttBar v={a.attainment} /></td>
                    <td className="n">{usd2(a.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="eyebrow" style={{ margin: "18px 0 6px" }}>Earnings detail — {MONTHS[period]}</div>
            {s.lines.length === 0 ? (
              <div className="mini" style={{ padding: "10px 0" }}>No bookings or revenue attributed in this period.</div>
            ) : (
              <table className="led">
                <thead><tr><th>Line</th><th>Date</th><th>Client</th><th>Type</th>
                  <th className="n">Amount</th><th className="n">Rate</th><th className="n">Commission</th></tr></thead>
                <tbody>
                  {s.lines.map((l) => (
                    <tr key={l.key}>
                      <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{l.id}</td>
                      <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{shortDate(l.date)}</td>
                      <td>{l.client} <span className="mini">{l.agreement}</span></td>
                      <td className="mini">{l.type}</td>
                      <td className="n">{usd(l.amount)}</td>
                      <td className="n mini">{l.segments.map((g) => rateStr(g.rate / 100)).join(" / ")}</td>
                      <td className="n">{usd2(l.commission)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={6}>Total earned — {MONTHS[period]}</td>
                  <td className="n">{usd2(s.earned)}</td></tr></tfoot>
              </table>
            )}

            <div className="sig">
              <div className="box"><b>{s.person.manager}</b>
                Manager approval — stage 1 · {s.lines.length === 0 ? "nothing to approve" : s.lines.every((l) => l.s1 === "Approved") ? "complete" : "outstanding"}</div>
              <div className="box"><b>Brian Paula</b>
                Finance Admin — stage 2 · {s.lines.length === 0 ? "nothing to approve" : s.lines.every((l) => l.s2 === "Approved") ? "complete" : "outstanding"}</div>
            </div>

            <div className="mini" style={{ marginTop: 18, paddingTop: 10, borderTop: "1px solid var(--rule)" }}>
              Rates follow the Comp Rates table in force at the booking date. Bookings recorded after a component target is
              reached earn {ACCEL_MULTIPLIER}× the base rate on the excess only; earlier bookings are not repriced.
              Revenue commission is attributed to the rep who owns the client relationship.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   ACCRUAL & AMORTISATION
   ========================================================================== */
function Accrual({ engine, calc, period, periods, user, setToast, exportCSV, locked, burden, setBurden, closePeriod, reopenPeriod, markPosted }) {
  const t = calc.totals;
  const pi = PERIODS.indexOf(period);
  const priorClose = pi > 0 ? engine.results[PERIODS[pi - 1]].totals.deferredClose : 0;
  const burdenAmt = t.earned * (burden / 100);

  const je = [
    { acct: "1450", name: "Deferred commission cost (contract asset)", dr: t.capitalised, cr: 0 },
    { acct: "6100", name: "Commission expense — expensed as earned", dr: t.expensed, cr: 0 },
    { acct: "6150", name: `Employer payroll burden @ ${burden}%`, dr: burdenAmt, cr: 0 },
    { acct: "2210", name: "Accrued commissions payable", dr: 0, cr: t.earned },
    { acct: "2215", name: "Accrued payroll taxes", dr: 0, cr: burdenAmt },
  ].filter((r) => r.dr > 0.004 || r.cr > 0.004);
  const je2 = t.amortExpense > 0.004
    ? [{ acct: "6100", name: "Commission expense — amortisation", dr: t.amortExpense, cr: 0 },
       { acct: "1450", name: "Deferred commission cost", dr: 0, cr: t.amortExpense }]
    : [];
  const drTot = je.reduce((s, r) => s + r.dr, 0);
  const crTot = je.reduce((s, r) => s + r.cr, 0);

  const canPost = user.role === "finance";
  const blockers = calc.lines.filter((l) => (!l.approved && !l.unpriced && !l.derived) || l.unpriced).length;

  const post = markPosted;
  const close = closePeriod;
  const reopen = reopenPeriod;

  return (
    <>
      <div className="masthead">
        <div className="mfigs">
          <div className="mfig"><div className="k">Earned this period</div><div className="v">{usd2(t.earned)}</div><div className="s">payable to participants</div></div>
          <div className="mfig blue"><div className="k">Capitalised</div><div className="v">{usd2(t.capitalised)}</div><div className="s">to contract asset 1450</div></div>
          <div className="mfig"><div className="k">Amortisation</div><div className="v">{usd2(t.amortExpense)}</div><div className="s">{CUSTOMER_LIFE_MONTHS}-month customer life</div></div>
          <div className="mfig"><div className="k">Expensed as earned</div><div className="v">{usd2(t.expensed)}</div><div className="s">revenue component</div></div>
          <div className="mfig accent"><div className="k">Deferred asset at close</div><div className="v">{usd2(t.deferredClose)}</div>
            <div className="s">{periods[period].posted ? "Posted to GL" : "Not yet posted"}</div></div>
        </div>
      </div>

      <div className="grid2">
        <div>
          <div className="panel">
            <div className="phead">
              <h3>Journal · JE-{period}-CM</h3>
              <span className="note">{Math.abs(drTot - crTot) < 0.005 ? "In balance" : "Out of balance"}</span>
            </div>
            {je.length === 0 ? (
              <div className="empty"><b>Nothing earned this period</b>No commission was earned in {MONTHS[period]}, so there is no accrual entry. Amortisation still posts below.</div>
            ) : (
              <table className="led je">
                <thead><tr><th>Account</th><th>Description</th><th className="n">Debit</th><th className="n">Credit</th></tr></thead>
                <tbody>
                  {je.map((r, i) => (
                    <tr key={i}>
                      <td className="n" style={{ textAlign: "left" }}>{r.acct}</td><td>{r.name}</td>
                      <td className="n">{r.dr ? usd2(r.dr) : ""}</td><td className="n">{r.cr ? usd2(r.cr) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2}>Totals</td><td className="n">{usd2(drTot)}</td><td className="n">{usd2(crTot)}</td></tr></tfoot>
              </table>
            )}

            {je2.length > 0 && (
              <>
                <div className="phead" style={{ borderTop: "1px solid var(--rule)" }}>
                  <h3>Journal · JE-{period}-AM</h3><span className="note">monthly amortisation</span>
                </div>
                <table className="led je">
                  <tbody>
                    {je2.map((r, i) => (
                      <tr key={i}>
                        <td className="n" style={{ textAlign: "left", width: 70 }}>{r.acct}</td><td>{r.name}</td>
                        <td className="n" style={{ width: 105 }}>{r.dr ? usd2(r.dr) : ""}</td>
                        <td className="n" style={{ width: 105 }}>{r.cr ? usd2(r.cr) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            <div className="pbody" style={{ borderTop: "1px solid var(--rule)" }}>
              <div className="toolbar">
                <button className="btn primary" disabled={!canPost || periods[period].posted} onClick={post}>
                  {periods[period].posted ? "Posted" : "Post to GL"}
                </button>
                <button className="btn" onClick={() => exportCSV(`JE-${period}.csv`,
                  [["Journal", "Account", "Description", "Debit", "Credit", "Period"]]
                    .concat(je.map((r) => [`JE-${period}-CM`, r.acct, r.name, r.dr.toFixed(2), r.cr.toFixed(2), period]))
                    .concat(je2.map((r) => [`JE-${period}-AM`, r.acct, r.name, r.dr.toFixed(2), r.cr.toFixed(2), period])))}>
                  Export journals
                </button>
                <label className="mini" style={{ marginLeft: "auto" }}>Burden %{" "}
                  <input className="inp n" style={{ width: 64 }} type="number" step="0.05" value={burden}
                    onChange={(e) => setBurden(parseFloat(e.target.value) || 0)} disabled={locked} />
                </label>
              </div>
              {!canPost && <div className="mini" style={{ marginTop: 8 }}>Only the Finance Admin can post journals.</div>}
              <div className="mini" style={{ marginTop: 8 }}>
                The burden rate is an assumption, not something the rate table carries. Set it to zero to leave employer taxes out.
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="phead"><h3>Deferred commission cost — rollforward</h3></div>
            <div className="pbody">
              <div className="kv"><span className="k">Opening balance</span><span className="n">{usd2(priorClose)}</span></div>
              <div className="kv"><span className="k">Additions — commission capitalised</span><span className="n">{usd2(t.capitalised)}</span></div>
              <div className="kv"><span className="k">Amortisation to expense</span><span className="n">{usd2(-t.amortExpense)}</span></div>
              <div className="kv" style={{ borderTop: "1px solid var(--ink)", borderBottom: "3px double var(--ink)", fontWeight: 600, paddingTop: 6 }}>
                <span>Closing balance</span><span className="n">{usd2(priorClose + t.capitalised - t.amortExpense)}</span>
              </div>
              <div className="mini" style={{ marginTop: 10 }}>
                Capitalised commission amortises straight-line over a {CUSTOMER_LIFE_MONTHS}-month average customer life,
                beginning in the month the agreement was signed. The revenue component is expensed as earned and never
                touches the contract asset.
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="phead">
              <h3>Amortisation schedule</h3>
              <span className="note">{calc.amort.length} capitalised line{calc.amort.length === 1 ? "" : "s"}</span>
              {calc.amort.length > 0 && (
                <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() =>
                  exportCSV(`amortisation-${period}.csv`,
                    [["Line", "Client", "Agreement", "Signed", "Capitalised", "Life (months)", "Per month", "This period", "Taken to date", "Remaining"]]
                      .concat(calc.amort.map((a) => [a.line.id, a.line.client, a.line.agreement, a.line.period,
                        a.line.commission.toFixed(2), CUSTOMER_LIFE_MONTHS, a.monthly.toFixed(2),
                        a.thisPeriod.toFixed(2), a.toDate.toFixed(2), Math.max(a.remaining, 0).toFixed(2)])))}>
                  Export schedule
                </button>
              )}
            </div>
            <div className="scroll">
              <table className="led">
                <thead><tr><th>Line</th><th>Client</th><th>Signed</th><th className="n">Capitalised</th>
                  <th className="n">Per month</th><th className="n">This period</th><th className="n">Taken to date</th><th className="n">Remaining</th></tr></thead>
                <tbody>
                  {calc.amort.map((a) => (
                    <tr key={a.line.key}>
                      <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{a.line.id}</td>
                      <td>{a.line.client} <span className="mini">{a.line.agreement}</span></td>
                      <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{MSHORT[a.line.period]}</td>
                      <td className="n">{usd2(a.line.commission)}</td>
                      <td className="n">{usd2(a.monthly)}</td>
                      <td className="n">{usd2(a.thisPeriod)}</td>
                      <td className="n">{usd2(a.toDate)}</td>
                      <td className="n">{usd2(Math.max(a.remaining, 0))}</td>
                    </tr>
                  ))}
                </tbody>
                {calc.amort.length > 0 && (
                  <tfoot><tr>
                    <td colSpan={3}>Total</td>
                    <td className="n">{usd2(calc.amort.reduce((s, a) => s + a.line.commission, 0))}</td>
                    <td className="n">{usd2(calc.amort.reduce((s, a) => s + a.monthly, 0))}</td>
                    <td className="n">{usd2(calc.amort.reduce((s, a) => s + a.thisPeriod, 0))}</td>
                    <td className="n">{usd2(calc.amort.reduce((s, a) => s + a.toDate, 0))}</td>
                    <td className="n">{usd2(calc.amort.reduce((s, a) => s + Math.max(a.remaining, 0), 0))}</td>
                  </tr></tfoot>
                )}
              </table>
              {calc.amort.length === 0 && (
                <div className="empty"><b>Nothing capitalised yet</b>Capitalised commission appears here from the month it is earned.</div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="phead"><h3>Period control</h3></div>
            <div className="pbody">
              <div className="kv"><span className="k">Status</span><span>{periods[period].status}</span></div>
              <div className="kv"><span className="k">Journals posted</span><span>{periods[period].posted ? "Yes" : "No"}</span></div>
              <div className="kv"><span className="k">Lines blocking close</span><span className="n">{blockers}</span></div>
              <div className="kv"><span className="k">Payment released</span><span>{periods[period].paidOn || "—"}</span></div>
              <div className="toolbar" style={{ marginTop: 12 }}>
                {!locked
                  ? <button className="btn ink" disabled={blockers > 0 || !periods[period].posted || !canPost} onClick={close}>Close period</button>
                  : <button className="btn" disabled={!canPost} onClick={reopen}>Reopen period</button>}
              </div>
              {!locked && blockers > 0 && (
                <div className="mini" style={{ marginTop: 8 }}>{blockers} line{blockers === 1 ? "" : "s"} still unapproved or unpriced.</div>
              )}
              {!locked && blockers === 0 && !periods[period].posted && (
                <div className="mini" style={{ marginTop: 8 }}>Post the journals before closing.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================================
   PLANS & RATES
   ========================================================================== */
function Plans({ components, user, locked, calc, people, saveRate, overrides }) {
  const [editing, setEditing] = useState(null);
  const editable = user.role === "finance" && !locked;
  const grouped = people.map((p) => ({ person: p, comps: components.filter((c) => c.repId === p.id) }));

  return (
    <>
      {!editable && (
        <div className="warnbox">
          {locked ? "This period is locked, so the rate table is read-only."
            : `Rates are maintained by the Finance Admin. You are signed in as ${user.title}.`}
        </div>
      )}

      <div className="panel">
        <div className="phead">
          <h3>Plan policy</h3>
          <span className="srcnote">source: Commission_Rate_Tables.xlsx · sheet “Comp Rates”</span>
        </div>
        <div className="pbody">
          <div className="kv"><span className="k">Attainment measurement</span>
            <span>Year to date, each component against its own target</span></div>
          <div className="kv"><span className="k">Accelerator</span>
            <span>{ACCEL_MULTIPLIER}× base rate on bookings after target is reached — never retroactive</span></div>
          <div className="kv"><span className="k">Capitalised components</span>
            <span>Straight-line over {CUSTOMER_LIFE_MONTHS} months average customer life, from the month signed</span></div>
          <div className="kv"><span className="k">Revenue attribution</span>
            <span>By client ownership — the rep who signed the earliest agreement with that client</span></div>
          <div className="kv"><span className="k">Separation of duties</span>
            <span>Manager approves at stage 1, Finance Admin at stage 2 and posts the journals</span></div>
        </div>
      </div>

      {editing && (
        <ReviseRate comp={editing.comp} rate={editing.rate}
          onClose={() => setEditing(null)} onSave={saveRate} />
      )}

      {grouped.map(({ person: p, comps }) => (
        <div className="panel" key={p.id}>
          <div className="phead">
            <h3>{p.name}</h3>
            <span className="chip ghost">{p.role}</span>
            <span className="note">reports to {p.manager || "—"}</span>
            {comps.length > 0 && (
              <span className="note" style={{ marginLeft: "auto" }}>
                target bookings {usd(comps.reduce((s, c) => s + c.target, 0))} · target compensation {usd2(comps.reduce((s, c) => s + c.targetComp, 0))}
              </span>
            )}
          </div>
          {comps.length === 0 ? (
            <div className="empty">
              <b>No rate table on file</b>
              {p.role === "Finance Admin"
                ? "Finance Admin is not a commission-carrying role on the Comp Rates sheet."
                : p.role === "Manager"
                ? "Listed as a Manager with no override component. Add target and rate rows to pay an override on team performance."
                : `Listed with a manager and role, but no targets or rates. Bookings for ${p.name} cannot be priced until those rows arrive.`}
            </div>
          ) : (
            <div className="scroll">
              <table className="led">
                <thead>
                  <tr><th>Component</th><th className="n">Target bookings</th><th className="n">Target comp</th>
                    <th>Basis</th><th className="n">Rate in force</th><th className="n">Above target</th>
                    <th>Accounting</th><th className="n">YTD attainment</th></tr>
                </thead>
                <tbody>
                  {comps.map((c) => {
                    const a = calc.attain.find((x) => x.component.id === c.id);
                    const logos = Array.from(new Set(c.rates.map((r) => r.logo)));
                    const current = logos.map((lg) =>
                      rateHistory(c).filter((x) => x.logo === lg)[0]).filter(Boolean);
                    return current.map((r, ri) => (
                      <tr key={c.id + ri}>
                        {ri === 0 && (
                          <td rowSpan={c.rates.length}>
                            <TypeTag t={c.type} />
                            {c.fromRevenueFile && <div className="mini" style={{ marginTop: 4 }}>Driven by the monthly revenue file</div>}
                            {c.note && <div className="mini" style={{ marginTop: 4 }}>{c.note}</div>}
                          </td>
                        )}
                        {ri === 0 && <td rowSpan={current.length} className="n">{usd(c.target)}</td>}
                        {ri === 0 && <td rowSpan={current.length} className="n">{usd2(c.targetComp)}</td>}
                        <td className="mini">{r.label}</td>
                        <td className="n">
                          <input className="inp n" style={{ width: 72 }} type="number" step="0.005" min="0" max="1"
                            defaultValue={r.rate} disabled={!editable}
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value);
                              if (isNaN(v) || v === r.rate) return;
                              saveRate(c, r, v);
                            }} />
                          <div className="mini">{rateStr(r.rate)}</div>
                        </td>
                        <td className="n">{rateStr(r.rate * ACCEL_MULTIPLIER)}
                          <div className="mini">{ACCEL_MULTIPLIER}× base</div></td>
                        {ri === 0 && (
                          <td rowSpan={current.length}>
                            <span className={"chip " + (c.accounting === "Capitalize" ? "cap" : "exp")}>{c.accounting}</span>
                          </td>
                        )}
                        {ri === 0 && <td rowSpan={current.length} className="n">{a ? pct(a.attainment) : "—"}</td>}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
              {comps.some((c) => c.rates.length > new Set(c.rates.map((r) => r.logo)).size) && (
                <div className="pbody" style={{ borderTop: "1px solid var(--rule)" }}>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Rate history</div>
                  <table className="led">
                    <thead><tr><th>Component</th><th>Basis</th><th>Effective from</th><th className="n">Rate</th></tr></thead>
                    <tbody>
                      {comps.flatMap((c) => rateHistory(c).map((r, i) => (
                        <tr key={c.id + r.logo + r.from + i}>
                          <td className="mini">{c.type}</td>
                          <td className="mini">{r.label}</td>
                          <td className="n" style={{ textAlign: "left" }}>{r.from}</td>
                          <td className="n">{rateStr(r.rate)}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                  <div className="mini" style={{ marginTop: 8 }}>
                    A booking is priced at the version in force on the date it was signed, so revising a
                    rate never changes what an earlier period already paid.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function ReviseRate({ comp, rate, onClose, onSave }) {
  const [val, setVal] = useState(rate.rate);
  const [from, setFrom] = useState("2026-04-01");
  const [why, setWhy] = useState("");
  const bad = isNaN(Number(val)) || Number(val) <= 0 || Number(val) > 1;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" style={{ width: "min(430px,94vw)" }}>
        <div className="dhead">
          <div>
            <h3>Revise rate</h3>
            <div className="mini">{comp.type} · {rate.label}</div>
          </div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dbody">
          <p style={{ marginTop: 0, fontSize: 12.5 }}>
            This adds a new version rather than replacing the old one. Bookings signed before the date
            below keep the rate they were priced at, so closed periods are untouched.
          </p>
          <div className="kv"><span className="k">Current rate</span><span className="n">{rateStr(rate.rate)} from {rate.from}</span></div>
          <label className="eyebrow" htmlFor="nr" style={{ display: "block", marginTop: 12 }}>New rate</label>
          <input id="nr" className="inp n" style={{ width: 110 }} type="number" step="0.005" min="0" max="1"
            value={val} onChange={(e) => setVal(e.target.value)} />
          <span className="mini"> {!bad && rateStr(Number(val))}</span>
          <label className="eyebrow" htmlFor="ef" style={{ display: "block", marginTop: 12 }}>Effective from</label>
          <input id="ef" className="inp" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label className="eyebrow" htmlFor="wy" style={{ display: "block", marginTop: 12 }}>Reason (optional)</label>
          <input id="wy" className="inp" style={{ width: "100%" }} value={why}
            placeholder="e.g. comp committee memo CC-11"
            onChange={(e) => setWhy(e.target.value)} />
          <div className="toolbar" style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={bad}
              onClick={() => { onSave(comp, rate, Number(val), from, why); onClose(); }}>
              Add version
            </button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
          {bad && <div className="mini" style={{ marginTop: 8, color: "var(--red)" }}>Enter a rate between 0 and 1 (0.03 for 3%).</div>}
        </div>
      </div>
    </>
  );
}

/* ============================================================================
   AUDIT
   ========================================================================== */
function AuditTrail({ audit, exportCSV, period }) {
  const [q, setQ] = useState("");
  const [fActor, setFActor] = useState("all");
  const actors = Array.from(new Set(audit.map((a) => a.actor)));
  const rows = audit.filter((a) => {
    if (fActor !== "all" && a.actor !== fActor) return false;
    if (q && !`${a.entity} ${a.detail} ${a.action}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  return (
    <div className="panel">
      <div className="phead"><h3>Audit trail</h3><span className="note">{rows.length} of {audit.length} events</span></div>
      <div className="pbody" style={{ borderBottom: "1px solid var(--rule)" }}>
        <div className="toolbar">
          <input className="inp" style={{ width: 235 }} placeholder="Search entity, action or detail"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="inp" value={fActor} onChange={(e) => setFActor(e.target.value)}>
            <option value="all">Any actor</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button className="btn sm" onClick={() => { setQ(""); setFActor("all"); }}>Clear</button>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() =>
            exportCSV(`audit-log.csv`, [["Timestamp", "Actor", "Role", "Action", "Entity", "Detail"]]
              .concat(rows.map((a) => [a.ts, a.actor, a.role, a.action, a.entity, a.detail])))}>
            Export log
          </button>
        </div>
      </div>
      <div className="scroll">
        <table className="led">
          <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="n" style={{ textAlign: "left", fontSize: 11, whiteSpace: "nowrap" }}>{a.ts}</td>
                <td><div>{a.actor}</div><div className="mini">{a.role}</div></td>
                <td><span className="tag">{a.action}</span></td>
                <td className="n" style={{ textAlign: "left", fontSize: 11 }}>{a.entity}</td>
                <td className="mini" style={{ color: "var(--ink2)" }}>{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty"><b>No events match</b>Clear the filters to see the full log.</div>}
      </div>
    </div>
  );
}

/* ============================================================================
   DRAWER
   ========================================================================== */
function Drawer({ drawer, calc, engine, setDrawer, period, canStage1, canStage2, setApproval, user }) {
  const close = () => setDrawer(null);
  useEffect(() => {
    const h = (e) => e.key === "Escape" && setDrawer(null);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setDrawer]);

  if (drawer.type === "rep") {
    const s = calc.summary.find((x) => x.person.id === drawer.id);
    if (!s) return null;
    return (
      <>
        <div className="scrim" onClick={close} />
        <div className="drawer" role="dialog" aria-label={`${s.person.name} detail`}>
          <div className="dhead">
            <div><h3>{s.person.name}</h3><div className="mini">{s.person.role} · reports to {s.person.manager}</div></div>
            <button className="x" onClick={close} aria-label="Close">×</button>
          </div>
          <div className="dbody">
            <div className="panel"><div className="pbody">
              <div className="kv"><span className="k">Target bookings</span><span className="n">{usd(s.attain.reduce((a, x) => a + x.target, 0))}</span></div>
              <div className="kv"><span className="k">Target compensation</span><span className="n">{usd2(s.targetComp)}</span></div>
              <div className="kv"><span className="k">Volume this period</span><span className="n">{usd(s.volume)}</span></div>
              <div className="kv"><span className="k">Earned this period</span><span className="n">{usd2(s.earned)}</span></div>
              <div className="kv"><span className="k">Capitalised / expensed</span><span className="n">{usd2(s.capitalised)} / {usd2(s.expensed)}</span></div>
            </div></div>
            <div className="eyebrow" style={{ margin: "14px 0 6px" }}>Components — year to date</div>
            {s.attain.map((a) => (
              <div key={a.component.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
                <div style={{ width: 145, fontSize: 12 }}>{a.component.type}</div>
                <div style={{ flex: 1 }}><AttBar v={a.attainment} /></div>
                <div className="n" style={{ width: 80, fontSize: 11.5 }}>{usd2(a.commission)}</div>
              </div>
            ))}
            <div className="eyebrow" style={{ margin: "16px 0 6px" }}>Lines in {MONTHS[period]}</div>
            {s.lines.length === 0 ? <div className="mini">No activity this period.</div> : (
              <table className="led"><tbody>
                {s.lines.map((l) => (
                  <tr key={l.key} className="click" onClick={() => setDrawer({ type: "line", id: l.key })}>
                    <td className="n" style={{ textAlign: "left", fontSize: 11, width: 62 }}>{l.id}</td>
                    <td>{l.client}</td>
                    <td style={{ width: 155 }}><TypeTag t={l.type} /></td>
                    <td className="n" style={{ width: 88, fontWeight: 600 }}>{usd2(l.commission)}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        </div>
      </>
    );
  }

  if (drawer.type === "component") {
    const a = calc.attain.find((x) => x.component.id === drawer.id);
    if (!a) return null;
    const lines = [];
    PERIODS.slice(0, PERIODS.indexOf(period) + 1).forEach((p) =>
      engine.results[p].lines.filter((l) => l.componentId === a.component.id).forEach((l) => lines.push(l)));
    return (
      <>
        <div className="scrim" onClick={close} />
        <div className="drawer" role="dialog" aria-label={`${a.component.type} detail`}>
          <div className="dhead">
            <div><h3>{a.component.type}</h3><div className="mini">{a.rep.name} · {a.component.accounting}</div></div>
            <button className="x" onClick={close} aria-label="Close">×</button>
          </div>
          <div className="dbody">
            <div className="panel"><div className="pbody">
              <div className="kv"><span className="k">Target bookings</span><span className="n">{usd(a.target)}</span></div>
              <div className="kv"><span className="k">Target compensation</span><span className="n">{usd2(a.component.targetComp)}</span></div>
              {a.component.rates.map((r) => (
                <div className="kv" key={r.label}><span className="k">{r.label}</span>
                  <span className="n">{rateStr(r.rate)} → {rateStr(r.rate * ACCEL_MULTIPLIER)} above target</span></div>
              ))}
              <div className="kv"><span className="k">Year-to-date volume</span><span className="n">{usd(a.volume)}</span></div>
              <div className="kv"><span className="k">Attainment</span><span className="n">{pct(a.attainment)}</span></div>
              <div className="kv"><span className="k">Remaining to accelerator</span>
                <span className="n">{a.component.isOverride ? "no accelerator on an override"
                  : a.accelerated ? "target reached" : usd(a.headroom)}</span></div>
              <div className="kv"><span className="k">Commission earned YTD</span><span className="n">{usd2(a.commission)}</span></div>
            </div></div>
            <div style={{ margin: "12px 0" }}><AttBar v={a.attainment} /></div>
            <p className="mini">
              {a.component.isOverride
                ? `A manager override pays ${pct(a.component.share, 0)} of what the reports earned at base rates on this component. Managers earn no accelerator, so any uplift the reps earned is excluded before the share is taken. The target shown is the reports' combined target and drives the attainment figure only.`
                : `The accelerator lifts the rate to ${ACCEL_MULTIPLIER}× on volume recorded after the ${usd(a.target)} target is reached. Anything already credited at the base rate stays at the base rate, so a single deal that crosses the target is split — the portion up to target at base, the remainder accelerated.`}
            </p>
            <div className="eyebrow" style={{ margin: "14px 0 6px" }}>Contributing lines</div>
            {lines.length === 0 ? <div className="mini">No activity against this component yet.</div> : (
              <table className="led"><tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="click" onClick={() => setDrawer({ type: "line", id: l.key })}>
                    <td className="n" style={{ textAlign: "left", fontSize: 11, width: 62 }}>{l.id}</td>
                    <td className="mini" style={{ width: 38 }}>{MSHORT[l.period]}</td>
                    <td>{l.client}</td>
                    <td className="n" style={{ width: 82 }}>{usd(l.amount)}</td>
                    <td className="n" style={{ width: 88, fontWeight: 600 }}>{usd2(l.commission)}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        </div>
      </>
    );
  }

  const l = calc.lines.find((x) => x.key === drawer.id);
  if (!l || l.unpriced) return null;
  const amort = calc.amort.find((x) => x.line.key === l.key);
  const tm = termMonths(l.term);

  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="drawer" role="dialog" aria-label={`Calculation for ${l.id}`}>
        <div className="dhead">
          <div>
            <h3>{l.client}</h3>
            <div className="mini">{l.id} · {l.repName} · {l.agreement} · {shortDate(l.date)}</div>
          </div>
          <button className="x" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="dbody">
          <div className="toolbar" style={{ marginBottom: 14 }}>
            <TypeTag t={l.type} />
            <ApprovalChip l={l} />
            <span className={"chip " + (l.accounting === "Capitalize" ? "cap" : "exp")}>{l.accounting}</span>
          </div>

          <Tape line={l} />

          <div className="panel" style={{ marginTop: 18 }}>
            <div className="phead"><h3>How this line was priced</h3></div>
            <div className="pbody">
              <p style={{ marginTop: 0, fontSize: 12.5 }}>
                {l.derived
                  ? <>Manager override on {l.type}. The reports earned {usd2(l.repsEarned)} on this component, of which{" "}
                      {usd2(l.upliftExcluded)} was accelerator uplift. Managers earn no accelerator, so the uplift is
                      removed and the {pct(l.share, 0)} share is taken on the {usd2(l.repsBase)} base-rate figure. It is
                      derived from the reports&apos; approved lines rather than approved in its own right.</>
                  : l.kind === "revenue"
                  ? <>Recognised revenue for {l.client} in {MONTHS[l.period]}. The revenue file carries no rep column, so it is
                      attributed by {l.attributedVia}. The Revenue component is expensed as earned rather than capitalised.</>
                  : <>{l.existing === "No" ? "New logo" : l.existing === "Yes" ? "Existing logo" : "This"} booking, priced at the{" "}
                      {l.type} rate for {l.repName}. Attainment against the {usd(l.component.target)} target is measured year
                      to date, and the {ACCEL_MULTIPLIER}× accelerator applies only to volume booked after the target is reached.</>}
              </p>
              {l.derived && (
                <>
                  <div className="kv"><span className="k">Reports earned</span><span className="n">{usd2(l.repsEarned)}</span></div>
                  <div className="kv"><span className="k">Accelerator uplift excluded</span><span className="n">{usd2(-l.upliftExcluded)}</span></div>
                  <div className="kv"><span className="k">Base-rate commission</span><span className="n">{usd2(l.repsBase)}</span></div>
                  <div className="kv"><span className="k">Override share</span><span className="n">{pct(l.share, 0)}</span></div>
                </>
              )}
              <div className="kv"><span className="k">Component target</span><span className="n">{usd(l.component.target)}</span></div>
              <div className="kv"><span className="k">Position before this line</span>
                <span className="n">{usd(l.attainBefore)} · {pct(l.attainBefore / l.component.target)}</span></div>
              <div className="kv"><span className="k">Position after</span>
                <span className="n">{usd(l.attainAfter)} · {pct(l.attainAfter / l.component.target)}</span></div>
              <div className="kv"><span className="k">Rate applied</span>
                <span className="n">{rateStr(l.baseRate)} — {l.rateLabel}</span></div>
              <div className="kv"><span className="k">Accounting treatment</span><span>{l.accounting}</span></div>
              {l.term && <div className="kv"><span className="k">Contract term on the booking</span><span>{l.term} ({tm} months)</span></div>}
              {amort && (
                <>
                  <div className="kv"><span className="k">Amortised over</span>
                    <span>{CUSTOMER_LIFE_MONTHS} months from {MONTHS[l.period]}</span></div>
                  <div className="kv"><span className="k">Monthly amortisation</span><span className="n">{usd2(amort.monthly)}</span></div>
                  <div className="kv"><span className="k">Taken to date</span><span className="n">{usd2(amort.toDate)}</span></div>
                  <div className="kv"><span className="k">Remaining on the balance sheet</span>
                    <span className="n">{usd2(Math.max(amort.remaining, 0))}</span></div>
                </>
              )}
              <div className="kv"><span className="k">Stage 1 — manager</span><span>{l.s1}</span></div>
              <div className="kv"><span className="k">Stage 2 — finance</span><span>{l.s2}</span></div>
            </div>
          </div>

          {l.accounting === "Capitalize" && tm && tm !== CUSTOMER_LIFE_MONTHS && (
            <div className="warnbox" style={{ marginTop: 14 }}>
              The agreement runs {l.term}, but the commission amortises over {CUSTOMER_LIFE_MONTHS} months because policy uses
              average customer life rather than the contract term. Change the policy if a short SOW should amortise over its own term instead.
            </div>
          )}

          {(canStage1(l) || canStage2(l)) && !l.approved && (
            <div className="toolbar" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => { setApproval(l, canStage1(l) ? "s1" : "s2", "Approved"); close(); }}>
                Approve as {user.name}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* --- calculation tape --- */
function Tape({ line }) {
  return (
    <div className="tape">
      <div className="edge top" />
      <div className="inner">
        <div className="th">CALCULATION TAPE · {line.id}</div>
        <div className="row"><div className="l">{line.repName}
          <small>{line.type} · target {usd(line.component.target)}</small></div></div>
        <div className="row">
          <div className="l">Attainment after this line<small>year to date</small></div>
          <div className="r">{pct(line.attainAfter / line.component.target)}</div>
        </div>
        <div className="sep" />
        <div className="row">
          <div className="l">{line.kind === "revenue" ? "Recognised revenue" : "Booking amount"}
            <small>{line.client} · {line.agreement}</small></div>
          <div className="r">{usd(line.amount)}</div>
        </div>
        <div className="row">
          <div className="l">Position on arrival<small>{pct(line.attainBefore / line.component.target)} of target</small></div>
          <div className="r">{usd(line.attainBefore)}</div>
        </div>
        <div className="sep" />
        {line.derived && line.upliftExcluded > 0.005 && (
          <>
            <div className="row"><div className="l">Reports earned<small>including their accelerators</small></div>
              <div className="r">{usd2(line.repsEarned)}</div></div>
            <div className="row"><div className="l">Less accelerator uplift<small>stays with the rep who booked it</small></div>
              <div className="r">{usd2(-line.upliftExcluded)}</div></div>
            <div className="sep" />
          </>
        )}
        {line.segments.map((g, i) => (
          <div className={"row" + (g.accelerated ? " accel" : "")} key={i}>
            <div className="l">{g.label}<small>{usd(g.base)} @ {rateStr(g.rate / 100)}</small></div>
            <div className="r">{usd2(g.amount)}</div>
          </div>
        ))}
        <div className="tot"><span>TOTAL</span><span>{usd2(line.commission)}</span></div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="l">{line.accounting === "Capitalize" ? "To contract asset" : "To expense"}
            <small>{line.accounting === "Capitalize"
              ? `${CUSTOMER_LIFE_MONTHS} months from ${MSHORT[line.period]}`
              : "expensed as earned"}</small></div>
          <div className="r">{line.accounting === "Capitalize"
            ? usd2(line.commission / CUSTOMER_LIFE_MONTHS) + "/mo"
            : usd2(line.commission)}</div>
        </div>
        <div className="stampbox">
          {line.approved
            ? <span className="redstamp" style={{ borderColor: "#1E6B48", color: "#1E6B48" }}>APPROVED</span>
            : <span className="redstamp pend">PENDING</span>}
        </div>
        <div className="th" style={{ paddingTop: 10 }}>{NOW}</div>
      </div>
      <div className="edge" />
    </div>
  );
}

/* ============================================================================
   IMPORT — drop a spreadsheet in, check what it will do, then commit
   ========================================================================== */

/* Headers vary between exports, so match on a normalised form rather than
   demanding an exact string. */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const BOOKING_FIELDS = [
  { key: "deal_id",   label: "Deal ID",        aliases: ["dealid", "deal", "id", "dealnumber"], required: true },
  { key: "rep",       label: "Rep",            aliases: ["rep", "salesrep", "salesrepname", "owner", "ae"], required: true },
  { key: "date",      label: "Date Signed",    aliases: ["datesigned", "date", "signeddate", "bookingdate", "closedate"], required: true },
  { key: "client",    label: "Client",         aliases: ["client", "customer", "account", "customername"], required: true },
  { key: "agreement", label: "Agreement",      aliases: ["agreement", "contract", "document", "paper"], required: false },
  { key: "existing",  label: "Existing (Y/N)", aliases: ["existingyn", "existing", "existinglogo", "existingcustomer"], required: false },
  { key: "term",      label: "Term",           aliases: ["term", "contractterm", "length"], required: false },
  { key: "type",      label: "Booking Type",   aliases: ["bookingtype", "type", "commissiontype", "salestype"], required: true },
  { key: "amount",    label: "Booking Amount", aliases: ["bookingamount", "amount", "value", "acv", "tcv", "bookings"], required: true },
];

const RATE_FIELDS = [
  { key: "rep",         label: "Sales Rep Name",     aliases: ["salesrepname", "rep", "salesrep", "name", "person"], required: true },
  { key: "manager",     label: "Manager",            aliases: ["manager", "reportsto", "managername"], required: false },
  { key: "role",        label: "Role",               aliases: ["role", "title", "position"], required: false },
  { key: "target",      label: "Target Bookings",    aliases: ["targetbookings", "target", "quota", "targetbooking"], required: true },
  { key: "target_comp", label: "Target Compensation",aliases: ["targetcompensation", "targetcomp", "ote", "variable"], required: false },
  { key: "type",        label: "Commission Type",    aliases: ["commissiontype", "type", "salestype", "component"], required: true },
  { key: "logo",        label: "Existing Logo?",     aliases: ["existinglogo", "existinglogo2", "existing", "logo", "existingyn"], required: false },
  { key: "rate",        label: "Rate",               aliases: ["rate", "commissionrate", "percent"], required: true },
  { key: "accounting",  label: "Accounting",         aliases: ["accounting", "treatment", "accountingtreatment"], required: false },
];

const REVENUE_FIELDS = [
  { key: "period", label: "Period",  aliases: ["period", "month", "revenueperiod", "date"], required: true },
  { key: "client", label: "Client",  aliases: ["client", "customer", "account", "customername"], required: true },
  { key: "amount", label: "Revenue", aliases: ["revenue", "amount", "recognisedrevenue", "recognizedrevenue", "value"], required: true },
];

/* Excel serial dates come through as numbers; turn everything into YYYY-MM-DD. */
function toISO(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? s : d.toISOString().slice(0, 10);
}

/* Find the header row: the first row matching two or more known column names. */
function findHeaderRow(grid, fields) {
  const all = fields.flatMap((f) => f.aliases);
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const hits = (grid[i] || []).filter((c) => all.includes(norm(c))).length;
    if (hits >= 2) return i;
  }
  return -1;
}

function autoMap(headers, fields) {
  const m = {};
  fields.forEach((f) => {
    const idx = headers.findIndex((h) => f.aliases.includes(norm(h)));
    if (idx >= 0) m[f.key] = idx;
  });
  return m;
}

function Import({ user, refresh, setToast, people, components, periods }) {
  const [kind, setKind] = useState("bookings");
  const [file, setFile] = useState(null);
  const [headers, setHeaders] = useState(null);
  const [grid, setGrid] = useState(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState({});
  const [sheetNames, setSheetNames] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [wb, setWb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [parseErr, setParseErr] = useState(null);
  const [effective, setEffective] = useState("2026-01-01");

  const fields = kind === "bookings" ? BOOKING_FIELDS : kind === "rates" ? RATE_FIELDS : REVENUE_FIELDS;
  const fieldsFor = (k) => (k === "bookings" ? BOOKING_FIELDS : k === "rates" ? RATE_FIELDS : REVENUE_FIELDS);
  const isFinance = user.role === "finance";

  const readSheet = (workbook, name, k) => {
    const g = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: "" });
    const f = k === "bookings" ? BOOKING_FIELDS : k === "rates" ? RATE_FIELDS : REVENUE_FIELDS;
    const hr = findHeaderRow(g, f);
    if (hr < 0) {
      setGrid(g); setHeaders(null); setHeaderRow(0); setMap({});
      setParseErr(`No header row found on “${name}”. Expected columns like ${f.filter((x) => x.required).map((x) => x.label).join(", ")}.`);
      return;
    }
    const hdr = (g[hr] || []).map((h) => String(h));
    setGrid(g); setHeaderRow(hr); setHeaders(hdr); setMap(autoMap(hdr, f)); setParseErr(null);
  };

  const onFile = async (f) => {
    if (!f) return;
    setFile(f); setResult(null); setParseErr(null);
    try {
      const buf = await f.arrayBuffer();
      const workbook = window.XLSX.read(buf, { cellDates: true });
      setWb(workbook);
      setSheetNames(workbook.SheetNames);
      const guess = workbook.SheetNames.find((n) => /revenue/i.test(n) && kind === "revenue")
        || workbook.SheetNames.find((n) => /booking/i.test(n) && kind === "bookings")
        || workbook.SheetNames.find((n) => /rate|comp/i.test(n) && kind === "rates")
        || workbook.SheetNames[0];
      setSheet(guess);
      readSheet(workbook, guess, kind);
    } catch (e) {
      setParseErr("That file could not be read. Excel (.xlsx) and CSV are supported.");
    }
  };

  /* Build the rows the database will see, using the current mapping.
     On the rate sheet a merged target and a repeated rep name leave later
     cells blank, so those carry down from the row above. The rep name resets
     the carry, since a new rep starts a new block. */
  const rows = useMemo(() => {
    if (!grid || !headers) return [];
    const out = [];
    const carry = {};
    const CARRY_KEYS = ["rep", "manager", "role", "target", "target_comp"];
    for (let i = headerRow + 1; i < grid.length; i++) {
      const r = grid[i] || [];
      if (r.every((c) => c === "" || c == null)) continue;
      const o = {};
      fields.forEach((f) => {
        const idx = map[f.key];
        let v = idx == null ? "" : r[idx];
        if (f.key === "date" || (kind === "revenue" && f.key === "period")) v = toISO(v);
        else if (v instanceof Date) v = toISO(v);
        else v = v == null ? "" : String(v).trim();
        o[f.key] = v;
      });
      if (kind === "rates") {
        if (o.rep !== "") CARRY_KEYS.forEach((k) => { delete carry[k]; });
        CARRY_KEYS.forEach((k) => {
          if (o[k] === "" && carry[k] != null) o[k] = carry[k];
          else if (o[k] !== "") carry[k] = o[k];
        });
      }
      const req = fields.filter((f) => f.required).map((f) => o[f.key]);
      if (req.every((v) => v === "")) continue;
      if (kind === "rates" && (o.type === "" || String(o.type).toUpperCase() === "N/A")) continue;
      out.push(o);
    }
    return out;
  }, [grid, headers, headerRow, map, kind, fields]);

  /* Local pre-flight. The database checks all of this again on commit. */
  const preflight = useMemo(() => {
    const problems = [], notes = [];
    const missing = fields.filter((f) => f.required && map[f.key] == null);
    missing.forEach((f) => problems.push(`No column mapped to ${f.label}.`));
    rows.forEach((o, i) => {
      const n = i + 1;
      if (kind === "bookings") {
        if (!/^\d+$/.test(String(o.deal_id))) problems.push(`Row ${n}: Deal ID “${o.deal_id}” is not a whole number.`);
        if (!people.some((p) => p.name.toLowerCase() === String(o.rep).toLowerCase()))
          problems.push(`Row ${n}: no person called “${o.rep}”.`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) problems.push(`Row ${n}: date “${o.date}” not understood.`);
        const per = o.date.slice(0, 7);
        if (periods[per] && periods[per].status !== "Open")
          notes.push(`Deal ${o.deal_id} falls in ${per}, which is ${periods[per].status.toLowerCase()} — it will be held back.`);
        const p = people.find((x) => x.name.toLowerCase() === String(o.rep).toLowerCase());
        if (p && !components.some((c) => c.repId === p.id && c.type === o.type))
          notes.push(`Deal ${o.deal_id}: ${o.rep} has no ${o.type} rates on file, so it will load unpriced.`);
      } else if (kind === "rates") {
        if (!o.rep) problems.push(`Row ${n}: sales rep name is blank.`);
        if (!o.type) problems.push(`Row ${n}: commission type is blank.`);
        const t = String(o.target).replace(/[$,]/g, "");
        if (t === "" || isNaN(Number(t))) problems.push(`Row ${n} (${o.rep}): target “${o.target}” is not a number.`);
        let rt = Number(String(o.rate).replace(/%/g, ""));
        if (String(o.rate) === "" || isNaN(rt)) problems.push(`Row ${n} (${o.rep} / ${o.type}): rate “${o.rate}” is not a number.`);
        else {
          if (rt > 1) rt = rt / 100;
          if (rt <= 0 || rt > 1) problems.push(`Row ${n} (${o.rep} / ${o.type}): rate ${o.rate} is outside 0–100%.`);
        }
        if (o.rep && !people.some((p) => p.name.toLowerCase() === String(o.rep).toLowerCase()))
          notes.push(`${o.rep} is not on the team yet and will be added.`);
        const p = people.find((x) => x.name.toLowerCase() === String(o.rep).toLowerCase());
        const existing = p && components.find((c) => c.repId === p.id && c.type === o.type);
        if (existing) {
          const cur = existing.rates.find((x) => (o.logo || "N/A").toUpperCase().startsWith(String(x.logo).toUpperCase().charAt(0)));
          let nr = Number(String(o.rate).replace(/%/g, "")); if (nr > 1) nr = nr / 100;
          if (cur && Math.abs(cur.rate - nr) > 1e-9)
            notes.push(`${o.rep} / ${o.type} (${cur.label}): ${rateStr(cur.rate)} → ${rateStr(nr)}.`);
        }
        return;
      } else {
        if (!o.period) problems.push(`Row ${n}: period is blank.`);
        if (!o.client) problems.push(`Row ${n}: client is blank.`);
      }
      const amt = String(o.amount).replace(/[$,]/g, "");
      if (amt === "" || isNaN(Number(amt))) problems.push(`Row ${n}: amount “${o.amount}” is not a number.`);
    });
    const dupes = {};
    if (kind === "bookings") rows.forEach((o) => { dupes[o.deal_id] = (dupes[o.deal_id] || 0) + 1; });
    if (kind === "rates") {
      const seen = {};
      rows.forEach((o) => {
        const k = `${o.rep}|${o.type}|${o.logo || "N/A"}`;
        seen[k] = (seen[k] || 0) + 1;
      });
      Object.entries(seen).filter(([, n]) => n > 1).forEach(([k]) =>
        problems.push(`${k.split("|").join(" / ")} appears more than once in this file.`));
    }
    Object.entries(dupes).filter(([, n]) => n > 1)
      .forEach(([id]) => problems.push(`Deal ID ${id} appears more than once in this file.`));
    return { problems, notes };
  }, [rows, map, kind, people, components, periods]);

  const commit = async () => {
    setBusy(true); setResult(null);
    const fn = kind === "bookings" ? "import_bookings" : kind === "rates" ? "import_rates" : "import_revenue";
    const args = { p_rows: rows, p_filename: file ? file.name : null };
    if (kind === "rates") args.p_effective = effective;
    const { data, error } = await sb().rpc(fn, args);
    setBusy(false);
    if (error) { setResult({ failed: true, message: error.message }); return; }
    setResult(data);
    await refresh();
    const n = kind === "rates" ? (data.rates_added || 0) + (data.rates_changed || 0) : data.loaded;
    setToast(`${n} row${n === 1 ? "" : "s"} applied from ${file ? file.name : "the file"}.`);
  };

  const canCommit = isFinance && rows.length > 0 && preflight.problems.length === 0 && !busy;

  return (
    <>
      {!isFinance && (
        <div className="warnbox">
          Loading source files is a Finance Admin job. You are signed in as {user.title}, so the
          commit button stays disabled — but you can still open a file and check how it maps.
        </div>
      )}

      <div className="panel">
        <div className="phead">
          <h3>Load a source file</h3>
          <span className="note">Excel or CSV · nothing is written until you commit</span>
        </div>
        <div className="pbody">
          <div className="toolbar" style={{ marginBottom: 12 }}>
            <div className="pgroup" style={{ marginLeft: 0 }}>
              <button className={kind === "bookings" ? "on" : ""}
                onClick={() => { setKind("bookings"); setResult(null); if (wb && sheet) readSheet(wb, sheet, "bookings"); }}>
                Bookings
              </button>
              <button className={kind === "revenue" ? "on" : ""}
                onClick={() => { setKind("revenue"); setResult(null); if (wb && sheet) readSheet(wb, sheet, "revenue"); }}>
                Revenue
              </button>
              <button className={kind === "rates" ? "on" : ""}
                onClick={() => { setKind("rates"); setResult(null); if (wb && sheet) readSheet(wb, sheet, "rates"); }}>
                Rate table
              </button>
            </div>
            <input type="file" accept=".xlsx,.xls,.csv" className="inp"
              onChange={(e) => onFile(e.target.files && e.target.files[0])} />
            {file && <span className="mini">{file.name}</span>}
          </div>

          {kind === "rates" && (
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <label className="eyebrow" htmlFor="eff">These rates take effect from</label>
              <input id="eff" className="inp" type="date" value={effective}
                onChange={(e) => setEffective(e.target.value)} />
              <span className="mini">
                Anything signed before this date keeps the rate it was priced at.
              </span>
            </div>
          )}

          {sheetNames.length > 1 && (
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <label className="eyebrow" htmlFor="sh">Sheet</label>
              <select id="sh" className="inp" value={sheet || ""}
                onChange={(e) => { setSheet(e.target.value); readSheet(wb, e.target.value, kind); }}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          )}

          {parseErr && <div className="gapbox" style={{ marginBottom: 0 }}>{parseErr}</div>}

          {!file && (
            <div className="mini">
              Pick the file you would normally email round — a bookings file, a monthly revenue extract, or the
              Comp Rates sheet. Column names are matched automatically and you can correct any that come out wrong.
              On the rate sheet, a merged target and a repeated rep name carry down the block, so blank cells fill
              themselves in.
            </div>
          )}
        </div>
      </div>

      {headers && (
        <>
          <div className="panel">
            <div className="phead">
              <h3>Column mapping</h3>
              <span className="note">header found on row {headerRow + 1} · {rows.length} data row{rows.length === 1 ? "" : "s"}</span>
            </div>
            <div className="scroll">
              <table className="led">
                <thead><tr><th>Field</th><th>Column in your file</th><th>First value</th></tr></thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f.key}>
                      <td>
                        {f.label}
                        {f.required && <span className="mini" style={{ color: "var(--red)" }}> · required</span>}
                      </td>
                      <td>
                        <select className="inp" value={map[f.key] == null ? "" : map[f.key]}
                          onChange={(e) => setMap((m) => ({ ...m,
                            [f.key]: e.target.value === "" ? undefined : Number(e.target.value) }))}>
                          <option value="">— not mapped —</option>
                          {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                        </select>
                      </td>
                      <td className="mini">{rows[0] ? String(rows[0][f.key] || "—") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {preflight.problems.length > 0 && (
            <div className="gapbox">
              <b>{preflight.problems.length} problem{preflight.problems.length === 1 ? "" : "s"} to fix first</b>
              <ul>{preflight.problems.slice(0, 12).map((p, i) => <li key={i}>{p}</li>)}</ul>
              {preflight.problems.length > 12 && <div className="mini">…and {preflight.problems.length - 12} more.</div>}
            </div>
          )}
          {preflight.problems.length === 0 && preflight.notes.length > 0 && (
            <div className="warnbox">
              <b>Worth knowing before you commit</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {preflight.notes.slice(0, 8).map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}

          <div className="panel">
            <div className="phead">
              <h3>Preview</h3>
              <span className="note">first {Math.min(rows.length, 10)} of {rows.length}</span>
              <div style={{ marginLeft: "auto" }}>
                <button className="btn primary" disabled={!canCommit} onClick={commit}>
                  {busy ? "Loading…" : `Load ${rows.length} row${rows.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
            <div className="scroll">
              <table className="led">
                <thead><tr>{fields.map((f) => <th key={f.key} className={f.key === "amount" ? "n" : ""}>{f.label}</th>)}</tr></thead>
                <tbody>
                  {rows.slice(0, 10).map((o, i) => (
                    <tr key={i}>
                      {fields.map((f) => (
                        <td key={f.key} className={f.key === "amount" ? "n" : ""}>
                          {f.key === "amount" && o[f.key] !== "" && !isNaN(Number(String(o[f.key]).replace(/[$,]/g, "")))
                            ? usd(Number(String(o[f.key]).replace(/[$,]/g, "")))
                            : String(o[f.key] || "—")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && <div className="empty"><b>No data rows found</b>Check the sheet and header row.</div>}
          </div>
        </>
      )}

      {result && (
        <div className={result.failed ? "gapbox" : "panel"}>
          {result.failed ? (
            <>
              <b>Nothing was loaded</b>
              <div style={{ marginTop: 6 }}>{result.message}</div>
              <div className="mini" style={{ marginTop: 8 }}>
                The whole file is one transaction, so a single bad row stops all of it. Fix the file and try again.
              </div>
            </>
          ) : (
            <>
              <div className="phead"><h3>Loaded</h3></div>
              <div className="pbody">
                <div className="kv"><span className="k">Rows read</span><span className="n">{result.seen}</span></div>
                {result.rates_added != null ? (
                  <>
                    <div className="kv"><span className="k">People added</span><span className="n">{result.people_added}</span></div>
                    <div className="kv"><span className="k">New rates</span><span className="n">{result.rates_added}</span></div>
                    <div className="kv"><span className="k">Rates changed</span><span className="n">{result.rates_changed}</span></div>
                  </>
                ) : (
                  <>
                    <div className="kv"><span className="k">Loaded</span><span className="n">{result.loaded}</span></div>
                    <div className="kv"><span className="k">Skipped</span><span className="n">{result.skipped}</span></div>
                  </>
                )}
                {result.warnings && result.warnings.length > 0 && (
                  <>
                    <div className="eyebrow" style={{ margin: "10px 0 4px" }}>Notes</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }} className="mini">
                      {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </>
                )}
                <div className="mini" style={{ marginTop: 10 }}>
                  {result.rates_added != null
                    ? "Rates carry no effective date, so a change applies to every period, closed ones included."
                    : "Rows already present were left untouched, so re-uploading the same file is safe."}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
