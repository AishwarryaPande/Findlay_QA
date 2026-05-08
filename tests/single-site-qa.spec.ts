import { test, expect } from '../src/fixtures/test-fixtures';
import { URLS_TO_TEST, TARGET_BASE_URL } from '../config/url-list';
import { CONSOLE_CONFIG } from '../config/test.config';

type LinkKind = 'header' | 'footer' | 'button' | 'internal' | 'asset';

type LinkOccurrence = {
  sourceUrl: string;
  kind: LinkKind;
};

const BASE_ORIGIN = new URL(TARGET_BASE_URL).origin;

function normalizePath(pathname: string): string {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '');
}

function shouldSkipLink(url: string): boolean {
  return (
    url.startsWith('mailto:') ||
    url.startsWith('tel:') ||
    url.startsWith('javascript:') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  );
}

function toAbsoluteInternalUrl(href: string, pageUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || shouldSkipLink(trimmed) || trimmed.startsWith('#')) {
    return null;
  }

  try {
    const parsed = new URL(trimmed, pageUrl);
    parsed.hash = '';

    if (parsed.origin !== BASE_ORIGIN) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

async function getFinalStatus(
  request: { get: (url: string, options: { failOnStatusCode: boolean; maxRedirects: number; timeout: number }) => Promise<{ status: () => number }> },
  url: string
): Promise<number> {
  try {
    const response = await request.get(url, {
      failOnStatusCode: false,
      maxRedirects: 10,
      timeout: 30000
    });
    return response.status();
  } catch {
    return 0;
  }
}

async function checkStatusesInBatches(
  request: { get: (url: string, options: { failOnStatusCode: boolean; maxRedirects: number; timeout: number }) => Promise<{ status: () => number }> },
  urls: string[],
  concurrency = 15
): Promise<Map<string, number>> {
  const results = new Map<string, number>();

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const statuses = await Promise.all(batch.map(url => getFinalStatus(request, url)));

    batch.forEach((url, idx) => {
      results.set(url, statuses[idx]);
    });
  }

  return results;
}

test.describe('Single Site QA - URL List Validation', () => {
  test.setTimeout(60 * 60 * 1000);

  test('1) every listed URL returns HTTP 200', async ({ request }: { request: any }, testInfo: any) => {
    const statusMap = await checkStatusesInBatches(request, URLS_TO_TEST, 20);

    const failures = URLS_TO_TEST
      .map(url => ({ url, status: statusMap.get(url) || 0 }))
      .filter(item => item.status !== 200);

    await testInfo.attach('status-check-results', {
      contentType: 'application/json',
      body: JSON.stringify({
        baseUrl: TARGET_BASE_URL,
        total: URLS_TO_TEST.length,
        failures
      }, null, 2)
    });

    expect(failures, `Found ${failures.length} non-200 URLs`).toEqual([]);
  });

  test('2-8) links, assets, console, and SEO checks pass for all listed pages', async ({ context, request }: { context: any; request: any }, testInfo: any) => {
    const linkTargets = new Map<string, LinkOccurrence[]>();

    const consoleIssues: Array<{ url: string; errors: string[] }> = [];
    const seoIssues: Array<{ url: string; issue: string }> = [];
    const pageLoadFailures: Array<{ url: string; error: string }> = [];

    const addTargets = (urls: string[], sourceUrl: string, kind: LinkKind) => {
      for (const target of urls) {
        const existing = linkTargets.get(target) || [];
        existing.push({ sourceUrl, kind });
        linkTargets.set(target, existing);
      }
    };

    for (const url of URLS_TO_TEST) {
      const pageErrors: string[] = [];

      const onConsole = (msg: { type: () => string; text: () => string }) => {
        if (msg.type() !== 'error') return;

        const text = msg.text() || '';
        const ignored = CONSOLE_CONFIG.ignorePatterns.some(pattern => text.includes(pattern));
        if (!ignored) {
          pageErrors.push(text);
        }
      };

      const onPageError = (error: Error) => {
        const text = error.message || String(error);
        const ignored = CONSOLE_CONFIG.ignorePatterns.some(pattern => text.includes(pattern));
        if (!ignored) {
          pageErrors.push(text);
        }
      };

      const page = await context.newPage();
      page.on('console', onConsole);
      page.on('pageerror', onPageError);

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });

        const currentUrl = page.url();
        const current = new URL(currentUrl);

        // SEO basics
        const title = await page.title();
        if (!title || !title.trim()) {
          seoIssues.push({ url, issue: 'Missing title tag content' });
        }

        const h1Count = await page.locator('h1').count();
        if (h1Count < 1) {
          seoIssues.push({ url, issue: 'Missing H1' });
        }

        const canonicalHref = await page.evaluate(() => {
          const canonical = document.querySelector('link[rel="canonical"]');
          return canonical?.getAttribute('href') || null;
        });
        if (!canonicalHref) {
          seoIssues.push({ url, issue: 'Missing canonical link' });
        } else {
          try {
            const canonical = new URL(canonicalHref, currentUrl);
            if (canonical.origin !== BASE_ORIGIN) {
              seoIssues.push({
                url,
                issue: `Canonical origin mismatch (${canonical.origin})`
              });
            }

            if (normalizePath(canonical.pathname) !== normalizePath(current.pathname)) {
              seoIssues.push({
                url,
                issue: `Canonical path mismatch (${canonical.pathname} vs ${current.pathname})`
              });
            }
          } catch {
            seoIssues.push({ url, issue: `Invalid canonical URL (${canonicalHref})` });
          }
        }

        const extracted = await page.evaluate((pageUrl: string) => {
          const makeAbsolute = (value: string | null): string | null => {
            if (!value) return null;
            try {
              const parsed = new URL(value, pageUrl);
              parsed.hash = '';
              return parsed.toString();
            } catch {
              return null;
            }
          };

          const hrefs = (selector: string): string[] => {
            const nodes = Array.from(document.querySelectorAll(selector));
            const values = nodes
              .map(node => (node as HTMLAnchorElement).getAttribute('href'))
              .map(makeAbsolute)
              .filter((v): v is string => !!v);
            return [...new Set(values)];
          };

          const srcs = (selector: string, attr: 'src' | 'href'): string[] => {
            const nodes = Array.from(document.querySelectorAll(selector));
            const values = nodes
              .map(node => node.getAttribute(attr))
              .map(makeAbsolute)
              .filter((v): v is string => !!v);
            return [...new Set(values)];
          };

          return {
            header: hrefs('header a[href], [role="banner"] a[href], nav a[href]'),
            footer: hrefs('footer a[href], [role="contentinfo"] a[href]'),
            buttons: hrefs('a[href][class*="btn"], a[href][class*="button"], .wp-block-button a[href], a[href][role="button"]'),
            internal: hrefs('a[href]'),
            assets: [
              ...srcs('img[src]', 'src'),
              ...srcs('script[src]', 'src'),
              ...srcs('link[rel="stylesheet"][href]', 'href')
            ]
          };
        }, currentUrl);

        const toInternal = (values: string[]) => {
          const normalized = values
            .map(value => toAbsoluteInternalUrl(value, currentUrl))
            .filter((v): v is string => !!v);
          return [...new Set(normalized)];
        };

        addTargets(toInternal(extracted.header), url, 'header');
        addTargets(toInternal(extracted.footer), url, 'footer');
        addTargets(toInternal(extracted.buttons), url, 'button');
        addTargets(toInternal(extracted.internal), url, 'internal');
        addTargets(toInternal(extracted.assets), url, 'asset');
      } catch (error) {
        pageLoadFailures.push({
          url,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        await page.close();
      }

      if (pageErrors.length > 0) {
        consoleIssues.push({
          url,
          errors: [...new Set(pageErrors)]
        });
      }
    }

    const uniqueTargets = [...linkTargets.keys()];
    const statusMap = await checkStatusesInBatches(request, uniqueTargets, 20);

    const failuresByKind: Record<LinkKind, Array<{ target: string; status: number; sourceUrl: string }>> = {
      header: [],
      footer: [],
      button: [],
      internal: [],
      asset: []
    };

    for (const [target, occurrences] of linkTargets.entries()) {
      const status = statusMap.get(target) || 0;
      if (status >= 400 || status === 0) {
        for (const occurrence of occurrences) {
          failuresByKind[occurrence.kind].push({
            target,
            status,
            sourceUrl: occurrence.sourceUrl
          });
        }
      }
    }

    const summary = {
      pagesChecked: URLS_TO_TEST.length,
      uniqueTargetsChecked: uniqueTargets.length,
      pageLoadFailures,
      consoleIssues,
      seoIssues,
      headerFailures: failuresByKind.header,
      footerFailures: failuresByKind.footer,
      buttonFailures: failuresByKind.button,
      internalFailures: failuresByKind.internal,
      assetFailures: failuresByKind.asset
    };

    await testInfo.attach('single-site-qa-summary', {
      contentType: 'application/json',
      body: JSON.stringify(summary, null, 2)
    });

    expect(pageLoadFailures, `Pages that failed to load: ${pageLoadFailures.length}`).toEqual([]);
    expect(failuresByKind.header, `Broken header links: ${failuresByKind.header.length}`).toEqual([]);
    expect(failuresByKind.footer, `Broken footer links: ${failuresByKind.footer.length}`).toEqual([]);
    expect(failuresByKind.button, `Broken button/CTA links: ${failuresByKind.button.length}`).toEqual([]);
    expect(failuresByKind.internal, `Broken internal links: ${failuresByKind.internal.length}`).toEqual([]);
    expect(failuresByKind.asset, `Broken assets: ${failuresByKind.asset.length}`).toEqual([]);
    expect(consoleIssues, `Console errors found on ${consoleIssues.length} pages`).toEqual([]);
    expect(seoIssues, `SEO basic issues found: ${seoIssues.length}`).toEqual([]);
  });
});
