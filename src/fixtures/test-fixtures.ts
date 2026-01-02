/**
 * Custom Playwright Test Fixtures
 *
 * MIGRATION CONTEXT:
 * These fixtures provide shared functionality across all test files:
 * - Site-specific test execution
 * - Console error collection
 * - Network failure tracking
 * - Asset validation helpers
 *
 * Fixtures make tests cleaner and ensure consistent behavior.
 */

import { test as base, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { SiteMapping, ConsoleMessage, NetworkFailure, PageAsset } from '../types';
import { getEnabledSites, NEW_BASE_URL } from '../../config/sites.config';
import { CONSOLE_CONFIG, ASSET_CONFIG } from '../../config/test.config';

/**
 * Extended test type with custom fixtures
 */
export type TestFixtures = {
  /** Current site being tested */
  site: SiteMapping;

  /** Full URL to the site's subdirectory homepage */
  siteHomepage: string;

  /** Collected console messages during test */
  consoleMessages: ConsoleMessage[];

  /** Collected network failures during test */
  networkFailures: NetworkFailure[];

  /** Helper to collect console messages from a page */
  collectConsoleMessages: (page: Page) => void;

  /** Helper to check page assets */
  getPageAssets: (page: Page) => Promise<PageAsset[]>;

  /** Helper for batched API requests */
  batchRequest: <T>(
    urls: string[],
    handler: (url: string, request: APIRequestContext) => Promise<T>,
    concurrency?: number
  ) => Promise<T[]>;
};

/**
 * Extended test with site-specific fixtures
 */
export const test = base.extend<TestFixtures>({
  // Site fixture - will be overridden per-test using test.describe
  site: [async ({}, use) => {
    // Default to first enabled site
    // Individual tests should specify their site
    const sites = getEnabledSites();
    await use(sites[0]);
  }, { option: true }],

  // Computed homepage URL
  siteHomepage: async ({ site }, use) => {
    const homepage = `${NEW_BASE_URL}/${site.subdirectoryPath}/`;
    await use(homepage);
  },

  // Console message collection
  consoleMessages: async ({}, use) => {
    const messages: ConsoleMessage[] = [];
    await use(messages);
  },

  // Network failure collection
  networkFailures: async ({}, use) => {
    const failures: NetworkFailure[] = [];
    await use(failures);
  },

  // Helper to attach console listeners
  collectConsoleMessages: async ({ consoleMessages, networkFailures }, use) => {
    const collector = (page: Page) => {
      // Collect console messages
      page.on('console', msg => {
        const type = msg.type();
        const text = msg.text();

        // Check if should be ignored
        const isIgnored = CONSOLE_CONFIG.ignorePatterns.some(pattern =>
          text.includes(pattern)
        );

        // Determine if critical
        const isCritical = type === 'error' && !isIgnored && CONSOLE_CONFIG.failOnError;

        consoleMessages.push({
          type,
          text,
          url: page.url(),
          isCritical,
          isIgnored
        });
      });

      // Collect page errors (uncaught exceptions)
      page.on('pageerror', error => {
        const text = error.message || error.toString();
        const isIgnored = CONSOLE_CONFIG.ignorePatterns.some(pattern =>
          text.includes(pattern)
        );

        consoleMessages.push({
          type: 'pageerror',
          text,
          url: page.url(),
          isCritical: !isIgnored,
          isIgnored
        });
      });

      // Collect network failures
      if (CONSOLE_CONFIG.captureNetworkFailures) {
        page.on('requestfailed', request => {
          networkFailures.push({
            url: request.url(),
            resourceType: request.resourceType(),
            reason: request.failure()?.errorText || 'Unknown failure',
            status: undefined
          });
        });
      }
    };

    await use(collector);
  },

  // Helper to extract and validate assets from a page
  getPageAssets: async ({}, use) => {
    const getAssets = async (page: Page): Promise<PageAsset[]> => {
      const assets: PageAsset[] = [];

      // Extract all images
      const images = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img[src]');
        return Array.from(imgs).map(img => ({
          url: (img as HTMLImageElement).src,
          element: 'img',
          naturalWidth: (img as HTMLImageElement).naturalWidth
        }));
      });

      for (const img of images) {
        const isForbidden = ASSET_CONFIG.forbiddenAssetDomains.some(domain =>
          img.url.includes(domain)
        );

        assets.push({
          url: img.url,
          type: 'image',
          element: 'img',
          loaded: img.naturalWidth > 0,
          isForbiddenDomain: isForbidden
        });
      }

      // Extract stylesheets
      const stylesheets = await page.evaluate(() => {
        const links = document.querySelectorAll('link[rel="stylesheet"][href]');
        return Array.from(links).map(link => ({
          url: (link as HTMLLinkElement).href,
          element: 'link'
        }));
      });

      for (const css of stylesheets) {
        const isForbidden = ASSET_CONFIG.forbiddenAssetDomains.some(domain =>
          css.url.includes(domain)
        );

        assets.push({
          url: css.url,
          type: 'stylesheet',
          element: 'link[rel=stylesheet]',
          loaded: true, // Will be validated separately
          isForbiddenDomain: isForbidden
        });
      }

      // Extract scripts
      const scripts = await page.evaluate(() => {
        const scriptTags = document.querySelectorAll('script[src]');
        return Array.from(scriptTags).map(script => ({
          url: (script as HTMLScriptElement).src,
          element: 'script'
        }));
      });

      for (const script of scripts) {
        const isForbidden = ASSET_CONFIG.forbiddenAssetDomains.some(domain =>
          script.url.includes(domain)
        );

        assets.push({
          url: script.url,
          type: 'script',
          element: 'script',
          loaded: true, // Will be validated separately
          isForbiddenDomain: isForbidden
        });
      }

      // Limit assets per page
      return assets.slice(0, ASSET_CONFIG.maxAssetsPerPage);
    };

    await use(getAssets);
  },

  // Batched request helper for parallel API calls
  batchRequest: async ({ request }, use) => {
    const batcher = async <T>(
      urls: string[],
      handler: (url: string, req: APIRequestContext) => Promise<T>,
      concurrency = 10
    ): Promise<T[]> => {
      const results: T[] = [];

      for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map(url => handler(url, request))
        );
        results.push(...batchResults);
      }

      return results;
    };

    await use(batcher);
  }
});

/**
 * Re-export expect for convenience
 */
export { expect } from '@playwright/test';

/**
 * Helper to create test suites for all enabled sites
 */
export function describeSites(
  suiteName: string,
  testFn: (site: SiteMapping) => void
): void {
  const sites = getEnabledSites();

  for (const site of sites) {
    test.describe(`${suiteName} - ${site.name}`, () => {
      // Override the site fixture for this describe block
      test.use({ site });
      testFn(site);
    });
  }
}

/**
 * Helper to run tests for a single site (for CLI filtering)
 */
export function getSiteFromEnv(): SiteMapping | null {
  const siteName = process.env.SITE_FILTER;
  if (!siteName) return null;

  const sites = getEnabledSites();
  return sites.find(s =>
    s.name.toLowerCase() === siteName.toLowerCase()
  ) || null;
}

/**
 * Helper to filter sites for testing
 */
export function getTestSites(): SiteMapping[] {
  const envSite = getSiteFromEnv();
  if (envSite) {
    return [envSite];
  }
  return getEnabledSites();
}
