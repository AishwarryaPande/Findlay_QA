/**
 * Sitemap Parser Utility
 *
 * MIGRATION CONTEXT:
 * Compares sitemaps between old domain and new subdirectory to detect:
 * - Missing migrated URLs
 * - Unexpected URL differences
 * - Significant count mismatches
 *
 * Supports:
 * - Standard sitemaps (sitemap.xml)
 * - Sitemap indexes (multiple child sitemaps)
 * - Configurable thresholds for warnings vs failures
 */

import { APIRequestContext } from '@playwright/test';
import { XMLParser } from 'fast-xml-parser';
import {
  SiteMapping,
  SitemapEntry,
  SitemapParseResult,
  SitemapComparisonResult
} from '../types';
import { SITEMAP_CONFIG } from '../../config/test.config';
import { extractPath, convertToNewUrl } from './url-normalizer';
import { NEW_BASE_URL } from '../../config/sites.config';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_'
});

/**
 * Fetch and parse a sitemap from a URL
 */
export async function fetchAndParseSitemap(
  url: string,
  request: APIRequestContext,
  followIndex = true
): Promise<SitemapParseResult> {
  const startTime = Date.now();
  const result: SitemapParseResult = {
    sourceUrl: url,
    urls: [],
    isSitemapIndex: false,
    childSitemaps: [],
    errors: [],
    parseTime: 0
  };

  try {
    const response = await request.get(url, {
      timeout: SITEMAP_CONFIG.fetchTimeout,
      headers: {
        'Accept': 'application/xml, text/xml, */*'
      }
    });

    if (!response.ok()) {
      result.errors.push(`Failed to fetch sitemap: HTTP ${response.status()}`);
      result.parseTime = Date.now() - startTime;
      return result;
    }

    const contentType = response.headers()['content-type'] || '';
    const body = await response.text();

    // Check if it's XML
    if (!body.trim().startsWith('<?xml') && !body.trim().startsWith('<')) {
      result.errors.push('Response is not valid XML');
      result.parseTime = Date.now() - startTime;
      return result;
    }

    const parsed = xmlParser.parse(body);

    // Check if this is a sitemap index
    if (parsed.sitemapindex) {
      result.isSitemapIndex = true;
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];

      result.childSitemaps = sitemaps
        .filter((s: any) => s && s.loc)
        .map((s: any) => s.loc);

      // If following indexes, fetch all child sitemaps
      if (followIndex && SITEMAP_CONFIG.followSitemapIndex) {
        for (const childUrl of result.childSitemaps!) {
          try {
            const childResult = await fetchAndParseSitemap(childUrl, request, false);
            result.urls.push(...childResult.urls);
            result.errors.push(...childResult.errors.map(e => `[${childUrl}] ${e}`));
          } catch (error) {
            result.errors.push(`Failed to fetch child sitemap ${childUrl}: ${error}`);
          }

          // Respect max URLs limit
          if (result.urls.length >= SITEMAP_CONFIG.maxUrlsToCompare) {
            break;
          }
        }
      }
    } else if (parsed.urlset) {
      // Standard sitemap
      const urls = Array.isArray(parsed.urlset.url)
        ? parsed.urlset.url
        : parsed.urlset.url
        ? [parsed.urlset.url]
        : [];

      result.urls = urls
        .filter((u: any) => u && u.loc)
        .slice(0, SITEMAP_CONFIG.maxUrlsToCompare)
        .map((u: any) => ({
          loc: u.loc,
          lastmod: u.lastmod,
          changefreq: u.changefreq,
          priority: u.priority
        }));
    } else {
      result.errors.push('Unknown sitemap format - no urlset or sitemapindex found');
    }
  } catch (error) {
    result.errors.push(`Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  result.parseTime = Date.now() - startTime;
  return result;
}

/**
 * Compare sitemaps between old domain and new subdirectory
 */
export async function compareSitemaps(
  site: SiteMapping,
  request: APIRequestContext
): Promise<SitemapComparisonResult> {
  const oldSitemapUrl = `${site.oldDomain}${site.sitemapPath || '/sitemap.xml'}`;
  const newSitemapUrl = `${NEW_BASE_URL}/${site.subdirectoryPath}${site.sitemapPath || '/sitemap.xml'}`;

  // Fetch both sitemaps
  const [oldResult, newResult] = await Promise.all([
    fetchAndParseSitemap(oldSitemapUrl, request),
    fetchAndParseSitemap(newSitemapUrl, request)
  ]);

  // Extract and normalize paths from old sitemap
  const oldPaths = new Set(oldResult.urls.map(u => extractPath(u.loc)));

  // Extract paths from new sitemap, removing subdirectory prefix
  const subdirPrefix = `/${site.subdirectoryPath}`;
  const newPaths = new Set(
    newResult.urls.map(u => {
      const path = extractPath(u.loc);
      // Remove subdirectory prefix if present
      if (path.startsWith(subdirPrefix)) {
        const remaining = path.slice(subdirPrefix.length);
        return remaining || '/';
      }
      return path;
    })
  );

  // Find differences
  const missingPaths: string[] = [];
  const extraPaths: string[] = [];
  const matchingPaths: string[] = [];

  for (const path of oldPaths) {
    if (newPaths.has(path)) {
      matchingPaths.push(path);
    } else {
      missingPaths.push(path);
    }
  }

  for (const path of newPaths) {
    if (!oldPaths.has(path)) {
      extraPaths.push(path);
    }
  }

  // Calculate migration percentage
  const migrationPercentage = oldPaths.size > 0
    ? (matchingPaths.length / oldPaths.size) * 100
    : 100;

  // Convert missing paths back to full URLs for reporting
  const missingUrls = missingPaths.map(path => `${site.oldDomain}${path}`);
  const extraUrls = extraPaths.map(path => `${NEW_BASE_URL}/${site.subdirectoryPath}${path}`);

  // Determine status
  let status: 'pass' | 'warning' | 'fail' = 'pass';
  let message = 'Sitemap comparison passed';

  const missingPercentage = oldPaths.size > 0
    ? (missingPaths.length / oldPaths.size) * 100
    : 0;

  if (newResult.urls.length < SITEMAP_CONFIG.minimumExpectedUrls) {
    status = 'fail';
    message = `New sitemap has only ${newResult.urls.length} URLs (minimum expected: ${SITEMAP_CONFIG.minimumExpectedUrls})`;
  } else if (missingPercentage >= SITEMAP_CONFIG.missingUrlFailureThreshold) {
    status = 'fail';
    message = `${missingPercentage.toFixed(1)}% of old URLs are missing (threshold: ${SITEMAP_CONFIG.missingUrlFailureThreshold}%)`;
  } else if (missingPercentage >= SITEMAP_CONFIG.missingUrlWarningThreshold) {
    status = 'warning';
    message = `${missingPercentage.toFixed(1)}% of old URLs are missing (warning threshold: ${SITEMAP_CONFIG.missingUrlWarningThreshold}%)`;
  }

  // Add errors to message if any
  if (oldResult.errors.length > 0 || newResult.errors.length > 0) {
    const allErrors = [...oldResult.errors, ...newResult.errors];
    if (status === 'pass') {
      status = 'warning';
    }
    message += `. Errors: ${allErrors.join('; ')}`;
  }

  return {
    site,
    oldUrlCount: oldResult.urls.length,
    newUrlCount: newResult.urls.length,
    missingUrls,
    extraUrls,
    matchingUrls: matchingPaths.map(p => `${site.oldDomain}${p}`),
    migrationPercentage,
    status,
    message
  };
}

/**
 * Get a summary of sitemap comparison suitable for reporting
 */
export function getSitemapComparisonSummary(result: SitemapComparisonResult): string {
  const lines: string[] = [
    `Site: ${result.site.name}`,
    `Old sitemap URLs: ${result.oldUrlCount}`,
    `New sitemap URLs: ${result.newUrlCount}`,
    `Migration rate: ${result.migrationPercentage.toFixed(1)}%`,
    `Missing URLs: ${result.missingUrls.length}`,
    `Extra URLs: ${result.extraUrls.length}`,
    `Status: ${result.status.toUpperCase()}`,
    `Message: ${result.message}`
  ];

  if (result.missingUrls.length > 0 && result.missingUrls.length <= 10) {
    lines.push('');
    lines.push('Missing URLs:');
    result.missingUrls.forEach(url => lines.push(`  - ${url}`));
  } else if (result.missingUrls.length > 10) {
    lines.push('');
    lines.push(`Missing URLs (first 10 of ${result.missingUrls.length}):`);
    result.missingUrls.slice(0, 10).forEach(url => lines.push(`  - ${url}`));
  }

  return lines.join('\n');
}

/**
 * Validate sitemap accessibility (quick check)
 */
export async function validateSitemapAccessibility(
  url: string,
  request: APIRequestContext
): Promise<{ accessible: boolean; statusCode: number; error?: string }> {
  try {
    const response = await request.head(url, {
      timeout: 10000
    });

    return {
      accessible: response.ok(),
      statusCode: response.status()
    };
  } catch (error) {
    return {
      accessible: false,
      statusCode: 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Sample random URLs from a sitemap for testing
 */
export function sampleSitemapUrls(
  urls: SitemapEntry[],
  sampleSize: number
): SitemapEntry[] {
  if (urls.length <= sampleSize) {
    return urls;
  }

  // Fisher-Yates shuffle and take first n
  const shuffled = [...urls];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, sampleSize);
}
