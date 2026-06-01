#!/usr/bin/env ts-node
/**
 * 404 URL Validator — Playwright TypeScript Project
 *
 * Reads the latest dated CSV from  input/YYYY-MM-DD/
 * Validates all URLs concurrently (default 10 workers)
 * Outputs both:
 *   reports/YYYY-MM-DD/404-validation-YYYY-MM-DD.html
 *   reports/YYYY-MM-DD/404-validation-YYYY-MM-DD.xlsx
 *
 * Usage:
 *   npm run check-404
 *   CONCURRENCY=15 npm run check-404
 *   npm run check-404 -- --input input/2026-05-21/myfile.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import ExcelJS from 'exceljs';

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '5', 10);
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const BODY_TIMEOUT_MS = 20_000;
const THIN_WORD_THRESHOLD = 100;
const PLACEHOLDER_PATTERNS = ['lorem ipsum', 'coming soon', 'under construction', 'hello world'];
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusCategory =
  | 'ok'
  | 'redirect'
  | 'not-found'
  | 'server-error'
  | 'rate-limited'
  | 'timeout'
  | 'error';

type ContentStatus = 'ok' | 'thin' | 'soft-404' | 'placeholder' | 'warning' | 'error' | 'skipped';

interface ContentResult {
  pageTitle: string;
  h1: string;
  wordCount: number;
  contentIssues: string[];
  contentStatus: ContentStatus;
}

interface UrlResult {
  index: number;
  url: string;
  urlPath: string;
  section: string;
  finalStatus: number;
  statusLabel: string;
  statusCategory: StatusCategory;
  redirectChain: string;
  finalUrl: string;
  responseTimeMs: number;
  notes: string;
  checkedAt: string;
  // Content validation
  pageTitle: string;
  h1: string;
  wordCount: number;
  contentIssues: string;
  contentStatus: ContentStatus;
}

interface SectionStats {
  ok: number;
  redirect: number;
  notFound: number;
  error: number;
  total: number;
}

interface Summary {
  total: number;
  ok: number;
  redirects: number;
  notFound: number;
  serverErrors: number;
  rateLimited: number;
  timeouts: number;
  errors: number;
  avgResponseMs: number;
  contentIssues: number;
  sections: Record<string, SectionStats>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.pathname + u.search || '/';
  } catch {
    return rawUrl;
  }
}

const SECTION_MAP: Record<string, string> = {
  faculty: 'Faculty',
  academics: 'Academics',
  about: 'About',
  'campus-life': 'Campus Life',
  'admissions-aid': 'Admissions & Aid',
};

function extractSection(rawUrl: string): string {
  try {
    const parts = new URL(rawUrl).pathname.split('/').filter(Boolean);
    if (parts.length === 0) return 'Home';
    return SECTION_MAP[parts[0]] ?? parts[0];
  } catch {
    return 'Unknown';
  }
}

function labelFromStatus(status: number): string {
  const MAP: Record<number, string> = {
    200: '200 OK',
    301: '301 Moved Permanently',
    302: '302 Found',
    307: '307 Temporary Redirect',
    308: '308 Permanent Redirect',
    400: '400 Bad Request',
    401: '401 Unauthorized',
    403: '403 Forbidden',
    404: '404 Not Found',
    410: '410 Gone',
    429: '429 Too Many Requests',
    500: '500 Internal Server Error',
    502: '502 Bad Gateway',
    503: '503 Service Unavailable',
    504: '504 Gateway Timeout',
  };
  return MAP[status] ?? `HTTP ${status}`;
}

function categorize(status: number, notes: string, chainLength: number): StatusCategory {
  if (status === 200 && chainLength > 1) return 'redirect';
  if (status === 200) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 404 || status === 410) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  if (notes.startsWith('TIMEOUT')) return 'timeout';
  return 'error';
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── HTTP checker ─────────────────────────────────────────────────────────────

interface RawResult {
  finalStatus: number;
  chain: number[];
  finalUrl: string;
  responseTimeMs: number;
  notes: string;
}

function httpGet(
  urlStr: string,
  timeoutMs: number
): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Connection: 'close',
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.destroy();
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers['location'] ?? null,
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('TIMEOUT'));
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function checkUrl(url: string): Promise<RawResult> {
  const start = Date.now();
  const chain: number[] = [];
  let cur = url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { status, location } = await httpGet(cur, TIMEOUT_MS);
      chain.push(status);

      const isRedirect = status >= 300 && status < 400;
      if (!isRedirect || !location || hop === MAX_REDIRECTS) {
        return {
          finalStatus: status,
          chain,
          finalUrl: cur,
          responseTimeMs: Date.now() - start,
          notes: hop === MAX_REDIRECTS && isRedirect ? 'Too many redirects' : '',
        };
      }
      cur = new URL(location, cur).toString();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg === 'TIMEOUT' || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
    return {
      finalStatus: 0,
      chain,
      finalUrl: cur,
      responseTimeMs: Date.now() - start,
      notes: isTimeout
        ? `TIMEOUT — no response within ${TIMEOUT_MS / 1000}s`
        : `ERROR: ${msg}`,
    };
  }

  return { finalStatus: 0, chain, finalUrl: cur, responseTimeMs: Date.now() - start, notes: 'Too many redirects' };
}

async function checkUrlWithRetry(url: string): Promise<RawResult> {
  let lastResult: RawResult = { finalStatus: 0, chain: [], finalUrl: url, responseTimeMs: 0, notes: '' };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
    }

    const result = await checkUrl(url);
    lastResult = result;

    const s = result.finalStatus;
    const definitive =
      s === 200 ||
      (s >= 300 && s < 400) ||
      s === 404 || s === 410 ||
      s === 403 || s === 401;

    if (definitive) return result;

    if (attempt === MAX_RETRIES && attempt > 0) {
      lastResult = {
        ...result,
        notes: `${result.notes || labelFromStatus(s)} (confirmed after ${attempt + 1} attempts)`,
      };
    }
  }

  return lastResult;
}

// ─── Content validation ───────────────────────────────────────────────────────

function fetchBody(urlStr: string): Promise<string> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch { return resolve(''); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const chunks: Buffer[] = [];

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Connection: 'close',
        },
        timeout: BODY_TIMEOUT_MS,
      },
      (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => resolve(''));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.end();
  });
}

function extractContent(html: string, pageUrl: string): ContentResult {
  // Strip scripts, styles, comments
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const h1Match = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match ? h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';

  const bodyText = clean
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = bodyText.split(' ').filter((w) => w.length > 1).length;

  const issues: string[] = [];
  const lTitle = pageTitle.toLowerCase();
  const lH1 = h1.toLowerCase();
  const lUrl = pageUrl.toLowerCase();

  if (!pageTitle) issues.push('Missing page title');
  if (!h1) issues.push('Missing H1 heading');
  if (pageTitle && /^page not found/i.test(pageTitle)) issues.push('Soft 404 — title says "Page not found" but status is 200');
  if (lUrl.includes('__trashed')) issues.push('WordPress trashed post is still live (__trashed in URL)');
  if (lUrl.includes('-test-') || /\/test-[a-z]/.test(lUrl)) issues.push('Test entry in URL slug — verify if intentional');
  if (wordCount < THIN_WORD_THRESHOLD) issues.push(`Thin content — only ${wordCount} words detected`);

  for (const p of PLACEHOLDER_PATTERNS) {
    if (lTitle.includes(p) || lH1.includes(p) || bodyText.toLowerCase().includes(p)) {
      issues.push(`Placeholder content detected: "${p}"`);
      break;
    }
  }

  let contentStatus: ContentStatus = 'ok';
  if (issues.some((i) => i.startsWith('Soft 404'))) contentStatus = 'soft-404';
  else if (issues.some((i) => i.startsWith('Placeholder'))) contentStatus = 'placeholder';
  else if (issues.some((i) => i.startsWith('Thin'))) contentStatus = 'thin';
  else if (issues.length > 0) contentStatus = 'warning';

  return { pageTitle, h1, wordCount, contentIssues: issues, contentStatus };
}

// ─── Worker pool ──────────────────────────────────────────────────────────────

async function processUrls(
  urls: string[],
  onResult: (r: UrlResult, done: number) => void
): Promise<UrlResult[]> {
  const results: UrlResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx]!;
      const checkedAt = new Date().toISOString();

      const raw = await checkUrlWithRetry(url);

      const statusLabel =
        raw.notes.startsWith('TIMEOUT') || raw.notes.startsWith('ERROR') || raw.notes === 'Too many redirects'
          ? raw.notes
          : raw.chain.length > 1 && raw.finalStatus === 200
            ? `${labelFromStatus(raw.chain[0]!)} → ${labelFromStatus(raw.finalStatus)}`
            : labelFromStatus(raw.finalStatus);

      const redirectChain =
        raw.chain.length > 1 ? raw.chain.join(' → ') : String(raw.chain[0] ?? '—');

      // Fetch and validate inner content for pages that resolve to 200
      let content: ContentResult;
      const targetUrl = raw.finalUrl || url;
      if (raw.finalStatus === 200) {
        const body = await fetchBody(targetUrl);
        content = body ? extractContent(body, url) : { pageTitle: '', h1: '', wordCount: 0, contentIssues: ['Failed to fetch body'], contentStatus: 'error' };
      } else {
        content = { pageTitle: '', h1: '', wordCount: 0, contentIssues: [], contentStatus: 'skipped' };
      }

      const result: UrlResult = {
        index: idx + 1,
        url,
        urlPath: extractPath(url),
        section: extractSection(url),
        finalStatus: raw.finalStatus,
        statusLabel,
        statusCategory: categorize(raw.finalStatus, raw.notes, raw.chain.length),
        redirectChain,
        finalUrl: raw.finalUrl !== url ? raw.finalUrl : '',
        responseTimeMs: raw.responseTimeMs,
        notes: raw.notes,
        checkedAt,
        pageTitle: content.pageTitle,
        h1: content.h1,
        wordCount: content.wordCount,
        contentIssues: content.contentIssues.join('; '),
        contentStatus: content.contentStatus,
      };

      results.push(result);
      onResult(result, results.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return results.sort((a, b) => a.index - b.index);
}

// ─── Input discovery ──────────────────────────────────────────────────────────

function resolveInputCsv(cliArg?: string): string {
  if (cliArg) {
    const abs = path.resolve(ROOT, cliArg);
    if (!fs.existsSync(abs)) throw new Error(`Input file not found: ${abs}`);
    return abs;
  }

  const inputDir = path.join(ROOT, 'input');
  if (!fs.existsSync(inputDir)) throw new Error(`input/ directory not found: ${inputDir}`);

  const dated = fs
    .readdirSync(inputDir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();

  if (dated.length === 0) throw new Error('No YYYY-MM-DD folders found in input/');

  const folder = path.join(inputDir, dated[0]!);
  const csvs = fs.readdirSync(folder).filter((f) => f.endsWith('.csv'));
  if (csvs.length === 0) throw new Error(`No CSV files found in ${folder}`);

  return path.join(folder, csvs[0]!);
}

function parseCsvUrls(csvPath: string): string[] {
  const lines = fs
    .readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error('CSV is empty');

  const first = lines[0]!.toLowerCase();
  const start = first === 'url' || first.startsWith('url,') ? 1 : 0;

  return lines
    .slice(start)
    .map((line) => {
      const val = line.startsWith('"') ? line.slice(1, line.lastIndexOf('"')) : line.split(',')[0]!;
      return val.trim();
    })
    .filter((u) => {
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function computeSummary(results: UrlResult[]): Summary {
  const sections: Record<string, SectionStats> = {};
  let totalMs = 0;

  const s: Summary = {
    total: results.length,
    ok: 0,
    redirects: 0,
    notFound: 0,
    serverErrors: 0,
    rateLimited: 0,
    timeouts: 0,
    errors: 0,
    avgResponseMs: 0,
    contentIssues: 0,
    sections,
  };

  for (const r of results) {
    totalMs += r.responseTimeMs;

    switch (r.statusCategory) {
      case 'ok':           s.ok++;           break;
      case 'redirect':     s.redirects++;     break;
      case 'not-found':    s.notFound++;      break;
      case 'server-error': s.serverErrors++;  break;
      case 'rate-limited': s.rateLimited++;   break;
      case 'timeout':      s.timeouts++;      break;
      default:             s.errors++;        break;
    }

    if (r.contentIssues) s.contentIssues++;

    if (!sections[r.section]) {
      sections[r.section] = { ok: 0, redirect: 0, notFound: 0, error: 0, total: 0 };
    }
    const sec = sections[r.section]!;
    sec.total++;
    if (r.statusCategory === 'ok')          sec.ok++;
    else if (r.statusCategory === 'redirect') sec.redirect++;
    else if (r.statusCategory === 'not-found') sec.notFound++;
    else sec.error++;
  }

  s.avgResponseMs = results.length > 0 ? Math.round(totalMs / results.length) : 0;
  return s;
}

// ─── HTML Report ─────────────────────────────────────────────────────────────

function generateHtml(
  results: UrlResult[],
  summary: Summary,
  runDate: string,
  csvPath: string
): string {
  const healthScore = summary.total > 0 ? Math.round((summary.ok / summary.total) * 100) : 0;
  const healthColor = healthScore >= 90 ? '#22c55e' : healthScore >= 70 ? '#f59e0b' : '#ef4444';

  const catDot: Record<StatusCategory, string> = {
    ok: '🟢',
    redirect: '🟡',
    'not-found': '🔴',
    'server-error': '🔴',
    'rate-limited': '🟠',
    timeout: '⏱',
    error: '❌',
  };

  const contentDot: Record<ContentStatus, string> = {
    ok: '🟢', thin: '🟡', 'soft-404': '🔴', placeholder: '🟠', warning: '🟡', error: '❌', skipped: '—',
  };

  const tableRows = results
    .map((r) => {
      const dot = catDot[r.statusCategory];
      const pathCell = escHtml(r.urlPath);
      const href = escHtml(r.url);
      const redirect = escHtml(r.redirectChain);
      const finalUrlCell = r.finalUrl ? `<span class="final-url" title="${escHtml(r.finalUrl)}">→ ${escHtml(r.finalUrl.replace(/^https?:\/\/[^/]+/, ''))}</span>` : '';
      const notesCell = r.notes ? `<span class="notes-text">${escHtml(r.notes)}</span>` : '—';
      const time = new Date(r.checkedAt).toLocaleTimeString('en-US', { hour12: false });
      const cdot = contentDot[r.contentStatus] ?? '—';
      const contentIssueCell = r.contentIssues ? `<span class="content-issue">${escHtml(r.contentIssues)}</span>` : '—';

      return `<tr class="row-${r.statusCategory}" data-status="${r.statusCategory}" data-section="${r.section.toLowerCase()}" data-url="${href}" data-content="${r.contentStatus}">
      <td class="idx">${r.index}</td>
      <td class="cell-url"><a href="${href}" target="_blank" rel="noopener noreferrer">${pathCell}</a>${finalUrlCell}</td>
      <td class="cell-section">${escHtml(r.section)}</td>
      <td class="cell-status">${dot} <code>${r.finalStatus || '—'}</code></td>
      <td class="cell-label">${escHtml(r.statusLabel)}</td>
      <td class="cell-chain"><code>${redirect}</code></td>
      <td class="cell-time">${r.responseTimeMs}ms</td>
      <td class="cell-notes">${notesCell}</td>
      <td class="cell-title" title="${escHtml(r.pageTitle)}">${escHtml(r.pageTitle || '—')}</td>
      <td class="cell-h1" title="${escHtml(r.h1)}">${escHtml(r.h1 || '—')}</td>
      <td class="cell-words">${r.wordCount > 0 ? r.wordCount.toLocaleString() : '—'}</td>
      <td class="cell-content">${cdot} ${contentIssueCell}</td>
      <td class="cell-time">${time}</td>
    </tr>`;
    })
    .join('\n');

  const sectionRows = Object.entries(summary.sections)
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([name, sec]) => {
      const pct404 = sec.total > 0 ? ((sec.notFound / sec.total) * 100).toFixed(0) : '0';
      const icon = sec.notFound > 0 ? '🔴' : sec.redirect > 0 ? '🟡' : '🟢';
      return `<tr>
      <td>${icon} <strong>${escHtml(name)}</strong></td>
      <td>${sec.total}</td>
      <td class="ok-val">${sec.ok}</td>
      <td class="rd-val">${sec.redirect}</td>
      <td class="nf-val">${sec.notFound}</td>
      <td class="er-val">${sec.error}</td>
      <td>${sec.notFound > 0 ? `<span class="pct-bad">${pct404}%</span>` : '—'}</td>
    </tr>`;
    })
    .join('\n');

  const sectionOptions = Object.keys(summary.sections)
    .sort()
    .map((s) => `<option value="${s.toLowerCase()}">${escHtml(s)}</option>`)
    .join('');

  const okPct = ((summary.ok / summary.total) * 100).toFixed(1);
  const rdPct = ((summary.redirects / summary.total) * 100).toFixed(1);
  const nfPct = ((summary.notFound / summary.total) * 100).toFixed(1);
  const errCount = summary.serverErrors + summary.timeouts + summary.errors + summary.rateLimited;
  const errPct = ((errCount / summary.total) * 100).toFixed(1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 Validation Report — ${escHtml(runDate)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;line-height:1.4}
    a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
    code{font-family:'JetBrains Mono','Fira Code','Courier New',monospace;font-size:11px;background:#0f172a;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc}

    /* Layout */
    .wrap{max-width:1500px;margin:0 auto}
    .card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:18px 20px;margin-bottom:16px}
    h1{font-size:22px;font-weight:800;color:#f1f5f9;margin-bottom:4px}
    h2{font-size:15px;font-weight:700;color:#f1f5f9;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b}
    .meta{color:#64748b;font-size:12px}

    /* Progress bar */
    .prog-wrap{margin:10px 0}
    .prog{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#1e293b}
    .pb-ok{background:#22c55e}
    .pb-rd{background:#f59e0b}
    .pb-nf{background:#ef4444}
    .pb-er{background:#475569}
    .prog-legend{display:flex;gap:12px;margin-top:5px;font-size:11px;color:#64748b;flex-wrap:wrap}
    .leg-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px}

    /* Metrics grid */
    .metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px}
    .metric{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px 10px;text-align:center}
    .metric-val{font-size:26px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
    .metric-lbl{font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
    .m-ok   .metric-val{color:#22c55e} .m-ok{border-color:#166534}
    .m-rd   .metric-val{color:#f59e0b} .m-rd{border-color:#92400e}
    .m-nf   .metric-val{color:#ef4444} .m-nf{border-color:#991b1b}
    .m-err  .metric-val{color:#94a3b8}
    .m-score .metric-val{color:${healthColor};font-size:34px}

    /* Section table */
    .sec-tbl{width:100%;border-collapse:collapse;font-size:12px}
    .sec-tbl th,.sec-tbl td{padding:6px 10px;border-bottom:1px solid #1e293b;text-align:left}
    .sec-tbl th{background:#0f172a;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
    .sec-tbl tr:hover td{background:rgba(255,255,255,.02)}
    .ok-val{color:#22c55e}.rd-val{color:#f59e0b}.nf-val{color:#ef4444;font-weight:700}.er-val{color:#64748b}
    .pct-bad{background:#3f1d1d;color:#f87171;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:700}

    /* Controls */
    .controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    .controls input,.controls select{padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none;transition:border-color .15s}
    .controls input:focus,.controls select:focus{border-color:#3b82f6}
    .controls input{flex:1;min-width:220px}
    .btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#94a3b8;font-size:12px;cursor:pointer;white-space:nowrap;transition:all .15s}
    .btn:hover,.btn.active{background:#3b82f6;border-color:#3b82f6;color:#fff}
    .result-count{margin-left:auto;font-size:12px;color:#64748b;white-space:nowrap}

    /* Main table */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{position:sticky;top:0;z-index:2;background:#0f172a;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;font-size:11px;border-bottom:1px solid #334155;white-space:nowrap;cursor:pointer;user-select:none}
    th:hover{color:#e2e8f0}
    td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:middle}
    tr:hover td{background:rgba(255,255,255,.015)}
    .idx{color:#334155;text-align:right;width:38px;font-variant-numeric:tabular-nums}
    .cell-url{max-width:400px;word-break:break-all;font-size:11px}
    .cell-url a{color:#93c5fd}
    .cell-url a:hover{color:#60a5fa}
    .final-url{display:block;font-size:10px;color:#475569;margin-top:2px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
    .cell-section{color:#94a3b8;font-size:11px;white-space:nowrap}
    .cell-status{white-space:nowrap;font-weight:600}
    .cell-label{font-size:11px;color:#94a3b8;white-space:nowrap}
    .cell-chain code{font-size:10px}
    .cell-time{color:#475569;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}
    .cell-notes{max-width:240px}.notes-text{color:#f59e0b;font-size:11px}
    .cell-title{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#cbd5e1}
    .cell-h1{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#94a3b8}
    .cell-words{text-align:right;font-variant-numeric:tabular-nums;font-size:11px;color:#64748b}
    .cell-content{max-width:280px;font-size:11px}
    .content-issue{color:#fb923c}

    /* Row colours */
    .row-ok          td{background:rgba(34,197,94,.025)}
    .row-not-found   td{background:rgba(239,68,68,.05)}
    .row-redirect    td{background:rgba(245,158,11,.03)}
    .row-server-error td,.row-timeout td,.row-error td{background:rgba(100,116,139,.04)}
    .row-rate-limited td{background:rgba(249,115,22,.04)}

    .hidden{display:none!important}
    footer{text-align:center;padding:16px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:8px}
  </style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:260px">
        <h1>404 URL Validation Report</h1>
        <div class="meta">
          Run date: <strong style="color:#e2e8f0">${escHtml(runDate)}</strong> &nbsp;·&nbsp;
          Source: <code>${escHtml(path.basename(csvPath))}</code> &nbsp;·&nbsp;
          ${summary.total.toLocaleString()} URLs &nbsp;·&nbsp;
          ${CONCURRENCY} concurrent workers &nbsp;·&nbsp;
          avg ${summary.avgResponseMs}ms/URL
        </div>
        <div class="prog-wrap">
          <div class="prog">
            <div class="pb-ok"  style="width:${okPct}%"  title="${summary.ok} OK (${okPct}%)"></div>
            <div class="pb-rd"  style="width:${rdPct}%"  title="${summary.redirects} Redirects (${rdPct}%)"></div>
            <div class="pb-nf"  style="width:${nfPct}%"  title="${summary.notFound} Not Found (${nfPct}%)"></div>
            <div class="pb-er"  style="width:${errPct}%" title="${errCount} Errors (${errPct}%)"></div>
          </div>
          <div class="prog-legend">
            <span><span class="leg-dot" style="background:#22c55e"></span>OK ${okPct}%</span>
            <span><span class="leg-dot" style="background:#f59e0b"></span>Redirect ${rdPct}%</span>
            <span><span class="leg-dot" style="background:#ef4444"></span>404 ${nfPct}%</span>
            <span><span class="leg-dot" style="background:#475569"></span>Error ${errPct}%</span>
          </div>
        </div>
      </div>
      <div class="metric m-score" style="min-width:100px">
        <div class="metric-val">${healthScore}%</div>
        <div class="metric-lbl">Health Score</div>
      </div>
    </div>
  </div>

  <div class="metrics">
    <div class="metric m-ok">
      <div class="metric-val">${summary.ok.toLocaleString()}</div>
      <div class="metric-lbl">200 OK</div>
    </div>
    <div class="metric m-rd">
      <div class="metric-val">${summary.redirects.toLocaleString()}</div>
      <div class="metric-lbl">Redirects 3xx</div>
    </div>
    <div class="metric m-nf">
      <div class="metric-val">${summary.notFound.toLocaleString()}</div>
      <div class="metric-lbl">404 Not Found</div>
    </div>
    <div class="metric" style="border-color:#7f1d1d">
      <div class="metric-val" style="color:#f87171">${summary.serverErrors.toLocaleString()}</div>
      <div class="metric-lbl">Server Errors 5xx</div>
    </div>
    <div class="metric m-err">
      <div class="metric-val">${summary.timeouts.toLocaleString()}</div>
      <div class="metric-lbl">Timeouts</div>
    </div>
    ${
      summary.rateLimited > 0
        ? `<div class="metric" style="border-color:#9a3412">
      <div class="metric-val" style="color:#fb923c">${summary.rateLimited.toLocaleString()}</div>
      <div class="metric-lbl">Rate Limited 429</div>
    </div>`
        : ''
    }
    <div class="metric m-err">
      <div class="metric-val">${summary.errors.toLocaleString()}</div>
      <div class="metric-lbl">Network Errors</div>
    </div>
    <div class="metric" style="border-color:${summary.contentIssues > 0 ? '#92400e' : '#1e293b'}">
      <div class="metric-val" style="color:${summary.contentIssues > 0 ? '#fb923c' : '#22c55e'}">${summary.contentIssues.toLocaleString()}</div>
      <div class="metric-lbl">Content Issues</div>
    </div>
  </div>

  <div class="card">
    <h2>Section Breakdown</h2>
    <table class="sec-tbl">
      <thead>
        <tr>
          <th>Section</th><th>Total</th><th>200 OK</th>
          <th>Redirect</th><th>404</th><th>Error</th><th>404 Rate</th>
        </tr>
      </thead>
      <tbody>${sectionRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>URL Validation Results</h2>
    <div class="controls">
      <input id="q" placeholder="Search URL, path, or notes…" autocomplete="off">
      <select id="sf">
        <option value="">All Statuses</option>
        <option value="ok">🟢 200 OK</option>
        <option value="redirect">🟡 Redirects 3xx</option>
        <option value="not-found">🔴 404 Not Found</option>
        <option value="server-error">🔴 Server Errors 5xx</option>
        <option value="rate-limited">🟠 Rate Limited 429</option>
        <option value="timeout">⏱ Timeouts</option>
        <option value="error">❌ Network Errors</option>
      </select>
      <select id="sec">
        <option value="">All Sections</option>
        ${sectionOptions}
      </select>
      <select id="cf">
        <option value="">All Content</option>
        <option value="ok">🟢 Content OK</option>
        <option value="thin">🟡 Thin Content</option>
        <option value="soft-404">🔴 Soft 404</option>
        <option value="placeholder">🟠 Placeholder</option>
        <option value="warning">⚠ Warning</option>
        <option value="error">❌ Content Error</option>
      </select>
      <button class="btn" onclick="exportVisible()">⬇ Export CSV</button>
      <span class="result-count" id="rc">${results.length.toLocaleString()} URLs</span>
    </div>
    <div class="tbl-wrap">
      <table id="tbl">
        <thead>
          <tr>
            <th title="Row number">#</th>
            <th onclick="sortBy(1)" title="Sort by URL path">URL Path ↕</th>
            <th onclick="sortBy(2)" title="Sort by section">Section ↕</th>
            <th onclick="sortBy(3)" title="Sort by status code">Status ↕</th>
            <th>Label</th>
            <th>Redirect Chain</th>
            <th onclick="sortBy(6)" title="Sort by response time">Time ↕</th>
            <th>Notes</th>
            <th onclick="sortBy(8)">Page Title ↕</th>
            <th onclick="sortBy(9)">H1 ↕</th>
            <th onclick="sortBy(10)" title="Sort by word count">Words ↕</th>
            <th>Content Issues</th>
            <th>Checked</th>
          </tr>
        </thead>
        <tbody id="tbody">${tableRows}</tbody>
      </table>
    </div>
  </div>

  <footer>
    Generated by 404 URL Validator (Playwright TypeScript) &nbsp;·&nbsp;
    ${escHtml(runDate)} &nbsp;·&nbsp;
    ${summary.total.toLocaleString()} URLs checked
  </footer>
</div>

<script>
  const allRows = [...document.querySelectorAll('#tbody tr')];
  const q   = document.getElementById('q');
  const sf  = document.getElementById('sf');
  const sec = document.getElementById('sec');
  const cf  = document.getElementById('cf');
  const rc  = document.getElementById('rc');

  function applyFilters() {
    const qs = q.value.toLowerCase();
    const ss = sf.value;
    const se = sec.value;
    const sc = cf.value;
    let vis = 0;
    allRows.forEach(r => {
      const matchQ  = !qs || r.dataset.url.includes(qs) || r.textContent.toLowerCase().includes(qs);
      const matchSf = !ss || r.dataset.status === ss;
      const matchSe = !se || r.dataset.section === se;
      const matchCf = !sc || r.dataset.content === sc;
      const show = matchQ && matchSf && matchSe && matchCf;
      r.classList.toggle('hidden', !show);
      if (show) vis++;
    });
    rc.textContent = vis.toLocaleString() + ' URLs';
  }

  q.addEventListener('input', applyFilters);
  sf.addEventListener('change', applyFilters);
  sec.addEventListener('change', applyFilters);
  cf.addEventListener('change', applyFilters);

  let sortCol = -1, asc = true;
  function sortBy(col) {
    asc = sortCol === col ? !asc : true;
    sortCol = col;
    const tbody = document.getElementById('tbody');
    const rows = [...tbody.querySelectorAll('tr')];
    rows.sort((a, b) => {
      const ta = a.cells[col]?.textContent?.trim() ?? '';
      const tb = b.cells[col]?.textContent?.trim() ?? '';
      const na = parseFloat(ta); const nb = parseFloat(tb);
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
      return asc ? ta.localeCompare(tb) : tb.localeCompare(ta);
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  function exportVisible() {
    const vis = allRows.filter(r => !r.classList.contains('hidden'));
    const hdrs = ['#','Full URL','Section','Status Code','Status Label','Redirect Chain','Response Time (ms)','Notes','Checked At'];
    const lines = [hdrs.join(',')];
    vis.forEach(r => {
      const fullUrl = r.dataset.url || '';
      const cells = [
        r.cells[0]?.textContent?.trim() ?? '',
        fullUrl,
        r.cells[2]?.textContent?.trim() ?? '',
        r.cells[3]?.textContent?.replace(/[🟢🟡🔴🟠⏱❌]/g,'').trim() ?? '',
        r.cells[4]?.textContent?.trim() ?? '',
        r.cells[5]?.textContent?.trim() ?? '',
        r.cells[6]?.textContent?.replace('ms','').trim() ?? '',
        r.cells[7]?.textContent?.trim() ?? '',
        r.cells[8]?.textContent?.trim() ?? '',
      ].map(v => '"' + String(v).replace(/"/g,'""') + '"');
      lines.push(cells.join(','));
    });
    const blob = new Blob([lines.join('\\n')], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '404-validation-export.csv';
    a.click();
  }
</script>
</body>
</html>`;
}

// ─── Excel Report ─────────────────────────────────────────────────────────────

// ARGB colour helpers
const C = {
  dark:      'FF0F172A',
  card:      'FF111827',
  border:    'FF1E293B',
  headerBg:  'FF0F172A',
  headerFg:  'FF94A3B8',
  text:      'FFE2E8F0',
  muted:     'FF64748B',

  green:     'FF22C55E',
  greenBg:   'FF052E16',
  yellow:    'FFF59E0B',
  yellowBg:  'FF422006',
  red:       'FFEF4444',
  redBg:     'FF450A0A',
  orange:    'FFFB923C',
  orangeBg:  'FF431407',
  gray:      'FF475569',
  grayBg:    'FF1E293B',
  white:     'FFFFFFFF',

  rowOk:     'FF0A1F0A',
  rowRd:     'FF1A1400',
  rowNf:     'FF1A0505',
  rowSvr:    'FF111827',
  rowErr:    'FF111827',
};

type Fill = ExcelJS.FillPattern;
function solidFill(argb: string): Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

type Alignment = Partial<ExcelJS.Alignment>;
const LEFT: Alignment  = { horizontal: 'left',  vertical: 'middle', wrapText: false };
const CENTER: Alignment = { horizontal: 'center', vertical: 'middle' };

type Border = Partial<ExcelJS.Borders>;
function thinBorder(argb: string): Border {
  const side: ExcelJS.BorderStyle = 'thin';
  const b = { style: side, color: { argb } } as ExcelJS.Border;
  return { top: b, bottom: b, left: b, right: b };
}

function styleHeader(row: ExcelJS.Row, bgArgb: string = C.headerBg): void {
  row.eachCell((cell) => {
    cell.fill  = solidFill(bgArgb);
    cell.font  = { bold: true, color: { argb: C.headerFg }, size: 10 };
    cell.alignment = { ...CENTER, wrapText: false };
    cell.border = thinBorder(C.border);
  });
  row.height = 22;
}

function styleDataRow(row: ExcelJS.Row, fillArgb: string): void {
  row.eachCell((cell) => {
    cell.fill   = solidFill(fillArgb);
    cell.font   = { color: { argb: C.text }, size: 10 };
    cell.border = thinBorder(C.border);
    cell.alignment = LEFT as ExcelJS.Alignment;
  });
  row.height = 18;
}

function rowFill(cat: StatusCategory): string {
  switch (cat) {
    case 'ok':           return C.rowOk;
    case 'redirect':     return C.rowRd;
    case 'not-found':    return C.rowNf;
    case 'server-error': return C.rowSvr;
    default:             return C.rowErr;
  }
}

function statusColor(cat: StatusCategory): string {
  switch (cat) {
    case 'ok':           return C.green;
    case 'redirect':     return C.yellow;
    case 'not-found':    return C.red;
    case 'server-error': return C.red;
    case 'rate-limited': return C.orange;
    default:             return C.gray;
  }
}

async function generateExcel(
  results: UrlResult[],
  summary: Summary,
  outPath: string,
  runDate: string,
  csvPath: string
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '404 URL Validator';
  wb.created = new Date();

  // ── Sheet 1: Summary ────────────────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF3B82F6' } } });
  ws1.views = [{ showGridLines: false }];

  const addSummaryTitle = (ws: ExcelJS.Worksheet, text: string, row: number) => {
    const r = ws.getRow(row);
    r.getCell(1).value = text;
    r.getCell(1).font = { bold: true, size: 14, color: { argb: C.text } };
    r.getCell(1).fill = solidFill(C.card);
    ws.mergeCells(`A${row}:G${row}`);
    r.height = 28;
  };

  addSummaryTitle(ws1, `404 URL Validation Report — ${runDate}`, 1);

  const metaRows = [
    ['Source file', path.basename(csvPath)],
    ['Run date', runDate],
    ['Total URLs', summary.total],
    ['Concurrency', `${CONCURRENCY} workers`],
    ['Avg response time', `${summary.avgResponseMs}ms`],
  ];
  metaRows.forEach(([k, v], i) => {
    const r = ws1.getRow(i + 2);
    r.getCell(1).value = k;
    r.getCell(1).font  = { color: { argb: C.muted }, size: 10 };
    r.getCell(2).value = v;
    r.getCell(2).font  = { bold: true, color: { argb: C.text }, size: 10 };
    [1, 2].forEach((c) => { r.getCell(c).fill = solidFill(C.dark); });
    r.height = 16;
  });

  ws1.addRow([]);

  // Status summary table
  const statsStart = metaRows.length + 3;
  const statsHdr = ws1.getRow(statsStart);
  statsHdr.values = ['', 'Category', 'Count', 'Percentage'];
  styleHeader(statsHdr, C.card);
  statsHdr.height = 20;

  const statsData: [string, string, number][] = [
    [C.green,  '200 OK',           summary.ok],
    [C.yellow, 'Redirects 3xx',    summary.redirects],
    [C.red,    '404 Not Found',    summary.notFound],
    [C.red,    'Server Errors 5xx',summary.serverErrors],
    [C.orange, 'Rate Limited 429', summary.rateLimited],
    [C.gray,   'Timeouts',         summary.timeouts],
    [C.gray,   'Network Errors',   summary.errors],
  ];

  statsData.forEach(([color, label, count], i) => {
    const r = ws1.getRow(statsStart + 1 + i);
    const dot = ws1.getCell(`A${statsStart + 1 + i}`);
    dot.value = '●';
    dot.font  = { color: { argb: color }, size: 14 };
    dot.fill  = solidFill(C.dark);
    dot.alignment = CENTER;

    const labelCell = r.getCell(2);
    labelCell.value = label;
    labelCell.font  = { bold: count > 0, color: { argb: C.text }, size: 10 };
    labelCell.fill  = solidFill(C.dark);

    const countCell = r.getCell(3);
    countCell.value = count;
    countCell.numFmt = '#,##0';
    countCell.font   = { bold: true, color: { argb: color }, size: 11 };
    countCell.fill   = solidFill(C.dark);
    countCell.alignment = CENTER;

    const pctCell = r.getCell(4);
    pctCell.value  = summary.total > 0 ? count / summary.total : 0;
    pctCell.numFmt = '0.0%';
    pctCell.font   = { color: { argb: C.muted }, size: 10 };
    pctCell.fill   = solidFill(C.dark);
    pctCell.alignment = CENTER;

    r.height = 18;
  });

  ws1.addRow([]);
  const secStart = statsStart + statsData.length + 2;

  // Section breakdown
  const secTitleRow = ws1.getRow(secStart);
  secTitleRow.getCell(1).value = 'Section Breakdown';
  secTitleRow.getCell(1).font  = { bold: true, size: 12, color: { argb: C.text } };
  ws1.mergeCells(`A${secStart}:G${secStart}`);
  secTitleRow.height = 22;

  const secHdr = ws1.getRow(secStart + 1);
  secHdr.values = ['Section', 'Total', '200 OK', 'Redirects', '404 Not Found', 'Errors', '404 Rate'];
  styleHeader(secHdr);

  Object.entries(summary.sections)
    .sort(([, a], [, b]) => b.total - a.total)
    .forEach(([name, sec], i) => {
      const r = ws1.getRow(secStart + 2 + i);
      r.values = [
        name,
        sec.total,
        sec.ok,
        sec.redirect,
        sec.notFound,
        sec.error,
        sec.total > 0 ? sec.notFound / sec.total : 0,
      ];
      r.getCell(7).numFmt = '0%';
      styleDataRow(r, i % 2 === 0 ? C.dark : C.card);
      if (sec.notFound > 0) {
        r.getCell(5).font = { bold: true, color: { argb: C.red }, size: 10 };
        r.getCell(7).font = { bold: true, color: { argb: C.red }, size: 10 };
      }
    });

  ws1.getColumn(1).width = 22;
  ws1.getColumn(2).width = 12;
  ws1.getColumn(3).width = 12;
  ws1.getColumn(4).width = 12;
  ws1.getColumn(5).width = 16;
  ws1.getColumn(6).width = 12;
  ws1.getColumn(7).width = 12;

  // ── Sheet helper: full URL table ────────────────────────────────────────────
  const DATA_COLS = [
    { header: '#',               width: 6  },
    { header: 'Full URL',        width: 55 },
    { header: 'URL Path',        width: 42 },
    { header: 'Section',         width: 16 },
    { header: 'Status Code',     width: 13 },
    { header: 'Status Label',    width: 26 },
    { header: 'Redirect Chain',  width: 20 },
    { header: 'Final URL',       width: 44 },
    { header: 'Response (ms)',   width: 14 },
    { header: 'Notes',           width: 30 },
    { header: 'Page Title',      width: 40 },
    { header: 'H1 Heading',      width: 40 },
    { header: 'Word Count',      width: 12 },
    { header: 'Content Status',  width: 16 },
    { header: 'Content Issues',  width: 55 },
    { header: 'Checked At',      width: 22 },
  ];

  function addDataSheet(
    name: string,
    tabColor: string,
    rows: UrlResult[]
  ): ExcelJS.Worksheet {
    const ws = wb.addWorksheet(name, { properties: { tabColor: { argb: tabColor } } });
    ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];

    DATA_COLS.forEach((col, i) => {
      ws.getColumn(i + 1).width = col.width;
    });

    const hdr = ws.addRow(DATA_COLS.map((c) => c.header));
    styleHeader(hdr, 'FF1E293B');

    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: DATA_COLS.length },
    };

    rows.forEach((r) => {
      const row = ws.addRow([
        r.index,
        r.url,
        r.urlPath,
        r.section,
        r.finalStatus || '',
        r.statusLabel,
        r.redirectChain,
        r.finalUrl,
        r.responseTimeMs,
        r.notes,
        r.pageTitle,
        r.h1,
        r.wordCount > 0 ? r.wordCount : '',
        r.contentStatus !== 'skipped' ? r.contentStatus : '',
        r.contentIssues,
        r.checkedAt,
      ]);

      styleDataRow(row, rowFill(r.statusCategory));

      // URL cell as hyperlink
      const urlCell = row.getCell(2);
      urlCell.value = { text: r.url, hyperlink: r.url };
      urlCell.font  = { color: { argb: 'FF60A5FA' }, underline: true, size: 10 };

      // Status code coloured
      const stCell = row.getCell(5);
      stCell.font = { bold: true, color: { argb: statusColor(r.statusCategory) }, size: 10 };
      stCell.alignment = CENTER;

      // Index right-aligned, muted
      row.getCell(1).font      = { color: { argb: C.muted }, size: 10 };
      row.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    });

    return ws;
  }

  // ── Sheet 2: All URLs ───────────────────────────────────────────────────────
  addDataSheet('All URLs', 'FF1E293B', results);

  // ── Sheet 3: 404 Not Found ──────────────────────────────────────────────────
  const notFound = results.filter((r) => r.statusCategory === 'not-found');
  addDataSheet(`404 Not Found (${notFound.length})`, 'FF991B1B', notFound);

  // ── Sheet 4: Redirects ──────────────────────────────────────────────────────
  const redirects = results.filter((r) => r.statusCategory === 'redirect');
  addDataSheet(`Redirects (${redirects.length})`, 'FF92400E', redirects);

  // ── Sheet 5: Errors ─────────────────────────────────────────────────────────
  const errors = results.filter(
    (r) => !['ok', 'redirect', 'not-found'].includes(r.statusCategory)
  );
  if (errors.length > 0) {
    addDataSheet(`Errors (${errors.length})`, 'FF374151', errors);
  }

  // ── Sheet 6: Content Issues ─────────────────────────────────────────────────
  const contentIssueRows = results.filter((r) => r.contentIssues);
  if (contentIssueRows.length > 0) {
    addDataSheet(`Content Issues (${contentIssueRows.length})`, 'FF7C2D12', contentIssueRows);
  }

  await wb.xlsx.writeFile(outPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse --input flag
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const cliInput = inputFlag >= 0 ? args[inputFlag + 1] : undefined;

  const csvPath = resolveInputCsv(cliInput);
  const urls = parseCsvUrls(csvPath);

  // Derive run date from the CSV folder name (or today if not in dated folder)
  const folderName = path.basename(path.dirname(csvPath));
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(folderName)
    ? folderName
    : new Date().toISOString().slice(0, 10);

  const outDir = path.join(ROOT, 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });

  const htmlOut  = path.join(outDir, `404-validation-${runDate}.html`);
  const xlsxOut  = path.join(outDir, `404-validation-${runDate}.xlsx`);

  console.log(`\n🔍  404 URL Validator — Playwright TypeScript`);
  console.log(`    Input   : ${csvPath}`);
  console.log(`    URLs    : ${urls.length.toLocaleString()}`);
  console.log(`    Workers : ${CONCURRENCY} concurrent`);
  console.log(`    Output  : ${outDir}\n`);

  const startTime = Date.now();
  let lastLog = 0;

  const results = await processUrls(urls, (r, done) => {
    const now = Date.now();
    if (now - lastLog > 800 || done === urls.length) {
      const pct = Math.round((done / urls.length) * 100);
      const elapsed = ((now - startTime) / 1000).toFixed(1);
      const icon =
        r.statusCategory === 'ok'       ? '✅' :
        r.statusCategory === 'redirect' ? '↪ ' :
        r.statusCategory === 'not-found'? '❌' :
        r.statusCategory === 'timeout'  ? '⏱ ' : '⚠ ';
      process.stdout.write(
        `\r  [${String(done).padStart(4)}/${urls.length}] ${pct}%  ${icon} ${r.statusLabel.slice(0, 20).padEnd(20)}  ${elapsed}s`
      );
      lastLog = now;
    }
  });

  console.log(`\n\n  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  const summary = computeSummary(results);

  // Print summary
  const line = '─'.repeat(44);
  console.log(`  ${line}`);
  console.log(`  ✅ 200 OK               : ${summary.ok.toLocaleString().padStart(6)}`);
  console.log(`  ↪  Redirects 3xx        : ${summary.redirects.toLocaleString().padStart(6)}`);
  console.log(`  ❌ 404 Not Found        : ${summary.notFound.toLocaleString().padStart(6)}`);
  console.log(`  🔴 Server Errors 5xx    : ${summary.serverErrors.toLocaleString().padStart(6)}`);
  console.log(`  🟠 Rate Limited 429     : ${summary.rateLimited.toLocaleString().padStart(6)}`);
  console.log(`  ⏱  Timeouts             : ${summary.timeouts.toLocaleString().padStart(6)}`);
  console.log(`  ❓ Network Errors       : ${summary.errors.toLocaleString().padStart(6)}`);
  console.log(`  ${line}`);
  console.log(`  📋 Total URLs           : ${summary.total.toLocaleString().padStart(6)}`);
  console.log(`  ⚡ Avg response time    : ${String(summary.avgResponseMs + 'ms').padStart(6)}`);
  console.log(`  📝 Content Issues       : ${summary.contentIssues.toLocaleString().padStart(6)}`);
  console.log(`  ${line}\n`);

  process.stdout.write('  Generating HTML report…');
  const html = generateHtml(results, summary, runDate, csvPath);
  fs.writeFileSync(htmlOut, html, 'utf8');
  console.log(` ✅  (${Math.round(html.length / 1024)}KB)`);

  process.stdout.write('  Generating Excel report…');
  await generateExcel(results, summary, xlsxOut, runDate, csvPath);
  const xlsxKb = Math.round(fs.statSync(xlsxOut).size / 1024);
  console.log(` ✅  (${xlsxKb}KB)`);

  console.log(`\n  📄 HTML : ${htmlOut}`);
  console.log(`  📊 Excel: ${xlsxOut}\n`);

  if (summary.notFound > 0) {
    console.log(`  ⚠  ${summary.notFound} URLs returned 404 — check the "404 Not Found" sheet in Excel or filter the HTML report.\n`);
  }
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err?.message ?? err);
  process.exit(1);
});
