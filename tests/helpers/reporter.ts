import fs from 'node:fs';
import path from 'node:path';

export type IssueType =
  | 'OVERFLOW'
  | 'BROKEN_IMG'
  | 'NAV'
  | 'FONT'
  | 'LAYOUT'
  | 'FORM'
  | 'CONSOLE_ERROR'
  | 'CROSS_BROWSER'
  | 'CSS_DIFF'
  | 'JS_ERROR'
  | 'CWV_LCP'
  | 'CWV_CLS'
  | 'CWV_FCP'
  | 'CWV_TTFB'
  | 'CWV_TBT'
  | 'CWV_INP';

export interface Issue {
  type: IssueType;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  selector?: string;
  browser?: string;
  viewport: string;
  url: string;
  screenshotPath?: string;
  cwvMetric?: string;
  cwvValue?: number;
  cwvRating?: 'good' | 'needs-improvement' | 'poor';
}

export interface CWVMetrics {
  lcp: number;
  fcp: number;
  cls: number;
  ttfb: number;
  tbt: number;
  inp: number;
  speedIndex: number;
}

export interface CWVResult {
  url: string;
  browser: string;
  viewport: string;
  run: number;
  metrics: CWVMetrics;
  rating: 'good' | 'needs-improvement' | 'poor';
}

const ROOT = process.cwd();
const REPORTS_DIR = path.resolve(ROOT, 'reports');
const TMP_DIR = path.resolve(ROOT, '.qa-runtime');
const ISSUES_FILE = path.join(TMP_DIR, 'issues.ndjson');
const CWV_FILE = path.join(TMP_DIR, 'cwv.ndjson');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Reset reporter runtime state.
 */
export function resetRuntimeState(): void {
  ensureDir(TMP_DIR);
  fs.writeFileSync(ISSUES_FILE, '', 'utf8');
  fs.writeFileSync(CWV_FILE, '', 'utf8');
}

/**
 * Record issues to runtime store.
 */
export function recordIssues(issues: Issue[]): void {
  if (!issues.length) return;
  ensureDir(TMP_DIR);
  const payload = `${issues.map((i) => JSON.stringify(i)).join('\n')}\n`;
  fs.appendFileSync(ISSUES_FILE, payload, 'utf8');
}

/**
 * Record CWV results to runtime store.
 */
export function recordCWVResults(results: CWVResult[]): void {
  if (!results.length) return;
  ensureDir(TMP_DIR);
  const payload = `${results.map((r) => JSON.stringify(r)).join('\n')}\n`;
  fs.appendFileSync(CWV_FILE, payload, 'utf8');
}

function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function healthScore(issues: Issue[], cwv: CWVResult[]): number {
  const responsiveness = issues.filter((i) => ['OVERFLOW', 'BROKEN_IMG', 'NAV', 'FONT', 'LAYOUT', 'FORM'].includes(i.type));
  const browser = issues.filter((i) => ['CROSS_BROWSER', 'CSS_DIFF', 'JS_ERROR', 'CONSOLE_ERROR'].includes(i.type));
  const cwvPoor = cwv.filter((r) => r.rating === 'poor').length;

  const responsiveScore = Math.max(0, 100 - responsiveness.length * 2);
  const browserScore = Math.max(0, 100 - browser.length * 3);
  const cwvScore = cwv.length ? Math.max(0, 100 - Math.round((cwvPoor / cwv.length) * 100)) : 100;

  return Math.round(responsiveScore * 0.4 + browserScore * 0.3 + cwvScore * 0.3);
}

function summarize(issues: Issue[], cwv: CWVResult[]) {
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType: Record<string, number> = {};
  const browserViewport: Record<string, { pass: number; fail: number }> = {};

  for (const issue of issues) {
    bySeverity[issue.severity] += 1;
    byType[issue.type] = (byType[issue.type] || 0) + 1;
    const key = `${issue.browser || 'unknown'}|${issue.viewport}`;
    browserViewport[key] ??= { pass: 0, fail: 0 };
    browserViewport[key].fail += 1;
  }

  for (const result of cwv) {
    const key = `${result.browser}|${result.viewport}`;
    browserViewport[key] ??= { pass: 0, fail: 0 };
    if (result.rating === 'poor') browserViewport[key].fail += 1;
    else browserViewport[key].pass += 1;
  }

  return { bySeverity, byType, browserViewport };
}

function toCsv(cwv: CWVResult[]): string {
  const header = 'URL,Browser,Viewport,LCP,FCP,CLS,TTFB,TBT,INP,Rating';
  const lines = cwv.map((r) => [
    r.url,
    r.browser,
    r.viewport,
    r.metrics.lcp,
    r.metrics.fcp,
    r.metrics.cls,
    r.metrics.ttfb,
    r.metrics.tbt,
    r.metrics.inp,
    r.rating
  ].map((value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(','));

  return `${header}\n${lines.join('\n')}\n`;
}

/**
 * Generate JSON/CSV/HTML outputs.
 */
export function generateReports(): void {
  ensureDir(REPORTS_DIR);

  const issues = readNdjson<Issue>(ISSUES_FILE);
  const cwv = readNdjson<CWVResult>(CWV_FILE);
  const summary = summarize(issues, cwv);
  const score = healthScore(issues, cwv);

  const fullReport = { generatedAt: new Date().toISOString(), score, issues, cwv, summary };
  fs.writeFileSync(path.join(REPORTS_DIR, 'qa-report.json'), JSON.stringify(fullReport, null, 2), 'utf8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'cwv-report.json'), JSON.stringify({ generatedAt: fullReport.generatedAt, cwv }, null, 2), 'utf8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'summary.json'), JSON.stringify({ generatedAt: fullReport.generatedAt, score, summary }, null, 2), 'utf8');
  fs.writeFileSync(path.join(REPORTS_DIR, 'cwv-report.csv'), toCsv(cwv), 'utf8');

  const topIssueTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>QA Report</title>
  <style>
  body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}
  .card{background:#111827;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse}th,td{border:1px solid #334155;padding:8px;text-align:left}
  .good{color:#22c55e}.warn{color:#eab308}.bad{color:#ef4444}
  </style></head><body>
  <div class="card"><h1>QA Report</h1><p>Health Score: <strong>${score}</strong>/100</p></div>
  <div class="card"><h2>Summary</h2>
  <p>Critical: <span class="bad">${summary.bySeverity.critical}</span> | Warning: <span class="warn">${summary.bySeverity.warning}</span> | Info: ${summary.bySeverity.info}</p>
  <h3>Top 5 Issue Types</h3><table><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>
  ${topIssueTypes.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2">No issues</td></tr>'}
  </tbody></table></div>
  <div class="card"><h2>CWV Results</h2><table><thead><tr><th>URL</th><th>Browser</th><th>Viewport</th><th>LCP</th><th>FCP</th><th>CLS</th><th>TTFB</th><th>TBT</th><th>INP</th><th>Rating</th></tr></thead><tbody>
  ${cwv.map((r) => `<tr><td>${r.url}</td><td>${r.browser}</td><td>${r.viewport}</td><td>${r.metrics.lcp}</td><td>${r.metrics.fcp}</td><td>${r.metrics.cls}</td><td>${r.metrics.ttfb}</td><td>${r.metrics.tbt}</td><td>${r.metrics.inp}</td><td>${r.rating}</td></tr>`).join('') || '<tr><td colspan="10">No CWV results</td></tr>'}
  </tbody></table></div>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  </body></html>`;

  fs.writeFileSync(path.join(REPORTS_DIR, 'qa-report.html'), html, 'utf8');
}
