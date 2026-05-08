#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const INPUT_FILE = path.resolve(process.cwd(), 'content-audit-urls.txt');
const OUTPUT_FILE = path.resolve(process.cwd(), 'content-audit-results.csv');
const EXTERNAL_OUTPUT_FILE = path.resolve(process.cwd(), 'content-audit-external-links.csv');

const REQUEST_DELAY_MS = 800;
const NAV_TIMEOUT_MS = 30000;
const LINK_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 20;

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function parseOnclickUrl(value) {
  const text = String(value || '');
  if (!text) return '';

  const absoluteMatch = text.match(/https?:\/\/[^'"\s)]+/i);
  if (absoluteMatch) return absoluteMatch[0];

  const quotedPath = text.match(/['"](\/[^'"\s]*)['"]/);
  if (quotedPath) return quotedPath[1];

  return '';
}

function isSkippableHref(href) {
  const text = String(href || '').trim().toLowerCase();
  return !text
    || text.startsWith('#')
    || text.startsWith('mailto:')
    || text.startsWith('tel:')
    || text.startsWith('javascript:');
}

async function fetchWithManualRedirects(url) {
  const redirects = [];
  const startedAt = Date.now();
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: REQUEST_HEADERS,
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    redirects.push(response.status);

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');

    if (!isRedirect || !location) {
      return {
        finalStatusCode: response.status,
        statusLabel: response.status === 404
          ? 'NOT_FOUND'
          : (response.status >= 500 && response.status < 600 ? 'SERVER_ERROR' : `HTTP_${response.status}`),
        redirectChain: redirects.join('→'),
        responseTimeMs: Date.now() - startedAt,
        notes: ''
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return {
    finalStatusCode: 0,
    statusLabel: 'INFINITE_REDIRECT_LOOP',
    redirectChain: redirects.join('→'),
    responseTimeMs: Date.now() - startedAt,
    notes: `Too many redirects (>${MAX_REDIRECTS})`
  };
}

function errorLabel(error) {
  if (error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') return 'TIMEOUT';
  if (error?.code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
  return `UNKNOWN_ERROR`;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Missing input file: ${INPUT_FILE}`);
    console.error('Create it first with: node scripts/prepare-content-audit-input.js <csv-path>');
    process.exit(1);
  }

  const pageUrls = fs.readFileSync(INPUT_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!pageUrls.length) {
    console.error('❌ content-audit-urls.txt has no URLs.');
    process.exit(1);
  }

  let baseHost = '';
  try {
    baseHost = normalizeHost(new URL(pageUrls[0]).hostname);
  } catch {
    console.error('❌ First URL in content-audit-urls.txt is invalid.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: REQUEST_HEADERS['User-Agent']
  });

  const allOccurrences = [];
  const internalToOccurrences = new Map();
  const externalRows = [];
  const checkedAt = new Date().toISOString();

  try {
    for (let i = 0; i < pageUrls.length; i += 1) {
      const sourceUrl = pageUrls[i];
      const page = await context.newPage();

      try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

        const found = await page.evaluate(() => {
          function inferSection(el) {
            const area = el.closest('header, footer, nav, main');
            if (!area) return 'other';
            return area.tagName.toLowerCase();
          }

          function normalizedText(el) {
            return (el.innerText || el.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 180);
          }

          const rows = [];

          document.querySelectorAll('a[href]').forEach((el) => {
            rows.push({
              href: el.getAttribute('href') || '',
              text: normalizedText(el),
              section: inferSection(el),
              elementType: 'a'
            });
          });

          document.querySelectorAll('button[data-href], button[onclick], [role="button"][data-href], [role="button"][onclick]').forEach((el) => {
            rows.push({
              href: el.getAttribute('data-href') || el.getAttribute('onclick') || '',
              text: normalizedText(el),
              section: inferSection(el),
              elementType: el.tagName.toLowerCase() === 'button' ? 'button' : 'role-button'
            });
          });

          return rows;
        });

        for (const item of found) {
          let rawHref = String(item.href || '').trim();
          if (!rawHref) continue;

          if (item.elementType !== 'a') {
            rawHref = parseOnclickUrl(rawHref) || rawHref;
          }

          if (isSkippableHref(rawHref)) continue;

          let absolute;
          try {
            absolute = new URL(rawHref, sourceUrl).toString();
          } catch {
            continue;
          }

          const occurrence = {
            SourcePage: sourceUrl,
            Section: item.section || 'other',
            LinkText: item.text || '',
            LinkUrl: absolute,
            LinkType: 'internal',
            FinalStatusCode: '',
            StatusLabel: '',
            RedirectChain: '',
            ResponseTimeMs: '',
            HardFail: '',
            Notes: '',
            CheckedAt: checkedAt
          };

          const linkHost = normalizeHost(new URL(absolute).hostname);
          if (linkHost === baseHost) {
            const list = internalToOccurrences.get(absolute) || [];
            list.push(occurrence);
            internalToOccurrences.set(absolute, list);
            allOccurrences.push(occurrence);
          } else {
            occurrence.LinkType = 'external';
            occurrence.StatusLabel = 'EXTERNAL_NOT_CHECKED';
            externalRows.push(occurrence);
          }
        }

        console.log(`[${String(i + 1).padStart(3, '0')}/${pageUrls.length}] ✅ Crawled ${sourceUrl}`);
      } catch (error) {
        console.log(`[${String(i + 1).padStart(3, '0')}/${pageUrls.length}] ⚠️ Could not crawl ${sourceUrl} (${error?.message || error})`);
      } finally {
        await page.close();
      }

      if (i < pageUrls.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    const uniqueInternalLinks = Array.from(internalToOccurrences.keys());
    console.log(`\nℹ️ Unique internal links discovered: ${uniqueInternalLinks.length}`);

    for (let i = 0; i < uniqueInternalLinks.length; i += 1) {
      const linkUrl = uniqueInternalLinks[i];
      const occurrences = internalToOccurrences.get(linkUrl) || [];

      let status;
      try {
        status = await fetchWithManualRedirects(linkUrl);
      } catch (error) {
        status = {
          finalStatusCode: 0,
          statusLabel: errorLabel(error),
          redirectChain: 'N/A',
          responseTimeMs: LINK_TIMEOUT_MS,
          notes: error?.message || String(error)
        };
      }

      const hardFail = status.finalStatusCode === 404
        || (status.finalStatusCode >= 500 && status.finalStatusCode < 600)
        || status.statusLabel === 'INFINITE_REDIRECT_LOOP';

      for (const row of occurrences) {
        row.FinalStatusCode = status.finalStatusCode;
        row.StatusLabel = status.statusLabel;
        row.RedirectChain = status.redirectChain;
        row.ResponseTimeMs = status.responseTimeMs;
        row.HardFail = hardFail ? 'YES' : 'NO';
        row.Notes = status.notes || '';
      }

      const icon = hardFail ? '❌' : '✅';
      console.log(`[${String(i + 1).padStart(4, '0')}/${uniqueInternalLinks.length}] ${icon} ${status.finalStatusCode || 0} ${linkUrl}`);

      if (i < uniqueInternalLinks.length - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const headers = [
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

  fs.writeFileSync(OUTPUT_FILE, toCsv(allOccurrences, headers), 'utf8');
  fs.writeFileSync(EXTERNAL_OUTPUT_FILE, toCsv(externalRows, headers), 'utf8');

  const hardFails = allOccurrences.filter((r) => r.HardFail === 'YES').length;

  console.log('\n─────────────────────────');
  console.log(`📄 Pages crawled: ${pageUrls.length}`);
  console.log(`🔗 Internal link occurrences checked: ${allOccurrences.length}`);
  console.log(`🌍 External link occurrences captured: ${externalRows.length}`);
  console.log(`🚨 Hard fail internal link occurrences: ${hardFails}`);
  console.log(`\nSaved: ${OUTPUT_FILE}`);
  console.log(`Saved: ${EXTERNAL_OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(`Fatal error: ${error?.message || error}`);
  process.exit(1);
});
