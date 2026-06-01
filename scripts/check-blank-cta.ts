#!/usr/bin/env ts-node
/**
 * Blank CTA Checker — University of Findlay
 *
 * Reads every URL from the latest input CSV, fetches the page HTML,
 * extracts all CTAs (<a>, <button>, <input type=button/submit>),
 * and flags:
 *   - Blank       : no visible text and no usable alt/aria-label
 *   - Image-only  : img CTA with missing or empty alt text
 *   - Icon-only   : SVG/icon element with no aria-label or title
 *   - Generic     : text is "click here", "read more", "here", "more", "link", etc.
 *
 * Outputs: reports/YYYY-MM-DD/blank-cta-YYYY-MM-DD.html
 *
 * Usage:
 *   npm run check-cta
 *   CONCURRENCY=10 npm run check-cta
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http  from 'http';
import { URL } from 'url';

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '5', 10);
const TIMEOUT_MS  = 20_000;
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GENERIC_TEXTS = new Set([
  'click here', 'click', 'here', 'read more', 'learn more', 'more',
  'link', 'button', 'submit', 'go', 'view', 'see more', 'see all',
  'view more', 'view all', 'find out more', 'find out', 'details',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

type CtaIssue = 'blank' | 'no-accessible-name' | 'image-no-alt' | 'icon-only' | 'generic' | 'empty-href';

interface CtaResult {
  pageUrl:     string;
  section:     string;
  elementType: string;   // a | button | input
  ctaText:     string;   // extracted visible text
  href:        string;
  ariaLabel:   string;
  altText:     string;
  issueType:   CtaIssue;
  issueDetail: string;
  htmlSnippet: string;
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

function fetchBody(urlStr: string): Promise<string> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch { return resolve(''); }

    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const chunks: Buffer[] = [];

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Connection: 'close' },
        timeout:  TIMEOUT_MS,
      },
      (res) => {
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error',() => resolve(''));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error',   () => resolve(''));
    req.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1]!.trim() : '';
}

function sectionOf(html: string, matchIndex: number): string {
  const before = html.slice(0, matchIndex);
  if (before.lastIndexOf('<nav')    > before.lastIndexOf('</nav>'))    return 'nav';
  if (before.lastIndexOf('<header') > before.lastIndexOf('</header>')) return 'header';
  if (before.lastIndexOf('<footer') > before.lastIndexOf('</footer>')) return 'footer';
  if (before.lastIndexOf('<aside')  > before.lastIndexOf('</aside>'))  return 'sidebar';
  return 'content';
}

// Returns true if the anchor is inside a <td> or <th> — table headers provide context,
// so "Details"/"Learn more" in a data table cell is acceptable under WCAG 2.4.4 (AA).
function isInTableCell(html: string, matchIndex: number): boolean {
  const before = html.slice(0, matchIndex);
  const lastTd   = Math.max(before.lastIndexOf('<td'), before.lastIndexOf('<th'));
  const closeTd  = Math.max(before.lastIndexOf('</td>'), before.lastIndexOf('</th>'));
  return lastTd > closeTd;
}

function snippetOf(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function hasOnlyIcons(inner: string): boolean {
  if (!inner.trim()) return false; // truly empty — not icon-only, it's blank
  // Must actually contain an icon element; bare <br> / whitespace tags are not icons
  const hasIcon = /<svg[\s\S]*?<\/svg>/i.test(inner)
    || /<i\s[^>]*class="[^"]*fa[^"]*"/i.test(inner)
    || /<span\s[^>]*class="[^"]*icon[^"]*"/i.test(inner);
  if (!hasIcon) return false;
  const stripped = inner
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<i\s[^>]*class="[^"]*fa[^"]*"[^>]*>\s*<\/i>/gi, '')
    .replace(/<span\s[^>]*class="[^"]*icon[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

// ─── CTA extraction ───────────────────────────────────────────────────────────

function extractCtas(html: string, pageUrl: string): CtaResult[] {
  const results: CtaResult[] = [];

  // ── <a href> tags ──────────────────────────────────────────────────────────
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = anchorRe.exec(html)) !== null) {
    const attrs     = m[1]!;
    const inner     = m[2]!;
    const fullMatch = m[0]!;
    const matchIdx  = m.index;

    const href      = attr(attrs, 'href');
    const ariaLabel = attr(attrs, 'aria-label') || attr(attrs, 'title') || attr(attrs, 'aria-labelledby');
    const visible   = stripTags(inner);
    const section   = sectionOf(html, matchIdx);

    // Skip: skip-links, mailto, tel, javascript — but keep missing/empty href so we can flag them
    if (href && /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;

    // Image-only CTA
    const imgMatch = inner.match(/<img\b[^>]*>/i);
    if (imgMatch && !visible) {
      const imgAlt = attr(imgMatch[0], 'alt');
      if (!imgAlt && !ariaLabel) {
        results.push({
          pageUrl, section, elementType: 'a', ctaText: '(image)',
          href, ariaLabel, altText: '',
          issueType: 'image-no-alt',
          issueDetail: 'Image link with no alt text and no aria-label — screen readers cannot describe this CTA',
          htmlSnippet: snippetOf(fullMatch),
        });
      }
      continue;
    }

    // Icon-only CTA
    if (!visible && hasOnlyIcons(inner) && !ariaLabel) {
      results.push({
        pageUrl, section, elementType: 'a', ctaText: '(icon)',
        href, ariaLabel, altText: '',
        issueType: 'icon-only',
        issueDetail: 'Icon-only link with no aria-label or title — inaccessible to screen readers',
        htmlSnippet: snippetOf(fullMatch),
      });
      continue;
    }

    // Anchor with href but no accessible name — may be wrapping non-text content
    if (!visible && !ariaLabel) {
      results.push({
        pageUrl, section, elementType: 'a', ctaText: '',
        href, ariaLabel, altText: '',
        issueType: 'no-accessible-name',
        issueDetail: 'Link has no visible text, aria-label, or title. If it wraps only visual/icon content verify visually — may be a false positive. Add aria-label for full accessibility.',
        htmlSnippet: snippetOf(fullMatch),
      });
      continue;
    }

    // Missing or empty href — not a navigable link
    if (!href || href === 'javascript:void(0)') {
      results.push({
        pageUrl, section, elementType: 'a', ctaText: visible,
        href, ariaLabel, altText: '',
        issueType: 'empty-href',
        issueDetail: !href
          ? 'Link has no href attribute — not a navigable element (use <button> or add href)'
          : `Link goes nowhere — href="${href}"`,
        htmlSnippet: snippetOf(fullMatch),
      });
      continue;
    }

    // Generic text — skip if inside a table cell (row/column headers provide context)
    if (visible && GENERIC_TEXTS.has(visible.toLowerCase()) && !ariaLabel) {
      if (isInTableCell(html, matchIdx)) continue;
      results.push({
        pageUrl, section, elementType: 'a', ctaText: visible,
        href, ariaLabel, altText: '',
        issueType: 'generic',
        issueDetail: `Generic link text "${visible}" — gives no context about the destination`,
        htmlSnippet: snippetOf(fullMatch),
      });
    }
  }

  // ── <button> tags ──────────────────────────────────────────────────────────
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = buttonRe.exec(html)) !== null) {
    const attrs     = m[1]!;
    const inner     = m[2]!;
    const fullMatch = m[0]!;
    const matchIdx  = m.index;

    const ariaLabel = attr(attrs, 'aria-label') || attr(attrs, 'title') || attr(attrs, 'aria-labelledby');
    const visible   = stripTags(inner);
    const section   = sectionOf(html, matchIdx);

    if (!visible && !ariaLabel) {
      const isIconOnly = hasOnlyIcons(inner);
      results.push({
        pageUrl, section, elementType: 'button', ctaText: visible || '(icon)',
        href: '', ariaLabel, altText: '',
        issueType: isIconOnly ? 'icon-only' : 'blank',
        issueDetail: isIconOnly
          ? 'Icon-only button with no aria-label — inaccessible to screen readers'
          : 'Button has no visible text and no aria-label',
        htmlSnippet: snippetOf(fullMatch),
      });
      continue;
    }

    if (visible && GENERIC_TEXTS.has(visible.toLowerCase()) && !ariaLabel) {
      results.push({
        pageUrl, section, elementType: 'button', ctaText: visible,
        href: '', ariaLabel, altText: '',
        issueType: 'generic',
        issueDetail: `Generic button text "${visible}" — gives no context to the user`,
        htmlSnippet: snippetOf(fullMatch),
      });
    }
  }

  // ── <input type=button|submit|reset> ──────────────────────────────────────
  const inputRe = /<input\b([^>]*)>/gi;
  while ((m = inputRe.exec(html)) !== null) {
    const attrs     = m[1]!;
    const fullMatch = m[0]!;
    const matchIdx  = m.index;

    const type = attr(attrs, 'type').toLowerCase();
    if (!['button', 'submit', 'reset'].includes(type)) continue;

    const value     = attr(attrs, 'value');
    const ariaLabel = attr(attrs, 'aria-label') || attr(attrs, 'title');
    const section   = sectionOf(html, matchIdx);

    if (!value && !ariaLabel) {
      results.push({
        pageUrl, section, elementType: `input[${type}]`, ctaText: '',
        href: '', ariaLabel, altText: '',
        issueType: 'blank',
        issueDetail: `Input button has no value or aria-label`,
        htmlSnippet: snippetOf(fullMatch),
      });
    }
  }

  return results;
}

// ─── Input discovery ──────────────────────────────────────────────────────────

function resolveInputCsv(cliArg?: string): string {
  if (cliArg) {
    const abs = path.resolve(ROOT, cliArg);
    if (!fs.existsSync(abs)) throw new Error(`Input file not found: ${abs}`);
    return abs;
  }
  const inputDir = path.join(ROOT, 'input');
  if (!fs.existsSync(inputDir)) throw new Error('input/ directory not found');
  const dated = fs.readdirSync(inputDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  if (dated.length === 0) throw new Error('No YYYY-MM-DD folders found in input/');
  const folder = path.join(inputDir, dated[0]!);
  const csvs   = fs.readdirSync(folder).filter((f) => f.endsWith('.csv'));
  if (csvs.length === 0) throw new Error(`No CSV files in ${folder}`);
  return path.join(folder, csvs[0]!);
}

function parseCsvUrls(csvPath: string): string[] {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const start = lines[0]?.toLowerCase().startsWith('url') ? 1 : 0;
  return lines.slice(start).map((line) => {
    const val = line.startsWith('"') ? line.slice(1, line.lastIndexOf('"')) : line.split(',')[0]!;
    return val.trim();
  }).filter((u) => { try { new URL(u); return true; } catch { return false; } });
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

const ISSUE_META: Record<CtaIssue, { label: string; color: string; bg: string; dot: string }> = {
  'blank':                { label: 'Blank CTA',           color: '#ef4444', bg: 'rgba(239,68,68,.08)',   dot: '🔴' },
  'image-no-alt':         { label: 'Image — No Alt',      color: '#ef4444', bg: 'rgba(239,68,68,.06)',   dot: '🔴' },
  'no-accessible-name':   { label: 'No Accessible Name',  color: '#a78bfa', bg: 'rgba(167,139,250,.06)', dot: '🟣' },
  'icon-only':            { label: 'Icon — No Label',     color: '#f59e0b', bg: 'rgba(245,158,11,.06)',  dot: '🟡' },
  'empty-href':           { label: 'Empty href',          color: '#f59e0b', bg: 'rgba(245,158,11,.06)',  dot: '🟡' },
  'generic':              { label: 'Generic Text',        color: '#fb923c', bg: 'rgba(251,146,60,.05)',  dot: '🟠' },
};

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateHtml(
  results: CtaResult[],
  urls: string[],
  runDate: string,
  csvPath: string
): string {
  const counts: Record<CtaIssue, number> = { blank: 0, 'no-accessible-name': 0, 'image-no-alt': 0, 'icon-only': 0, 'empty-href': 0, generic: 0 };
  for (const r of results) counts[r.issueType]++;

  const pageSet = new Set(results.map((r) => r.pageUrl));
  const sectionSet = new Set(results.map((r) => r.section));

  const rows = results.map((r, i) => {
    const meta = ISSUE_META[r.issueType];
    return `<tr data-issue="${r.issueType}" data-section="${r.section}" data-url="${escHtml(r.pageUrl)}">
  <td class="idx">${i + 1}</td>
  <td class="cell-url"><a href="${escHtml(r.pageUrl)}" target="_blank" rel="noopener">${escHtml(new URL(r.pageUrl).pathname)}</a></td>
  <td><span class="badge-sec">${escHtml(r.section)}</span></td>
  <td><code>${escHtml(r.elementType)}</code></td>
  <td class="cell-text">${r.ctaText ? `<em>${escHtml(r.ctaText)}</em>` : '<span class="na">—</span>'}</td>
  <td class="cell-href">${r.href ? `<code title="${escHtml(r.href)}">${escHtml(r.href.slice(0,60))}${r.href.length>60?'…':''}</code>` : '<span class="na">—</span>'}</td>
  <td><span class="badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}40">${meta.dot} ${meta.label}</span></td>
  <td class="cell-detail">${escHtml(r.issueDetail)}</td>
  <td class="cell-snip"><code>${escHtml(r.htmlSnippet)}</code></td>
</tr>`;
  }).join('\n');

  const sectionOpts = [...sectionSet].sort().map((s) => `<option value="${s}">${s}</option>`).join('');

  const totalCritical = counts['blank'] + counts['image-no-alt'];
  const totalWarning  = counts['icon-only'] + counts['empty-href'];
  const totalInfo     = counts['generic'];
  const totalReview   = counts['no-accessible-name'];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Blank CTA Report — ${escHtml(runDate)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;line-height:1.5}
    a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
    code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:10px;background:#1e293b;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc;word-break:break-all}
    .wrap{max-width:1600px;margin:0 auto}
    .card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:18px 22px;margin-bottom:16px}
    h1{font-size:22px;font-weight:800;color:#f1f5f9}
    h2{font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e293b}
    .meta{color:#64748b;font-size:12px;margin-top:4px}

    /* Metric cards */
    .metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px}
    .metric{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:14px 10px;text-align:center}
    .metric-val{font-size:28px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
    .metric-lbl{font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
    .m-crit{border-color:#991b1b}.m-crit .metric-val{color:#ef4444}
    .m-warn{border-color:#92400e}.m-warn .metric-val{color:#f59e0b}
    .m-info{border-color:#92400e}.m-info .metric-val{color:#fb923c}
    .m-review{border-color:#5b21b6}.m-review .metric-val{color:#a78bfa}
    .m-pages{border-color:#1d4ed8}.m-pages .metric-val{color:#60a5fa}
    .m-total{border-color:#334155}.m-total .metric-val{color:#94a3b8}

    /* Legend */
    .legend{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
    .leg{display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8}
    .leg-dot{width:10px;height:10px;border-radius:50%}

    /* Controls */
    .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .controls input,.controls select{padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none}
    .controls input:focus,.controls select:focus{border-color:#3b82f6}
    .controls input{flex:1;min-width:220px}
    .btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#94a3b8;font-size:12px;cursor:pointer}
    .btn:hover{background:#3b82f6;border-color:#3b82f6;color:#fff}
    .rc{margin-left:auto;font-size:12px;color:#64748b;white-space:nowrap}

    /* Table */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:11px}
    th{position:sticky;top:0;z-index:2;background:#0f172a;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #334155;white-space:nowrap}
    td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:top}
    tr:hover td{background:rgba(255,255,255,.015)}
    .idx{color:#334155;text-align:right;width:36px;font-variant-numeric:tabular-nums}
    .cell-url{max-width:260px;word-break:break-all}
    .cell-url a{color:#93c5fd;font-size:11px}
    .cell-text em{color:#fbbf24;font-style:normal;font-weight:600}
    .cell-href{max-width:180px}
    .cell-detail{max-width:280px;color:#94a3b8;font-size:11px}
    .cell-snip{max-width:300px}
    .na{color:#334155}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap}
    .badge-sec{display:inline-block;padding:1px 6px;border-radius:3px;background:#1e293b;color:#64748b;font-size:10px;border:1px solid #334155}
    .hidden{display:none!important}
    footer{text-align:center;padding:16px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:8px}
  </style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>Blank CTA Audit Report</h1>
    <div class="meta">
      Run date: <strong style="color:#e2e8f0">${escHtml(runDate)}</strong> &nbsp;·&nbsp;
      Source: <code>${escHtml(path.basename(csvPath))}</code> &nbsp;·&nbsp;
      ${urls.length.toLocaleString()} URLs checked &nbsp;·&nbsp;
      ${pageSet.size.toLocaleString()} pages with issues
    </div>
  </div>

  <div class="metrics">
    <div class="metric m-pages">
      <div class="metric-val">${urls.length.toLocaleString()}</div>
      <div class="metric-lbl">Pages Checked</div>
    </div>
    <div class="metric m-total">
      <div class="metric-val">${results.length.toLocaleString()}</div>
      <div class="metric-lbl">Total Issues</div>
    </div>
    <div class="metric m-crit">
      <div class="metric-val">${counts['blank'].toLocaleString()}</div>
      <div class="metric-lbl">Blank CTAs</div>
    </div>
    <div class="metric m-crit">
      <div class="metric-val">${counts['image-no-alt'].toLocaleString()}</div>
      <div class="metric-lbl">Image — No Alt</div>
    </div>
    <div class="metric m-review">
      <div class="metric-val">${counts['no-accessible-name'].toLocaleString()}</div>
      <div class="metric-lbl">No Accessible Name</div>
    </div>
    <div class="metric m-warn">
      <div class="metric-val">${counts['icon-only'].toLocaleString()}</div>
      <div class="metric-lbl">Icon — No Label</div>
    </div>
    <div class="metric m-warn">
      <div class="metric-val">${counts['empty-href'].toLocaleString()}</div>
      <div class="metric-lbl">Empty href</div>
    </div>
    <div class="metric m-info">
      <div class="metric-val">${counts['generic'].toLocaleString()}</div>
      <div class="metric-lbl">Generic Text</div>
    </div>
  </div>

  <div class="card">
    <h2>CTA Issues</h2>
    <div class="legend">
      <span class="leg"><span class="leg-dot" style="background:#ef4444"></span>Blank CTA — button/input with no text (critical)</span>
      <span class="leg"><span class="leg-dot" style="background:#ef4444"></span>Image link — missing alt text (critical)</span>
      <span class="leg"><span class="leg-dot" style="background:#a78bfa"></span>No Accessible Name — link with href but no label (needs review / may be false positive)</span>
      <span class="leg"><span class="leg-dot" style="background:#f59e0b"></span>Icon-only — no aria-label (warning)</span>
      <span class="leg"><span class="leg-dot" style="background:#f59e0b"></span>Empty href — link goes nowhere (warning)</span>
      <span class="leg"><span class="leg-dot" style="background:#fb923c"></span>Generic text — "click here" etc. (info)</span>
    </div>
    <div class="controls">
      <input id="q" placeholder="Search URL, text, detail…" autocomplete="off">
      <select id="fi">
        <option value="">All Issue Types</option>
        <option value="blank">🔴 Blank CTA</option>
        <option value="image-no-alt">🔴 Image — No Alt</option>
        <option value="no-accessible-name">🟣 No Accessible Name</option>
        <option value="icon-only">🟡 Icon — No Label</option>
        <option value="empty-href">🟡 Empty href</option>
        <option value="generic">🟠 Generic Text</option>
      </select>
      <select id="fs">
        <option value="">All Sections</option>
        ${sectionOpts}
      </select>
      <button class="btn" onclick="exportCsv()">⬇ Export CSV</button>
      <span class="rc" id="rc">${results.length.toLocaleString()} issues</span>
    </div>
    <div class="tbl-wrap">
      <table id="tbl">
        <thead>
          <tr>
            <th>#</th>
            <th>Page URL</th>
            <th>Section</th>
            <th>Element</th>
            <th>CTA Text</th>
            <th>href / Target</th>
            <th>Issue Type</th>
            <th>Detail</th>
            <th>HTML Snippet</th>
          </tr>
        </thead>
        <tbody id="tbody">
          ${rows}
        </tbody>
      </table>
    </div>
  </div>

  <footer>
    Blank CTA Checker — Playwright TypeScript QA Suite &nbsp;·&nbsp;
    ${escHtml(runDate)} &nbsp;·&nbsp;
    ${urls.length.toLocaleString()} pages checked
  </footer>
</div>

<script>
  const allRows = [...document.querySelectorAll('#tbody tr')];
  const q  = document.getElementById('q');
  const fi = document.getElementById('fi');
  const fs = document.getElementById('fs');
  const rc = document.getElementById('rc');

  function filter() {
    const qs = q.value.toLowerCase();
    const is = fi.value;
    const ss = fs.value;
    let vis = 0;
    allRows.forEach(r => {
      const ok = (!qs || r.textContent.toLowerCase().includes(qs))
               && (!is || r.dataset.issue === is)
               && (!ss || r.dataset.section === ss);
      r.classList.toggle('hidden', !ok);
      if (ok) vis++;
    });
    rc.textContent = vis.toLocaleString() + ' issues';
  }

  q.addEventListener('input', filter);
  fi.addEventListener('change', filter);
  fs.addEventListener('change', filter);

  function exportCsv() {
    const vis = allRows.filter(r => !r.classList.contains('hidden'));
    const hdrs = ['#','Page URL','Section','Element','CTA Text','href','Issue Type','Detail','HTML Snippet'];
    const lines = [hdrs.join(',')];
    vis.forEach(r => {
      const cells = [...r.cells].map(c => '"' + c.textContent.trim().replace(/"/g,'""') + '"');
      lines.push(cells.join(','));
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\\n')], {type:'text/csv'}));
    a.download = 'blank-cta-export.csv';
    a.click();
  }
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args      = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const cliInput  = inputFlag >= 0 ? args[inputFlag + 1] : undefined;

  const csvPath = resolveInputCsv(cliInput);
  const urls    = parseCsvUrls(csvPath);

  const folderName = path.basename(path.dirname(csvPath));
  const runDate    = /^\d{4}-\d{2}-\d{2}$/.test(folderName) ? folderName : new Date().toISOString().slice(0, 10);
  const outDir     = path.join(ROOT, 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlOut = path.join(outDir, `blank-cta-${runDate}.html`);

  console.log(`\n🔘  Blank CTA Checker — University of Findlay`);
  console.log(`    Input   : ${csvPath}`);
  console.log(`    URLs    : ${urls.length.toLocaleString()}`);
  console.log(`    Workers : ${CONCURRENCY} concurrent`);
  console.log(`    Output  : ${outDir}\n`);

  const allResults: CtaResult[] = [];
  let cursor = 0;
  const startTime = Date.now();
  let lastLog = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx]!;
      const body = await fetchBody(url);
      if (body) {
        const found = extractCtas(body, url);
        allResults.push(...found);
      }
      const done = idx + 1;
      const now  = Date.now();
      if (now - lastLog > 800 || done === urls.length) {
        const pct     = Math.round((done / urls.length) * 100);
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r  [${String(done).padStart(4)}/${urls.length}] ${pct}%  — ${allResults.length} issues found  ${elapsed}s`);
        lastLog = now;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  console.log(`\n\n  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  const counts: Record<CtaIssue, number> = { blank: 0, 'no-accessible-name': 0, 'image-no-alt': 0, 'icon-only': 0, 'empty-href': 0, generic: 0 };
  for (const r of allResults) counts[r.issueType]++;

  const line = '─'.repeat(50);
  console.log(`  ${line}`);
  console.log(`  📋 Pages checked           : ${urls.length.toLocaleString().padStart(6)}`);
  console.log(`  ⚠  Total CTA issues        : ${allResults.length.toLocaleString().padStart(6)}`);
  console.log(`  🔴 Blank CTAs (btn/input)  : ${counts['blank'].toLocaleString().padStart(6)}`);
  console.log(`  🔴 Image — No Alt          : ${counts['image-no-alt'].toLocaleString().padStart(6)}`);
  console.log(`  🟣 No Accessible Name (⚠ may be FP): ${counts['no-accessible-name'].toLocaleString().padStart(6)}`);
  console.log(`  🟡 Icon — No Label         : ${counts['icon-only'].toLocaleString().padStart(6)}`);
  console.log(`  🟡 Empty href              : ${counts['empty-href'].toLocaleString().padStart(6)}`);
  console.log(`  🟠 Generic Text            : ${counts['generic'].toLocaleString().padStart(6)}`);
  console.log(`  ${line}\n`);

  process.stdout.write('  Generating HTML report…');
  const html = generateHtml(allResults, urls, runDate, csvPath);
  fs.writeFileSync(htmlOut, html, 'utf8');
  console.log(` ✅  (${Math.round(html.length / 1024)}KB)`);
  console.log(`\n  📄 HTML : ${htmlOut}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
