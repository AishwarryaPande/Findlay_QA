#!/usr/bin/env ts-node
/**
 * UX Spacing Audit — University of Findlay
 *
 * QA-lead reviewed spacing analysis. Eliminates false alarms by:
 *   1. Only checking MAIN CONTENT area (skips header/nav/footer)
 *   2. Higher thresholds calibrated to the Figma design
 *   3. Separating GLOBAL CSS issues (theme-level, one fix) from PAGE-SPECIFIC issues
 *   4. Always flagging empty spacer divs (never intentional)
 *   5. Skipping auto-centred containers (equal margin-left === margin-right)
 *
 * Thresholds:
 *   WARN_PX=120    vertical margin/padding ≥ 120px  → warning
 *   CRIT_PX=250    vertical margin/padding ≥ 250px  → critical
 *   H_WARN_PX=80   horizontal padding ≥ 80px        → warning (lower — unusual in content)
 *   EMPTY_PX=60    empty spacer div height ≥ 60px   → always flagged
 *
 * Global threshold:
 *   GLOBAL_THRESHOLD=0.35  Pattern on >35% of pages = theme CSS issue
 */

import * as fs   from 'fs';
import * as path from 'path';
import { URL }   from 'url';
import { chromium, Browser, Page } from '@playwright/test';

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT             = path.resolve(__dirname, '..');
const CONCURRENCY      = parseInt(process.env['CONCURRENCY']        ?? '3',    10);
const WARN_PX          = parseInt(process.env['WARN_PX']            ?? '120',  10);
const CRIT_PX          = parseInt(process.env['CRIT_PX']            ?? '250',  10);
const H_WARN_PX        = parseInt(process.env['H_WARN_PX']          ?? '80',   10);
const EMPTY_PX         = parseInt(process.env['EMPTY_PX']           ?? '60',   10);
const GLOBAL_THRESHOLD = parseFloat(process.env['GLOBAL_THRESHOLD'] ?? '0.35');
const VIEWPORT         = { width: 1440, height: 900 };
const NAV_TIMEOUT      = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'warning';

interface RawIssue {
  selector:      string;
  normSelector:  string;
  property:      string;
  value:         number;
  severity:      Severity;
  section:       string;
  rect:          { top: number; left: number; width: number; height: number };
  isEmptySpacer: boolean;
  context:       string;
}

interface PageResult {
  url:        string;
  urlPath:    string;
  issues:     RawIssue[];
  screenshot: string;
  error?:     string;
  checkedAt:  string;
}

interface PatternEntry {
  normSelector: string;
  property:     string;
  values:       number[];
  maxValue:     number;
  pageCount:    number;
  pagePaths:    string[];
  severity:     Severity;
}

// ─── Input discovery ──────────────────────────────────────────────────────────

function resolveInputCsv(): string {
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

// ─── Page evaluation ─────────────────────────────────────────────────────────

async function checkPage(page: Page, url: string): Promise<PageResult> {
  const checkedAt = new Date().toISOString();
  let urlPath = '/';
  try { urlPath = new URL(url).pathname; } catch {}

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 0));

    const issues: RawIssue[] = await page.evaluate(
      ({ warnPx, critPx, emptyPx, hWarnPx }: { warnPx: number; critPx: number; emptyPx: number; hWarnPx: number }) => {

        // ── Helpers ──────────────────────────────────────────────────────────

        function inMainContent(el: Element): boolean {
          let cur: Element | null = el;
          while (cur) {
            const tag  = cur.tagName.toLowerCase();
            const role = cur.getAttribute('role') ?? '';
            // Stop at template shell → not in content
            if (tag === 'nav')    return false;
            if (tag === 'header' && cur.parentElement === document.body) return false;
            if (tag === 'footer') return false;
            // Inside known content containers → in content
            if (tag === 'main' || role === 'main') return true;
            if (cur.id === 'main' || cur.id === 'content' || cur.id === 'primary') return true;
            if (cur.classList.contains('site-main')     ||
                cur.classList.contains('entry-content') ||
                cur.classList.contains('page-content')  ||
                cur.classList.contains('post-content')  ||
                cur.classList.contains('site-content')) return true;
            cur = cur.parentElement;
          }
          // Fallback: if no wrapper found, treat body-direct sections as content
          return false;
        }

        function normalizeSelector(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const cls = Array.from(el.classList)
            .filter((c) =>
              !c.match(/^(wp-container-|is-|has-active|open|selected|hover|focus|visible|animate)/) &&
              !c.match(/\d{5,}/)   // dynamic numeric IDs
            )
            .sort()
            .slice(0, 5)
            .join('.');
          return cls ? `${tag}.${cls}` : tag;
        }

        function fullSelector(el: Element): string {
          const tag = el.tagName.toLowerCase();
          const id  = el.id ? `#${el.id}` : '';
          const cls = Array.from(el.classList).slice(0, 4).map((c) => `.${c}`).join('');
          return `${tag}${id}${cls}`;
        }

        function getContext(el: Element): string {
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
          return text || el.tagName.toLowerCase();
        }

        // ── Scan ─────────────────────────────────────────────────────────────

        const targets = Array.from(document.querySelectorAll(
          'section, div, article, p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, ' +
          '.wp-block-group, .wp-block-spacer, .wp-block-cover, .wp-block-columns, .wp-block-column'
        ));

        const found: Array<{
          selector: string; normSelector: string; property: string; value: number;
          severity: 'critical' | 'warning'; section: string;
          rect: { top: number; left: number; width: number; height: number };
          isEmptySpacer: boolean; context: string;
        }> = [];

        const seen = new Set<string>();

        for (const el of targets) {
          if (!inMainContent(el)) continue;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || (rect.width === 0 && rect.height === 0)) continue;

          const tag     = el.tagName.toLowerCase();
          const sel     = fullSelector(el);
          const normSel = normalizeSelector(el);
          const ctx     = getContext(el);

          // ── 1. Empty spacer divs — always flag ───────────────────────────
          if (tag === 'div' && rect.height >= emptyPx) {
            const textContent = (el.textContent ?? '').trim();
            if (!textContent && el.children.length === 0) {
              const key = `${sel}::empty-spacer`;
              if (!seen.has(key)) {
                seen.add(key);
                found.push({
                  selector: sel, normSelector: normSel, property: 'empty-spacer',
                  value: Math.round(rect.height),
                  severity: rect.height >= critPx ? 'critical' : 'warning',
                  section: 'main-content',
                  rect: { top: Math.round(rect.top + window.scrollY), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                  isEmptySpacer: true, context: 'Empty spacer div',
                });
              }
              continue;
            }
          }

          // ── 2. Vertical spacing — high threshold ─────────────────────────
          const vertProps: [string, string][] = [
            ['margin-top',    style.marginTop],
            ['margin-bottom', style.marginBottom],
            ['padding-top',   style.paddingTop],
            ['padding-bottom',style.paddingBottom],
          ];
          for (const [prop, raw] of vertProps) {
            const val = parseFloat(raw);
            if (isNaN(val) || val < warnPx) continue;
            const key = `${sel}::${prop}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({
              selector: sel, normSelector: normSel, property: prop, value: val,
              severity: val >= critPx ? 'critical' : 'warning',
              section: 'main-content',
              rect: { top: Math.round(rect.top + window.scrollY), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
              isEmptySpacer: false, context: ctx,
            });
          }

          // ── 3. Horizontal spacing — lower threshold ───────────────────────
          const mL = parseFloat(style.marginLeft);
          const mR = parseFloat(style.marginRight);
          const pL = parseFloat(style.paddingLeft);
          const pR = parseFloat(style.paddingRight);

          // Skip auto-centered containers (equal non-zero L/R margins = intentional layout)
          const autoCentered = !isNaN(mL) && !isNaN(mR) && mL === mR && mL > 0;

          if (!autoCentered) {
            const horizProps: [string, string][] = [
              ['padding-left',  style.paddingLeft],
              ['padding-right', style.paddingRight],
            ];
            for (const [prop, raw] of horizProps) {
              const val = parseFloat(raw);
              if (isNaN(val) || val < hWarnPx) continue;
              const key = `${sel}::${prop}`;
              if (seen.has(key)) continue;
              seen.add(key);
              found.push({
                selector: sel, normSelector: normSel, property: prop, value: val,
                severity: val >= critPx ? 'critical' : 'warning',
                section: 'main-content',
                rect: { top: Math.round(rect.top + window.scrollY), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                isEmptySpacer: false, context: ctx,
              });
            }
          }

          // Suppress unused vars warning
          void mL; void mR; void pL; void pR;
        }

        return found;
      },
      { warnPx: WARN_PX, critPx: CRIT_PX, emptyPx: EMPTY_PX, hWarnPx: H_WARN_PX }
    );

    // Annotate page before screenshot (only if issues found)
    if (issues.length > 0) {
      await page.evaluate((issuesToDraw: RawIssue[]) => {
        const ov = document.createElement('div');
        ov.id = '__ux_overlay__';
        ov.style.cssText = 'position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:999999';
        document.body.appendChild(ov);
        issuesToDraw.slice(0, 80).forEach((issue, idx) => {
          const issueNo = idx + 1;
          const col = issue.severity === 'critical' ? '#ef4444' : '#f59e0b';
          const box = document.createElement('div');
          box.style.cssText = `position:absolute;top:${issue.rect.top}px;left:${issue.rect.left}px;width:${issue.rect.width}px;height:${issue.rect.height}px;border:3px solid ${col};background:${col}22;box-shadow:0 0 0 2px #ffffff88 inset;box-sizing:border-box;`;

          const pin = document.createElement('span');
          pin.textContent = String(issueNo);
          pin.style.cssText = `position:absolute;top:-10px;left:-10px;min-width:18px;height:18px;border-radius:999px;background:${col};color:#fff;font:800 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;border:1px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);`;
          box.appendChild(pin);

          const lbl = document.createElement('span');
          lbl.textContent = issue.isEmptySpacer ? `#${issueNo} empty spacer ${issue.value}px` : `#${issueNo} ${issue.property}:${issue.value}px`;
          lbl.style.cssText = `background:${col};color:#fff;font:700 10px monospace;padding:2px 6px;position:absolute;top:0;left:0;white-space:nowrap;max-width:260px;overflow:hidden;`;
          box.appendChild(lbl);
          ov.appendChild(box);
        });
      }, issues);
    }

    const buf = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 55 });
    const screenshot = buf.toString('base64');
    await page.evaluate(() => { document.getElementById('__ux_overlay__')?.remove(); });

    return { url, urlPath, issues, screenshot, checkedAt };

  } catch (err: unknown) {
    return { url, urlPath, issues: [], screenshot: '', error: err instanceof Error ? err.message : String(err), checkedAt };
  }
}

// ─── Post-processing: global vs page-specific ────────────────────────────────

function analysePatterns(results: PageResult[], totalPages: number): {
  globalPatterns: PatternEntry[];
  pageSpecific:   PageResult[];
  globalKeys:     Set<string>;
} {
  const map = new Map<string, PatternEntry>();

  for (const r of results) {
    for (const i of r.issues) {
      if (i.isEmptySpacer) continue; // empty spacers always page-specific — show on page
      const key = `${i.normSelector}::${i.property}`;
      if (!map.has(key)) {
        map.set(key, { normSelector: i.normSelector, property: i.property, values: [], maxValue: 0, pageCount: 0, pagePaths: [], severity: 'warning' });
      }
      const p = map.get(key)!;
      p.values.push(i.value);
      p.maxValue = Math.max(p.maxValue, i.value);
      p.pageCount++;
      if (!p.pagePaths.includes(r.urlPath)) p.pagePaths.push(r.urlPath);
      if (i.severity === 'critical') p.severity = 'critical';
    }
  }

  const globalKeys = new Set<string>();
  const globalPatterns: PatternEntry[] = [];

  for (const [key, pattern] of map.entries()) {
    const freq = pattern.pageCount / totalPages;
    if (freq >= GLOBAL_THRESHOLD) {
      globalKeys.add(key);
      globalPatterns.push(pattern);
    }
  }

  // Sort global patterns by page count desc (most impactful first)
  globalPatterns.sort((a, b) => b.pageCount - a.pageCount);

  // Page-specific: issues NOT in global patterns (or empty spacers)
  const pageSpecific = results.map((r) => ({
    ...r,
    issues: r.issues.filter((i) => {
      if (i.isEmptySpacer) return true;
      const key = `${i.normSelector}::${i.property}`;
      return !globalKeys.has(key);
    }),
  })).filter((r) => r.issues.length > 0);

  // Sort pages: critical first, then by issue count
  pageSpecific.sort((a, b) => {
    const aCrit = a.issues.filter((i) => i.severity === 'critical').length;
    const bCrit = b.issues.filter((i) => i.severity === 'critical').length;
    if (bCrit !== aCrit) return bCrit - aCrit;
    return b.issues.length - a.issues.length;
  });

  return { globalPatterns, pageSpecific, globalKeys };
}

// ─── CSS suggestion ───────────────────────────────────────────────────────────

function cssFix(normSel: string, prop: string, maxVal: number, isGlobal: boolean): string {
  if (prop === 'empty-spacer') return 'Remove this empty &lt;div&gt;. Apply spacing via margin/padding on surrounding elements instead.';
  const rec = prop.includes('padding') ? Math.round(maxVal * 0.5) : Math.round(maxVal * 0.4);
  const scopeNote = isGlobal
    ? `In theme CSS: <code>.${normSel.split('.').slice(1, 3).join('.')} { ${prop}: ${rec}px; }</code>`
    : `Inline or block-level override: <code style="font-size:10px">${prop}: ${rec}px;</code>`;
  return `${prop}: ${maxVal}px is excessive. Reduce to ~${rec}px. ${scopeNote}`;
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badge(sev: Severity): string {
  return sev === 'critical'
    ? '<span class="bc">Critical</span>'
    : '<span class="bw">Warning</span>';
}

function generateHtml(
  results: PageResult[],
  globalPatterns: PatternEntry[],
  pageSpecific: PageResult[],
  runDate: string,
  csvBase: string,
  totalUrls: number
): string {
  const allIssues       = results.flatMap((r) => r.issues);
  const critTotal       = allIssues.filter((i) => i.severity === 'critical').length;
  const warnTotal       = allIssues.filter((i) => i.severity === 'warning').length;
  const emptySpacers    = allIssues.filter((i) => i.isEmptySpacer).length;
  const pagesAffected   = results.filter((r) => r.issues.length > 0).length;
  const errorPages      = results.filter((r) => r.error).length;

  // ── Global pattern table ──────────────────────────────────────────────────
  const globalRows = globalPatterns.map((p) => {
    const avg  = Math.round(p.values.reduce((s, v) => s + v, 0) / p.values.length);
    const freq = Math.round((p.pageCount / totalUrls) * 100);
    const fix  = cssFix(p.normSelector, p.property, p.maxValue, true);
    return `<tr>
      <td><code class="sel">${esc(p.normSelector)}</code></td>
      <td><code>${esc(p.property)}</code></td>
      <td class="num">${p.maxValue}px <span class="dim">(avg ${avg}px)</span></td>
      <td>${badge(p.severity)}</td>
      <td class="num"><strong>${p.pageCount}</strong> <span class="dim">${freq}% of pages</span></td>
      <td class="fix-cell">${fix}</td>
    </tr>`;
  }).join('');

  // ── Page-specific cards ───────────────────────────────────────────────────
  const pageCards = pageSpecific.map((r) => {
    const crit = r.issues.filter((i) => i.severity === 'critical').length;
    const warn = r.issues.filter((i) => i.severity === 'warning').length;
    const sp   = r.issues.filter((i) => i.isEmptySpacer).length;
    const rows = r.issues.map((i, idx) => {
      const issueNo = idx + 1;
      const fix = cssFix(i.normSelector, i.property, i.value, false);
      const prop = i.isEmptySpacer ? '<span class="be">empty-spacer</span>' : `<code>${esc(i.property)}</code>`;
      return `<tr>
        <td class="num"><strong>#${issueNo}</strong></td>
        <td><code class="sel">${esc(i.selector)}</code></td>
        <td>${prop}</td>
        <td class="num"><strong>${i.value}px</strong></td>
        <td>${badge(i.severity)}</td>
        <td class="ctx-cell">${esc(i.context.slice(0, 60))}</td>
        <td class="fix-cell">${fix}</td>
      </tr>`;
    }).join('');

    const img = r.screenshot
      ? `<img class="ss" src="data:image/jpeg;base64,${r.screenshot}" alt="" loading="lazy">`
      : '<div class="no-ss">No screenshot</div>';

    return `<div class="pg-card" data-crit="${crit}" data-url="${esc(r.urlPath)}">
  <div class="pg-hdr" onclick="toggle(this)">
    <div class="pg-left">
      <a href="${esc(r.url)}" target="_blank" class="pg-url">${esc(r.urlPath)}</a>
      <div class="pg-badges">
        ${crit ? `<span class="bc">${crit} critical</span>` : ''}
        ${warn ? `<span class="bw">${warn} warning</span>` : ''}
        ${sp   ? `<span class="be">${sp} empty spacer${sp > 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
    <span class="chevron">▼</span>
  </div>
  <div class="pg-body">
    <div class="ss-wrap">${img}</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>Selector</th><th>Issue</th><th>Value</th><th>Severity</th><th>Context</th><th>Fix</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</div>`;
  }).join('\n');

  // ── Assemble full HTML ────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>UX Spacing Audit — ${esc(runDate)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;line-height:1.55}
    a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}
    code{font-family:'JetBrains Mono','Fira Code',Menlo,monospace;font-size:10px;background:#1e293b;border:1px solid #334155;padding:1px 5px;border-radius:3px;color:#7dd3fc}
    .wrap{max-width:1440px;margin:0 auto}

    /* ── Header ── */
    .hdr{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border:1px solid #334155;border-radius:12px;padding:24px 28px;margin-bottom:20px}
    .hdr h1{font-size:24px;font-weight:800;color:#f8fafc;letter-spacing:-.3px}
    .hdr-sub{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px}
    .hdr-pill{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:4px 12px;font-size:11px;color:#94a3b8}
    .hdr-pill strong{color:#e2e8f0}

    /* ── Metrics ── */
    .metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
    .metric{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:16px 12px;text-align:center}
    .mv{font-size:32px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
    .ml{font-size:10px;color:#94a3b8;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
    .mc{border-color:#991b1b}.mc .mv{color:#ef4444}
    .mw{border-color:#92400e}.mw .mv{color:#f59e0b}
    .mb{border-color:#1d4ed8}.mb .mv{color:#60a5fa}
    .mg{border-color:#166534}.mg .mv{color:#22c55e}
    .mp{border-color:#6b21a8}.mp .mv{color:#a78bfa}

    /* ── Methodology box ── */
    .method{background:#111827;border:1px solid #334155;border-left:4px solid #3b82f6;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:12px;color:#94a3b8}
    .method strong{color:#93c5fd}
    .method ul{margin:6px 0 0 18px;line-height:1.8}

    /* ── Section headings ── */
    .section-hdr{display:flex;align-items:center;gap:10px;margin:24px 0 12px;padding:14px 18px;background:#111827;border:1px solid #334155;border-radius:10px}
    .section-hdr h2{font-size:16px;font-weight:700;color:#f1f5f9}
    .section-hdr .tag{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700}
    .tag-global{background:rgba(168,85,247,.15);color:#a855f7;border:1px solid #a855f740}
    .tag-page{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid #ef444440}
    .section-desc{font-size:12px;color:#64748b;margin-left:auto;text-align:right}

    /* ── Global table ── */
    .card{background:#111827;border:1px solid #1e293b;border-radius:10px;padding:0;margin-bottom:20px;overflow:hidden}
    table{width:100%;border-collapse:collapse;font-size:11px}
    thead{background:#0f172a}
    th{padding:9px 12px;text-align:left;color:#64748b;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #334155;white-space:nowrap}
    td{padding:8px 12px;border-bottom:1px solid #1e293b;vertical-align:top}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#1e293b30}
    .sel{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .num{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
    .num strong{color:#fbbf24}
    .dim{color:#64748b;font-size:10px}
    .fix-cell{font-size:10px;color:#94a3b8;max-width:300px;line-height:1.5}
    .fix-cell code{font-size:9px}
    .ctx-cell{font-size:10px;color:#64748b;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

    /* ── Badges ── */
    .bc{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(239,68,68,.15);color:#ef4444;border:1px solid #ef444440;white-space:nowrap}
    .bw{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid #f59e0b40;white-space:nowrap}
    .be{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(168,85,247,.13);color:#a855f7;border:1px solid #a855f740;white-space:nowrap}

    /* ── Page cards ── */
    .pg-card{background:#111827;border:1px solid #1e293b;border-radius:8px;margin-bottom:10px;overflow:hidden}
    .pg-card[data-crit]:not([data-crit="0"]) .pg-hdr{border-left:4px solid #ef4444}
    .pg-card[data-crit="0"] .pg-hdr{border-left:4px solid #f59e0b}
    .pg-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;gap:12px;transition:background .15s}
    .pg-hdr:hover{background:#1e293b}
    .pg-left{flex:1;min-width:0}
    .pg-url{font-size:12px;font-weight:700;color:#93c5fd;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pg-badges{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}
    .chevron{color:#475569;font-size:11px;flex-shrink:0;transition:transform .2s}
    .pg-body{display:none;padding:0 16px 16px}
    .ss-wrap{margin-bottom:12px;border-radius:6px;overflow:hidden;border:1px solid #334155;max-height:420px;overflow-y:auto;margin-top:12px}
    .ss{width:100%;display:block}
    .no-ss{background:#1e293b;color:#64748b;text-align:center;padding:24px;font-size:11px}
    .tbl-wrap{overflow-x:auto}

    /* ── Controls ── */
    .controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:14px 16px;border-bottom:1px solid #1e293b;background:#0a0f1a}
    .controls input,.controls select{padding:6px 10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:12px;outline:none}
    .controls input{flex:1;min-width:200px}
    .controls input:focus,.controls select:focus{border-color:#3b82f6}
    .btn{padding:6px 14px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#94a3b8;font-size:12px;cursor:pointer;white-space:nowrap;transition:all .15s}
    .btn:hover{background:#3b82f6;border-color:#3b82f6;color:#fff}
    .rc{color:#64748b;font-size:12px;white-space:nowrap;margin-left:auto}
    .hidden{display:none!important}

    footer{text-align:center;padding:20px 0;color:#334155;font-size:11px;border-top:1px solid #1e293b;margin-top:12px}
  </style>
</head>
<body>
<div class="wrap">

<!-- ── Header ── -->
<div class="hdr">
  <h1>🔍 UX Spacing Audit — University of Findlay</h1>
  <div class="hdr-sub">
    <span class="hdr-pill">Date: <strong>${esc(runDate)}</strong></span>
    <span class="hdr-pill">Source: <strong>${esc(csvBase)}</strong></span>
    <span class="hdr-pill">Pages audited: <strong>${totalUrls.toLocaleString()}</strong></span>
    <span class="hdr-pill">Viewport: <strong>${VIEWPORT.width}×${VIEWPORT.height}</strong></span>
    <span class="hdr-pill">Thresholds: <strong>warn ≥${WARN_PX}px · critical ≥${CRIT_PX}px</strong></span>
  </div>
</div>

<!-- ── Metrics ── -->
<div class="metrics">
  <div class="metric mb">
    <div class="mv">${totalUrls.toLocaleString()}</div>
    <div class="ml">Pages Audited</div>
  </div>
  <div class="metric mc">
    <div class="mv">${critTotal.toLocaleString()}</div>
    <div class="ml">Critical Issues</div>
  </div>
  <div class="metric mw">
    <div class="mv">${warnTotal.toLocaleString()}</div>
    <div class="ml">Warning Issues</div>
  </div>
  <div class="metric mp">
    <div class="mv">${emptySpacers.toLocaleString()}</div>
    <div class="ml">Empty Spacers</div>
  </div>
  <div class="metric mc">
    <div class="mv">${globalPatterns.length.toLocaleString()}</div>
    <div class="ml">Global CSS Patterns</div>
  </div>
  <div class="metric mw">
    <div class="mv">${pageSpecific.length.toLocaleString()}</div>
    <div class="ml">Pages w/ Unique Issues</div>
  </div>
  <div class="metric mg">
    <div class="mv">${(totalUrls - pagesAffected).toLocaleString()}</div>
    <div class="ml">Clean Pages</div>
  </div>
  ${errorPages ? `<div class="metric"><div class="mv" style="color:#94a3b8">${errorPages}</div><div class="ml">Load Errors</div></div>` : ''}
</div>

<!-- ── Methodology ── -->
<div class="method">
  <strong>QA Methodology — What was checked and what was excluded:</strong>
  <ul>
    <li><strong>Scope:</strong> Main content area only — <code>&lt;main&gt;</code>, <code>.entry-content</code>, <code>.site-main</code>. Header, navigation, and footer are excluded (template-level, intentional).</li>
    <li><strong>Vertical spacing:</strong> margin/padding ≥ ${WARN_PX}px flagged as warning, ≥ ${CRIT_PX}px as critical. Calibrated to the Figma design (sections use ~80–100px intentionally).</li>
    <li><strong>Horizontal spacing:</strong> padding-left/right ≥ ${H_WARN_PX}px flagged (unusual in content blocks).</li>
    <li><strong>Auto-centred containers:</strong> Equal margin-left/right (e.g., <code>margin: 0 auto</code>) excluded — this is standard layout behaviour.</li>
    <li><strong>Empty spacer divs:</strong> Always flagged regardless of threshold — never an acceptable practice; replace with CSS margin/padding.</li>
    <li><strong>Global vs page-specific:</strong> A pattern appearing on ≥${Math.round(GLOBAL_THRESHOLD * 100)}% of pages is classified as a <strong>Global CSS Issue</strong> (one theme CSS fix resolves it everywhere). Below that threshold → page-specific fix needed.</li>
  </ul>
</div>

<!-- ── PRIORITY 1: Global CSS Issues ── -->
<div class="section-hdr">
  <h2>⚡ Priority 1 — Global CSS Issues</h2>
  <span class="tag tag-global">Theme-level fix</span>
  <span class="section-desc">${globalPatterns.length} patterns · fix once → fixes all pages</span>
</div>
<div class="card">
  <table>
    <thead>
      <tr>
        <th>CSS Pattern</th>
        <th>Property</th>
        <th>Max Value</th>
        <th>Severity</th>
        <th>Pages Affected</th>
        <th>Recommended Fix</th>
      </tr>
    </thead>
    <tbody>
      ${globalRows || '<tr><td colspan="6" style="text-align:center;padding:20px;color:#64748b">No global CSS patterns found</td></tr>'}
    </tbody>
  </table>
</div>

<!-- ── PRIORITY 2: Page-Specific Issues ── -->
<div class="section-hdr">
  <h2>📋 Priority 2 — Page-Specific Issues</h2>
  <span class="tag tag-page">Per-page fix</span>
  <span class="section-desc">${pageSpecific.length} pages · individual content fixes</span>
</div>
<div class="card" style="padding:0">
  <div class="controls">
    <input id="q" placeholder="Search page URL…" autocomplete="off">
    <select id="sf">
      <option value="">All Severities</option>
      <option value="critical">🔴 Critical only</option>
      <option value="warning">🟡 Warning / Spacers only</option>
    </select>
    <button class="btn" onclick="expandAll()">Expand All</button>
    <button class="btn" onclick="collapseAll()">Collapse All</button>
    <button class="btn" onclick="exportCsv()">⬇ Export CSV</button>
    <span class="rc" id="rc">${pageSpecific.length} pages</span>
  </div>
  <div id="cards" style="padding:12px">
    ${pageCards || '<div style="text-align:center;padding:30px;color:#64748b;font-size:13px">No page-specific spacing issues found ✓</div>'}
  </div>
</div>

<footer>UX Spacing Audit — University of Findlay &nbsp;·&nbsp; ${esc(runDate)} &nbsp;·&nbsp; QA Automation Suite</footer>
</div>

<script>
  const cards = [...document.querySelectorAll('.pg-card')];
  const q  = document.getElementById('q');
  const sf = document.getElementById('sf');
  const rc = document.getElementById('rc');

  function filterCards() {
    const qs = q.value.toLowerCase().trim();
    const sv = sf.value;
    let vis = 0;
    cards.forEach(c => {
      const url  = (c.dataset.url ?? '').toLowerCase();
      const crit = parseInt(c.dataset.crit ?? '0', 10);
      const okQ  = !qs || url.includes(qs);
      const okS  = !sv
        || (sv === 'critical' && crit > 0)
        || (sv === 'warning'  && crit === 0);
      const hide = !(okQ && okS);
      c.classList.toggle('hidden', hide);
      if (!hide) vis++;
    });
    rc.textContent = vis + ' pages';
  }

  q.addEventListener('input', filterCards);
  sf.addEventListener('change', filterCards);

  function toggle(hdr) {
    const body    = hdr.closest('.pg-card').querySelector('.pg-body');
    const chevron = hdr.querySelector('.chevron');
    const open    = body.style.display !== 'none';
    body.style.display     = open ? 'none' : 'block';
    chevron.style.transform = open ? '' : 'rotate(180deg)';
  }

  function expandAll() {
    cards.filter(c => !c.classList.contains('hidden')).forEach(c => {
      c.querySelector('.pg-body').style.display = 'block';
      c.querySelector('.chevron').style.transform = 'rotate(180deg)';
    });
  }

  function collapseAll() {
    cards.forEach(c => {
      c.querySelector('.pg-body').style.display = 'none';
      c.querySelector('.chevron').style.transform = '';
    });
  }

  function exportCsv() {
    const rows = [['Priority','Page URL','#','Selector','Property','Value (px)','Severity','Context','Fix']];
    cards.filter(c => !c.classList.contains('hidden')).forEach(c => {
      const url = c.querySelector('.pg-url')?.textContent?.trim() ?? '';
      c.querySelectorAll('tbody tr').forEach(tr => {
        const tds = [...tr.querySelectorAll('td')].map(td => td.textContent?.trim() ?? '');
        rows.push(['Page-Specific', url, ...tds]);
      });
    });
    // Add global patterns first
    const globalTbody = document.querySelector('.card table tbody');
    if (globalTbody) {
      [...globalTbody.querySelectorAll('tr')].forEach(tr => {
        const tds = [...tr.querySelectorAll('td')].map(td => td.textContent?.trim() ?? '');
        rows.unshift(['Global CSS', '', ...tds]);
      });
    }
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\\n');
    const a   = document.createElement('a');
    a.href    = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = 'ux-spacing-audit-export.csv';
    a.click();
  }
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const csvPath   = resolveInputCsv();
  const urls      = parseCsvUrls(csvPath);
  const folderName = path.basename(path.dirname(csvPath));
  const runDate   = /^\d{4}-\d{2}-\d{2}$/.test(folderName) ? folderName : new Date().toISOString().slice(0, 10);
  const outDir    = path.join(ROOT, 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlOut   = path.join(outDir, `ux-spacing-audit-${runDate}.html`);

  console.log(`\n📐  UX Spacing Audit — University of Findlay`);
  console.log(`    Input     : ${csvPath}`);
  console.log(`    URLs      : ${urls.length.toLocaleString()}`);
  console.log(`    Browsers  : ${CONCURRENCY} concurrent`);
  console.log(`    Viewport  : ${VIEWPORT.width}×${VIEWPORT.height}`);
  console.log(`    Thresholds: warn ≥${WARN_PX}px · critical ≥${CRIT_PX}px · horiz ≥${H_WARN_PX}px · empty spacer ≥${EMPTY_PX}px`);
  console.log(`    Global at : ≥${Math.round(GLOBAL_THRESHOLD * 100)}% of pages`);
  console.log(`    Output    : ${outDir}\n`);

  const browser: Browser = await chromium.launch({ headless: true });
  const results: PageResult[] = new Array(urls.length);
  let cursor   = 0;
  let done     = 0;
  let lastLog  = 0;
  const startTime = Date.now();

  async function worker(): Promise<void> {
    const ctx  = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    while (cursor < urls.length) {
      const idx  = cursor++;
      const url  = urls[idx]!;
      results[idx] = await checkPage(page, url);
      done++;
      const now = Date.now();
      if (now - lastLog > 1000 || done === urls.length) {
        const pct     = Math.round((done / urls.length) * 100);
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        const issues  = results.slice(0, done).reduce((s, r) => s + (r?.issues.length ?? 0), 0);
        process.stdout.write(`\r  [${String(done).padStart(4)}/${urls.length}] ${pct}%  — ${issues} genuine issues found  ${elapsed}s`);
        lastLog = now;
      }
    }
    await ctx.close();
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  console.log(`\n\n  Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  const validResults = results.filter(Boolean) as PageResult[];
  const { globalPatterns, pageSpecific } = analysePatterns(validResults, urls.length);

  const allIssues  = validResults.flatMap((r) => r.issues);
  const critCount  = allIssues.filter((i) => i.severity === 'critical').length;
  const warnCount  = allIssues.filter((i) => i.severity === 'warning').length;
  const spacers    = allIssues.filter((i) => i.isEmptySpacer).length;
  const errPages   = validResults.filter((r) => r.error).length;
  const pagesIss   = validResults.filter((r) => r.issues.length > 0).length;

  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  📋 Pages audited       : ${urls.length.toLocaleString().padStart(6)}`);
  console.log(`  ⚠  Pages with issues   : ${pagesIss.toLocaleString().padStart(6)}`);
  console.log(`  🔴 Critical            : ${critCount.toLocaleString().padStart(6)}`);
  console.log(`  🟡 Warning             : ${warnCount.toLocaleString().padStart(6)}`);
  console.log(`  🟣 Empty spacers       : ${spacers.toLocaleString().padStart(6)}`);
  console.log(`  🌐 Global CSS patterns : ${globalPatterns.length.toLocaleString().padStart(6)}`);
  console.log(`  📄 Page-specific pages : ${pageSpecific.length.toLocaleString().padStart(6)}`);
  if (errPages) console.log(`  ❌ Load errors         : ${errPages.toLocaleString().padStart(6)}`);
  console.log(`  ${'─'.repeat(50)}\n`);

  process.stdout.write('  Generating HTML report…');
  const html = generateHtml(validResults, globalPatterns, pageSpecific, runDate, path.basename(csvPath), urls.length);
  fs.writeFileSync(htmlOut, html, 'utf8');
  const sizeMb = (html.length / 1024 / 1024).toFixed(1);
  console.log(` ✅  (${sizeMb}MB)`);
  console.log(`\n  📄 Report : ${htmlOut}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
