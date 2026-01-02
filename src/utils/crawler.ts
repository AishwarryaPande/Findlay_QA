/**
 * Depth-Limited Crawler Utility
 *
 * MIGRATION CONTEXT:
 * This crawler validates internal links within each subdirectory up to a
 * configurable depth. It detects:
 * - 404 errors (broken links)
 * - Links pointing to old domains (contamination)
 * - Links crossing into other subdirectories
 *
 * DEPTH DEFINITION:
 * - Depth 0: Subdirectory homepage
 * - Depth 1: Links discovered on homepage
 * - Depth 2: Links discovered on depth 1 pages
 * - Depth 3: Links discovered on depth 2 pages
 *
 * SPEED OPTIMIZATION:
 * - Enforces max URLs per depth level
 * - Enforces max total URLs per site
 * - Uses APIRequestContext for HEAD requests where possible
 * - Parallel processing within depth levels
 */

import { APIRequestContext, Page } from '@playwright/test';
import { SiteMapping, CrawledUrl, CrawlResult, CrawlerConfig } from '../types';
import { CRAWLER_CONFIG } from '../../config/test.config';
import { SITES, NEW_BASE_URL } from '../../config/sites.config';
import {
  isInternalUrl,
  isOldDomainUrl,
  isCrossSubdirectoryUrl,
  shouldExcludeUrl,
  hasSkippableExtension,
  resolveUrl,
  extractPath,
  isOldDomain
} from './url-normalizer';

/**
 * Main crawler class for depth-limited link validation
 */
export class DepthLimitedCrawler {
  private config: CrawlerConfig;
  private site: SiteMapping;
  private visitedUrls: Set<string> = new Set();
  private urlsByDepth: Map<number, CrawledUrl[]> = new Map();
  private failedUrls: CrawledUrl[] = [];
  private oldDomainUrls: string[] = [];
  private crossSubdirectoryUrls: string[] = [];
  private totalUrlsProcessed = 0;
  private startTime = 0;

  constructor(site: SiteMapping, configOverrides?: Partial<CrawlerConfig>) {
    this.site = site;
    this.config = { ...CRAWLER_CONFIG, ...configOverrides };
  }

  /**
   * Main crawl method - starts from homepage and crawls to max depth
   */
  async crawl(page: Page, request: APIRequestContext): Promise<CrawlResult> {
    this.startTime = Date.now();
    const homepageUrl = `${NEW_BASE_URL}/${this.site.subdirectoryPath}/`;

    // Initialize depth 0 with homepage
    await this.processUrl(homepageUrl, 0, null, page, request);

    // Process each depth level
    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      const currentDepthUrls = this.urlsByDepth.get(depth) || [];
      const successfulUrls = currentDepthUrls.filter(u => u.success);

      // Collect all links from current depth pages
      const linksToProcess: Array<{ url: string; parentUrl: string }> = [];

      for (const crawledUrl of successfulUrls) {
        if (this.shouldStop()) break;

        const links = await this.extractLinks(crawledUrl.url, page);
        for (const link of links) {
          if (!this.visitedUrls.has(link)) {
            linksToProcess.push({ url: link, parentUrl: crawledUrl.url });
          }
        }
      }

      // Apply per-depth limit
      const maxForNextDepth = this.config.maxUrlsPerDepth[depth + 1] || 50;
      const limitedLinks = linksToProcess.slice(0, maxForNextDepth);

      // Process next depth level
      for (const { url, parentUrl } of limitedLinks) {
        if (this.shouldStop()) break;
        await this.processUrl(url, depth + 1, parentUrl, page, request);
      }
    }

    return this.buildResult();
  }

  /**
   * Process a single URL
   */
  private async processUrl(
    url: string,
    depth: number,
    parentUrl: string | null,
    page: Page,
    request: APIRequestContext
  ): Promise<void> {
    // Skip if already visited
    if (this.visitedUrls.has(url)) return;
    this.visitedUrls.add(url);

    // Skip if we've hit the total limit
    if (this.shouldStop()) return;

    // Check for old domain contamination
    if (isOldDomain(url, SITES)) {
      this.oldDomainUrls.push(url);
    }

    // Check for cross-subdirectory contamination
    if (isCrossSubdirectoryUrl(url, this.site, SITES)) {
      this.crossSubdirectoryUrls.push(url);
    }

    // Only fully process internal URLs
    if (!isInternalUrl(url, this.site)) {
      return;
    }

    // Skip excluded patterns
    if (shouldExcludeUrl(url, this.config.excludePatterns)) {
      return;
    }

    // Skip non-HTML extensions
    if (hasSkippableExtension(url, this.config.skipExtensions)) {
      return;
    }

    const startTime = Date.now();
    const crawledUrl: CrawledUrl = {
      url,
      depth,
      parentUrl,
      status: 0,
      success: false,
      responseTime: 0
    };

    try {
      // Use HEAD request first for speed, fall back to GET if needed
      const response = await request.head(url, {
        timeout: this.config.requestTimeout,
        failOnStatusCode: false
      });

      crawledUrl.status = response.status();
      crawledUrl.success = response.ok();
      crawledUrl.responseTime = Date.now() - startTime;

      // For depth 0 or if we need to extract links, do a full page load
      if (depth < this.config.maxDepth && crawledUrl.success) {
        // We'll extract links in the main crawl loop
      }

      if (!crawledUrl.success) {
        crawledUrl.error = `HTTP ${response.status()}`;
        this.failedUrls.push(crawledUrl);
      }
    } catch (error) {
      crawledUrl.success = false;
      crawledUrl.error = error instanceof Error ? error.message : 'Unknown error';
      crawledUrl.responseTime = Date.now() - startTime;
      this.failedUrls.push(crawledUrl);
    }

    // Store in depth map
    const depthUrls = this.urlsByDepth.get(depth) || [];
    depthUrls.push(crawledUrl);
    this.urlsByDepth.set(depth, depthUrls);
    this.totalUrlsProcessed++;

    // Respect rate limiting
    if (this.config.requestDelay > 0) {
      await this.delay(this.config.requestDelay);
    }
  }

  /**
   * Extract all links from a page
   */
  private async extractLinks(url: string, page: Page): Promise<string[]> {
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.requestTimeout
      });

      // Extract all anchor hrefs
      const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors)
          .map(a => a.getAttribute('href'))
          .filter((href): href is string => href !== null && href.length > 0);
      });

      // Resolve relative URLs and filter
      const resolvedLinks: string[] = [];
      for (const link of links) {
        // Skip javascript:, mailto:, tel:, etc.
        if (/^(javascript|mailto|tel|fax|sms):/i.test(link)) {
          continue;
        }

        // Skip anchor-only links
        if (link.startsWith('#')) {
          continue;
        }

        const resolved = resolveUrl(link, url);

        // Only include http/https URLs
        if (/^https?:\/\//i.test(resolved)) {
          resolvedLinks.push(resolved);
        }
      }

      return [...new Set(resolvedLinks)]; // Deduplicate
    } catch {
      return [];
    }
  }

  /**
   * Check if we should stop crawling
   */
  private shouldStop(): boolean {
    return this.totalUrlsProcessed >= this.config.maxTotalUrlsPerSite;
  }

  /**
   * Build the final crawl result
   */
  private buildResult(): CrawlResult {
    const allUrls: CrawledUrl[] = [];
    const statsByDepth: Record<number, { total: number; success: number; failed: number }> = {};

    for (let depth = 0; depth <= this.config.maxDepth; depth++) {
      const depthUrls = this.urlsByDepth.get(depth) || [];
      allUrls.push(...depthUrls);

      statsByDepth[depth] = {
        total: depthUrls.length,
        success: depthUrls.filter(u => u.success).length,
        failed: depthUrls.filter(u => !u.success).length
      };
    }

    return {
      site: this.site,
      urls: allUrls,
      failedUrls: this.failedUrls,
      oldDomainUrls: this.oldDomainUrls,
      crossSubdirectoryUrls: this.crossSubdirectoryUrls,
      totalTime: Date.now() - this.startTime,
      statsByDepth
    };
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Quick link check using only API requests (no browser)
 * Faster for simple availability checks
 */
export async function checkLinkAvailability(
  url: string,
  request: APIRequestContext,
  timeout = 10000
): Promise<{ url: string; status: number; ok: boolean; error?: string }> {
  try {
    const response = await request.head(url, {
      timeout,
      failOnStatusCode: false
    });

    return {
      url,
      status: response.status(),
      ok: response.ok()
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Batch check multiple URLs in parallel
 */
export async function batchCheckUrls(
  urls: string[],
  request: APIRequestContext,
  concurrency = 10,
  timeout = 10000
): Promise<Array<{ url: string; status: number; ok: boolean; error?: string }>> {
  const results: Array<{ url: string; status: number; ok: boolean; error?: string }> = [];

  // Process in batches
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(url => checkLinkAvailability(url, request, timeout))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Extract and categorize all links from a page
 */
export async function extractAndCategorizeLinks(
  page: Page,
  currentSite: SiteMapping
): Promise<{
  internal: string[];
  external: string[];
  oldDomain: string[];
  crossSubdirectory: string[];
  invalid: string[];
}> {
  const currentUrl = page.url();

  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll('a[href]');
    return Array.from(anchors)
      .map(a => a.getAttribute('href'))
      .filter((href): href is string => href !== null);
  });

  const result = {
    internal: [] as string[],
    external: [] as string[],
    oldDomain: [] as string[],
    crossSubdirectory: [] as string[],
    invalid: [] as string[]
  };

  for (const link of links) {
    // Skip non-navigable links
    if (/^(javascript|mailto|tel|fax|sms|#):/i.test(link) || link === '#') {
      continue;
    }

    try {
      const resolved = resolveUrl(link, currentUrl);

      if (!resolved.startsWith('http')) {
        result.invalid.push(link);
        continue;
      }

      if (isOldDomainUrl(resolved, currentSite)) {
        result.oldDomain.push(resolved);
      } else if (isCrossSubdirectoryUrl(resolved, currentSite, SITES)) {
        result.crossSubdirectory.push(resolved);
      } else if (isInternalUrl(resolved, currentSite)) {
        result.internal.push(resolved);
      } else {
        result.external.push(resolved);
      }
    } catch {
      result.invalid.push(link);
    }
  }

  // Deduplicate
  return {
    internal: [...new Set(result.internal)],
    external: [...new Set(result.external)],
    oldDomain: [...new Set(result.oldDomain)],
    crossSubdirectory: [...new Set(result.crossSubdirectory)],
    invalid: [...new Set(result.invalid)]
  };
}
