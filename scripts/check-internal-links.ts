#!/usr/bin/env ts-node
/**
 * Internal Link Audit — University of Findlay
 *
 * Phase 1: Crawl every page from the input CSV, extract all internal <a href> links.
 * Phase 2: Check every unique internal link for HTTP status.
 * Phase 3: Map broken links back to pages, detect nav/sitewide issues.
 * Phase 4: Generate Excel report matching the QA Content Audit format.
 *
 * Usage:
 *   npm run check-links
 *   CRAWL_CONCURRENCY=8 npm run check-links
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import ExcelJS from 'exceljs';

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CRAWL_CONCURRENCY = parseInt(process.env['CRAWL_CONCURRENCY'] ?? '5', 10);
const CHECK_CONCURRENCY = parseInt(process.env['CHECK_CONCURRENCY'] ?? '10', 10);
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 15;
const NAV_THRESHOLD = 0.5; // link on >50% of pages = sitewide/nav issue
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FoundLink {
  linkUrl: string;
  linkText: string;
  section: string;
}

interface NoHrefAnchor {
  pageUrl: string;
  section: string;
  anchorText: string;
  htmlSnippet: string;
}

interface PageCrawlResult {
  pageUrl: string;
  links: FoundLink[];
  noHrefAnchors: NoHrefAnchor[];
  error?: string;
}

interface LinkCheckResult {
  url: string;
  finalStatus: number;
  statusLabel: string;
  redirectChain: string;
  isBroken: boolean;
  pagesContaining: string[];
  pageCount: number;
  isNavLink: boolean;
}

interface PageLinkRow {
  pageUrl: string;
  section: string;
  linkText: string;
  linkUrl: string;
  finalStatus: number;
  statusLabel: string;
  redirectChain: string;
  hardFail: string;
  isNavLink: boolean;
}

interface PageSummary {
  pageUrl: string;
  totalLinks: number;
  passLinks: number;
  failLinks: number;
  failRate: number;
}

interface KeyFinding {
  severity: 'CRITICAL' | 'CONTENT' | 'INFO';
  message: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function labelFromStatus(s: number): string {
  const MAP: Record<number, string> = {
    200: '200 OK', 301: '301 Moved Permanently', 302: '302 Found',
    307: '307 Temporary Redirect', 308: '308 Permanent Redirect',
    400: '400 Bad Request', 401: '401 Unauthorized', 403: '403 Forbidden',
    404: '404 Not Found', 410: '410 Gone', 429: '429 Too Many Requests',
    500: '500 Internal Server Error', 502: '502 Bad Gateway',
    503: '503 Service Unavailable', 504: '504 Gateway Timeout',
  };
  return MAP[s] ?? `HTTP ${s}`;
}

function isBrokenStatus(s: number): boolean {
  return s === 0 || s === 404 || s === 410 || s >= 500;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpRequest(
  urlStr: string,
  readBody: boolean
): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch (e) { return reject(e); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const chunks: Buffer[] = [];

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Connection: 'close' },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (readBody) {
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers['location'] ?? null, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', () => resolve({ status: res.statusCode ?? 0, location: null, body: '' }));
        } else {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, location: res.headers['location'] ?? null, body: '' });
        }
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

async function fetchPage(url: string): Promise<{ status: number; body: string }> {
  try {
    let cur = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { status, location, body } = await httpRequest(cur, true);
      const isRedirect = status >= 300 && status < 400;
      if (!isRedirect || !location || hop === MAX_REDIRECTS) {
        return { status, body };
      }
      cur = new URL(location, cur).toString();
    }
  } catch {
    // fall through
  }
  return { status: 0, body: '' };
}

async function checkLink(url: string): Promise<{ finalStatus: number; chain: number[] }> {
  const chain: number[] = [];
  let cur = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { status, location } = await httpRequest(cur, false);
      chain.push(status);
      const isRedirect = status >= 300 && status < 400;
      if (!isRedirect || !location || hop === MAX_REDIRECTS) {
        return { finalStatus: status, chain };
      }
      cur = new URL(location, cur).toString();
    }
  } catch {
    return { finalStatus: 0, chain };
  }
  return { finalStatus: 0, chain };
}

// ─── Link extraction ──────────────────────────────────────────────────────────

function extractSection(html: string, linkHtml: string): string {
  const idx = html.indexOf(linkHtml);
  if (idx === -1) return 'content';
  const before = html.slice(0, idx);
  const openNav = before.lastIndexOf('<nav');
  const closeNav = before.lastIndexOf('</nav>');
  if (openNav > closeNav) return 'nav';
  const openHeader = before.lastIndexOf('<header');
  const closeHeader = before.lastIndexOf('</header>');
  if (openHeader > closeHeader) return 'header';
  const openFooter = before.lastIndexOf('<footer');
  const closeFooter = before.lastIndexOf('</footer>');
  if (openFooter > closeFooter) return 'footer';
  return 'content';
}

function extractInternalLinks(html: string, pageUrl: string, host: string): FoundLink[] {
  const links: FoundLink[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#\s][^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const raw = m[1]!.trim();
    const text = m[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const fullMatch = m[0]!;

    if (/^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;

    let resolved: string;
    try {
      resolved = new URL(raw, pageUrl).toString();
    } catch { continue; }

    let parsedResolved: URL;
    try { parsedResolved = new URL(resolved); } catch { continue; }

    // Internal only (same host)
    const resolvedHost = parsedResolved.hostname.replace(/^www\./, '');
    const baseHost = host.replace(/^www\./, '');
    if (resolvedHost !== baseHost) continue;

    // Strip fragment
    parsedResolved.hash = '';
    const clean = parsedResolved.toString();
    if (seen.has(clean)) continue;
    seen.add(clean);

    const section = extractSection(html, fullMatch);
    links.push({ linkUrl: clean, linkText: text || '(no text)', section });
  }

  return links;
}

function extractNoHrefAnchors(html: string, pageUrl: string): NoHrefAnchor[] {
  const results: NoHrefAnchor[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1]!;
    const inner = m[2]!;
    // Skip if href is present (even if empty — blank-cta covers that)
    if (/\bhref\s*=/i.test(attrs)) continue;
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue; // invisible/empty anchors add no signal
    const section = extractSection(html, m[0]!);
    results.push({
      pageUrl,
      section,
      anchorText: text.slice(0, 120),
      htmlSnippet: m[0]!.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return results;
}

// ─── Worker pools ─────────────────────────────────────────────────────────────

async function crawlPages(
  urls: string[],
  host: string,
  onDone: (done: number) => void
): Promise<PageCrawlResult[]> {
  const results: PageCrawlResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      const idx = cursor++;
      const url = urls[idx]!;
      const { status, body } = await fetchPage(url);
      if (status === 200 && body) {
        const links = extractInternalLinks(body, url, host);
        const noHrefAnchors = extractNoHrefAnchors(body, url);
        results.push({ pageUrl: url, links, noHrefAnchors });
      } else {
        results.push({ pageUrl: url, links: [], noHrefAnchors: [], error: `HTTP ${status}` });
      }
      onDone(results.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CRAWL_CONCURRENCY, urls.length) }, worker));
  return results;
}

async function checkUniqueLinks(
  uniqueUrls: string[],
  onDone: (done: number) => void
): Promise<Map<string, { finalStatus: number; chain: number[] }>> {
  const map = new Map<string, { finalStatus: number; chain: number[] }>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < uniqueUrls.length) {
      const idx = cursor++;
      const url = uniqueUrls[idx]!;
      const result = await checkLink(url);
      map.set(url, result);
      onDone(map.size);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, uniqueUrls.length) }, worker));
  return map;
}

// ─── Input discovery (same as check-404) ──────────────────────────────────────

function resolveInputCsv(cliArg?: string): string {
  if (cliArg) {
    const abs = path.resolve(ROOT, cliArg);
    if (!fs.existsSync(abs)) throw new Error(`Input file not found: ${abs}`);
    return abs;
  }
  const inputDir = path.join(ROOT, 'input');
  if (!fs.existsSync(inputDir)) throw new Error(`input/ directory not found`);
  const dated = fs.readdirSync(inputDir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  if (dated.length === 0) throw new Error('No YYYY-MM-DD folders found in input/');
  const folder = path.join(inputDir, dated[0]!);
  const csvs = fs.readdirSync(folder).filter((f) => f.endsWith('.csv'));
  if (csvs.length === 0) throw new Error(`No CSV files found in ${folder}`);
  return path.join(folder, csvs[0]!);
}

function parseCsvUrls(csvPath: string): string[] {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('CSV is empty');
  const first = lines[0]!.toLowerCase();
  const start = first === 'url' || first.startsWith('url,') ? 1 : 0;
  return lines.slice(start).map((line) => {
    const val = line.startsWith('"') ? line.slice(1, line.lastIndexOf('"')) : line.split(',')[0]!;
    return val.trim();
  }).filter((u) => { try { new URL(u); return true; } catch { return false; } });
}

// ─── Key Findings ─────────────────────────────────────────────────────────────

function buildKeyFindings(
  brokenLinks: LinkCheckResult[],
  pageSummaries: PageSummary[],
  totalPages: number,
  totalLinkInstances: number,
  totalFail: number
): KeyFinding[] {
  const findings: KeyFinding[] = [];

  const navBroken = brokenLinks.filter((l) => l.isNavLink);
  if (navBroken.length > 0) {
    const navFailInstances = navBroken.reduce((s, l) => s + l.pageCount, 0);
    findings.push({
      severity: 'CRITICAL',
      message: `${navBroken.length} broken navigation link${navBroken.length > 1 ? 's' : ''} appear on EVERY page of the site (${navBroken[0]!.pageCount} pages each). This is a global nav issue — fix these first to resolve ~${navFailInstances.toLocaleString()} of the ${totalFail.toLocaleString()} failures instantly.`,
    });

    const navUrls = navBroken.map((l) => {
      try { return new URL(l.url).pathname; } catch { return l.url; }
    });
    findings.push({
      severity: 'CRITICAL',
      message: `${navBroken.length} nav link${navBroken.length > 1 ? 's' : ''} are broken — ${navUrls.slice(0, 5).join(', ')}${navUrls.length > 5 ? '…' : ''}. Every user clicking nav will hit broken pages.`,
    });
  }

  // Redirect loops
  const loops = brokenLinks.filter((l) => l.redirectChain.split(' → ').length > 10);
  if (loops.length > 0) {
    findings.push({
      severity: 'CRITICAL',
      message: `${loops.length} URL${loops.length > 1 ? 's have' : ' has'} an infinite redirect loop (10+ hops): ${loops.map((l) => { try { return new URL(l.url).pathname; } catch { return l.url; } }).slice(0, 3).join(', ')}. ${loops.some((l) => l.isNavLink) ? 'Appears in nav on every page.' : ''}`,
    });
  }

  // Page-specific broken links (not nav)
  const contentBroken = brokenLinks.filter((l) => !l.isNavLink);
  if (contentBroken.length > 0) {
    const docLinks = contentBroken.filter((l) => /SiteAssets|\.pdf|\/offices\//i.test(l.url));
    if (docLinks.length > 0) {
      findings.push({
        severity: 'CONTENT',
        message: `${docLinks.length} page-specific broken document/PDF links found — mostly old SharePoint/SiteAssets paths not migrated to the new system.`,
      });
      findings.push({
        severity: 'CONTENT',
        message: `Multiple PDF and document links still point to old paths. Files need to be re-uploaded or redirects set up.`,
      });
    } else {
      findings.push({
        severity: 'CONTENT',
        message: `${contentBroken.length} page-specific broken link${contentBroken.length > 1 ? 's' : ''} found across ${new Set(contentBroken.flatMap((l) => l.pagesContaining)).size} pages.`,
      });
    }
  }

  const passCount = totalLinkInstances - totalFail;
  const passPct = totalLinkInstances > 0 ? ((passCount / totalLinkInstances) * 100).toFixed(1) : '100.0';
  findings.push({
    severity: 'INFO',
    message: `${passPct}% of all internal links across ${totalPages} pages are working correctly. The failures are concentrated in ${navBroken.length > 0 ? 'nav and ' : ''}unmigrated documents.`,
  });

  return findings;
}

// ─── Excel Report ─────────────────────────────────────────────────────────────

const C = {
  dark: 'FF0F172A', card: 'FF1E3A5F', border: 'FF2D5986', headerBg: 'FF1B3A6B',
  headerFg: 'FFFFFFFF', text: 'FF1F2937', muted: 'FF6B7280', white: 'FFFFFFFF',
  green: 'FF16A34A', greenBg: 'FFF0FFF4', greenBorder: 'FF86EFAC',
  red: 'FFDC2626', redBg: 'FFFFF1F2', redBorder: 'FFFCA5A5',
  orange: 'FFD97706', orangeBg: 'FFFFFBEB', orangeBorder: 'FFFCD34D',
  blue: 'FF1D4ED8', blueBg: 'FFEFF6FF', blueBorder: 'FF93C5FD',
  gray: 'FF6B7280', grayBg: 'FFF9FAFB', grayBorder: 'FFD1D5DB',
  critBg: 'FFFEF2F2', warnBg: 'FFFFFBEB', infoBg: 'FFEFF6FF',
  rowAlt: 'FFF8FAFC',
};

function solidFill(argb: string): ExcelJS.FillPattern {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}
function thinBorder(argb: string): Partial<ExcelJS.Borders> {
  const b: ExcelJS.Border = { style: 'thin', color: { argb } };
  return { top: b, bottom: b, left: b, right: b };
}
function styleHdr(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.fill = solidFill(C.headerBg);
    c.font = { bold: true, color: { argb: C.headerFg }, size: 10 };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    c.border = thinBorder(C.border);
  });
  row.height = 22;
}
function styleData(row: ExcelJS.Row, fillArgb: string): void {
  row.eachCell((c) => {
    c.fill = solidFill(fillArgb);
    c.font = { color: { argb: C.text }, size: 10 };
    c.border = thinBorder(C.grayBorder);
    c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
  });
  row.height = 18;
}

async function generateExcel(
  csvPath: string,
  runDate: string,
  outPath: string,
  crawlResults: PageCrawlResult[],
  linkCheckMap: Map<string, { finalStatus: number; chain: number[] }>,
  brokenLinks: LinkCheckResult[],
  pageSummaries: PageSummary[],
  allLinkRows: PageLinkRow[],
  keyFindings: KeyFinding[],
  totalLinkInstances: number,
  totalPass: number,
  totalFail: number,
  noHrefAnchors: NoHrefAnchor[]
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QA Internal Link Audit';
  wb.created = new Date();

  const totalPages = crawlResults.filter((r) => !r.error).length;
  const uniqueBroken = brokenLinks.length;
  const navBroken = brokenLinks.filter((l) => l.isNavLink).length;
  const passPct = totalLinkInstances > 0 ? ((totalPass / totalLinkInstances) * 100).toFixed(1) : '0.0';
  const failPct = totalLinkInstances > 0 ? ((totalFail / totalLinkInstances) * 100).toFixed(1) : '0.0';

  // ── Sheet 1: Executive Summary ──────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Executive Summary', { properties: { tabColor: { argb: 'FF1D4ED8' } } });
  ws1.views = [{ showGridLines: false }];
  ws1.getColumn('A').width = 20;
  ws1.getColumn('B').width = 100;

  // Title block
  const titleRow = ws1.addRow(['University of Findlay — QA Content Link Audit Report']);
  ws1.mergeCells(`A1:F1`);
  titleRow.getCell(1).value = 'University of Findlay — QA Content Link Audit Report';
  titleRow.getCell(1).font = { bold: true, size: 16, color: { argb: C.white } };
  titleRow.getCell(1).fill = solidFill(C.headerBg);
  titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  titleRow.height = 36;

  const metaRow = ws1.addRow([`Generated: ${runDate}  |  Scope: ${crawlResults.length} developer-provided URLs  |  Tool: Automated Node.js content link checker`]);
  ws1.mergeCells('A2:F2');
  metaRow.getCell(1).font = { italic: true, size: 10, color: { argb: C.muted } };
  metaRow.getCell(1).fill = solidFill(C.blueBg);
  metaRow.getCell(1).alignment = { horizontal: 'center' };
  metaRow.height = 20;

  ws1.addRow([]);

  // Stats header — set each cell individually to avoid merge wiping values
  const hdrLabels = ['Pages Crawled', 'Internal Links Checked', '✅ PASS', '❌ FAIL', 'Unique Broken URLs', 'Nav Broken (sitewide)'];
  const statsHdrRow = ws1.getRow(4);
  hdrLabels.forEach((label, i) => {
    const c = statsHdrRow.getCell(i + 1);
    c.value = label;
    c.font = { bold: true, size: 11, color: { argb: C.muted } };
    c.fill = solidFill(C.grayBg);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder(C.grayBorder);
  });
  statsHdrRow.height = 22;
  ws1.getColumn('A').width = 18; ws1.getColumn('B').width = 24;
  ws1.getColumn('C').width = 22; ws1.getColumn('D').width = 22;
  ws1.getColumn('E').width = 22; ws1.getColumn('F').width = 22;

  const statsValRow = ws1.addRow([
    totalPages, totalLinkInstances,
    `${totalPass.toLocaleString()} (${passPct}%)`,
    `${totalFail.toLocaleString()} (${failPct}%)`,
    uniqueBroken, navBroken,
  ]);
  ['A5', 'B5', 'C5', 'D5', 'E5', 'F5'].forEach((addr, i) => {
    const c = ws1.getCell(addr);
    const colors = [C.blue, C.blue, C.green, C.red, C.red, C.orange];
    const bgs    = [C.blueBg, C.blueBg, C.greenBg, C.redBg, C.redBg, C.orangeBg];
    c.font = { bold: true, size: 18, color: { argb: colors[i] } };
    c.fill = solidFill(bgs[i]!);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.border = thinBorder(C.grayBorder);
  });
  ws1.getRow(5).height = 40;

  ws1.addRow([]);
  ws1.addRow([]);

  // Key Findings
  const kfTitleRow = ws1.addRow(['KEY FINDINGS FOR PROJECT MANAGER']);
  ws1.mergeCells(`A8:F8`);
  kfTitleRow.getCell(1).font = { bold: true, size: 12, color: { argb: C.white } };
  kfTitleRow.getCell(1).fill = solidFill(C.headerBg);
  kfTitleRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
  kfTitleRow.getCell(1).border = thinBorder(C.border);
  kfTitleRow.height = 26;

  keyFindings.forEach((f, i) => {
    const rowNum = 9 + i;
    const row = ws1.getRow(rowNum);
    const severityBg = f.severity === 'CRITICAL' ? C.critBg : f.severity === 'CONTENT' ? C.orangeBg : C.infoBg;
    const severityColor = f.severity === 'CRITICAL' ? C.red : f.severity === 'CONTENT' ? C.orange : C.blue;
    const icon = f.severity === 'CRITICAL' ? '🔴' : f.severity === 'CONTENT' ? '⚠' : 'ℹ';

    const labelCell = ws1.getCell(`A${rowNum}`);
    labelCell.value = `${icon}  ${f.severity}`;
    labelCell.font = { bold: true, size: 10, color: { argb: severityColor } };
    labelCell.fill = solidFill(severityBg);
    labelCell.alignment = { horizontal: 'center', vertical: 'top' };
    labelCell.border = thinBorder(C.grayBorder);

    ws1.mergeCells(`B${rowNum}:F${rowNum}`);
    const msgCell = ws1.getCell(`B${rowNum}`);
    msgCell.value = f.message;
    msgCell.font = { size: 10, color: { argb: C.text } };
    msgCell.fill = solidFill(severityBg);
    msgCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
    msgCell.border = thinBorder(C.grayBorder);
    row.height = 36;
  });

  // ── Sheet 2: Broken Links (Unique) ──────────────────────────────────────────
  const ws2 = wb.addWorksheet('Broken Links (Unique)', { properties: { tabColor: { argb: 'FFDC2626' } } });
  ws2.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  const bl_cols = [
    { header: 'Broken URL', width: 60 },
    { header: 'Status', width: 10 },
    { header: 'Status Label', width: 26 },
    { header: 'Redirect Chain', width: 20 },
    { header: 'Pages Affected', width: 14 },
    { header: 'Sitewide/Nav?', width: 14 },
    { header: 'Sample Pages', width: 70 },
  ];
  bl_cols.forEach((c, i) => { ws2.getColumn(i + 1).width = c.width; });
  styleHdr(ws2.addRow(bl_cols.map((c) => c.header)));
  ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: bl_cols.length } };

  brokenLinks.sort((a, b) => b.pageCount - a.pageCount).forEach((l, i) => {
    const row = ws2.addRow([
      l.url, l.finalStatus, l.statusLabel, l.redirectChain,
      l.pageCount,
      l.isNavLink ? 'YES — Sitewide' : 'No',
      l.pagesContaining.slice(0, 3).join(' | '),
    ]);
    const bg = i % 2 === 0 ? C.redBg : C.white;
    styleData(row, bg);
    const urlCell = row.getCell(1);
    urlCell.value = { text: l.url, hyperlink: l.url };
    urlCell.font = { color: { argb: l.isNavLink ? C.red : C.orange }, underline: true, size: 10 };
    row.getCell(2).font = { bold: true, color: { argb: C.red }, size: 10 };
    row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
    if (l.isNavLink) {
      row.getCell(6).font = { bold: true, color: { argb: C.red }, size: 10 };
    }
  });

  // ── Sheet 3: Page Summary ───────────────────────────────────────────────────
  const ws3 = wb.addWorksheet('Page Summary', { properties: { tabColor: { argb: 'FF0284C7' } } });
  ws3.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  const ps_cols = [
    { header: 'Page URL', width: 65 },
    { header: 'Total Links', width: 13 },
    { header: 'Pass', width: 10 },
    { header: 'Fail', width: 10 },
    { header: 'Fail %', width: 10 },
    { header: 'Status', width: 12 },
  ];
  ps_cols.forEach((c, i) => { ws3.getColumn(i + 1).width = c.width; });
  styleHdr(ws3.addRow(ps_cols.map((c) => c.header)));
  ws3.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ps_cols.length } };

  pageSummaries.sort((a, b) => b.failLinks - a.failLinks).forEach((p, i) => {
    const bg = p.failLinks > 0 ? (i % 2 === 0 ? C.redBg : '#FEF9F9') : (i % 2 === 0 ? C.greenBg : C.white);
    const row = ws3.addRow([
      p.pageUrl, p.totalLinks, p.passLinks, p.failLinks,
      p.totalLinks > 0 ? p.failLinks / p.totalLinks : 0,
      p.failLinks > 0 ? '❌ Has broken links' : '✅ Pass',
    ]);
    styleData(row, bg);
    const urlCell = row.getCell(1);
    urlCell.value = { text: p.pageUrl, hyperlink: p.pageUrl };
    urlCell.font = { color: { argb: C.blue }, underline: true, size: 10 };
    row.getCell(5).numFmt = '0%';
    row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
    if (p.failLinks > 0) {
      row.getCell(4).font = { bold: true, color: { argb: C.red }, size: 10 };
      row.getCell(5).font = { bold: true, color: { argb: C.red }, size: 10 };
    }
  });

  // ── Sheet 4: All Link Details ───────────────────────────────────────────────
  const ws4 = wb.addWorksheet('All Link Details', { properties: { tabColor: { argb: 'FF374151' } } });
  ws4.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  const al_cols = [
    { header: 'Source Page', width: 55 },
    { header: 'Section', width: 10 },
    { header: 'Link Text', width: 30 },
    { header: 'Link URL', width: 55 },
    { header: 'Status Code', width: 13 },
    { header: 'Status Label', width: 26 },
    { header: 'Redirect Chain', width: 20 },
    { header: 'Hard Fail', width: 10 },
    { header: 'Nav Link?', width: 10 },
  ];
  al_cols.forEach((c, i) => { ws4.getColumn(i + 1).width = c.width; });
  styleHdr(ws4.addRow(al_cols.map((c) => c.header)));
  ws4.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: al_cols.length } };

  allLinkRows.forEach((r, i) => {
    const bg = r.hardFail === 'YES' ? (i % 2 === 0 ? C.redBg : C.white) : (i % 2 === 0 ? C.grayBg : C.white);
    const row = ws4.addRow([
      r.pageUrl, r.section, truncate(r.linkText, 60), r.linkUrl,
      r.finalStatus || '', r.statusLabel, r.redirectChain,
      r.hardFail, r.isNavLink ? 'YES' : '',
    ]);
    styleData(row, bg);
    row.getCell(4).value = { text: r.linkUrl, hyperlink: r.linkUrl };
    row.getCell(4).font = { color: { argb: C.blue }, underline: true, size: 10 };
    if (r.hardFail === 'YES') {
      row.getCell(5).font = { bold: true, color: { argb: C.red }, size: 10 };
      row.getCell(8).font = { bold: true, color: { argb: C.red }, size: 10 };
    }
    row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
  });

  // ── Sheet 5: Anchors Without Href ──────────────────────────────────────────
  const ws5 = wb.addWorksheet('No-Href Anchors', { properties: { tabColor: { argb: 'FFDC2626' } } });
  ws5.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  const nh_cols = [
    { header: 'Page URL',      width: 60 },
    { header: 'Section',       width: 12 },
    { header: 'Anchor Text',   width: 40 },
    { header: 'HTML Snippet',  width: 80 },
    { header: 'Issue',         width: 50 },
  ];
  nh_cols.forEach((c, i) => { ws5.getColumn(i + 1).width = c.width; });
  styleHdr(ws5.addRow(nh_cols.map((c) => c.header)));
  ws5.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: nh_cols.length } };

  noHrefAnchors.forEach((r, i) => {
    const bg = i % 2 === 0 ? C.redBg : C.white;
    const row = ws5.addRow([
      r.pageUrl,
      r.section,
      r.anchorText,
      r.htmlSnippet,
      '<a> tag has no href — renders as text but styled as link; add href or change to <span>/<button>',
    ]);
    styleData(row, bg);
    const urlCell = row.getCell(1);
    urlCell.value = { text: r.pageUrl, hyperlink: r.pageUrl };
    urlCell.font = { color: { argb: C.blue }, underline: true, size: 10 };
    row.getCell(3).font = { bold: true, color: { argb: C.red }, size: 10 };
  });

  if (noHrefAnchors.length === 0) {
    const r = ws5.addRow(['✅ No anchors without href found across all crawled pages.', '', '', '', '']);
    ws5.mergeCells(`A2:E2`);
    r.getCell(1).font = { italic: true, color: { argb: C.green }, size: 11 };
    r.getCell(1).alignment = { horizontal: 'center' };
  }

  // ── Sheet 6: Dev Action List ────────────────────────────────────────────────
  const ws6 = wb.addWorksheet('Dev Action List', { properties: { tabColor: { argb: 'FF7C3AED' } } });
  ws6.views = [{ showGridLines: false }];
  ws6.getColumn('A').width = 14;
  ws6.getColumn('B').width = 20;
  ws6.getColumn('C').width = 60;
  ws6.getColumn('D').width = 14;
  ws6.getColumn('E').width = 16;

  const devTitleRow = ws6.addRow(['Dev Action List — Prioritized Fix Plan']);
  ws6.mergeCells('A1:E1');
  devTitleRow.getCell(1).font = { bold: true, size: 14, color: { argb: C.white } };
  devTitleRow.getCell(1).fill = solidFill(C.headerBg);
  devTitleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  devTitleRow.height = 32;

  const devHdrRow = ws6.addRow(['Priority', 'Fix Type', 'Broken URL / Issue', 'Affected Pages', 'Suggested Action']);
  styleHdr(devHdrRow);

  const navBrokenLinks = brokenLinks.filter((l) => l.isNavLink);
  const contentBrokenLinks = brokenLinks.filter((l) => !l.isNavLink);

  let devRowIdx = 0;
  navBrokenLinks.forEach((l) => {
    const row = ws6.addRow([
      'P1 — Critical', 'Fix Nav Link', l.url, l.pageCount,
      l.finalStatus === 404 ? 'Page missing — create page or update nav link' : `Remove redirect loop or fix target`,
    ]);
    styleData(row, devRowIdx++ % 2 === 0 ? C.redBg : C.white);
    row.getCell(1).font = { bold: true, color: { argb: C.red }, size: 10 };
  });
  contentBrokenLinks.forEach((l) => {
    const isSiteAssets = /SiteAssets|\.pdf/i.test(l.url);
    const row = ws6.addRow([
      'P2 — Content', isSiteAssets ? 'Re-upload Document' : 'Fix Broken Link',
      l.url, l.pageCount,
      isSiteAssets ? 'Re-upload file to new CMS or set up redirect from old path' : l.finalStatus === 404 ? 'Page missing — create or redirect' : 'Fix link target',
    ]);
    styleData(row, devRowIdx++ % 2 === 0 ? C.orangeBg : C.white);
    row.getCell(1).font = { bold: true, color: { argb: C.orange }, size: 10 };
  });

  await wb.xlsx.writeFile(outPath);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputFlag = args.indexOf('--input');
  const cliInput = inputFlag >= 0 ? args[inputFlag + 1] : undefined;

  const csvPath = resolveInputCsv(cliInput);
  const urls = parseCsvUrls(csvPath);
  const host = new URL(urls[0]!).hostname;

  const folderName = path.basename(path.dirname(csvPath));
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(folderName) ? folderName : new Date().toISOString().slice(0, 10);
  const outDir = path.join(ROOT, 'reports', runDate);
  fs.mkdirSync(outDir, { recursive: true });

  const now = new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const xlsxOut = path.join(outDir, `UOF_QA_Content_Audit_${runDate}.xlsx`);

  console.log(`\n🔗  Internal Link Audit — University of Findlay`);
  console.log(`    Input    : ${csvPath}`);
  console.log(`    Pages    : ${urls.length.toLocaleString()}`);
  console.log(`    Host     : ${host}`);
  console.log(`    Output   : ${outDir}\n`);

  // Phase 1: Crawl pages
  const t0 = Date.now();
  let crawlDone = 0;
  process.stdout.write(`  Phase 1/3 — Crawling ${urls.length} pages for internal links…`);
  const crawlResults = await crawlPages(urls, host, (done) => {
    crawlDone = done;
    if (done % 20 === 0 || done === urls.length) {
      process.stdout.write(`\r  Phase 1/3 — Crawling pages… ${done}/${urls.length} (${Math.round((done / urls.length) * 100)}%)`);
    }
  });
  console.log(`\r  Phase 1/3 — Crawled ${crawlResults.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Collect all unique internal links and build page→link map
  const linkToPages = new Map<string, string[]>();
  const allLinkInstances: PageLinkRow[] = [];

  for (const page of crawlResults) {
    for (const link of page.links) {
      if (!linkToPages.has(link.linkUrl)) linkToPages.set(link.linkUrl, []);
      linkToPages.get(link.linkUrl)!.push(page.pageUrl);
      allLinkInstances.push({
        pageUrl: page.pageUrl,
        section: link.section,
        linkText: link.linkText,
        linkUrl: link.linkUrl,
        finalStatus: 0,
        statusLabel: '',
        redirectChain: '',
        hardFail: '',
        isNavLink: false,
      });
    }
  }

  // Collect no-href anchors across all successfully crawled pages
  const allNoHrefAnchors: NoHrefAnchor[] = [];
  for (const page of crawlResults) {
    allNoHrefAnchors.push(...page.noHrefAnchors);
  }

  const uniqueLinks = [...linkToPages.keys()];
  const totalLinkInstances = allLinkInstances.length;
  console.log(`  Phase 1/3 — Found ${totalLinkInstances.toLocaleString()} link instances, ${uniqueLinks.length.toLocaleString()} unique internal links, ${allNoHrefAnchors.length.toLocaleString()} anchors with no href\n`);

  // Phase 2: Check unique links
  const t1 = Date.now();
  process.stdout.write(`  Phase 2/3 — Checking ${uniqueLinks.length} unique links…`);
  const linkCheckMap = await checkUniqueLinks(uniqueLinks, (done) => {
    if (done % 50 === 0 || done === uniqueLinks.length) {
      process.stdout.write(`\r  Phase 2/3 — Checking unique links… ${done}/${uniqueLinks.length} (${Math.round((done / uniqueLinks.length) * 100)}%)`);
    }
  });
  console.log(`\r  Phase 2/3 — Checked ${uniqueLinks.length} unique links in ${((Date.now() - t1) / 1000).toFixed(1)}s\n`);

  // Phase 3: Build report data
  const totalPages = crawlResults.filter((r) => !r.error).length;
  const brokenLinks: LinkCheckResult[] = [];

  for (const [url, pages] of linkToPages) {
    const check = linkCheckMap.get(url)!;
    const chain = check.chain.join(' → ');
    if (isBrokenStatus(check.finalStatus)) {
      brokenLinks.push({
        url,
        finalStatus: check.finalStatus,
        statusLabel: check.finalStatus === 0 ? 'Timeout/Error' : labelFromStatus(check.finalStatus),
        redirectChain: chain,
        isBroken: true,
        pagesContaining: pages,
        pageCount: pages.length,
        isNavLink: pages.length / totalPages >= NAV_THRESHOLD,
      });
    }
  }

  // Update allLinkInstances with check results
  for (const row of allLinkInstances) {
    const check = linkCheckMap.get(row.linkUrl);
    if (check) {
      row.finalStatus = check.finalStatus;
      row.statusLabel = check.finalStatus === 0 ? 'Timeout/Error' : labelFromStatus(check.finalStatus);
      row.redirectChain = check.chain.join(' → ');
      row.hardFail = isBrokenStatus(check.finalStatus) ? 'YES' : 'NO';
      row.isNavLink = (linkToPages.get(row.linkUrl)?.length ?? 0) / totalPages >= NAV_THRESHOLD;
    }
  }

  // Page summaries
  const pageSummaryMap = new Map<string, PageSummary>();
  for (const row of allLinkInstances) {
    if (!pageSummaryMap.has(row.pageUrl)) {
      pageSummaryMap.set(row.pageUrl, { pageUrl: row.pageUrl, totalLinks: 0, passLinks: 0, failLinks: 0, failRate: 0 });
    }
    const ps = pageSummaryMap.get(row.pageUrl)!;
    ps.totalLinks++;
    if (row.hardFail === 'YES') ps.failLinks++; else ps.passLinks++;
  }
  const pageSummaries = [...pageSummaryMap.values()];
  pageSummaries.forEach((p) => { p.failRate = p.totalLinks > 0 ? p.failLinks / p.totalLinks : 0; });

  const totalFail = allLinkInstances.filter((r) => r.hardFail === 'YES').length;
  const totalPass = totalLinkInstances - totalFail;
  const passPct = totalLinkInstances > 0 ? ((totalPass / totalLinkInstances) * 100).toFixed(1) : '100.0';
  const failPct = totalLinkInstances > 0 ? ((totalFail / totalLinkInstances) * 100).toFixed(1) : '0.0';

  const line = '─'.repeat(48);
  console.log(`  ${line}`);
  console.log(`  📄 Pages crawled          : ${totalPages.toLocaleString().padStart(8)}`);
  console.log(`  🔗 Total link instances   : ${totalLinkInstances.toLocaleString().padStart(8)}`);
  console.log(`  🔗 Unique internal links  : ${uniqueLinks.length.toLocaleString().padStart(8)}`);
  console.log(`  ✅ PASS                   : ${totalPass.toLocaleString().padStart(8)}  (${passPct}%)`);
  console.log(`  ❌ FAIL                   : ${totalFail.toLocaleString().padStart(8)}  (${failPct}%)`);
  console.log(`  🔴 Unique broken URLs     : ${brokenLinks.length.toLocaleString().padStart(8)}`);
  console.log(`  🌐 Nav/sitewide broken    : ${brokenLinks.filter((l) => l.isNavLink).length.toLocaleString().padStart(8)}`);
  console.log(`  ⚠  Anchors — no href      : ${allNoHrefAnchors.length.toLocaleString().padStart(8)}`);
  console.log(`  ${line}\n`);

  const keyFindings = buildKeyFindings(brokenLinks, pageSummaries, totalPages, totalLinkInstances, totalFail);

  process.stdout.write('  Generating Excel report…');
  await generateExcel(
    csvPath, `${now}`, xlsxOut,
    crawlResults, linkCheckMap, brokenLinks, pageSummaries, allLinkInstances,
    keyFindings, totalLinkInstances, totalPass, totalFail, allNoHrefAnchors
  );
  const xlsxKb = Math.round(fs.statSync(xlsxOut).size / 1024);
  console.log(` ✅  (${xlsxKb}KB)`);
  console.log(`\n  📊 Excel: ${xlsxOut}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
