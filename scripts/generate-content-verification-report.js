#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const inputUrlsPath = path.join(projectRoot, 'content-audit-urls.txt');
const inputInternalCsvPath = path.join(projectRoot, 'content-audit-results.csv');
const inputExternalCsvPath = path.join(projectRoot, 'content-audit-external-links.csv');
const reportsDir = path.join(projectRoot, 'reports');
const outputSuffixArg = (process.argv[2] || '').trim();
const suffix = outputSuffixArg
  ? `-${outputSuffixArg.replace(/[^0-9A-Za-z._-]/g, '-')}`
  : '';
const outputPath = path.join(reportsDir, `qa-content-verification-report${suffix}.html`);
const outputSummaryCsvPath = path.join(reportsDir, `qa-content-verification-summary${suffix}.csv`);
const outputDetailsCsvPath = path.join(reportsDir, `qa-content-verification-details${suffix}.csv`);

function getRedirectHops(redirectChain) {
  const statuses = String(redirectChain || '')
    .split('→')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!statuses.length) return 0;

  let hops = 0;
  for (const code of statuses) {
    if (code >= 300 && code < 400) {
      hops += 1;
    } else {
      break;
    }
  }

  return hops;
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    for (let h = 0; h < headers.length; h += 1) {
      row[headers[h]] = cols[h] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

if (!fs.existsSync(inputUrlsPath)) {
  console.error(`❌ Missing file: ${inputUrlsPath}`);
  console.error('Run: node scripts/prepare-content-audit-input.js /path/to/wp-urls-public.csv');
  process.exit(1);
}

const sourceUrls = fs.readFileSync(inputUrlsPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const uniqueSourceUrls = Array.from(new Set(sourceUrls));
const sourceCount = sourceUrls.length;
const uniqueCount = uniqueSourceUrls.length;
const duplicateCount = sourceCount - uniqueCount;

const internalRows = fs.existsSync(inputInternalCsvPath)
  ? parseCsv(fs.readFileSync(inputInternalCsvPath, 'utf8'))
  : [];
const externalRows = fs.existsSync(inputExternalCsvPath)
  ? parseCsv(fs.readFileSync(inputExternalCsvPath, 'utf8'))
  : [];

const coveredPages = new Set([
  ...internalRows.map((r) => r.SourcePage).filter(Boolean),
  ...externalRows.map((r) => r.SourcePage).filter(Boolean)
]);

const hardFailRows = internalRows.filter((r) => {
  const code = Number(r.FinalStatusCode || 0);
  const label = String(r.StatusLabel || '');
  return r.HardFail === 'YES'
    || code === 404
    || (code >= 500 && code < 600)
    || label.includes('INFINITE_REDIRECT_LOOP');
});

function verdictForRow(row) {
  const code = Number(row.FinalStatusCode || 0);
  const label = String(row.StatusLabel || '');
  const redirectHops = getRedirectHops(row.RedirectChain);
  const responseTimeMs = Number(row.ResponseTimeMs || 0);

  const isFail = row.HardFail === 'YES'
    || code === 404
    || (code >= 500 && code < 600)
    || label.includes('INFINITE_REDIRECT_LOOP')
    || label.includes('TIMEOUT');

  if (isFail) return 'FAIL';

  const isWarn = redirectHops > 2 || responseTimeMs > 3000;

  if (isWarn) return 'WARN';

  const isPass = code === 200 || (redirectHops >= 1 && code === 200);
  if (isPass) return 'PASS';

  return 'WARN';
}

const detailedRows = internalRows.map((row) => ({
  ...row,
  Verdict: verdictForRow(row)
}));

const passRows = detailedRows.filter((r) => r.Verdict === 'PASS');
const failRows = detailedRows.filter((r) => r.Verdict === 'FAIL');
const warnRows = detailedRows.filter((r) => r.Verdict === 'WARN');
const warningRows = warnRows;

const totalEvaluated = detailedRows.length;
const passRate = totalEvaluated ? ((passRows.length / totalEvaluated) * 100).toFixed(1) : '0.0';
const failRate = totalEvaluated ? ((failRows.length / totalEvaluated) * 100).toFixed(1) : '0.0';
const warnRate = totalEvaluated ? ((warnRows.length / totalEvaluated) * 100).toFixed(1) : '0.0';

const uniqueBrokenLinks = Array.from(new Set(hardFailRows.map((r) => r.LinkUrl).filter(Boolean)));
const hardFailPreview = hardFailRows.slice(0, 100);
const warningPreview = warningRows.slice(0, 100);

const generatedAt = new Date().toISOString();
const hasAuditData = internalRows.length > 0 || externalRows.length > 0;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QA Content Verification Report</title>
  <style>
    body { margin: 0; background: #0b1020; color: #e8ecff; font-family: Arial, Helvetica, sans-serif; }
    .container { max-width: 1300px; margin: 0 auto; padding: 20px; }
    .card { background: #111831; border: 1px solid #273158; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    h1, h2, h3 { margin: 0 0 12px; }
    .note { padding: 12px; border-radius: 8px; background: #1d2b58; }
    .warn { background: #7a2323; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #2b3560; padding: 8px; text-align: left; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .kpi { background: #182145; border-radius: 8px; padding: 12px; font-size: 28px; font-weight: 700; }
    .kpi small { display: block; margin-top: 5px; font-size: 12px; color: #aab3d9; }
    .bad-link { color: #ff9b9b; font-weight: 700; }
  </style>
</head>
<body>
  <div class="container">
    <h1>QA Content Verification Report</h1>

    <div class="card">
      <h2>Scope</h2>
      <div class="note">This is a separate report for developer-shared content URLs and is independent from the migration URL status report.</div>
      <table>
        <thead><tr><th>Metric</th><th>Count</th></tr></thead>
        <tbody>
          <tr><td>Developer CSV URL lines submitted</td><td>${sourceCount}</td></tr>
          <tr><td>Unique URLs in content scope</td><td>${uniqueCount}</td></tr>
          <tr><td>Duplicate URL lines in content scope</td><td>${duplicateCount}</td></tr>
          <tr><td>Report generated at</td><td>${escapeHtml(generatedAt)}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Execution Summary</h2>
      ${hasAuditData
        ? '<div class="note">Content link verification data found and included below.</div>'
        : '<div class="note warn">Content link verification CSV files were not found yet. Run content checker to populate results.</div>'}
      <div class="grid" style="margin-top:10px;">
        <div class="kpi">${coveredPages.size}<small>Source pages crawled</small></div>
        <div class="kpi">${internalRows.length}<small>Internal link occurrences checked</small></div>
        <div class="kpi">${externalRows.length}<small>External link occurrences captured</small></div>
        <div class="kpi">${hardFailRows.length}<small>Hard fail internal occurrences</small></div>
        <div class="kpi">${uniqueBrokenLinks.length}<small>Unique broken internal destinations</small></div>
        <div class="kpi">${warningRows.length}<small>Warning-level internal links</small></div>
      </div>
    </div>

    <div class="card">
      <h2>Pass / Warn / Fail Breakdown (Internal Links)</h2>
      <table>
        <thead><tr><th>Verdict</th><th>Count</th><th>Rate</th></tr></thead>
        <tbody>
          <tr><td>PASS</td><td>${passRows.length}</td><td>${passRate}%</td></tr>
          <tr><td>WARN</td><td>${warnRows.length}</td><td>${warnRate}%</td></tr>
          <tr><td>FAIL</td><td>${failRows.length}</td><td>${failRate}%</td></tr>
          <tr><td><strong>Total evaluated internal link occurrences</strong></td><td><strong>${totalEvaluated}</strong></td><td><strong>100.0%</strong></td></tr>
        </tbody>
      </table>
      <div class="note" style="margin-top:10px;">Full row-level pass/warn/fail data is exported in CSV: ${escapeHtml(path.basename(outputDetailsCsvPath))}</div>
    </div>

    <div class="card">
      <h2>Critical Content Link Failures (first 100)</h2>
      <table>
        <thead><tr><th>Source Page</th><th>Section</th><th>Link Text</th><th>Broken URL</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${hardFailPreview.length
            ? hardFailPreview.map((r) => `<tr><td>${escapeHtml(r.SourcePage)}</td><td>${escapeHtml(r.Section)}</td><td>${escapeHtml(r.LinkText)}</td><td class="bad-link">${escapeHtml(r.LinkUrl)}</td><td>${escapeHtml(r.FinalStatusCode || r.StatusLabel)}</td><td>${escapeHtml(r.Notes)}</td></tr>`).join('')
            : '<tr><td colspan="6">No hard failures recorded.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Warning Items (first 100)</h2>
      <table>
        <thead><tr><th>Source Page</th><th>Link URL</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${warningPreview.length
            ? warningPreview.map((r) => `<tr><td>${escapeHtml(r.SourcePage)}</td><td>${escapeHtml(r.LinkUrl)}</td><td>${escapeHtml(r.FinalStatusCode || r.StatusLabel)}</td><td>${escapeHtml(r.Notes)}</td></tr>`).join('')
            : '<tr><td colspan="4">No warning-level items recorded.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

fs.writeFileSync(outputPath, html, 'utf8');

const summaryCsvRows = [
  { Metric: 'Developer CSV URL lines submitted', Value: sourceCount },
  { Metric: 'Unique URLs in content scope', Value: uniqueCount },
  { Metric: 'Duplicate URL lines in content scope', Value: duplicateCount },
  { Metric: 'Source pages crawled', Value: coveredPages.size },
  { Metric: 'Internal link occurrences checked', Value: internalRows.length },
  { Metric: 'External link occurrences captured', Value: externalRows.length },
  { Metric: 'PASS internal link occurrences', Value: passRows.length },
  { Metric: 'WARN internal link occurrences', Value: warnRows.length },
  { Metric: 'FAIL internal link occurrences', Value: failRows.length },
  { Metric: 'PASS rate (%)', Value: passRate },
  { Metric: 'WARN rate (%)', Value: warnRate },
  { Metric: 'FAIL rate (%)', Value: failRate },
  { Metric: 'Report generated at', Value: generatedAt }
];

const summaryCsv = toCsv(summaryCsvRows, ['Metric', 'Value']);
fs.writeFileSync(outputSummaryCsvPath, summaryCsv, 'utf8');

const detailsCsvHeaders = [
  'Verdict',
  'SourcePage',
  'Section',
  'LinkText',
  'LinkUrl',
  'LinkType',
  'FinalStatusCode',
  'StatusLabel',
  'RedirectChain',
  'ResponseTimeMs',
  'HardFail',
  'Notes',
  'CheckedAt'
];
const detailsCsv = toCsv(detailedRows, detailsCsvHeaders);
fs.writeFileSync(outputDetailsCsvPath, detailsCsv, 'utf8');

console.log(`✅ QA Content Verification Report generated: ${outputPath}`);
console.log(`✅ Summary CSV generated: ${outputSummaryCsvPath}`);
console.log(`✅ Detailed CSV generated: ${outputDetailsCsvPath}`);
console.log(`ℹ️ Source URL lines: ${sourceCount}`);
console.log(`ℹ️ Unique URLs in scope: ${uniqueCount}`);
console.log(`ℹ️ Internal result rows: ${internalRows.length}`);
console.log(`ℹ️ External result rows: ${externalRows.length}`);
