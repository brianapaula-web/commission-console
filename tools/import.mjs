#!/usr/bin/env node
/**
 * Loads the spreadsheets under data/ into Supabase.
 *
 *   node tools/import.mjs --dry-run     parse and report, touch nothing
 *   node tools/import.mjs               sign in and load
 *
 * It signs in as a normal finance user and calls the same import_* functions
 * the browser uses, so every rule in the database still applies: the
 * finance-only check, the all-or-nothing transaction, the skip of rows already
 * present, and the audit entry. No service key is involved.
 *
 * Files are found anywhere in the repository and sorted by what the file is
 * called, so the folder they sit in does not matter:
 *
 *   ...booking...  -> bookings
 *   ...revenue...  -> revenue
 *   ...rate... or ...comp...  -> rates, and the name must start with the date
 *                                the rates take effect, e.g.
 *                                2026-04-01_comp_rates.xlsx
 *
 * Anything that matches none of those is listed and skipped.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { readWorkbook } from "../src/file-parsing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://oxjtavkqxdhrdzjyfpjp.supabase.co";
const ANON = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.SUPABASE_EMAIL;
const PASSWORD = process.env.SUPABASE_PASSWORD;

const RPC = {
  bookings: "import_bookings",
  revenue:  "import_revenue",
  rates:    "import_rates",
};

/* Folders that never hold data files. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", "build", "dist", "sql", "src", "tools"]);
const DATA_EXT = new Set([".xlsx", ".xls", ".csv"]);

/* What kind of file is this? Decided by the name, not the folder. */
function classify(name) {
  const n = name.toLowerCase();
  if (/revenue/.test(n)) return "revenue";
  if (/booking/.test(n)) return "bookings";
  if (/rate|comp/.test(n)) return "rates";
  return null;
}

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, found);
    } else if (DATA_EXT.has(extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

/* A rate file must say when its rates start, so the date is taken from the
   front of the file name. Without it an old sheet could silently reprice
   everything back to January. */
function effectiveFrom(path) {
  const m = basename(path).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseOne(path, kind) {
  try {
    const buf = readFileSync(path);
    return readWorkbook(XLSX, new Uint8Array(buf), kind);
  } catch (e) {
    /* A corrupt or non-spreadsheet file should be reported, not crash the run. */
    return { rows: [], error: `Could not be read as a spreadsheet — ${e.message}` };
  }
}

let problems = 0;
const plan = [];
const ignored = [];

console.log(dry ? "Scanning the repository (dry run — nothing will be written)\n"
                : "Scanning the repository\n");

const found = walk(root).sort();
for (const path of found) {
  const rel = path.slice(root.length + 1).replace(/\\/g, "/");
  const name = basename(path);
  const kind = classify(name);
  if (!kind) { ignored.push(rel); continue; }

  const res = parseOne(path, kind);
  if (res.error) {
    console.log(`  \u2717 ${rel}\n      ${res.error}`);
    problems++;
    continue;
  }
  let effective = null;
  if (kind === "rates") {
    effective = effectiveFrom(path);
    if (!effective) {
      console.log(`  \u2717 ${rel}`);
      console.log(`      A rate file must start with the date its rates take effect,`);
      console.log(`      e.g. 2026-01-01_${name}`);
      problems++;
      continue;
    }
  }
  console.log(`  \u2713 ${rel}  [${kind}]`);
  console.log(`      sheet "${res.sheet}", header row ${res.headerRow + 1}, ${res.rows.length} row(s)` +
              (effective ? `, effective ${effective}` : ""));
  plan.push({ kind, rpc: RPC[kind], name, rel, rows: res.rows, effective });
}

if (ignored.length) {
  console.log(`\n  ${ignored.length} file(s) ignored — the name says nothing about what they hold:`);
  ignored.forEach((f) => console.log(`      ${f}`));
}

/* Rates must load before bookings, or a booking has no rate to price it with. */
const ORDER = { rates: 0, bookings: 1, revenue: 2 };
plan.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));

if (problems) {
  console.error(`\n${problems} file(s) could not be parsed. Nothing was loaded.`);
  process.exit(1);
}
if (plan.length === 0) {
  console.log("\nNothing to load.");
  process.exit(0);
}
if (dry) {
  console.log(`\nDry run complete — ${plan.length} file(s) would be loaded.`);
  process.exit(0);
}

for (const [k, v] of Object.entries({ SUPABASE_ANON_KEY: ANON, SUPABASE_EMAIL: EMAIL, SUPABASE_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`\nMissing ${k}. Set it as a repository secret.`); process.exit(1); }
}

const sb = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
const { error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (authErr) {
  console.error(`\nCould not sign in as ${EMAIL}: ${authErr.message}`);
  process.exit(1);
}
console.log(`\nSigned in as ${EMAIL}\n`);

let failed = 0;
for (const job of plan) {
  const args = { p_rows: job.rows, p_filename: job.name };
  if (job.kind === "rates") args.p_effective = job.effective;
  const { data, error } = await sb.rpc(job.rpc, args);
  if (error) {
    console.error(`  ✗ ${job.name}\n      ${error.message}`);
    failed++;
    continue;
  }
  const d = data || {};
  const summary = job.kind === "rates"
    ? `${d.people_added || 0} person(s) added, ${d.rates_added || 0} new rate(s), ${d.rates_changed || 0} version(s)`
    : `${d.loaded || 0} loaded, ${d.skipped || 0} skipped of ${d.seen || 0} read`;
  console.log(`  ✓ ${job.name} — ${summary}`);
  (d.warnings || []).forEach((w) => console.log(`      note: ${w}`));
}

await sb.auth.signOut();

if (failed) {
  console.error(`\n${failed} file(s) failed. Anything that did load is already committed in the database.`);
  process.exit(1);
}
console.log("\nDone.");
