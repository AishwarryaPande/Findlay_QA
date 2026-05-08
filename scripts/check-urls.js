#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.resolve(process.cwd(), 'url-list.txt');
const OUTPUT_FILE = path.resolve(process.cwd(), 'results.csv');
const PARTIAL_FILE = path.resolve(process.cwd(), 'partial-results.csv');

const REQUEST_DELAY_MS = 800;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 20;
const BLOCK_THRESHOLD = 10;

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

function toCsv(rows) {
  const header = [
    'URL',
    'FinalStatusCode',
    'StatusLabel',
    'RedirectChain',
    'ResponseTimeMs',
    'Notes',
    'CheckedAt'
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      csvEscape(row.URL),
      csvEscape(row.FinalStatusCode),
      csvEscape(row.StatusLabel),
      csvEscape(row.RedirectChain),
      csvEscape(row.ResponseTimeMs),
      csvEscape(row.Notes),
      csvEscape(row.CheckedAt)
    ].join(','));
  }

  return lines.join('\n') + '\n';
}

function labelFromStatus(statusCode) {
  if (statusCode === 200) return 'OK';
  if (statusCode === 301) return 'REDIRECT_PERMANENT';
  if (statusCode === 302) return 'REDIRECT_TEMPORARY';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 429) return 'RATE_LIMITED - result unreliable, recheck manually';
  if (statusCode === 500) return 'SERVER_ERROR';
  return `HTTP_${statusCode}`;
}

function labelFromError(error) {
  if (error?.code === 'ECONNREFUSED') return 'CONNECTION_REFUSED - server blocking crawler';
  if (error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') return 'TIMEOUT - could not reach page';
  return `UNKNOWN_ERROR: ${error?.message || String(error)}`;
}

function iconAndText(result) {
  const status = result.FinalStatusCode;
  const label = result.StatusLabel;

  if (label.startsWith('CONNECTION_REFUSED')) {
    return { icon: '🚫', text: 'BLOCKED' };
  }
  if (status === 200) {
    return { icon: '✅', text: '200 OK' };
  }
  if (result.RedirectChain.includes('→')) {
    return { icon: '↪️ ', text: `${result.RedirectChain} REDIRECT` };
  }
  if (status === 404) {
    return { icon: '❌', text: '404 NOT_FOUND' };
  }
  if (status === 429) {
    return { icon: '⚠️ ', text: '429 RATE_LIMITED' };
  }
  if (label.startsWith('TIMEOUT')) {
    return { icon: '🚫', text: 'TIMEOUT' };
  }
  if (label.startsWith('UNKNOWN_ERROR')) {
    return { icon: '❓', text: 'UNKNOWN_ERROR' };
  }
  return { icon: '❓', text: `${status || 0} ${label}` };
}

function extractPathOrUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

async function fetchWithManualRedirects(url) {
  const redirects = [];
  const startedAt = Date.now();
  let currentUrl = url;

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        redirectChain: redirects.join('→'),
        responseTimeMs: Date.now() - startedAt,
        notes: ''
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return {
    finalStatusCode: 0,
    redirectChain: redirects.join('→'),
    responseTimeMs: Date.now() - startedAt,
    notes: `UNKNOWN_ERROR: Too many redirects (>${MAX_REDIRECTS})`
  };
}

function classifyForSummary(result) {
  const label = result.StatusLabel;
  const status = Number(result.FinalStatusCode || 0);

  if (status === 200) return 'ok';
  if (status === 301 || status === 302 || result.RedirectChain.includes('→')) return 'redirect';
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (label.startsWith('TIMEOUT')) return 'timeout';
  if (label.startsWith('UNKNOWN_ERROR') || label.startsWith('CONNECTION_REFUSED')) return 'unknown';
  return 'unknown';
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Missing input file: ${INPUT_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const urls = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const total = urls.length;
  const results = [];
  let consecutive429 = 0;
  let blocked = false;

  for (let i = 0; i < total; i += 1) {
    const url = urls[i];
    const checkedAt = new Date().toISOString();
    let result;

    try {
      new URL(url);
    } catch (error) {
      const label = `UNKNOWN_ERROR: Invalid URL (${error.message})`;
      result = {
        URL: url,
        FinalStatusCode: 0,
        StatusLabel: label,
        RedirectChain: 'N/A',
        ResponseTimeMs: 0,
        Notes: label,
        CheckedAt: checkedAt
      };
    }

    if (!result) {
      try {
        const response = await fetchWithManualRedirects(url);
        const statusLabel = response.notes?.startsWith('UNKNOWN_ERROR')
          ? response.notes
          : labelFromStatus(response.finalStatusCode);

        result = {
          URL: url,
          FinalStatusCode: response.finalStatusCode,
          StatusLabel: statusLabel,
          RedirectChain: response.redirectChain,
          ResponseTimeMs: response.responseTimeMs,
          Notes: response.notes || '',
          CheckedAt: checkedAt
        };
      } catch (error) {
        const statusLabel = labelFromError(error);
        result = {
          URL: url,
          FinalStatusCode: 0,
          StatusLabel: statusLabel,
          RedirectChain: 'N/A',
          ResponseTimeMs: TIMEOUT_MS,
          Notes: statusLabel,
          CheckedAt: checkedAt
        };
      }
    }

    results.push(result);

    if (Number(result.FinalStatusCode) === 429) {
      consecutive429 += 1;
    } else {
      consecutive429 = 0;
    }

    const index = String(i + 1).padStart(3, '0');
    const totalLabel = String(total);
    const view = iconAndText(result);
    const pathLabel = extractPathOrUrl(result.URL);

    if (Number(result.FinalStatusCode) === 429) {
      console.log(`[${index}/${totalLabel}] ${view.icon} ${view.text.padEnd(22)} - ${pathLabel} (${result.ResponseTimeMs}ms) RECHECK MANUALLY`);
    } else {
      console.log(`[${index}/${totalLabel}] ${view.icon} ${view.text.padEnd(22)} - ${pathLabel} (${result.ResponseTimeMs}ms)`);
    }

    if (consecutive429 >= BLOCK_THRESHOLD) {
      blocked = true;
      console.log(`[${index}/${totalLabel}] 🚫 BLOCKED              - ${pathLabel} CRAWLER BLOCKED - STOPPING`);
      console.log('CRAWLER IS BEING BLOCKED BY SERVER - results unreliable');
      console.log(`URLs checked so far: ${results.length}/${total}`);
      console.log('Stopping to avoid false data');
      fs.writeFileSync(PARTIAL_FILE, toCsv(results), 'utf8');
      break;
    }

    if (i < total - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (!blocked) {
    fs.writeFileSync(OUTPUT_FILE, toCsv(results), 'utf8');
  }

  const summary = {
    ok: 0,
    redirect: 0,
    notFound: 0,
    rateLimited: 0,
    timeout: 0,
    unknown: 0
  };

  for (const row of results) {
    const key = classifyForSummary(row);
    summary[key] += 1;
  }

  const reliableResults = summary.ok + summary.redirect + summary.notFound;
  const unreliableResults = results.length - reliableResults;

  console.log('');
  console.log(`✅ Confirmed 200 OK: ${summary.ok}`);
  console.log(`↪️  Confirmed Redirects (301/302): ${summary.redirect}`);
  console.log(`❌ Confirmed 404 Not Found: ${summary.notFound}`);
  console.log(`⚠️  Rate Limited (unreliable - recheck): ${summary.rateLimited}`);
  console.log(`🚫 Timed Out: ${summary.timeout}`);
  console.log(`❓ Unknown Errors: ${summary.unknown}`);
  console.log('─────────────────────────');
  console.log(`📋 Total URLs attempted: ${results.length}/${total}`);
  console.log(`📋 Total URLs with RELIABLE results: ${reliableResults}`);
  console.log(`📋 Total URLs UNRELIABLE (need manual check): ${unreliableResults}`);

  if (!blocked) {
    console.log(`\nSaved: ${OUTPUT_FILE}`);
  } else {
    console.log(`Saved partial: ${PARTIAL_FILE}`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error?.message || error}`);
  process.exit(1);
});
