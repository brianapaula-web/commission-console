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
 * Folder layout:
 *   data/bookings/*.xlsx   any file name
 *   data/revenue/*.xlsx    any file name
 *   data/rates/*.xlsx      prefix the name with the effective date,
 *                          e.g. 2026-04-01_comp_rates.xlsx
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

const KINDS = [
  { kind: "bookings", dir: "data/bookings", rpc: "import_bookings" },
  { kind: "revenue",  dir: "data/revenue",  rpc: "import_revenue"  },
  { kind: "rates",    dir: "data/rates",    rpc: "import_rates"    },
];

const files = (dir) => {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => [".xlsx", ".xls", ".csv"].includes(extname(f).toLowerCase()))
    .filter((f) => !f.startsWith("~$") && !f.startsWith("."))   // Excel lock files
    .sort()
    .map((f) => join(full, f));
};

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

console.log(dry ? "Parsing data/ (dry run — nothing will be written)\n"
                : "Parsing data/\n");

for (const { kind, dir, rpc } of KINDS) {
  const found = files(dir);
  if (found.length === 0) { console.log(`  ${dir.padEnd(16)} — no files`); continue; }
  for (const path of found) {
    const name = basename(path);
    const res = parseOne(path, kind);
    if (res.error) {
      console.log(`  ✗ ${dir}/${name}\n      ${res.error}`);
      problems++;
      continue;
    }
    let effective = null;
    if (kind === "rates") {
      effective = effectiveFrom(path);
      if (!effective) {
        console.log(`  ✗ ${dir}/${name}`);
        console.log(`      Rate files must start with the effective date, e.g. 2026-04-01_${name}`);
        problems++;
        continue;
      }
    }
    console.log(`  ✓ ${dir}/${name}`);
    console.log(`      sheet "${res.sheet}", header row ${res.headerRow + 1}, ${res.rows.length} row(s)` +
                (effective ? `, effective ${effective}` : ""));
    if (res.rows[0]) console.log(`      first row: ${JSON.stringify(res.rows[0])}`);
    plan.push({ kind, rpc, name, rows: res.rows, effective });
  }
}

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
