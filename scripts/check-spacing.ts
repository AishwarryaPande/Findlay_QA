#!/usr/bin/env ts-node
/**
 * Spacing Issue Checker — University of Findlay
 *
 * Uses Playwright (real Chromium) to load every page from the input CSV,
 * evaluates all block-level elements for excessive margin/padding,
 * highlights problem areas, takes annotated screenshots, and generates
 * a developer-friendly HTML report.
 *
 * Thresholds (configurable via env):
 *   WARN_PX=80     margin/padding ≥ 80px → warning
 *   CRIT_PX=150    margin/padding ≥ 150px → critical
 *   EMPTY_PX=100   empty spacer div height ≥ 100px → flagged
 *
 * Usage:
 *   npm run check-spacing
 *   CONCURRENCY=3 npm run check-spacing
 */

import * as fs   from 'fs';
import * as path from 'path';
import { URL }   from 'url';
import { chromium, Browser, Page } from '@playwright/test';

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '3', 10);
const WARN_PX     = parseInt(process.env['WARN_PX']     ?? '80',  10);
const CRIT_PX     = parseInt(process.env['CRIT_PX']     ?? '150', 10);
const EMPTY_PX    = parseInt(process.env['EMPTY_PX']    ?? '100', 10);
const VIEWPORT    = { width: 1280, height: 800 };
const NAV_TIMEOUT = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'warning';

interface SpacingIssue {
  selector:    string;
  property:    string;
  value:       number;
  unit:        string;
  severity:    Severity;
  section:     string;
  rect:        { top: number; left: number; width: number; height: number };
  suggestion:  string;
}

interface PageResult {
  url:        string;
  urlPath:    string;
  issues:     SpacingIssue[];
  screenshot: string;   // base64 PNG
  error?:     string;
  checkedAt:  string;
}

// ─── Input discovery ──────────────────────────────────────────────────────────

function resolveInputCsv(cliArg?: string): string {
  if (cliArg) {
    const abs = path.resolve(ROOT, cliArg);
    if (!fs.existsSync(abs)) throw new Error(`Input not found: ${abs}`);
    return abs;
  }
  const inputDir = path.join(ROOT, 'input');
  const dated    = fs.readdirSync(inputDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  if (!dated.length) throw new Error('No YYYY-MM-DD folders in input/');
  const folder = path.join(inputDir, dated[0]!);
  const csvs   = fs.readdirSync(folder).filter((f) => f.endsWith('.csv'));
  if (!csvs.length) throw new Error(`No CSVs in ${folder}`);
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

// ─── Page evaluation (runs inside browser) ────────────────────────────────────

interface BrowserIssue {
  selector:   string;
  property:   string;
  value:      number;
  unit:       string;
  severity:   Severity;
  section:    string;
  rect:       { top: number; left: number; width: number; height: number };
  suggestion: string;
}

async function checkPage(page: Page, url: string): Promise<PageResult> {
  const checkedAt = new Date().toISOString();
  let urlPath = '/';
  try { urlPath = new URL(url).pathname; } catch {}

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1500); // allow CSS to settle

    // Evaluate spacing issues inside browser context
    const issues: BrowserIssue[] = await page.evaluate(
      ({ warnPx, critPx, emptyPx }: { warnPx: number; critPx: number; emptyPx: number }) => {
        const SELECTORS = 'section,div,main,article,aside,header,footer,h1,h2,h3,h4,h5,h6,p,ul,ol,li,blockquote,.wp-block-group,.entry-content';
        const els = Array.from(document.querySelectorAll(SELECTORS));
        const found: BrowserIssue[] = [];
        const seen  = new Set<string>();

        function getSection(el: Element): string {
          let cur: Element | null = el;
          while (cur) {
            const tag = cur.tagName.toLowerCase();
            if (tag === 'nav')    return 'nav';
            if (tag === 'header') return 'header';
            if (tag === 'footer') return 'footer';
            if (tag === 'aside')  return 'sidebar';
            if (tag === 'main' || cur.id === 'main' || cur.classList.contains('main')) return 'main';
            cur = cur.parentElement;
          }
          return 'content';
        }

        function selector(el: Element): string {
          const tag  = el.tagName.toLowerCase();
          const id   = el.id   ? `#${el.id}`   : '';
          const cls  = Array.from(el.classList).slice(0, 3).map((c) => `.${c}`).join('');
          const nth  = el.parentElement
            ? Array.from(el.parentElement.children).indexOf(el) + 1
            : 1;
          return `${tag}${id}${cls}:nth-child(${nth})`;
        }

        function suggestion(prop: string, val: number, tag: string): string {
          if (prop === 'empty-spacer') return `Remove or reduce empty spacer div (height: ${val}px). Use margin/padding on surrounding elements instead.`;
          const side = prop.includes('top') ? 'top' : 'bottom';
          const type = prop.startsWith('margin') ? 'margin' : 'padding';
          const rec  = val > 150 ? Math.round(val * 0.4) : Math.round(val * 0.6);
          return `${type}-${side}: ${val}px seems excessive on <${tag}>. Consider reducing to ~${rec}px or using a design token/spacing variable.`;
        }

        for (const el of els) {
          const style = window.getComputedStyle(el);
          const rect  = el.getBoundingClientRect();
          const tag   = el.tagName.toLowerCase();

          // Skip invisible/off-screen/tiny
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (rect.width < 10 || (rect.width === 0 && rect.height === 0)) continue;

          const section = getSection(el);
          const sel     = selector(el);

          // Check margin & padding properties
          const props: [string, string][] = [
            ['margin-top',    style.marginTop],
            ['margin-bottom', style.marginBottom],
            ['padding-top',   style.paddingTop],
            ['padding-bottom',style.paddingBottom],
            ['margin-left',   style.marginLeft],
            ['margin-right',  style.marginRight],
            ['padding-left',  style.paddingLeft],
            ['padding-right', style.paddingRight],
          ];

          for (const [prop, raw] of props) {
            const val = parseFloat(raw);
            if (isNaN(val) || val < warnPx) continue;
            const severity: Severity = val >= critPx ? 'critical' : 'warning';
            const key = `${sel}::${prop}`;
            if (seen.has(key)) continue;
            seen.add(key);

            found.push({
              selector: sel, property: prop, value: val, unit: 'px',
              severity, section,
              rect: { top: Math.round(rect.top + window.scrollY), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
              suggestion: suggestion(prop, val, tag),
            });
          }

          // Detect empty spacer divs
          if (tag === 'div' && rect.height >= emptyPx) {
            const textContent = (el.textContent ?? '').trim();
            const hasChildren = el.children.length > 0;
            if (!textContent && !hasChildren) {
              const key = `${sel}::empty-spacer`;
              if (!seen.has(key)) {
                seen.add(key);
                found.push({
                  selector: sel, property: 'empty-spacer', value: Math.round(rect.height), unit: 'px',
                  severity: rect.height >= critPx ? 'critical' : 'warning',
                  section,
                  rect: { top: Math.round(rect.top + window.scrollY), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                  suggestion: suggestion('empty-spacer', Math.round(rect.height), tag),
                });
              }
            }
          }
        }

        return found;
      },
      { warnPx: WARN_PX, critPx: CRIT_PX, emptyPx: EMPTY_PX }
    );

    // Highlight issues on the page before screenshot
    if (issues.length > 0) {
      await page.evaluate((issuesToHighlight: BrowserIssue[]) => {
        const overlay = document.createElement('div');
        overlay.id    = '__spacing_overlay__';
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:999999';
        document.body.appendChild(overlay);

        issuesToHighlight.slice(0, 60).forEach((issue) => {
          const box = document.createElement('div');
          const col = issue.severity === 'critical' ? '#ef4444' : '#f59e0b';
          box.style.cssText = `
            position:absolute;
            top:${issue.rect.top}px;
            left:${issue.rect.left}px;
            width:${issue.rect.width}px;
            height:${issue.rect.height}px;
            border:3px solid ${col};
            background:${col}18;
            box-sizing:border-box;
          `;
          const label = document.createElement('div');
          label.textContent = `${issue.property}: ${issue.value}px`;
          label.style.cssText = `
            background:${col};color:#fff;font:bold 10px monospace;
            padding:2px 6px;position:absolute;top:0;left:0;
            max-width:200px;white-space:nowrap;overflow:hidden;
          `;
          box.appendChild(label);
          overlay.appendChild(box);
        });
      }, issues);
    }

    // Full-page screenshot (compressed)
    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 60,
    });
    const screenshot = screenshotBuffer.toString('base64');

    // Remove overlay
    await page.evaluate(() => {
      document.getElementById('__spacing_overlay__')?.remove();
    });

    return { url, urlPath, issues, screenshot, checkedAt };

  } catch (err: unknown) {
    return {
      url, urlPath, issues: [], screenshot: '',
      error: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateHtml(
  results: PageResult[],
  runDate: string,
  csvPath: string,
  totalUrls: number
): string {
  const pagesWithIssues = results.filter((r) => r.issues.length > 0);
  const allIssues       = results.flatMap((r) => r.issues.map((i) => ({ ...i, pageUrl: r.url, urlPath: r.urlPath })));
  const critCount       = allIssues.filter((i) => i.severity === 'critical').length;
  const warnCount       = allIssues.filter((i) => i.severity === 'warning').length;
  const errorPages      = results.filter((r) => r.error).length;

  const propCounts: Record<string, number> = {};
  for (const i of allIssues) {
    propCounts[i.property] = (propCounts[i.property] ?? 0) + 1;
  }
  const topProps = Object.entries(propCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const pageCards = pagesWithIssues.map((r) => {
    const crit = r.issues.filter((i) => i.severity === 'critical').length;
    const warn = r.issues.filter((i) => i.severity === 'warning').length;
    const rows  = r.issues.map((issue) => {
      const sev = issue.severity === 'critical'
        ? '<span class="badge badge-crit">Critical</span>'
        : '<span class="badge badge-warn">Warning</span>';
      return `<tr>
        <td><code class="sel">${escHtml(issue.selector)}</code></td>
        <td><code>${escHtml(issue.property)}</code></td>
        <td class="val-cell"><strong>${issue.value}${issue.unit}</strong></td>
        <td>${sev}</td>
        <td class="sec-cell"><span class="badge-sec">${escHtml(issue.section)}</span></td>
        <td class="suggest-cell">${escHtml(issue.suggestion)}</td>
      </tr>`;
    }).join('');

    const imgTag = r.screenshot
      ? `<img class="page-ss" src="data:image/jpeg;base64,${r.screenshot}" alt="Screenshot of ${escHtml(r.urlPath)}" loading="lazy">`
      : '<div class="no-ss">No screenshot</div>';

    return `<div class="page-card" data-crit="${crit}" data-warn="${warn}">
  <div class="page-hdr">
    <div>
      <a href="${escHtml(r.url)}" target="_blank" rel="noopener" class="page-url">${escHtml(r.urlPath)}</a>
      <span class="page-counts">
        ${crit > 0 ? `<span class="badge badge-crit">${crit} critical</span>` : ''}
        ${warn > 0 ? `<span class="badge badge-warn">${warn} warning</span>` : ''}
      </span>
    </div>
    <button class="toggle-btn" onclick="toggleCard(this)">▼ Show details</button>
  </div>
  <div class="page-body" style="display:none">
    <div class="ss-wrap">${imgTag}</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Selector</th><th>Property</th><th>Value</th><th>Severity</th><th>Section</th><th>Suggestion</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</div>`;
  }).join('\n');

  const topPropsHtml = topProps.map(([prop, cnt]) =>
    `<div class="prop-bar">
      <span class="prop-name"><code>${escHtml(prop)}</code></span>
      <div class="bar-bg"><div class="bar-fill" style="width:${Math.round((cnt / (topProps[0]![1])) * 100)}%"></div></div>
      <span class="prop-cnt">${cnt}</span>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Spacing Issues Report — ${escHtml(runDate)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;line-height:1.5}
    a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
    code{font-family:'JetBrains Mono','Fira Code',monospace;font-size:10px;background:#1e293b;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc}
    .wrap{max-width:1400px;margin:0 auto}

    /* Header */
    .hdr{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:20px 24px;margin-bottom:16px}
    h1{font-size:22px;font-weight:800;color:#f1f5f9}
    .meta{color:#64748b;font-size:12px;margin-top:4px}

    /* Metrics */
    .metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px}
    .metric{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:14px 10px;text-align:center}
    .metric-val{font-size:30px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
    .metric-lbl{font-size:10px;color:#94a3b8;margin-top:3px;text-transform:uppercase;letter-spacing:.4px}
    .m-crit{border-color:#991b1b}.m-crit .metric-val{color:#ef4444}
    .m-warn{border-color:#92400e}.m-warn .metric-val{color:#f59e0b}
    .m-pages{border-color:#1d4ed8}.m-pages .metric-val{color:#60a5fa}
    .m-ok{border-color:#166534}.m-ok .metric-val{color:#22c55e}

    /* Property breakdown */
    .card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:18px 22px;margin-bottom:16px}
    h2{font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1e293b}
    .prop-bar{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px}
    .prop-name{min-width:180px}
    .bar-bg{flex:1;height:10px;background:#1e293b;border-radius:5px;overflow:hidden}
    .bar-fill{height:100%;background:#3b82f6;border-radius:5px;transition:width .3s}
    .prop-cnt{min-width:36px;text-align:right;color:#64748b}

    /* Controls */
    .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
    .controls input,.controls select{padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none}
    .controls input:focus,.controls select:focus{border-color:#3b82f6}
    .controls input{flex:1;min-width:220px}
    .btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#94a3b8;font-size:12px;cursor:pointer;white-space:nowrap}
    .btn:hover{background:#3b82f6;border-color:#3b82f6;color:#fff}
    .rc{margin-left:auto;font-size:12px;color:#64748b;white-space:nowrap}

    /* Page cards */
    .page-card{background:#111827;border:1px solid #1e293b;border-radius:8px;margin-bottom:10px;overflow:hidden}
    .page-card[data-crit]:not([data-crit="0"]) .page-hdr{border-left:4px solid #ef4444}
    .page-card[data-crit="0"] .page-hdr{border-left:4px solid #f59e0b}
    .page-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:12px;cursor:pointer}
    .page-url{font-size:12px;font-weight:600;color:#93c5fd}
    .page-counts{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
    .toggle-btn{padding:4px 10px;border-radius:5px;border:1px solid #334155;background:#0f172a;color:#94a3b8;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
    .toggle-btn:hover{background:#334155}
    .page-body{padding:0 16px 16px}

    /* Screenshot */
    .ss-wrap{margin-bottom:12px;border-radius:6px;overflow:hidden;border:1px solid #334155;max-height:400px;overflow-y:auto}
    .page-ss{width:100%;display:block}
    .no-ss{background:#1e293b;color:#64748b;text-align:center;padding:30px;font-size:12px}

    /* Issue table */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;font-size:11px}
    th{background:#0f172a;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #334155;white-space:nowrap}
    td{padding:6px 10px;border-bottom:1px solid #1e293b;vertical-align:top}
    .sel{display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .val-cell{text-align:center;font-variant-numeric:tabular-nums}.val-cell strong{color:#fbbf24}
    .sec-cell{white-space:nowrap}
    .suggest-cell{color:#94a3b8;font-size:10px;max-width:280px}

    /* Badges */
    .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap}
    .badge-crit{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid #ef444440}
    .badge-warn{background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid #f59e0b40}
    .badge-sec{display:inline-block;padding:1px 6px;border-radius:3px;background:#1e293b;color:#64748b;font-size:10px;border:1px solid #334155}

    .hidden{display:none!important}
    footer{text-align:center;padding:16px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:8px}
  </style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <h1>🔲 Spacing Issues Report</h1>
    <div class="meta">
      Run date: <strong style="color:#e2e8f0">${escHtml(runDate)}</strong> &nbsp;·&nbsp;
      Source: <code>${escHtml(path.basename(csvPath))}</code> &nbsp;·&nbsp;
      ${totalUrls.toLocaleString()} pages checked &nbsp;·&nbsp;
      Thresholds: warning ≥ ${WARN_PX}px · critical ≥ ${CRIT_PX}px
    </div>
  </div>

  <div class="metrics">
    <div class="metric m-pages">
      <div class="metric-val">${totalUrls.toLocaleString()}</div>
      <div class="metric-lbl">Pages Checked</div>
    </div>
    <div class="metric m-crit">
      <div class="metric-val">${pagesWithIssues.length.toLocaleString()}</div>
      <div class="metric-lbl">Pages with Issues</div>
    </div>
    <div class="metric m-crit">
      <div class="metric-val">${critCount.toLocaleString()}</div>
      <div class="metric-lbl">Critical (≥${CRIT_PX}px)</div>
    </div>
    <div class="metric m-warn">
      <div class="metric-val">${warnCount.toLocaleString()}</div>
      <div class="metric-lbl">Warning (≥${WARN_PX}px)</div>
    </div>
    <div class="metric m-ok">
      <div class="metric-val">${(totalUrls - pagesWithIssues.length - errorPages).toLocaleString()}</div>
      <div class="metric-lbl">Clean Pages</div>
    </div>
    ${errorPages > 0 ? `<div class="metric"><div class="metric-val" style="color:#94a3b8">${errorPages}</div><div class="metric-lbl">Load Errors</div></div>` : ''}
  </div>

  <div class="card">
    <h2>Most Frequent Spacing Properties</h2>
    ${topPropsHtml}
  </div>

  <div class="card">
    <h2>Pages with Spacing Issues (${pagesWithIssues.length})</h2>
    <div class="controls">
      <input id="q" placeholder="Search page URL or selector…" autocomplete="off">
      <select id="fs">
        <option value="">All Severities</option>
        <option value="critical">🔴 Critical only</option>
        <option value="warning">🟡 Warning only</option>
      </select>
      <button class="btn" onclick="expandAll()">Expand All</button>
      <button class="btn" onclick="collapseAll()">Collapse All</button>
      <button class="btn" onclick="exportCsv()">⬇ Export CSV</button>
      <span class="rc" id="rc">${pagesWithIssues.length} pages</span>
    </div>
    <div id="cards">
      ${pageCards}
    </div>
  </div>

  <footer>
    Spacing Issue Checker — Playwright TypeScript QA Suite &nbsp;·&nbsp;
    ${escHtml(runDate)} &nbsp;·&nbsp;
    Viewport: ${VIEWPORT.width}×${VIEWPORT.height}
  </footer>
</div>

<script>
  const cards = [...document.querySelectorAll('.page-card')];
  const q     = document.getElementById('q');
  const fs    = document.getElementById('fs');
  const rc    = document.getElementById('rc');

  function filter() {
    const qs = q.value.toLowerCase();
    const sv = fs.value;
    let vis  = 0;
    cards.forEach(c => {
      const url   = c.querySelector('.page-url')?.textContent?.toLowerCase() ?? '';
      const sels  = [...c.querySelectorAll('.sel')].map(s => s.textContent?.toLowerCase()).join(' ');
      const crit  = parseInt(c.dataset.crit ?? '0', 10);
      const warn  = parseInt(c.dataset.warn ?? '0', 10);
      const okSev = !sv || (sv === 'critical' && crit > 0) || (sv === 'warning' && warn > 0 && crit === 0);
      const okQ   = !qs || url.includes(qs) || sels.includes(qs);
      c.classList.toggle('hidden', !(okSev && okQ));
      if (!(c.classList.contains('hidden'))) vis++;
    });
    rc.textContent = vis + ' pages';
  }

  q.addEventListener('input', filter);
  fs.addEventListener('change', filter);

  function toggleCard(btn) {
    const body  = btn.closest('.page-card').querySelector('.page-body');
    const open  = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    btn.textContent    = open ? '▼ Show details' : '▲ Hide details';
  }

  function expandAll() {
    cards.filter(c => !c.classList.contains('hidden')).forEach(c => {
      c.querySelector('.page-body').style.display = 'block';
      c.querySelector('.toggle-btn').textContent  = '▲ Hide details';
    });
  }

  function collapseAll() {
    cards.forEach(c => {
      c.querySelector('.page-body').style.display = 'none';
      c.querySelector('.toggle-btn').textContent  = '▼ Show details';
    });
  }

  function exportCsv() {
    const rows = [['Page URL','Selector','Property','Value (px)','Severity','Section','Suggestion']];
    cards.filter(c => !c.classList.contains('hidden')).forEach(c => {
      const url = c.querySelector('.page-url')?.textContent?.trim() ?? '';
      c.querySelectorAll('tbody tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.textContent?.trim() ?? '');
        rows.push([url, ...cells]);
      });
    });
    const csv  = rows.map(r => r.map(v => '"' + v.replace(/"/g,'""') + '"').join(',')).join('\\n');
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = 'spacing-issues-export.csv';
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
  const htmlOut = path.join(outDir, `spacing-issues-${runDate}.html`);

  console.log(`\n📐  Spacing Issue Checker — University of Findlay`);
  console.log(`    Input     : ${csvPath}`);
  console.log(`    URLs      : ${urls.length.toLocaleString()}`);
  console.log(`    Browsers  : ${CONCURRENCY} concurrent`);
  console.log(`    Viewport  : ${VIEWPORT.width}×${VIEWPORT.height}`);
  console.log(`    Threshold : warning ≥ ${WARN_PX}px · critical ≥ ${CRIT_PX}px`);
  console.log(`    Output    : ${outDir}\n`);

  const browser: Browser = await chromium.launch({ headless: true });
  const results: PageResult[] = new Array(urls.length);
  let cursor    = 0;
  let done      = 0;
  const startTime = Date.now();
  let lastLog   = 0;

  async function worker(): Promise<void> {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx]!;
      results[idx] = await checkPage(page, url);
      done++;
      const now = Date.now();
      if (now - lastLog > 1000 || done === urls.length) {
        const pct     = Math.round((done / urls.length) * 100);
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        const issues  = results.slice(0, done).reduce((s, r) => s + (r?.issues.length ?? 0), 0);
        process.stdout.write(`\r  [${String(done).padStart(4)}/${urls.length}] ${pct}%  — ${issues} spacing issues found  ${elapsed}s`);
        lastLog = now;
      }
    }

    await context.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  console.log(`\n\n  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  const validResults = results.filter(Boolean) as PageResult[];
  const allIssues    = validResults.flatMap((r) => r.issues);
  const critCount    = allIssues.filter((i) => i.severity === 'critical').length;
  const warnCount    = allIssues.filter((i) => i.severity === 'warning').length;
  const errorPages   = validResults.filter((r) => r.error).length;
  const pagesWithIss = validResults.filter((r) => r.issues.length > 0).length;

  const line = '─'.repeat(46);
  console.log(`  ${line}`);
  console.log(`  📋 Pages checked       : ${urls.length.toLocaleString().padStart(6)}`);
  console.log(`  ⚠  Pages with issues   : ${pagesWithIss.toLocaleString().padStart(6)}`);
  console.log(`  🔴 Critical issues     : ${critCount.toLocaleString().padStart(6)}  (≥${CRIT_PX}px)`);
  console.log(`  🟡 Warning issues      : ${warnCount.toLocaleString().padStart(6)}  (≥${WARN_PX}px)`);
  console.log(`  ✅ Clean pages         : ${(urls.length - pagesWithIss - errorPages).toLocaleString().padStart(6)}`);
  if (errorPages) console.log(`  ❌ Load errors         : ${errorPages.toLocaleString().padStart(6)}`);
  console.log(`  ${line}\n`);

  process.stdout.write('  Generating HTML report…');
  const html = generateHtml(validResults, runDate, csvPath, urls.length);
  fs.writeFileSync(htmlOut, html, 'utf8');
  console.log(` ✅  (${Math.round(html.length / 1024)}KB)`);
  console.log(`\n  📄 HTML : ${htmlOut}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
