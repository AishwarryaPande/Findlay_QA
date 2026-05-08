#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const QA_SCOPE = 494;
const RAW_SITEMAP_TOTAL = 504;
const DUPLICATES_FOUND = 10;
const UNIQUE_AFTER_DEDUP = 494;
const SUBMITTED_TO_CHECKER = 494;

const DUPLICATE_DETAILS = [
  '[2x] /about/fast-facts/',
  '[2x] /academics/education/adolescent-young-adult/',
  '[3x] /academics/education/intervention-specialist/',
  '[2x] /academics/education/master-of-arts-in-education/',
  '[2x] /academics/education/middle-childhood/',
  '[2x] /academics/education/multi-age/',
  '[2x] /academics/education/primary-education/',
  '[2x] /admissions-aid/undergraduate-student/',
  '[2x] /campus-life/student-organizations/'
];

const projectRoot = path.resolve(__dirname, '..');
const resultsCsvPath = path.join(projectRoot, 'results.csv');
const partialCsvPath = path.join(projectRoot, 'partial-results.csv');
const contentAuditCsvPath = path.join(projectRoot, 'content-audit-results.csv');
const contentAuditExternalCsvPath = path.join(projectRoot, 'content-audit-external-links.csv');
const reportPath = path.join(projectRoot, 'report.html');
const reportsDir = path.join(projectRoot, 'reports');
const managementReportPath = path.join(reportsDir, 'qa-management-report.html');

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

function getDataSource() {
  if (fs.existsSync(resultsCsvPath)) {
    return { path: resultsCsvPath, isPartial: false };
  }
  if (fs.existsSync(partialCsvPath)) {
    return { path: partialCsvPath, isPartial: true };
  }

  console.error('❌ Missing results.csv (and partial-results.csv). Run URL checker first.');
  process.exit(1);
}

function statusClass(row) {
  const code = Number(row.FinalStatusCode || 0);
  const label = row.StatusLabel || '';
  const time = Number(row.ResponseTimeMs || 0);
  const redirects = (row.RedirectChain || '').includes('→');
  const redirectHops = redirects ? row.RedirectChain.split('→').length - 1 : 0;

  if (label.startsWith('TIMEOUT') || label.startsWith('UNKNOWN_ERROR') || label.startsWith('CONNECTION_REFUSED')) {
    return 'row-unverified';
  }
  if (code === 429 || time > 3000 || redirectHops > 2) {
    return 'row-warn';
  }
  if (code === 200) {
    return 'row-pass';
  }
  return 'row-fail';
}

function rowPriority(className) {
  if (className === 'row-fail') return 0;
  if (className === 'row-unverified') return 1;
  if (className === 'row-warn') return 2;
  return 3;
}

function parseChainCodes(chain) {
  return String(chain || '')
    .split('→')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function rowSeverity(row) {
  const code = Number(row.FinalStatusCode || 0);
  const label = row.StatusLabel || '';
  const responseTime = Number(row.ResponseTimeMs || 0);
  const redirectHops = String(row.RedirectChain || '').includes('→')
    ? String(row.RedirectChain || '').split('→').length - 1
    : 0;

  if (label.startsWith('TIMEOUT')) return 90;
  if (label.startsWith('CONNECTION_REFUSED')) return 85;
  if (label.startsWith('UNKNOWN_ERROR')) return 80;
  if (code >= 500 && code < 600) return 70;
  if (code === 404) return 60;
  if (code === 429) return 50;
  if (redirectHops > 2) return 40;
  if (responseTime > 3000) return 30;
  if (String(row.RedirectChain || '').includes('→')) return 20;
  if (code === 200) return 10;
  return 0;
}

function dedupeRowsByUrl(rows) {
  const firstSeenOrder = [];
  const bestByUrl = new Map();

  for (const row of rows) {
    const url = (row.URL || '').trim();
    if (!url) continue;

    if (!bestByUrl.has(url)) {
      firstSeenOrder.push(url);
      bestByUrl.set(url, row);
      continue;
    }

    const existing = bestByUrl.get(url);
    const existingSeverity = rowSeverity(existing);
    const candidateSeverity = rowSeverity(row);

    if (candidateSeverity > existingSeverity) {
      bestByUrl.set(url, row);
      continue;
    }

    if (candidateSeverity === existingSeverity) {
      const existingTime = Number(existing.ResponseTimeMs || 0);
      const candidateTime = Number(row.ResponseTimeMs || 0);
      if (candidateTime > existingTime) {
        bestByUrl.set(url, row);
      }
    }
  }

  return firstSeenOrder.map((url) => bestByUrl.get(url));
}

const source = getDataSource();
const csvText = fs.readFileSync(source.path, 'utf8');
const rawRows = parseCsv(csvText);
const dedupedRows = dedupeRowsByUrl(rawRows);
const rows = dedupedRows.slice(0, QA_SCOPE);
const checked = rows.length;
const skipped = Math.max(QA_SCOPE - checked, 0);
const generatedAt = new Date().toISOString();

const consecutive429AtEnd = (() => {
  let count = 0;
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    if (Number(rawRows[i].FinalStatusCode || 0) === 429) count += 1;
    else break;
  }
  return count;
})();

const blockedMidRun = checked < QA_SCOPE && (source.isPartial || consecutive429AtEnd >= 10);

let confirmed200 = 0;
let redirectUrls = 0;
let broken404or500 = 0;
let rateLimited = 0;
let timedOut = 0;
let unknownErrors = 0;
let slowOver3s = 0;
let redirectLongerThan2 = 0;
let serverErrors = 0;
let ac02Hits404 = 0;
let ac03TotalRedirects = 0;
let ac03GoodRedirects = 0;
let ac03BadRedirects = 0;
let ac05Under10s = 0;
let ac09Flagged429 = 0;

const criticalIssues = [];
const warningIssues = [];
const unverifiedIssues = [];

const tableRows = rows.map((row, idx) => {
  const code = Number(row.FinalStatusCode || 0);
  const label = row.StatusLabel || '';
  const chain = row.RedirectChain || '';
  const chainCodes = parseChainCodes(chain);
  const responseTime = Number(row.ResponseTimeMs || 0);
  const hasRedirect = chain.includes('→');
  const redirectHops = hasRedirect ? chain.split('→').length - 1 : 0;
  const has404InChain = chainCodes.includes(404);
  const has5xxInChain = chainCodes.some((n) => n >= 500 && n < 600);
  const has429InChain = chainCodes.includes(429);

  const ac01 = code === 200;
  const ac02 = !has404InChain && code !== 404;
  const ac03 = !hasRedirect ? true : code === 200;

  if (ac01) confirmed200 += 1;
  if (hasRedirect) redirectUrls += 1;
  if (code === 404 || code >= 500 && code < 600) broken404or500 += 1;
  if (code === 429) rateLimited += 1;
  if (label.startsWith('TIMEOUT')) timedOut += 1;
  if (label.startsWith('UNKNOWN_ERROR') || label.startsWith('CONNECTION_REFUSED')) unknownErrors += 1;
  if (responseTime > 3000) slowOver3s += 1;
  if (redirectHops > 2) redirectLongerThan2 += 1;
  if (code >= 500 && code < 600 || has5xxInChain) serverErrors += 1;
  if (!ac02) ac02Hits404 += 1;
  if (responseTime < 10000 && !label.startsWith('TIMEOUT') && !label.startsWith('UNKNOWN_ERROR') && !label.startsWith('CONNECTION_REFUSED')) ac05Under10s += 1;

  if (hasRedirect) {
    const startsWithRedirect = chainCodes.length > 0 && (chainCodes[0] === 301 || chainCodes[0] === 302);
    if (startsWithRedirect) {
      ac03TotalRedirects += 1;
      if (code === 200) ac03GoodRedirects += 1;
      else ac03BadRedirects += 1;
    }
  }

  if (code === 429 && label.includes('RATE_LIMITED')) {
    ac09Flagged429 += 1;
  }

  if (code === 404 || code >= 500 && code < 600 || has404InChain || has5xxInChain) {
    criticalIssues.push({ url: row.URL, status: code || 'N/A', notes: row.Notes || '' });
  }

  if (code === 429) {
    warningIssues.push({ url: row.URL, issue: '429 RATE_LIMITED', details: row.Notes || label });
  }
  if (responseTime > 3000) {
    warningIssues.push({ url: row.URL, issue: 'Slow response > 3000ms', details: `${responseTime}ms` });
  }
  if (redirectHops > 2) {
    warningIssues.push({ url: row.URL, issue: 'Redirect chain over 2 hops', details: chain });
  }

  if (label.startsWith('TIMEOUT') || label.startsWith('UNKNOWN_ERROR') || label.startsWith('CONNECTION_REFUSED')) {
    unverifiedIssues.push({ url: row.URL, issue: label, details: row.Notes || '' });
  }

  return {
    idx: idx + 1,
    row,
    ac01,
    ac02,
    ac03,
    className: statusClass(row)
  };
});

// Management-friendly default order: issues first, passes last
tableRows.sort((a, b) => {
  const priorityDiff = rowPriority(a.className) - rowPriority(b.className);
  if (priorityDiff !== 0) return priorityDiff;

  const aStatus = Number(a.row.FinalStatusCode || 0);
  const bStatus = Number(b.row.FinalStatusCode || 0);
  if (aStatus !== bStatus) return aStatus - bStatus;

  return String(a.row.URL || '').localeCompare(String(b.row.URL || ''));
});

// Renumber after sorting
tableRows.forEach((entry, index) => {
  entry.idx = index + 1;
});

const coveragePct = Math.min((checked / QA_SCOPE) * 100, 100).toFixed(1);
const passRatePct = Math.min((confirmed200 / QA_SCOPE) * 100, 100).toFixed(1);

const contentAuditAvailable = fs.existsSync(contentAuditCsvPath);
const contentRows = contentAuditAvailable
  ? parseCsv(fs.readFileSync(contentAuditCsvPath, 'utf8'))
  : [];
const contentExternalRows = fs.existsSync(contentAuditExternalCsvPath)
  ? parseCsv(fs.readFileSync(contentAuditExternalCsvPath, 'utf8'))
  : [];

const contentHardFailRows = contentRows.filter((r) => {
  const code = Number(r.FinalStatusCode || 0);
  const label = String(r.StatusLabel || '');
  return r.HardFail === 'YES'
    || code === 404
    || (code >= 500 && code < 600)
    || label.includes('INFINITE_REDIRECT_LOOP');
});

const contentWarnRows = contentRows.filter((r) => {
  const code = Number(r.FinalStatusCode || 0);
  const label = String(r.StatusLabel || '');
  return code === 429 || label.includes('TIMEOUT') || label.includes('UNKNOWN_ERROR') || label.includes('CONNECTION_REFUSED');
});

const uniqueContentPages = new Set([
  ...contentRows.map((r) => r.SourcePage).filter(Boolean),
  ...contentExternalRows.map((r) => r.SourcePage).filter(Boolean)
]);

const uniqueBrokenContentLinks = Array.from(new Set(contentHardFailRows.map((r) => r.LinkUrl).filter(Boolean)));
const contentHardFailPreview = contentHardFailRows
  .slice()
  .sort((a, b) => String(a.SourcePage || '').localeCompare(String(b.SourcePage || '')))
  .slice(0, 50);

const ac01PassCount = confirmed200;
const ac01Pass = ac01PassCount === QA_SCOPE;

const ac02Pass = ac02Hits404 === 0;

const ac03Pass = ac03BadRedirects === 0;

const ac04Status = redirectLongerThan2 > 0 ? 'WARN' : 'PASS';
const ac04Count = redirectLongerThan2;

const ac05FailCount = rows.filter((r) => {
  const label = r.StatusLabel || '';
  const time = Number(r.ResponseTimeMs || 0);
  const notes = r.Notes || '';
  const isTimeout = label.startsWith('TIMEOUT');
  const isTimeoutEquivalentRedirectLoop = label.includes('Too many redirects') || notes.includes('Too many redirects');
  const isHardTimeoutByDuration = time >= 10000;
  return isTimeout || isTimeoutEquivalentRedirectLoop || isHardTimeoutByDuration;
}).length;
const ac05Pass = ac05FailCount === 0 && checked === QA_SCOPE;

const ac06Pass = serverErrors === 0;

const ac07Pass = rateLimited < 5;

const ac08Status = slowOver3s > 0 ? 'WARN' : 'PASS';

const ac09AllFlagged = rateLimited === ac09Flagged429;
const ac09Status = ac09AllFlagged ? 'INFO' : 'FAIL';

const criticalAllPass = ac01Pass && ac02Pass && ac03Pass && ac05Pass && ac06Pass;
const bannerClass = criticalAllPass ? 'banner-pass' : 'banner-fail';
const bannerText = criticalAllPass
  ? '✅ READY FOR SIGN-OFF - All critical checks passed'
  : '🚨 NOT READY - Critical failures found. Dev team action required.';

function acRowClass(status) {
  if (status === 'PASS') return 'ac-pass';
  if (status === 'FAIL') return 'ac-fail';
  if (status === 'WARN') return 'ac-warn';
  return 'ac-info';
}

const coverageWarning = checked < QA_SCOPE
  ? `<div class="coverage-warning">🚨 QA coverage is under 100%: ${checked}/${QA_SCOPE} checked (${coveragePct}%).</div>`
  : '';

const blockedWarning = blockedMidRun
  ? `<div class="coverage-warning">🚫 Crawler appears blocked mid-run. URLs checked: ${checked}/${QA_SCOPE}.</div>`
  : '';

const extraRowsInfo = rawRows.length !== rows.length
  ? `<div class="coverage-warning">ℹ️ Calculation scope normalized to ${QA_SCOPE} unique URLs (raw rows: ${rawRows.length}, unique URLs: ${dedupedRows.length}).</div>`
  : '';

const section7Html = contentAuditAvailable
  ? `
    <div class="card issues">
      <h2 class="section-title">SECTION 7 — CONTENT LINK AUDIT (SEPARATE CHECK)</h2>
      <table class="metric-table">
        <thead><tr><th>Metric</th><th>Count</th></tr></thead>
        <tbody>
          <tr><td>Source pages crawled for content links</td><td>${uniqueContentPages.size}</td></tr>
          <tr><td>Internal clickable link occurrences checked</td><td>${contentRows.length}</td></tr>
          <tr><td>External clickable link occurrences captured (reported separately)</td><td>${contentExternalRows.length}</td></tr>
          <tr><td>Hard fail internal link occurrences (404/500/infinite redirect)</td><td>${contentHardFailRows.length}</td></tr>
          <tr><td>Unique broken internal destination URLs</td><td>${uniqueBrokenContentLinks.length}</td></tr>
          <tr><td>Warning-level internal links (429/timeout/unknown)</td><td>${contentWarnRows.length}</td></tr>
        </tbody>
      </table>

      <h4>🚨 Content link hard failures (first 50)</h4>
      <table>
        <thead><tr><th>Source Page</th><th>Section</th><th>Link Text</th><th>Broken URL</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${contentHardFailPreview.length
            ? contentHardFailPreview.map((r) => `<tr><td>${escapeHtml(r.SourcePage)}</td><td>${escapeHtml(r.Section)}</td><td>${escapeHtml(r.LinkText)}</td><td style="color:#ff9b9b;font-weight:700;">${escapeHtml(r.LinkUrl)}</td><td>${escapeHtml(r.FinalStatusCode || r.StatusLabel)}</td><td>${escapeHtml(r.Notes)}</td></tr>`).join('')
            : '<tr><td colspan="6">None</td></tr>'}
        </tbody>
      </table>
    </div>`
  : `
    <div class="card">
      <h2 class="section-title">SECTION 7 — CONTENT LINK AUDIT (SEPARATE CHECK)</h2>
      <p>Content audit data not found. Generate <strong>content-audit-results.csv</strong> first to include this section.</p>
    </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>University of Findlay Migration QA Report</title>
  <style>
    :root { --bg:#0b1020; --card:#111831; --text:#e8ecff; --muted:#aab3d9; --pass:#174d2f; --fail:#6b1f1f; --warn:#6b4a1f; --info:#2f3448; --table:#0f152c; }
    body { margin:0; font-family:Arial,Helvetica,sans-serif; background:var(--bg); color:var(--text); }
    .container { max-width:1400px; margin:0 auto; padding:20px; }
    h1,h2,h3 { margin:0 0 12px; }
    .card { background:var(--card); border:1px solid #273158; border-radius:10px; padding:16px; margin-bottom:16px; }
    .banner-pass,.banner-fail,.coverage-warning { padding:14px; border-radius:8px; margin:10px 0; font-weight:700; }
    .banner-pass { background:#1d5c39; }
    .banner-fail { background:#7a2323; }
    .coverage-warning { background:#7a2323; }
    .metric-table, .ac-table, .full-table { width:100%; border-collapse:collapse; }
    .metric-table th,.metric-table td,.ac-table th,.ac-table td,.full-table th,.full-table td { border:1px solid #2b3560; padding:8px; text-align:left; }
    .ac-pass { background:var(--pass); }
    .ac-fail { background:var(--fail); }
    .ac-warn { background:var(--warn); }
    .ac-info { background:var(--info); }
    .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
    .kpi { background:#182145; border-radius:8px; padding:12px; font-size:28px; font-weight:700; }
    .kpi small { display:block; font-size:12px; color:var(--muted); margin-top:6px; }
    .section-title { margin:16px 0 10px; font-size:22px; }
    details { background:#1b2447; border-radius:8px; padding:10px; }
    summary { cursor:pointer; font-weight:700; }
    ul { margin:8px 0 0 18px; }
    .issues h4 { margin:10px 0 8px; }
    .issues table { width:100%; border-collapse:collapse; margin-bottom:12px; }
    .issues th,.issues td { border:1px solid #2b3560; padding:7px; }
    .controls { display:flex; gap:10px; margin:10px 0; flex-wrap:wrap; }
    input, select { background:#0d1430; color:var(--text); border:1px solid #2b3560; border-radius:6px; padding:8px; }
    .row-pass { background:#163726; }
    .row-fail { background:#5a2020; }
    .row-warn { background:#5a421d; }
    .row-unverified { background:#353a4f; }
    .row-fail td:nth-child(2),
    .row-warn td:nth-child(2),
    .row-unverified td:nth-child(2) { color:#ff9b9b; font-weight:700; }
    footer { color:var(--muted); font-size:13px; line-height:1.5; }
    @media print {
      body { background: #fff; color: #000; }
      .card, .kpi, details, .banner-pass, .banner-fail, .coverage-warning { break-inside: avoid; }
      .controls { display:none; }
      .container { max-width: none; padding: 0; }
      .card { border: 1px solid #ddd; background: #fff; }
      .full-table th, .full-table td, .ac-table th, .ac-table td, .metric-table th, .metric-table td { border-color: #ccc; color: #000; }
      .row-pass, .row-fail, .row-warn, .row-unverified, .ac-pass, .ac-fail, .ac-warn, .ac-info { background: #fff !important; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>University of Findlay WordPress Migration QA Report</h1>
    <div class="${bannerClass}">${bannerText}</div>
    ${coverageWarning}
    ${blockedWarning}
    ${extraRowsInfo}

    <div class="card">
      <h2 class="section-title">SECTION 1 — SOURCE DATA SUMMARY</h2>
      <table class="metric-table">
        <thead><tr><th>Metric</th><th>Count</th></tr></thead>
        <tbody>
          <tr><td>Total URLs in Developer Sitemap (raw)</td><td>${RAW_SITEMAP_TOTAL}</td></tr>
          <tr><td>Duplicate URLs found</td><td>${DUPLICATES_FOUND}</td></tr>
          <tr><td>Unique URLs after deduplication</td><td>${UNIQUE_AFTER_DEDUP}</td></tr>
          <tr><td>URLs submitted to QA checker</td><td>${SUBMITTED_TO_CHECKER}</td></tr>
          <tr><td>URLs successfully checked</td><td>${checked}</td></tr>
          <tr><td>URLs not checked / skipped</td><td>${skipped}</td></tr>
          <tr><td>Report generated</td><td>${escapeHtml(generatedAt)}</td></tr>
        </tbody>
      </table>
      <details>
        <summary>Duplicates found in developer sitemap</summary>
        <ul>${DUPLICATE_DETAILS.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
      </details>
    </div>

    <div class="card">
      <h2 class="section-title">SECTION 2 — ACCEPTANCE CRITERIA RESULTS TABLE</h2>
      <table class="ac-table">
        <thead>
          <tr><th>AC ID</th><th>Description</th><th>Pass Condition</th><th>Fail Condition</th><th>Status</th><th>Count</th></tr>
        </thead>
        <tbody>
          <tr class="${acRowClass(ac01Pass ? 'PASS' : 'FAIL')}"><td>AC-01</td><td>Every URL must return 200 OK</td><td>Final status = 200</td><td>404, 500, timeout, refused</td><td>${ac01Pass ? 'PASS' : 'FAIL'}</td><td>${ac01PassCount}/${QA_SCOPE}</td></tr>
          <tr class="${acRowClass(ac02Pass ? 'PASS' : 'FAIL')}"><td>AC-02</td><td>No URL should ever return 404</td><td>404 never appears anywhere</td><td>404 in final or redirect chain</td><td>${ac02Pass ? 'PASS' : 'FAIL'}</td><td>${ac02Hits404}</td></tr>
          <tr class="${acRowClass(ac03Pass ? 'PASS' : 'FAIL')}"><td>AC-03</td><td>All redirects must resolve to valid page</td><td>301/302 → final 200</td><td>301/302 → 404 or loop</td><td>${ac03Pass ? 'PASS' : 'FAIL'}</td><td>${ac03GoodRedirects}/${ac03TotalRedirects}</td></tr>
          <tr class="${acRowClass(ac04Status)}"><td>AC-04</td><td>No redirect chains longer than 2 hops</td><td>0 or 1 redirect before 200</td><td>2+ redirects before 200</td><td>${ac04Status}</td><td>${ac04Count}</td></tr>
          <tr class="${acRowClass(ac05Pass ? 'PASS' : 'FAIL')}"><td>AC-05</td><td>All pages respond within 10 seconds</td><td>Response time under 10000ms</td><td>Timeout / no response</td><td>${ac05Pass ? 'PASS' : 'FAIL'}</td><td>${ac05FailCount}/${QA_SCOPE}</td></tr>
          <tr class="${acRowClass(ac06Pass ? 'PASS' : 'FAIL')}"><td>AC-06</td><td>No server errors</td><td>Zero 5xx responses</td><td>Any 500/503</td><td>${ac06Pass ? 'PASS' : 'FAIL'}</td><td>${serverErrors}</td></tr>
          <tr class="${acRowClass(ac07Pass ? 'PASS' : 'FAIL')}"><td>AC-07</td><td>Rate limiting must not block more than 5 URLs</td><td>Fewer than 5 URLs return 429</td><td>5 or more 429s</td><td>${ac07Pass ? 'PASS' : 'FAIL'}</td><td>${rateLimited}</td></tr>
          <tr class="${acRowClass(ac08Status)}"><td>AC-08</td><td>Response time warning over 3 seconds</td><td>All pages under 3000ms</td><td>Any page over 3000ms (warn not fail)</td><td>${ac08Status}</td><td>${slowOver3s}</td></tr>
          <tr class="${acRowClass(ac09Status)}"><td>AC-09</td><td>All 429 URLs flagged for manual recheck</td><td>All 429s listed separately</td><td>Any 429 counted as pass</td><td>${ac09Status}</td><td>${rateLimited}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 class="section-title">SECTION 3 — SUMMARY DASHBOARD</h2>
      <div class="grid">
        <div class="kpi">🔵 ${RAW_SITEMAP_TOTAL}<small>Total in Sitemap</small></div>
        <div class="kpi">🟡 ${DUPLICATES_FOUND}<small>Duplicates Removed</small></div>
        <div class="kpi">📋 ${QA_SCOPE}<small>Unique URLs (QA Scope)</small></div>
        <div class="kpi">✅ ${confirmed200}<small>Confirmed 200 OK</small></div>
        <div class="kpi">↪️ ${redirectUrls}<small>Redirects (301/302)</small></div>
        <div class="kpi">❌ ${broken404or500}<small>Broken (404/500)</small></div>
        <div class="kpi">⚠️ ${rateLimited}<small>Rate Limited (recheck)</small></div>
        <div class="kpi">⏱️ ${timedOut}<small>Timed Out</small></div>
        <div class="kpi">📊 ${passRatePct}%<small>Pass Rate</small></div>
        <div class="kpi">📊 ${coveragePct}%<small>QA Coverage</small></div>
      </div>
    </div>

    <div class="card issues">
      <h2 class="section-title">SECTION 4 — ISSUES LIST (failures only)</h2>
      <h4>🚨 CRITICAL — Must fix before go-live:</h4>
      <table><thead><tr><th>URL</th><th>Status</th><th>Notes</th></tr></thead><tbody>
        ${criticalIssues.length ? criticalIssues.map((i) => `<tr><td>${escapeHtml(i.url)}</td><td>${escapeHtml(i.status)}</td><td>${escapeHtml(i.notes)}</td></tr>`).join('') : '<tr><td colspan="3">None</td></tr>'}
      </tbody></table>

      <h4>⚠️ WARNINGS — Review recommended:</h4>
      <table><thead><tr><th>URL</th><th>Issue</th><th>Details</th></tr></thead><tbody>
        ${warningIssues.length ? warningIssues.map((i) => `<tr><td>${escapeHtml(i.url)}</td><td>${escapeHtml(i.issue)}</td><td>${escapeHtml(i.details)}</td></tr>`).join('') : '<tr><td colspan="3">None</td></tr>'}
      </tbody></table>

      <h4>❓ UNVERIFIED — Manual check required:</h4>
      <table><thead><tr><th>URL</th><th>Issue</th><th>Details</th></tr></thead><tbody>
        ${unverifiedIssues.length ? unverifiedIssues.map((i) => `<tr><td>${escapeHtml(i.url)}</td><td>${escapeHtml(i.issue)}</td><td>${escapeHtml(i.details)}</td></tr>`).join('') : '<tr><td colspan="3">None</td></tr>'}
      </tbody></table>
    </div>

    <div class="card">
      <h2 class="section-title">SECTION 5 — FULL RESULTS TABLE</h2>
      <div class="controls">
        <input id="searchInput" type="text" placeholder="Search by URL" />
        <select id="statusFilter">
          <option value="">All statuses</option>
          <option value="200">200</option>
          <option value="301">301</option>
          <option value="302">302</option>
          <option value="404">404</option>
          <option value="429">429</option>
          <option value="500">500</option>
          <option value="0">0 / Unverified</option>
        </select>
        <button id="sortStatus" type="button">Sort by status code</button>
      </div>
      <table class="full-table" id="resultsTable">
        <thead>
          <tr>
            <th>#</th><th>URL</th><th>Final Status</th><th>Status Label</th><th>Redirect Chain</th><th>Response Time</th><th>AC-01</th><th>AC-02</th><th>AC-03</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows.map((r) => `<tr class="${r.className}" data-status="${escapeHtml(r.row.FinalStatusCode)}" data-url="${escapeHtml(r.row.URL).toLowerCase()}"><td>${r.idx}</td><td>${escapeHtml(r.row.URL)}</td><td>${escapeHtml(r.row.FinalStatusCode)}</td><td>${escapeHtml(r.row.StatusLabel)}</td><td>${escapeHtml(r.row.RedirectChain)}</td><td>${escapeHtml(r.row.ResponseTimeMs)}ms</td><td>${r.ac01 ? 'PASS' : 'FAIL'}</td><td>${r.ac02 ? 'PASS' : 'FAIL'}</td><td>${r.ac03 ? 'PASS' : 'FAIL'}</td><td>${escapeHtml(r.row.Notes)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    ${section7Html}

    <div class="card">
      <h2 class="section-title">SECTION 8 — FOOTER</h2>
      <footer>
        Project: University of Findlay WordPress Migration QA<br/>
        Site tested: https://findlayedu.wpenginepowered.com/<br/>
        Source: Developer sitemap (504 raw URLs, 10 duplicates removed)<br/>
        QA scope: 494 unique URLs<br/>
        QA performed: ${escapeHtml(generatedAt)}<br/>
        Tool: Automated Node.js HTTP checker with 800ms delay<br/>
        ⚠️ URLs marked RATE LIMITED were not confirmed and require manual verification<br/>
        This report was auto-generated. Do not edit manually.
      </footer>
    </div>
  </div>

  <script>
    const searchInput = document.getElementById('searchInput');
    const statusFilter = document.getElementById('statusFilter');
    const sortBtn = document.getElementById('sortStatus');
    const tbody = document.querySelector('#resultsTable tbody');
    let sortAsc = true;

    function applyFilters() {
      const query = searchInput.value.toLowerCase().trim();
      const filter = statusFilter.value;
      const rows = Array.from(tbody.querySelectorAll('tr'));

      rows.forEach((row) => {
        const url = row.getAttribute('data-url') || '';
        const status = row.getAttribute('data-status') || '';
        const matchQuery = !query || url.includes(query);
        const matchStatus = !filter || status === filter;
        row.style.display = (matchQuery && matchStatus) ? '' : 'none';
      });
    }

    function sortByStatus() {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        const sa = Number(a.getAttribute('data-status') || 0);
        const sb = Number(b.getAttribute('data-status') || 0);
        return sortAsc ? sa - sb : sb - sa;
      });
      rows.forEach((r) => tbody.appendChild(r));
      sortAsc = !sortAsc;
      applyFilters();
    }

    searchInput.addEventListener('input', applyFilters);
    statusFilter.addEventListener('change', applyFilters);
    sortBtn.addEventListener('click', sortByStatus);
  </script>
</body>
</html>`;

if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true });
}

fs.writeFileSync(reportPath, html, 'utf8');
fs.writeFileSync(managementReportPath, html, 'utf8');

console.log(`✅ Report generated: ${reportPath}`);
console.log(`✅ Management report generated: ${managementReportPath}`);
console.log(`ℹ️ Source CSV: ${source.path}`);
console.log(`ℹ️ Raw rows in CSV: ${rawRows.length}`);
console.log(`ℹ️ Unique URLs after deduplication: ${dedupedRows.length}`);
console.log(`ℹ️ Rows checked (scope): ${checked}/${QA_SCOPE}`);
