/**
 * preview-scanner-tab.js — Renders the SID Scanner tab HTML in isolation.
 * Lets us visually check the new dashboard tab without running the full
 * research.js Perplexity pipeline. Writes ./docs/sid-scanner-preview.html.
 *
 * Usage: cd SID && node preview-scanner-tab.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pull the buildSidScannerHtml + readSidScanner functions from research.js
// by sourcing them via dynamic import. research.js is a CLI script that runs
// main() at the bottom; we just need its named functions.
// Workaround: regex-extract the two functions and eval them (research.js
// doesn't export them).
const researchSrc = fs.readFileSync(path.join(__dirname, '..', 'research.js'), 'utf-8');

function extractFunction(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m  = src.match(re);
  if (!m) throw new Error(`Could not find function ${name}() in research.js`);
  const start = m.index;
  // Find the matching closing brace
  let depth = 0;
  let i = start + m[0].length - 1; // start at the opening brace of the function body
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces in ${name}`);
}

const readerSrc   = extractFunction(researchSrc, 'readSidScanner');
const scannerSrc  = extractFunction(researchSrc, 'buildSidScannerHtml');
const heatmapSrc  = extractFunction(researchSrc, 'buildSidHeatmapHtml');

// `new Function` runs in global scope, so we inject fs as a parameter.
const readSidScanner       = new Function('fs', `${readerSrc}; return readSidScanner;`)(fs);
const buildSidScannerHtml  = new Function(`${scannerSrc}; return buildSidScannerHtml;`)();
const buildSidHeatmapHtml  = new Function(`${heatmapSrc}; return buildSidHeatmapHtml;`)();

process.chdir(path.join(__dirname, '..')); // mirror how research.js runs (cwd = repo root)
const scan = readSidScanner();
if (!scan) {
  console.error('No scanner-sid.json found. Run: cd SID && node scan-sid.js');
  process.exit(1);
}
const scannerHtml = buildSidScannerHtml(scan);
const heatmapHtml = buildSidHeatmapHtml(scan);

// Wrap in a minimal page that mimics the dashboard's styling so we can
// preview standalone. Copy just enough CSS from research.js's <head> to
// approximate the look.
const previewHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>SID Scanner — Preview</title>
<style>
  body { background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:32px; max-width:1400px; margin:0 auto; }
  h1 { margin:0 0 8px; }
  .header-note { color:#8b949e; font-size:13px; margin-bottom:24px; padding:12px; background:#161b22; border:1px solid #d29922; border-radius:6px; }
  .summary { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; font-size:13px; color:#c9d1d9; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; }
  .stat { flex:1; min-width:140px; background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; text-align:center; }
  .num { font-size:24px; font-weight:600; margin-bottom:4px; }
  .label { font-size:12px; color:#8b949e; }
  table { width:100%; border-collapse:collapse; margin-bottom:24px; }
  th { text-align:left; padding:10px 12px; background:#161b22; color:#8b949e; font-weight:500; font-size:12px; border-bottom:1px solid #30363d; }
  td { padding:10px 12px; border-bottom:1px solid #21262d; font-size:13px; }
  tr:hover td { background:#161b22; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head><body>
  <h1>🎯 SID Scanner + 🗺️ Heatmap — Preview</h1>
  <div class="header-note">
    Standalone preview of the two new SID dashboard tabs. Styling approximates the real dashboard (research.js).
    Run <code>node research.js</code> to render the full dashboard.
  </div>
  <h2 style="margin:32px 0 16px;color:#e6edf3">🗺️ Heatmap tab</h2>
  ${heatmapHtml}
  <h2 style="margin:48px 0 16px;color:#e6edf3">🎯 Scanner tab</h2>
  ${scannerHtml}
</body></html>`;

const outPath = path.join(__dirname, '..', 'docs', 'sid-scanner-preview.html');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, previewHtml);

console.log(`✓ Wrote ${outPath}`);
console.log(`  Open it in a browser to preview the SID Scanner tab.`);
