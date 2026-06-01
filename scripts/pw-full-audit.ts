#!/usr/bin/env ts-node
/**
 * Playwright Full Audit — 404 Validation + Internal Links
 *
 * Uses a real Chromium browser to bypass Cloudflare.
 * Single pass: navigates every sitemap URL once, captures HTTP status
 * AND extracts internal links simultaneously.
 *
 * Phase 1 (Browser, concurrent): Visit all sitemap URLs
 *   → capture final status, redirect chain, page title, H1
 *   → extract every internal <a href> on each page
 *
 * Phase 2 (HTTP, fast): Verify all unique internal links discovered
 *
 * Phase 3: Write four reports into reports/YYYY-MM-DD/
 *   → 404-browser-YYYY-MM-DD.html   (404/redirect check)
 *   → 404-browser-YYYY-MM-DD.xlsx
 *   → internal-links-browser-YYYY-MM-DD.html (link audit)
 *   → internal-links-browser-YYYY-MM-DD.xlsx
 *
 * Usage:
 *   npm run pw-audit
 *   CONCURRENCY=6 npm run pw-audit
 *   npm run pw-audit -- --input input/2026-05-25/file.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '5', 10);
const NAV_TIMEOUT = 40_000;   // ms per page navigation
const HTTP_TIMEOUT = 15_000;  // ms for link verification HTTP calls
const HTTP_RETRIES = 2;
const HTTP_RETRY_DELAY = 2_000;
const NAV_THRESHOLD = 0.5;    // link on >50% pages = sitewide

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusCat = 'ok' | 'redirect' | 'not-found' | 'server-error' | 'error' | 'timeout';

interface PageResult {
  index:          number;
  url:            string;
  urlPath:        string;
  section:        string;
  finalStatus:    number;
  statusLabel:    string;
  statusCat:      StatusCat;
  redirectChain:  string;    // e.g. "301 → 200"
  finalUrl:       string;    // non-empty only if URL changed
  responseMs:     number;
  notes:          string;
  checkedAt:      string;
  pageTitle:      string;
  h1:             string;
  internalLinks:  string[];  // raw hrefs found on this page
}

interface LinkStatus {
  url:         string;
  finalStatus: number;
  label:       string;
  isBroken:    boolean;
  redirectChain: string;
}

interface LinkRow {
  sourcePage:    string;
  section:       string;
  linkText:      string;
  linkUrl:       string;
  finalStatus:   number;
  label:         string;
  isBroken:      boolean;
  isNavLink:     boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPath(raw: string): string {
  try { return new URL(raw).pathname || '/'; } catch { return raw; }
}

const SECTION_MAP: Record<string, string> = {
  faculty:        'Faculty',
  academics:      'Academics',
  about:          'About',
  'campus-life':  'Campus Life',
  'admissions-aid':'Admissions & Aid',
};

function extractSection(raw: string): string {
  try {
    const parts = new URL(raw).pathname.split('/').filter(Boolean);
    if (!parts.length) return 'Home';
    return SECTION_MAP[parts[0]!] ?? parts[0]!;
  } catch { return 'Unknown'; }
}

function labelFromStatus(s: number): string {
  const M: Record<number, string> = {
    200: '200 OK', 301: '301 Moved Permanently', 302: '302 Found',
    307: '307 Temporary Redirect', 308: '308 Permanent Redirect',
    400: '400 Bad Request', 401: '401 Unauthorized', 403: '403 Forbidden',
    404: '404 Not Found', 410: '410 Gone', 429: '429 Too Many Requests',
    500: '500 Internal Server Error', 502: '502 Bad Gateway',
    503: '503 Service Unavailable', 504: '504 Gateway Timeout',
  };
  return M[s] ?? (s > 0 ? `HTTP ${s}` : 'Network Error');
}

function categorizeFinal(status: number, notes: string, hadRedirect: boolean): StatusCat {
  if (status === 200 && hadRedirect) return 'redirect';
  if (status === 200)               return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 404 || status === 410) return 'not-found';
  if (status >= 500)                return 'server-error';
  if (notes.includes('TIMEOUT'))    return 'timeout';
  return 'error';
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── HTTP link verifier (lightweight, not browser) ────────────────────────────

function httpHead(urlStr: string): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,*/*;q=0.8',
        Connection: 'close',
      },
      timeout: HTTP_TIMEOUT,
    }, res => {
      res.destroy();
      resolve({ status: res.statusCode ?? 0, location: res.headers['location'] ?? null });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.on('error', reject);
    req.end();
  });
}

async function verifyLink(urlStr: string): Promise<LinkStatus> {
  const chain: number[] = [];
  let cur = urlStr;

  for (let attempt = 0; attempt <= HTTP_RETRIES; attempt++) {
    if (attempt > 0) await new Promise<void>(r => setTimeout(r, HTTP_RETRY_DELAY * attempt));
    try {
      for (let hop = 0; hop <= 10; hop++) {
        const { status, location } = await httpHead(cur);
        chain.push(status);
        if (status >= 300 && status < 400 && location) {
          cur = new URL(location, cur).toString();
        } else {
          const finalStatus = status;
          return {
            url: urlStr,
            finalStatus,
            label: labelFromStatus(finalStatus),
            isBroken: finalStatus === 0 || finalStatus === 404 || finalStatus === 410 || finalStatus >= 500,
            redirectChain: chain.length > 1 ? chain.join(' → ') : String(chain[0] ?? '—'),
          };
        }
      }
      return { url: urlStr, finalStatus: 0, label: 'Too many redirects', isBroken: true, redirectChain: chain.join(' → ') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === HTTP_RETRIES) {
        return { url: urlStr, finalStatus: 0, label: `ERROR: ${msg}`, isBroken: true, redirectChain: chain.join(' → ') || '—' };
      }
    }
  }
  return { url: urlStr, finalStatus: 0, label: 'Unknown error', isBroken: true, redirectChain: '—' };
}

// ─── Input CSV ────────────────────────────────────────────────────────────────

function resolveInputCsv(cliArg?: string): string {
  if (cliArg) {
    const abs = path.resolve(ROOT, cliArg);
    if (!fs.existsSync(abs)) throw new Error(`Input file not found: ${abs}`);
    return abs;
  }
  const inputDir = path.join(ROOT, 'input');
  const dated = fs.readdirSync(inputDir)
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  if (!dated.length) throw new Error('No YYYY-MM-DD folders in input/');
  const folder = path.join(inputDir, dated[0]!);
  const csvs = fs.readdirSync(folder).filter(f => f.endsWith('.csv'));
  if (!csvs.length) throw new Error(`No CSV in ${folder}`);
  return path.join(folder, csvs[0]!);
}

function parseCsvUrls(csvPath: string): string[] {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const first = lines[0]!.toLowerCase();
  const start = (first === 'url' || first.startsWith('url,')) ? 1 : 0;
  return lines.slice(start).map(line => {
    const val = line.startsWith('"') ? line.slice(1, line.lastIndexOf('"')) : line.split(',')[0]!;
    return val.trim();
  }).filter(u => { try { new URL(u); return true; } catch { return false; } });
}

// ─── Phase 1 — browser crawl ──────────────────────────────────────────────────

async function crawlAllUrls(
  urls: string[],
  onResult: (r: PageResult, done: number) => void,
): Promise<PageResult[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const results: PageResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx]!;
      const ctx = await browser.newContext({
        userAgent: USER_AGENT,
        ignoreHTTPSErrors: true,
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const page = await ctx.newPage();

      // Block heavy resources to speed up navigation
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,mp4,mp3,pdf}', r => r.abort());

      const navResponses: { url: string; status: number }[] = [];
      page.on('response', resp => {
        if (resp.request().resourceType() === 'document') {
          navResponses.push({ url: resp.url(), status: resp.status() });
        }
      });

      const start = Date.now();
      let notes = '';
      let finalStatus = 0;
      let pageTitle = '';
      let h1 = '';
      const internalLinks: string[] = [];

      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        finalStatus = resp?.status() ?? 0;

        // Give JS-rendered content / anti-bot interstitials time to settle
        await page.waitForTimeout(1200);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        pageTitle = (await page.title()).trim();

        h1 = await page.evaluate(() => {
          const el = document.querySelector('main h1, article h1, .entry-content h1, h1');
          return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
        }).catch(() => '');

        // Extract internal links
        const host = new URL(url).hostname.replace(/^www\./, '');
        try {
          const hrefs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]'))
              .map((a) => a.getAttribute('href') ?? '')
              .filter(Boolean);
          });
          for (const raw of hrefs) {
            if (/^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
            try {
              const u = new URL(raw, url);
              const h = u.hostname.replace(/^www\./, '');
              if (h !== host) continue;
              u.hash = '';
              internalLinks.push(u.toString());
            } catch (_) { /* skip */ }
          }
        } catch (_) { /* skip on page error */ }

        // Soft 404 detection (only reliable signals, no false alarms)
        if (finalStatus === 200 && /^(page not found|404|not found)/i.test(pageTitle)) {
          notes = 'Soft 404 — page title indicates "not found" but status is 200';
        }

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notes = msg.includes('timeout') || msg.includes('Timeout')
          ? `TIMEOUT — no response within ${NAV_TIMEOUT / 1000}s`
          : `ERROR: ${msg}`;
        finalStatus = 0;
      } finally {
        await ctx.close();
      }

      const hadRedirect = navResponses.length > 1
        || (navResponses.length === 1 && navResponses[0]!.status >= 300 && navResponses[0]!.status < 400);
      const redirectChain = navResponses.length > 1
        ? navResponses.map(r => r.status).join(' → ')
        : String(navResponses[0]?.status ?? finalStatus ?? '—');

      const finalUrl = page.url() !== url ? page.url() : '';

      let statusLabel = labelFromStatus(finalStatus);
      if (notes.startsWith('TIMEOUT') || notes.startsWith('ERROR')) statusLabel = notes.slice(0, 40);
      else if (hadRedirect && finalStatus === 200)
        statusLabel = `${labelFromStatus(navResponses[0]!.status)} → 200 OK`;

      const result: PageResult = {
        index: idx + 1,
        url,
        urlPath: extractPath(url),
        section: extractSection(url),
        finalStatus,
        statusLabel,
        statusCat: categorizeFinal(finalStatus, notes, hadRedirect),
        redirectChain,
        finalUrl,
        responseMs: Date.now() - start,
        notes,
        checkedAt: new Date().toISOString(),
        pageTitle,
        h1,
        internalLinks,
      };

      results.push(result);
      onResult(result, results.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  await browser.close();

  return results.sort((a, b) => a.index - b.index);
}

// ─── Phase 2 — verify unique internal links ────────────────────────────────────

interface ExtractedLink {
  linkUrl:    string;
  sourcePage: string;
  section:    string;
  linkText:   string;
}

async function verifyUniqueLinks(
  pageResults: PageResult[],
  onDone: (done: number, total: number) => void,
): Promise<{ linkRows: LinkRow[]; uniqueStatuses: Map<string, LinkStatus> }> {
  // Build map: linkUrl → { pages, linkText }
  const linkMap = new Map<string, { pages: string[]; section: string; linkText: string }>();

  for (const pr of pageResults) {
    // Only extract links from pages that loaded OK
    if (pr.finalStatus !== 200) continue;
    const seen = new Set<string>();
    for (const href of pr.internalLinks) {
      if (seen.has(href)) continue;
      seen.add(href);
      if (!linkMap.has(href)) {
        linkMap.set(href, { pages: [], section: pr.section, linkText: '' });
      }
      linkMap.get(href)!.pages.push(pr.url);
    }
  }

  const uniqueUrls = [...linkMap.keys()];
  const totalPages = pageResults.filter(r => r.finalStatus === 200).length;
  const uniqueStatuses = new Map<string, LinkStatus>();

  // Verify in parallel batches
  let cursor = 0;
  const CHECK_CONCURRENCY = 15;

  async function worker(): Promise<void> {
    while (cursor < uniqueUrls.length) {
      const idx = cursor++;
      const u = uniqueUrls[idx]!;
      const status = await verifyLink(u);
      uniqueStatuses.set(u, status);
      onDone(uniqueStatuses.size, uniqueUrls.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, uniqueUrls.length) }, worker));

  // Build link rows
  const linkRows: LinkRow[] = [];
  for (const pr of pageResults) {
    if (pr.finalStatus !== 200) continue;
    const seen = new Set<string>();
    for (const href of pr.internalLinks) {
      if (seen.has(href)) continue;
      seen.add(href);
      const status = uniqueStatuses.get(href);
      if (!status) continue;
      const info = linkMap.get(href)!;
      const isNavLink = (info.pages.length / totalPages) >= NAV_THRESHOLD;
      linkRows.push({
        sourcePage: pr.url,
        section: pr.section,
        linkText: '',
        linkUrl: href,
        finalStatus: status.finalStatus,
        label: status.label,
        isBroken: status.isBroken,
        isNavLink,
      });
    }
  }

  return { linkRows, uniqueStatuses };
}

// ─── HTML — 404 report ────────────────────────────────────────────────────────

function build404Html(results: PageResult[], runDate: string, csvPath: string): string {
  const total      = results.length;
  const ok         = results.filter(r => r.statusCat === 'ok').length;
  const redirects  = results.filter(r => r.statusCat === 'redirect').length;
  const notFound   = results.filter(r => r.statusCat === 'not-found').length;
  const errors     = results.filter(r => !['ok','redirect','not-found'].includes(r.statusCat)).length;
  const score      = total > 0 ? Math.round((ok / total) * 100) : 0;
  const scoreColor = score >= 90 ? '#22c55e' : score >= 70 ? '#f59e0b' : '#ef4444';

  const catDot: Record<StatusCat, string> = {
    ok: '🟢', redirect: '🟡', 'not-found': '🔴',
    'server-error': '🔴', error: '❌', timeout: '⏱',
  };

  // Section summary
  const sections: Record<string, { ok: number; redirect: number; notFound: number; error: number; total: number }> = {};
  for (const r of results) {
    if (!sections[r.section]) sections[r.section] = { ok: 0, redirect: 0, notFound: 0, error: 0, total: 0 };
    const s = sections[r.section]!;
    s.total++;
    if (r.statusCat === 'ok') s.ok++;
    else if (r.statusCat === 'redirect') s.redirect++;
    else if (r.statusCat === 'not-found') s.notFound++;
    else s.error++;
  }

  const sectionRows = Object.entries(sections).sort(([,a],[,b]) => b.total - a.total).map(([name, s]) => {
    const icon = s.notFound > 0 ? '🔴' : s.redirect > 0 ? '🟡' : '🟢';
    return `<tr><td>${icon} <strong>${escHtml(name)}</strong></td>
      <td>${s.total}</td><td class="ok-v">${s.ok}</td>
      <td class="rd-v">${s.redirect}</td><td class="nf-v">${s.notFound}</td><td class="er-v">${s.error}</td></tr>`;
  }).join('');

  const tableRows = results.map(r => {
    const dot = catDot[r.statusCat];
    const href = escHtml(r.url);
    const pathCell = escHtml(r.urlPath);
    const finalUrlCell = r.finalUrl ? `<div class="furl">→ ${escHtml(r.finalUrl.replace(/^https?:\/\/[^/]+/,''))}</div>` : '';
    const time = new Date(r.checkedAt).toLocaleTimeString('en-US',{hour12:false});
    const noteCell = r.notes ? `<span class="note">${escHtml(r.notes.slice(0,80))}</span>` : '—';
    return `<tr class="row-${r.statusCat}" data-status="${r.statusCat}" data-section="${escHtml(r.section.toLowerCase())}" data-url="${href}">
      <td class="idx">${r.index}</td>
      <td class="cu"><a href="${href}" target="_blank">${pathCell}</a>${finalUrlCell}</td>
      <td class="cs">${escHtml(r.section)}</td>
      <td class="cst">${dot} <code>${r.finalStatus||'—'}</code></td>
      <td class="csl">${escHtml(r.statusLabel)}</td>
      <td class="cch"><code>${escHtml(r.redirectChain)}</code></td>
      <td class="ct">${r.responseMs}ms</td>
      <td class="cn">${noteCell}</td>
      <td class="ctitle" title="${escHtml(r.pageTitle)}">${escHtml(r.pageTitle||'—')}</td>
      <td class="ch1" title="${escHtml(r.h1)}">${escHtml(r.h1||'—')}</td>
      <td class="ctime">${time}</td>
    </tr>`;
  }).join('\n');

  const sectionOptions = Object.keys(sections).sort().map(s =>
    `<option value="${s.toLowerCase()}">${escHtml(s)}</option>`).join('');

  const okPct  = ((ok/total)*100).toFixed(1);
  const rdPct  = ((redirects/total)*100).toFixed(1);
  const nfPct  = ((notFound/total)*100).toFixed(1);
  const errPct = ((errors/total)*100).toFixed(1);

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 Validation (Browser) — ${escHtml(runDate)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;line-height:1.4}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:11px;background:#0f172a;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc}
.wrap{max-width:1500px;margin:0 auto}
.card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:18px 20px;margin-bottom:16px}
h1{font-size:22px;font-weight:800;color:#f1f5f9;margin-bottom:4px}
h2{font-size:15px;font-weight:700;color:#f1f5f9;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b}
.meta{color:#64748b;font-size:12px}
.prog{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#1e293b;margin:10px 0}
.pb-ok{background:#22c55e}.pb-rd{background:#f59e0b}.pb-nf{background:#ef4444}.pb-er{background:#475569}
.prog-legend{display:flex;gap:12px;font-size:11px;color:#64748b;flex-wrap:wrap}
.leg{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:3px}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.metric{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;text-align:center}
.mv{font-size:26px;font-weight:800;line-height:1.1}
.ml{font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
.m-ok{border-color:#166534}.m-ok .mv{color:#22c55e}
.m-rd{border-color:#92400e}.m-rd .mv{color:#f59e0b}
.m-nf{border-color:#991b1b}.m-nf .mv{color:#ef4444}
.m-sc{min-width:100px}.m-sc .mv{color:${scoreColor};font-size:34px}
.stbl{width:100%;border-collapse:collapse;font-size:12px}
.stbl th,.stbl td{padding:6px 10px;border-bottom:1px solid #1e293b;text-align:left}
.stbl th{background:#0f172a;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase}
.ok-v{color:#22c55e}.rd-v{color:#f59e0b}.nf-v{color:#ef4444;font-weight:700}.er-v{color:#64748b}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.controls input,.controls select{padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px}
.controls input{flex:1;min-width:220px}
.btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#94a3b8;font-size:12px;cursor:pointer;white-space:nowrap}
.btn:hover{background:#3b82f6;border-color:#3b82f6;color:#fff}
.rc{margin-left:auto;font-size:12px;color:#64748b;white-space:nowrap}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{position:sticky;top:0;z-index:2;background:#0f172a;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;font-size:11px;border-bottom:1px solid #334155;white-space:nowrap;cursor:pointer}
td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.015)}
.idx{color:#334155;text-align:right;width:38px}
.cu{max-width:380px;word-break:break-all;font-size:11px}
.cu a{color:#93c5fd}
.furl{font-size:10px;color:#475569;font-style:italic;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
.cs{color:#94a3b8;font-size:11px;white-space:nowrap}
.cst{white-space:nowrap;font-weight:600}
.csl{font-size:11px;color:#94a3b8;white-space:nowrap}
.ct,.ctime{color:#475569;white-space:nowrap;font-size:11px}
.cn{max-width:220px}.note{color:#f59e0b;font-size:11px}
.ctitle,.ch1{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#cbd5e1}
.row-ok td{background:rgba(34,197,94,.025)}
.row-not-found td{background:rgba(239,68,68,.05)}
.row-redirect td{background:rgba(245,158,11,.03)}
.row-server-error td,.row-timeout td,.row-error td{background:rgba(100,116,139,.04)}
.hidden{display:none!important}
.browser-badge{display:inline-block;background:#1e3a5f;color:#60a5fa;border:1px solid #1e40af;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;margin-left:8px}
footer{text-align:center;padding:16px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:8px}
</style></head><body>
<div class="wrap">
<div class="card">
  <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
    <div style="flex:1;min-width:260px">
      <h1>404 URL Validation Report <span class="browser-badge">🌐 Real Browser</span></h1>
      <div class="meta">Run date: <strong style="color:#e2e8f0">${escHtml(runDate)}</strong> &nbsp;·&nbsp;
        Source: <code>${escHtml(path.basename(csvPath))}</code> &nbsp;·&nbsp;
        ${total.toLocaleString()} URLs &nbsp;·&nbsp; ${CONCURRENCY} concurrent &nbsp;·&nbsp; Chromium (bypasses Cloudflare)
      </div>
      <div class="prog">
        <div class="pb-ok" style="width:${okPct}%" title="${ok} OK"></div>
        <div class="pb-rd" style="width:${rdPct}%" title="${redirects} Redirects"></div>
        <div class="pb-nf" style="width:${nfPct}%" title="${notFound} Not Found"></div>
        <div class="pb-er" style="width:${errPct}%" title="${errors} Errors"></div>
      </div>
      <div class="prog-legend">
        <span><span class="leg" style="background:#22c55e"></span>OK ${okPct}%</span>
        <span><span class="leg" style="background:#f59e0b"></span>Redirect ${rdPct}%</span>
        <span><span class="leg" style="background:#ef4444"></span>404 ${nfPct}%</span>
        <span><span class="leg" style="background:#475569"></span>Error ${errPct}%</span>
      </div>
    </div>
    <div class="metric m-sc"><div class="mv">${score}%</div><div class="ml">Health Score</div></div>
  </div>
</div>

<div class="metrics">
  <div class="metric m-ok"><div class="mv">${ok.toLocaleString()}</div><div class="ml">200 OK</div></div>
  <div class="metric m-rd"><div class="mv">${redirects.toLocaleString()}</div><div class="ml">Redirects 3xx</div></div>
  <div class="metric m-nf"><div class="mv">${notFound.toLocaleString()}</div><div class="ml">404 Not Found</div></div>
  <div class="metric" style="border-color:#7f1d1d"><div class="mv" style="color:#f87171">${errors.toLocaleString()}</div><div class="ml">Errors / Timeouts</div></div>
</div>

<div class="card"><h2>Section Breakdown</h2>
  <table class="stbl"><thead><tr><th>Section</th><th>Total</th><th>200 OK</th><th>Redirect</th><th>404</th><th>Error</th></tr></thead>
  <tbody>${sectionRows}</tbody></table>
</div>

<div class="card"><h2>URL Validation Results</h2>
  <div class="controls">
    <input id="q" placeholder="Search URL or notes…" autocomplete="off">
    <select id="sf">
      <option value="">All Statuses</option>
      <option value="ok">🟢 200 OK</option>
      <option value="redirect">🟡 Redirects</option>
      <option value="not-found">🔴 404 Not Found</option>
      <option value="server-error">🔴 Server Errors</option>
      <option value="timeout">⏱ Timeouts</option>
      <option value="error">❌ Errors</option>
    </select>
    <select id="sec"><option value="">All Sections</option>${sectionOptions}</select>
    <button class="btn" onclick="exportCsv()">⬇ Export CSV</button>
    <span class="rc" id="rc">${total.toLocaleString()} URLs</span>
  </div>
  <div class="tbl-wrap">
    <table id="tbl">
      <thead><tr>
        <th>#</th><th onclick="sortBy(1)">URL Path ↕</th><th onclick="sortBy(2)">Section ↕</th>
        <th onclick="sortBy(3)">Status ↕</th><th>Label</th><th>Redirect Chain</th>
        <th onclick="sortBy(6)">Time ↕</th><th>Notes</th><th onclick="sortBy(8)">Page Title ↕</th>
        <th onclick="sortBy(9)">H1 ↕</th><th>Checked</th>
      </tr></thead>
      <tbody id="tbody">${tableRows}</tbody>
    </table>
  </div>
</div>
<footer>404 Validation (Real Browser) · ${escHtml(runDate)} · ${total.toLocaleString()} URLs</footer>
</div>
<script>
const allRows=[...document.querySelectorAll('#tbody tr')];
const q=document.getElementById('q'),sf=document.getElementById('sf'),sec=document.getElementById('sec'),rc=document.getElementById('rc');
function applyFilters(){const qs=q.value.toLowerCase(),ss=sf.value,se=sec.value;let v=0;
allRows.forEach(r=>{const m=(!qs||r.dataset.url.includes(qs)||r.textContent.toLowerCase().includes(qs))&&(!ss||r.dataset.status===ss)&&(!se||r.dataset.section===se);r.classList.toggle('hidden',!m);if(m)v++;});rc.textContent=v.toLocaleString()+' URLs';}
q.addEventListener('input',applyFilters);sf.addEventListener('change',applyFilters);sec.addEventListener('change',applyFilters);
let sc=-1,asc=true;function sortBy(col){asc=sc===col?!asc:true;sc=col;const tb=document.getElementById('tbody'),rows=[...tb.querySelectorAll('tr')];
rows.sort((a,b)=>{const ta=a.cells[col]?.textContent?.trim()??'',tb2=b.cells[col]?.textContent?.trim()??'';const na=parseFloat(ta),nb=parseFloat(tb2);return(!isNaN(na)&&!isNaN(nb))?(asc?na-nb:nb-na):(asc?ta.localeCompare(tb2):tb2.localeCompare(ta));});rows.forEach(r=>tb.appendChild(r));}
function exportCsv(){const vis=allRows.filter(r=>!r.classList.contains('hidden'));const lines=[['#','URL','Section','Status','Label','Redirect Chain','Time(ms)','Notes','Title'].join(',')];
vis.forEach(r=>{const c=[r.cells[0]?.textContent?.trim()??'',r.dataset.url||'',r.cells[2]?.textContent?.trim()??'',r.cells[3]?.textContent?.replace(/[🟢🟡🔴⏱❌]/g,'').trim()??'',r.cells[4]?.textContent?.trim()??'',r.cells[5]?.textContent?.trim()??'',r.cells[6]?.textContent?.replace('ms','').trim()??'',r.cells[7]?.textContent?.trim()??'',r.cells[8]?.textContent?.trim()??''].map(v=>'"'+String(v).replace(/"/g,'""')+'"');lines.push(c.join(','));});
const b=new Blob([lines.join('\n')],{type:'text/csv'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='404-browser-export.csv';a.click();}
</script></body></html>`;
}

// ─── HTML — internal links report ─────────────────────────────────────────────

function buildLinksHtml(
  linkRows: LinkRow[],
  uniqueStatuses: Map<string, LinkStatus>,
  pageResults: PageResult[],
  runDate: string,
  csvPath: string,
): string {
  const totalInstances = linkRows.length;
  const brokenInstances = linkRows.filter(r => r.isBroken).length;
  const brokenLinks = [...uniqueStatuses.values()].filter(s => s.isBroken);
  const passPct = totalInstances > 0 ? ((totalInstances - brokenInstances) / totalInstances * 100).toFixed(1) : '100.0';
  const crawledOk = pageResults.filter(r => r.finalStatus === 200).length;

  const brokenTableRows = brokenLinks.map((bl, i) => {
    const pages = linkRows.filter(r => r.linkUrl === bl.url && r.isBroken).map(r => r.sourcePage);
    const uniquePages = [...new Set(pages)];
    const isNav = linkRows.find(r => r.linkUrl === bl.url)?.isNavLink ?? false;
    return `<tr class="${isNav ? 'row-nav' : 'row-content'}">
      <td>${i+1}</td>
      <td class="cu"><a href="${escHtml(bl.url)}" target="_blank">${escHtml(bl.url.replace(/^https?:\/\/[^/]+/,''))}</a></td>
      <td><code>${bl.finalStatus || '—'}</code></td>
      <td>${escHtml(bl.label)}</td>
      <td>${uniquePages.length}</td>
      <td>${isNav ? '⚠ Sitewide' : '—'}</td>
      <td style="font-size:10px;color:#64748b;max-width:300px;word-break:break-all">${uniquePages.slice(0,3).map(p => escHtml(p.replace(/^https?:\/\/[^/]+/,''))).join('<br>')}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Internal Links Audit (Browser) — ${escHtml(runDate)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;line-height:1.4}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
code{font-family:'JetBrains Mono',monospace;font-size:11px;background:#0f172a;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc}
.wrap{max-width:1400px;margin:0 auto}
.card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:18px 20px;margin-bottom:16px}
h1{font-size:22px;font-weight:800;color:#f1f5f9;margin-bottom:4px}
h2{font-size:15px;font-weight:700;color:#f1f5f9;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e293b}
.meta{color:#64748b;font-size:12px}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin:12px 0}
.metric{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;text-align:center}
.mv{font-size:26px;font-weight:800}.ml{font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase}
.m-ok{border-color:#166534}.m-ok .mv{color:#22c55e}
.m-nf{border-color:#991b1b}.m-nf .mv{color:#ef4444}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{position:sticky;top:0;background:#0f172a;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;font-size:11px;border-bottom:1px solid #334155;white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.015)}
.cu{max-width:380px;word-break:break-all;font-size:11px}.cu a{color:#93c5fd}
.row-nav td{background:rgba(239,68,68,.06)}
.row-content td{background:rgba(245,158,11,.03)}
.badge{display:inline-block;background:#1e3a5f;color:#60a5fa;border:1px solid #1e40af;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;margin-left:8px}
footer{text-align:center;padding:16px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:8px}
</style></head><body>
<div class="wrap">
<div class="card">
  <h1>Internal Links Audit <span class="badge">🌐 Real Browser</span></h1>
  <div class="meta">Run date: <strong style="color:#e2e8f0">${escHtml(runDate)}</strong> &nbsp;·&nbsp;
    Source: <code>${escHtml(path.basename(csvPath))}</code> &nbsp;·&nbsp;
    ${crawledOk} pages crawled &nbsp;·&nbsp; ${uniqueStatuses.size.toLocaleString()} unique links verified
  </div>
</div>

<div class="metrics">
  <div class="metric m-ok"><div class="mv">${(totalInstances-brokenInstances).toLocaleString()}</div><div class="ml">✅ Pass</div></div>
  <div class="metric m-nf"><div class="mv">${brokenInstances.toLocaleString()}</div><div class="ml">❌ Broken</div></div>
  <div class="metric" style="border-color:#334155"><div class="mv" style="color:#94a3b8">${totalInstances.toLocaleString()}</div><div class="ml">Total Instances</div></div>
  <div class="metric" style="border-color:#334155"><div class="mv" style="color:#94a3b8">${uniqueStatuses.size.toLocaleString()}</div><div class="ml">Unique Links</div></div>
  <div class="metric" style="border-color:#166534"><div class="mv" style="color:#22c55e">${passPct}%</div><div class="ml">Pass Rate</div></div>
  <div class="metric" style="border-color:#334155"><div class="mv" style="color:#94a3b8">${crawledOk}</div><div class="ml">Pages Crawled</div></div>
</div>

${brokenLinks.length === 0 ? `
<div class="card" style="border-color:#166534;background:#052e16">
  <h2 style="color:#22c55e;border-color:#166534">✅ Zero Broken Links</h2>
  <p style="color:#86efac;font-size:14px">All ${totalInstances.toLocaleString()} internal link instances across ${crawledOk} pages verified as working.</p>
</div>` : `
<div class="card">
  <h2>🔴 Broken Links — ${brokenLinks.length} unique broken URLs</h2>
  <div class="tbl-wrap">
    <table><thead><tr>
      <th>#</th><th>Broken URL</th><th>Status</th><th>Label</th>
      <th>Affected Pages</th><th>Scope</th><th>Found on Pages</th>
    </tr></thead>
    <tbody>${brokenTableRows}</tbody></table>
  </div>
</div>`}

<footer>Internal Links Audit (Real Browser) · ${escHtml(runDate)} · ${crawledOk} pages · ${uniqueStatuses.size.toLocaleString()} unique links</footer>
</div></body></html>`;
}

// ─── Excel — 404 report ───────────────────────────────────────────────────────

async function write404Excel(results: PageResult[], outPath: string, runDate: string, csvPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Playwright Full Audit';
  wb.created = new Date();

  const C = {
    dark:'FF0F172A', card:'FF111827', border:'FF1E293B',
    text:'FFE2E8F0', muted:'FF64748B', headerFg:'FF94A3B8',
    green:'FF22C55E', yellow:'FFF59E0B', red:'FFEF4444',
    orange:'FFFB923C', gray:'FF475569',
    rowOk:'FF0A1F0A', rowRd:'FF1A1400', rowNf:'FF1A0505', rowErr:'FF111827',
  };

  function fill(argb: string): ExcelJS.FillPattern {
    return { type:'pattern', pattern:'solid', fgColor:{ argb } };
  }

  function hdr(row: ExcelJS.Row): void {
    row.eachCell(c => {
      c.fill = fill(C.card); c.font = { bold:true, color:{argb:C.headerFg}, size:10 };
      c.alignment = { horizontal:'center', vertical:'middle' };
      c.border = { top:{style:'thin',color:{argb:C.border}}, bottom:{style:'thin',color:{argb:C.border}}, left:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}} };
    }); row.height = 22;
  }

  function dataRow(row: ExcelJS.Row, bgArgb: string): void {
    row.eachCell(c => {
      c.fill = fill(bgArgb); c.font = { color:{argb:C.text}, size:10 };
      c.border = { top:{style:'thin',color:{argb:C.border}}, bottom:{style:'thin',color:{argb:C.border}}, left:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}} };
      c.alignment = { horizontal:'left', vertical:'middle' };
    }); row.height = 18;
  }

  function catColor(cat: StatusCat): string {
    if (cat === 'ok') return C.green;
    if (cat === 'redirect') return C.yellow;
    if (cat === 'not-found') return C.red;
    if (cat === 'server-error') return C.red;
    return C.gray;
  }

  function rowBg(cat: StatusCat): string {
    if (cat === 'ok') return C.rowOk;
    if (cat === 'redirect') return C.rowRd;
    if (cat === 'not-found') return C.rowNf;
    return C.rowErr;
  }

  const COLS = [
    {h:'#',w:6},{h:'Full URL',w:55},{h:'URL Path',w:42},{h:'Section',w:16},
    {h:'Status Code',w:13},{h:'Status Label',w:28},{h:'Redirect Chain',w:20},
    {h:'Final URL',w:44},{h:'Response (ms)',w:14},{h:'Notes',w:35},
    {h:'Page Title',w:40},{h:'H1',w:40},{h:'Checked At',w:22},
  ];

  function addSheet(name: string, tabColor: string, rows: PageResult[]): void {
    const ws = wb.addWorksheet(name, { properties:{ tabColor:{ argb:tabColor } } });
    ws.views = [{ state:'frozen', ySplit:1, showGridLines:false }];
    COLS.forEach((c,i) => { ws.getColumn(i+1).width = c.w; });
    hdr(ws.addRow(COLS.map(c => c.h)));
    ws.autoFilter = { from:{row:1,column:1}, to:{row:1,column:COLS.length} };
    rows.forEach(r => {
      const row = ws.addRow([
        r.index, r.url, r.urlPath, r.section,
        r.finalStatus || '', r.statusLabel, r.redirectChain,
        r.finalUrl, r.responseMs, r.notes,
        r.pageTitle, r.h1, r.checkedAt,
      ]);
      dataRow(row, rowBg(r.statusCat));
      const urlCell = row.getCell(2);
      urlCell.value = { text: r.url, hyperlink: r.url };
      urlCell.font = { color:{argb:'FF60A5FA'}, underline:true, size:10 };
      const stCell = row.getCell(5);
      stCell.font = { bold:true, color:{argb:catColor(r.statusCat)}, size:10 };
      stCell.alignment = { horizontal:'center', vertical:'middle' };
      row.getCell(1).font = { color:{argb:C.muted}, size:10 };
      row.getCell(1).alignment = { horizontal:'right', vertical:'middle' };
    });
  }

  // Summary sheet
  const ws1 = wb.addWorksheet('Summary', { properties:{ tabColor:{argb:'FF3B82F6'} } });
  ws1.views = [{ showGridLines:false }];
  const ok = results.filter(r => r.statusCat === 'ok').length;
  const rds = results.filter(r => r.statusCat === 'redirect').length;
  const nf  = results.filter(r => r.statusCat === 'not-found').length;
  const errs = results.filter(r => !['ok','redirect','not-found'].includes(r.statusCat)).length;

  const titleRow = ws1.getRow(1);
  titleRow.getCell(1).value = `404 Validation (Browser) — ${runDate}`;
  titleRow.getCell(1).font = { bold:true, size:14, color:{argb:C.text} };
  titleRow.getCell(1).fill = fill(C.card);
  ws1.mergeCells('A1:G1'); titleRow.height = 28;

  [['Source', path.basename(csvPath)],['Run date', runDate],['Total URLs', results.length],
   ['Concurrency', `${CONCURRENCY} browser contexts`],['Method', 'Real Chromium — bypasses Cloudflare']
  ].forEach(([k,v], i) => {
    const r = ws1.getRow(i+2);
    r.getCell(1).value = k; r.getCell(1).font = { color:{argb:C.muted}, size:10 }; r.getCell(1).fill = fill(C.dark);
    r.getCell(2).value = v; r.getCell(2).font = { bold:true, color:{argb:C.text}, size:10 }; r.getCell(2).fill = fill(C.dark);
    r.height = 16;
  });

  const sh = ws1.getRow(8);
  sh.values = ['','Category','Count','%'];
  hdr(sh); sh.height = 20;

  [[C.green,'200 OK',ok],[C.yellow,'Redirects 3xx',rds],[C.red,'404 Not Found',nf],[C.gray,'Errors/Timeouts',errs]].forEach(([color,label,count], i) => {
    const r = ws1.getRow(9+i);
    r.getCell(1).value = '●'; r.getCell(1).font = { color:{argb:color as string}, size:14 }; r.getCell(1).fill = fill(C.dark); r.getCell(1).alignment = {horizontal:'center',vertical:'middle'};
    r.getCell(2).value = label; r.getCell(2).font = { bold:(count as number)>0, color:{argb:C.text}, size:10 }; r.getCell(2).fill = fill(C.dark);
    r.getCell(3).value = count; r.getCell(3).numFmt = '#,##0'; r.getCell(3).font = { bold:true, color:{argb:color as string}, size:11 }; r.getCell(3).fill = fill(C.dark); r.getCell(3).alignment = {horizontal:'center',vertical:'middle'};
    r.getCell(4).value = results.length > 0 ? (count as number)/results.length : 0; r.getCell(4).numFmt = '0.0%'; r.getCell(4).font = { color:{argb:C.muted}, size:10 }; r.getCell(4).fill = fill(C.dark); r.getCell(4).alignment = {horizontal:'center',vertical:'middle'};
    r.height = 18;
  });

  [1,2,3,4,5,6,7].forEach((c,i) => { ws1.getColumn(c).width = [4,22,12,12,12,12,12][i]!; });

  addSheet('All URLs', 'FF1E293B', results);

  const nfRows = results.filter(r => r.statusCat === 'not-found');
  addSheet(`404 Not Found (${nfRows.length})`, 'FF991B1B', nfRows);

  const rdRows = results.filter(r => r.statusCat === 'redirect');
  addSheet(`Redirects (${rdRows.length})`, 'FF92400E', rdRows);

  const errRows = results.filter(r => !['ok','redirect','not-found'].includes(r.statusCat));
  if (errRows.length) addSheet(`Errors (${errRows.length})`, 'FF374151', errRows);

  await wb.xlsx.writeFile(outPath);
}

// ─── Excel — internal links ───────────────────────────────────────────────────

async function writeLinksExcel(
  linkRows: LinkRow[],
  uniqueStatuses: Map<string, LinkStatus>,
  pageResults: PageResult[],
  outPath: string,
  runDate: string,
  csvPath: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Playwright Full Audit';
  wb.created = new Date();

  const C = {
    dark:'FF0F172A', card:'FF111827', border:'FF1E293B',
    text:'FFE2E8F0', muted:'FF64748B', hdrFg:'FF94A3B8',
    green:'FF22C55E', red:'FFEF4444', orange:'FFFB923C',
    blue:'FF60A5FA', grayBg:'FF1E293B', redBg:'FF450A0A',
  };

  function fill(argb: string): ExcelJS.FillPattern {
    return { type:'pattern', pattern:'solid', fgColor:{ argb } };
  }

  function styleHdr(row: ExcelJS.Row): void {
    row.eachCell(c => {
      c.fill = fill(C.card); c.font = { bold:true, color:{argb:C.hdrFg}, size:10 };
      c.alignment = { horizontal:'center', vertical:'middle' };
      c.border = { top:{style:'thin',color:{argb:C.border}}, bottom:{style:'thin',color:{argb:C.border}}, left:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}} };
    }); row.height = 22;
  }

  function styleData(row: ExcelJS.Row, bgArgb: string): void {
    row.eachCell(c => {
      c.fill = fill(bgArgb); c.font = { color:{argb:C.text}, size:10 };
      c.border = { top:{style:'thin',color:{argb:C.border}}, bottom:{style:'thin',color:{argb:C.border}}, left:{style:'thin',color:{argb:C.border}}, right:{style:'thin',color:{argb:C.border}} };
      c.alignment = { horizontal:'left', vertical:'middle', wrapText:false };
    }); row.height = 18;
  }

  const crawledOk = pageResults.filter(r => r.finalStatus === 200).length;
  const brokenLinks = [...uniqueStatuses.values()].filter(s => s.isBroken);
  const brokenInstances = linkRows.filter(r => r.isBroken).length;

  // ── Sheet 1: Executive Summary ─────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Executive Summary', { properties:{ tabColor:{argb:'FF3B82F6'} } });
  ws1.views = [{ showGridLines:false }];

  const t1 = ws1.getRow(1);
  t1.getCell(1).value = `Internal Links Audit (Browser) — ${runDate}`;
  t1.getCell(1).font = { bold:true, size:14, color:{argb:C.text} };
  t1.getCell(1).fill = fill(C.card);
  ws1.mergeCells('A1:F1'); t1.height = 28;

  [
    ['Source file', path.basename(csvPath)],
    ['Run date', runDate],
    ['Pages crawled', crawledOk],
    ['Unique links verified', uniqueStatuses.size],
    ['Total link instances', linkRows.length],
    ['Method', 'Real Chromium browser — bypasses Cloudflare'],
  ].forEach(([k,v], i) => {
    const r = ws1.getRow(i+2);
    r.getCell(1).value = k; r.getCell(1).font = { color:{argb:C.muted}, size:10 }; r.getCell(1).fill = fill(C.dark);
    r.getCell(2).value = v; r.getCell(2).font = { bold:true, color:{argb:C.text}, size:10 }; r.getCell(2).fill = fill(C.dark);
    r.height = 16;
  });

  const sh = ws1.getRow(9);
  sh.values = ['Category','Count','% of Instances'];
  styleHdr(sh);

  [[C.green,'Pass (working links)',linkRows.length-brokenInstances],
   [C.red,'Fail (broken links)',brokenInstances],
   [C.red,'Unique broken URLs',brokenLinks.length],
  ].forEach(([color,label,count], i) => {
    const r = ws1.getRow(10+i);
    r.values = [label, count, linkRows.length>0?(count as number)/linkRows.length:0];
    r.getCell(1).font = { color:{argb:C.text}, size:10 }; r.getCell(1).fill = fill(C.dark);
    r.getCell(2).font = { bold:true, color:{argb:color as string}, size:11 }; r.getCell(2).fill = fill(C.dark); r.getCell(2).alignment = {horizontal:'center',vertical:'middle'};
    r.getCell(3).numFmt = '0.0%'; r.getCell(3).font = { color:{argb:C.muted}, size:10 }; r.getCell(3).fill = fill(C.dark); r.getCell(3).alignment = {horizontal:'center',vertical:'middle'};
    r.height = 18;
  });

  [1,2,3].forEach(c => { ws1.getColumn(c).width = [30,14,18][c-1]!; });

  // ── Sheet 2: Broken Links (Unique) ─────────────────────────────────────────
  const ws2 = wb.addWorksheet(`Broken Links (${brokenLinks.length})`, { properties:{ tabColor:{argb:'FF991B1B'} } });
  ws2.views = [{ state:'frozen', ySplit:1, showGridLines:false }];
  const bl_cols = [
    {h:'Broken URL',w:60},{h:'Status Code',w:13},{h:'Status Label',w:26},
    {h:'Affected Pages',w:12},{h:'Sitewide?',w:12},{h:'Redirect Chain',w:20},
  ];
  bl_cols.forEach((c,i) => { ws2.getColumn(i+1).width = c.w; });
  styleHdr(ws2.addRow(bl_cols.map(c => c.h)));
  ws2.autoFilter = { from:{row:1,column:1}, to:{row:1,column:bl_cols.length} };

  brokenLinks.forEach((bl, i) => {
    const pages = linkRows.filter(r => r.linkUrl === bl.url && r.isBroken).map(r => r.sourcePage);
    const uniquePages = [...new Set(pages)];
    const isNav = linkRows.find(r => r.linkUrl === bl.url)?.isNavLink ?? false;
    const bg = i % 2 === 0 ? C.redBg : C.dark;
    const row = ws2.addRow([bl.url, bl.finalStatus || '', bl.label, uniquePages.length, isNav ? 'YES' : '', bl.redirectChain]);
    styleData(row, bg);
    row.getCell(1).value = { text: bl.url, hyperlink: bl.url };
    row.getCell(1).font = { color:{argb:C.blue}, underline:true, size:10 };
    row.getCell(2).font = { bold:true, color:{argb:C.red}, size:10 };
    row.getCell(2).alignment = { horizontal:'center', vertical:'middle' };
    if (isNav) { row.getCell(5).font = { bold:true, color:{argb:C.orange}, size:10 }; }
  });

  // ── Sheet 3: Page Summary ──────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Page Summary', { properties:{ tabColor:{argb:'FF1E293B'} } });
  ws3.views = [{ state:'frozen', ySplit:1, showGridLines:false }];
  const ps_cols = [{h:'Page URL',w:60},{h:'Total Links',w:12},{h:'Pass',w:10},{h:'Fail',w:10},{h:'Fail Rate',w:12}];
  ps_cols.forEach((c,i) => { ws3.getColumn(i+1).width = c.w; });
  styleHdr(ws3.addRow(ps_cols.map(c => c.h)));
  ws3.autoFilter = { from:{row:1,column:1}, to:{row:1,column:ps_cols.length} };

  const psMap = new Map<string, {total:number;pass:number;fail:number}>();
  for (const r of linkRows) {
    if (!psMap.has(r.sourcePage)) psMap.set(r.sourcePage, {total:0,pass:0,fail:0});
    const p = psMap.get(r.sourcePage)!;
    p.total++; if (r.isBroken) p.fail++; else p.pass++;
  }

  [...psMap.entries()].sort((a,b) => b[1].fail - a[1].fail).forEach(([pageUrl, ps], i) => {
    const row = ws3.addRow([pageUrl, ps.total, ps.pass, ps.fail, ps.total > 0 ? ps.fail/ps.total : 0]);
    styleData(row, i%2===0 ? C.dark : C.card);
    row.getCell(1).value = { text: pageUrl, hyperlink: pageUrl };
    row.getCell(1).font = { color:{argb:C.blue}, underline:true, size:10 };
    row.getCell(5).numFmt = '0%';
    if (ps.fail > 0) {
      row.getCell(4).font = { bold:true, color:{argb:C.red}, size:10 };
      row.getCell(5).font = { bold:true, color:{argb:C.red}, size:10 };
    }
  });

  // ── Sheet 4: All Link Details ──────────────────────────────────────────────
  const ws4 = wb.addWorksheet('All Link Details', { properties:{ tabColor:{argb:'FF374151'} } });
  ws4.views = [{ state:'frozen', ySplit:1, showGridLines:false }];
  const al_cols = [
    {h:'Source Page',w:55},{h:'Section',w:16},{h:'Link URL',w:55},
    {h:'Status Code',w:13},{h:'Status Label',w:26},{h:'Broken?',w:10},{h:'Sitewide?',w:10},
  ];
  al_cols.forEach((c,i) => { ws4.getColumn(i+1).width = c.w; });
  styleHdr(ws4.addRow(al_cols.map(c => c.h)));
  ws4.autoFilter = { from:{row:1,column:1}, to:{row:1,column:al_cols.length} };

  linkRows.forEach((r, i) => {
    const bg = r.isBroken ? (i%2===0 ? C.redBg : C.dark) : (i%2===0 ? C.grayBg : C.dark);
    const row = ws4.addRow([
      r.sourcePage, r.section, r.linkUrl,
      r.finalStatus || '', r.label,
      r.isBroken ? 'YES' : '', r.isNavLink ? 'YES' : '',
    ]);
    styleData(row, bg);
    row.getCell(1).value = { text:r.sourcePage, hyperlink:r.sourcePage };
    row.getCell(1).font = { color:{argb:C.blue}, underline:true, size:10 };
    row.getCell(3).value = { text:r.linkUrl, hyperlink:r.linkUrl };
    row.getCell(3).font = { color:{argb:C.blue}, underline:true, size:10 };
    row.getCell(4).font = { bold:true, color:{argb:r.isBroken ? C.red : C.green}, size:10 };
    row.getCell(4).alignment = { horizontal:'center', vertical:'middle' };
  });

  await wb.xlsx.writeFile(outPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const cliInput = inputFlag >= 0 ? args[inputFlag+1] : undefined;

  const csvPath = resolveInputCsv(cliInput);
  const urls    = parseCsvUrls(csvPath);

  const folderName = path.basename(path.dirname(csvPath));
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(folderName)
    ? folderName : new Date().toISOString().slice(0, 10);

  const outDir = path.join(ROOT, 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n🌐  Playwright Full Audit — 404 + Internal Links`);
  console.log(`    Input   : ${csvPath}`);
  console.log(`    URLs    : ${urls.length.toLocaleString()}`);
  console.log(`    Workers : ${CONCURRENCY} concurrent Chromium contexts`);
  console.log(`    Output  : ${outDir}\n`);

  // ── Phase 1: Browser crawl ─────────────────────────────────────────────────
  console.log('  Phase 1/3 — Browser crawl (visits every URL with real Chromium)…');
  const t1 = Date.now();
  let lastLog = 0;

  const pageResults = await crawlAllUrls(urls, (r, done) => {
    const now = Date.now();
    if (now - lastLog > 1000 || done === urls.length) {
      const pct = Math.round((done / urls.length) * 100);
      const icon = r.statusCat === 'ok' ? '✅' : r.statusCat === 'redirect' ? '↪' :
                   r.statusCat === 'not-found' ? '❌' : r.statusCat === 'timeout' ? '⏱' : '⚠';
      process.stdout.write(`\r  [${String(done).padStart(4)}/${urls.length}] ${pct}%  ${icon} ${r.statusLabel.slice(0,22).padEnd(22)}  ${((now-t1)/1000).toFixed(0)}s`);
      lastLog = now;
    }
  });

  const phase1s = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\n  Phase 1 done in ${phase1s}s`);

  // ── Phase 2: Verify unique internal links ──────────────────────────────────
  const allInternalLinks = pageResults.flatMap(r => r.internalLinks);
  const uniqueCount = new Set(allInternalLinks).size;
  console.log(`\n  Phase 2/3 — HTTP-verify ${uniqueCount.toLocaleString()} unique internal links…`);
  const t2 = Date.now();

  const { linkRows, uniqueStatuses } = await verifyUniqueLinks(pageResults, (done, total) => {
    const now = Date.now();
    if (now - lastLog > 800 || done === total) {
      process.stdout.write(`\r  [${String(done).padStart(4)}/${total}] ${Math.round((done/total)*100)}%  ${((now-t2)/1000).toFixed(0)}s`);
      lastLog = now;
    }
  });

  const phase2s = ((Date.now() - t2) / 1000).toFixed(1);
  console.log(`\n  Phase 2 done in ${phase2s}s`);

  // ── Summary ────────────────────────────────────────────────────────────────
  const ok         = pageResults.filter(r => r.statusCat === 'ok').length;
  const redirects  = pageResults.filter(r => r.statusCat === 'redirect').length;
  const notFound   = pageResults.filter(r => r.statusCat === 'not-found').length;
  const errs       = pageResults.filter(r => !['ok','redirect','not-found'].includes(r.statusCat)).length;
  const brokenLinks = [...uniqueStatuses.values()].filter(s => s.isBroken).length;
  const crawledOk  = pageResults.filter(r => r.finalStatus === 200).length;

  const line = '─'.repeat(48);
  console.log(`\n  ${line}`);
  console.log(`  404 / Status Check:`);
  console.log(`  ✅ 200 OK            : ${String(ok).padStart(6)}`);
  console.log(`  ↪  Redirects 3xx     : ${String(redirects).padStart(6)}`);
  console.log(`  ❌ 404 Not Found     : ${String(notFound).padStart(6)}`);
  console.log(`  ⚠  Errors/Timeouts   : ${String(errs).padStart(6)}`);
  console.log(`  ${line}`);
  console.log(`  Internal Links:`);
  console.log(`  📄 Pages crawled     : ${String(crawledOk).padStart(6)}`);
  console.log(`  🔗 Unique links      : ${String(uniqueStatuses.size).padStart(6)}`);
  console.log(`  ❌ Broken links      : ${String(brokenLinks).padStart(6)}`);
  console.log(`  ${line}\n`);

  // ── Phase 3: Reports ───────────────────────────────────────────────────────
  console.log('  Phase 3/3 — Generating reports…');

  const html404Path  = path.join(outDir, `404-browser-${runDate}.html`);
  const xlsx404Path  = path.join(outDir, `404-browser-${runDate}.xlsx`);
  const htmlLinkPath = path.join(outDir, `internal-links-browser-${runDate}.html`);
  const xlsxLinkPath = path.join(outDir, `UOF_QA_Links_Browser_${runDate}.xlsx`);

  process.stdout.write('    404 HTML…');
  const html404 = build404Html(pageResults, runDate, csvPath);
  fs.writeFileSync(html404Path, html404, 'utf8');
  console.log(` ✅  (${Math.round(html404.length/1024)}KB)`);

  process.stdout.write('    404 Excel…');
  await write404Excel(pageResults, xlsx404Path, runDate, csvPath);
  console.log(` ✅  (${Math.round(fs.statSync(xlsx404Path).size/1024)}KB)`);

  process.stdout.write('    Links HTML…');
  const htmlLinks = buildLinksHtml(linkRows, uniqueStatuses, pageResults, runDate, csvPath);
  fs.writeFileSync(htmlLinkPath, htmlLinks, 'utf8');
  console.log(` ✅  (${Math.round(htmlLinks.length/1024)}KB)`);

  process.stdout.write('    Links Excel…');
  await writeLinksExcel(linkRows, uniqueStatuses, pageResults, xlsxLinkPath, runDate, csvPath);
  console.log(` ✅  (${Math.round(fs.statSync(xlsxLinkPath).size/1024)}KB)\n`);

  console.log(`  📄 404 HTML  : ${html404Path}`);
  console.log(`  📊 404 Excel : ${xlsx404Path}`);
  console.log(`  🔗 Links HTML : ${htmlLinkPath}`);
  console.log(`  📊 Links Excel: ${xlsxLinkPath}\n`);

  if (notFound > 0)    console.log(`  ⚠  ${notFound} URLs returned 404 — see "404 Not Found" sheet.\n`);
  if (brokenLinks > 0) console.log(`  ⚠  ${brokenLinks} unique broken internal links — see "Broken Links" sheet.\n`);
  if (notFound === 0 && brokenLinks === 0) console.log(`  ✅ Clean bill of health — zero 404s and zero broken links.\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err?.message ?? err);
  process.exit(1);
});
