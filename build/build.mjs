#!/usr/bin/env node
/**
 * Builds dist/index.html — a single self-contained page.
 *
 * React, Supabase and SheetJS are inlined rather than pulled from a CDN, so the
 * file works from disk as well as from a URL. Run with: npm run build
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
if (!existsSync(out)) mkdirSync(out, { recursive: true });

/* React is loaded as a global by the UMD build, so map the bare import onto it. */
const shim = join(root, "build", "react-shim.js");
writeFileSync(shim, `const R = window.React;
export default R;
export const useState = R.useState;
export const useMemo = R.useMemo;
export const useCallback = R.useCallback;
export const useEffect = R.useEffect;
`);

const bundlePath = join(out, "app.bundle.js");
await build({
  entryPoints: [join(root, "src", "commission-console.jsx")],
  bundle: true,
  format: "iife",
  globalName: "CommissionApp",
  alias: { react: shim },
  loader: { ".jsx": "jsx" },
  target: "es2018",
  minify: true,
  outfile: bundlePath,
  logLevel: "info",
});

const libs = [
  ["react",     "react/umd/react.production.min.js"],
  ["react-dom", "react-dom/umd/react-dom.production.min.js"],
  ["supabase",  "@supabase/supabase-js/dist/umd/supabase.js"],
  ["xlsx",      "xlsx/dist/xlsx.full.min.js"],
];

/* Inside a <script> the HTML parser treats these sequences specially, so
   neutralise them before inlining. */
const safe = (js) =>
  js.replace(/<\/script/g, "<\\/script")
    .replace(/<!--/g, "<\\!--")
    .replace(/<script/g, "<\\script");

const blocks = libs.map(([name, rel]) =>
  `<script id="lib-${name}">${safe(readFileSync(join(root, "node_modules", rel), "utf8"))}</script>`);
blocks.push(`<script id="lib-app">${safe(readFileSync(bundlePath, "utf8"))}</script>`);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Commission Console — FY26</title>
<style>
  html,body{margin:0;padding:0;background:#F7F9F5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;}
  #root{min-height:100vh;}
  #boot{padding:40px;color:#14201B;max-width:640px;}
  #boot h1{font-size:18px;margin:0 0 8px;}
  #boot pre{background:#F5DEDB;border:1px solid #D9AEA9;padding:10px;border-radius:4px;
    white-space:pre-wrap;font-size:12px;color:#7A2020;}
</style>
</head>
<body>
<div id="root"><div id="boot"><h1>Loading the commission console…</h1>
<p>If this message stays on screen, the page could not start. Any error will appear below.</p></div></div>
<noscript><div id="boot"><h1>JavaScript is switched off</h1>
<p>This page needs JavaScript. Enable it, or try a different browser.</p></div></noscript>
${blocks.join("\n")}
<script>
(function () {
  function fail(what, detail) {
    var el = document.getElementById('root'); if (!el) return;
    el.innerHTML = '<div id="boot"><h1>' + what + '</h1><pre>' +
      String(detail).replace(/</g,'&lt;') + '</pre><p>The file should be roughly 1.1 MB. ' +
      'If it is smaller the download was cut short. Otherwise open the console with F12 ' +
      'and note the first red error.</p></div>';
  }
  window.addEventListener('error', function (e) {
    fail('Something failed on load', (e && e.message) || 'Unknown error'); });
  window.addEventListener('unhandledrejection', function (e) {
    fail('Something failed on load', (e && e.reason && e.reason.message) || e.reason || 'Unknown error'); });
  try {
    var missing = [];
    if (typeof React === 'undefined') missing.push('React');
    if (typeof ReactDOM === 'undefined') missing.push('ReactDOM');
    if (typeof supabase === 'undefined') missing.push('supabase-js');
    if (typeof XLSX === 'undefined') missing.push('SheetJS');
    if (typeof CommissionApp === 'undefined') missing.push('the app bundle');
    if (missing.length) { fail('The page did not load completely', 'Missing: ' + missing.join(', ')); return; }
    ReactDOM.createRoot(document.getElementById('root'))
      .render(React.createElement(CommissionApp.default));
  } catch (err) { fail('Something failed on load', (err && err.stack) || err); }
})();
</script>
</body></html>`;

writeFileSync(join(out, "index.html"), html);
console.log(`\nWrote dist/index.html — ${Math.round(html.length / 1024)} KB`);
