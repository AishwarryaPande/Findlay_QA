/**
 * Redirect Checker Utility
 *
 * MIGRATION CONTEXT:
 * Validates that redirects configured on the old domain are properly
 * replicated on the new subdirectory installation.
 *
 * Example:
 * Old: https://www.bainbridgereview.com/entertainment/ → /life
 * New: https://cmg-northwest2.go-vip.net/bainbridgereview/entertainment → /bainbridgereview/life
 *
 * Detects:
 * - Missing redirects on new installation
 * - Incorrect redirect destinations
 * - Redirect chain issues
 * - Temporary vs permanent redirect differences
 */

import { APIRequestContext } from '@playwright/test';
import {
  SiteMapping,
  RedirectHop,
  RedirectChain,
  RedirectParityResult
} from '../types';
import { REDIRECT_CONFIG } from '../../config/test.config';
import { extractPath, convertToNewUrl } from './url-normalizer';
import { NEW_BASE_URL } from '../../config/sites.config';

/**
 * Follow redirects and build a complete redirect chain
 */
export async function getRedirectChain(
  url: string,
  request: APIRequestContext
): Promise<RedirectChain> {
  const hops: RedirectHop[] = [];
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount < REDIRECT_CONFIG.maxRedirectChain) {
    try {
      const response = await request.get(currentUrl, {
        timeout: REDIRECT_CONFIG.timeout,
        maxRedirects: 0, // Don't auto-follow
        failOnStatusCode: false
      });

      const status = response.status();

      // Check if this is a redirect status
      if (status >= 300 && status < 400) {
        const location = response.headers()['location'];

        if (!location) {
          // Redirect without location header - unusual but possible
          break;
        }

        // Resolve relative redirect URLs
        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          nextUrl = location;
        }

        hops.push({
          from: currentUrl,
          to: nextUrl,
          statusCode: status,
          isPermanent: status === 301 || status === 308
        });

        currentUrl = nextUrl;
        redirectCount++;
      } else {
        // Not a redirect - we've reached the final destination
        break;
      }
    } catch (error) {
      // Network error - stop following chain
      break;
    }
  }

  return {
    originalUrl: url,
    finalUrl: currentUrl,
    hops,
    redirectCount: hops.length,
    isTooLong: redirectCount >= REDIRECT_CONFIG.maxRedirectChain,
    allPermanent: hops.every(h => h.isPermanent)
  };
}

/**
 * Check if a URL redirects (quick check)
 */
export async function checkIfRedirects(
  url: string,
  request: APIRequestContext
): Promise<{ redirects: boolean; status: number; location?: string }> {
  try {
    const response = await request.get(url, {
      timeout: REDIRECT_CONFIG.timeout,
      maxRedirects: 0,
      failOnStatusCode: false
    });

    const status = response.status();
    const redirects = status >= 300 && status < 400;

    return {
      redirects,
      status,
      location: redirects ? response.headers()['location'] : undefined
    };
  } catch {
    return { redirects: false, status: 0 };
  }
}

/**
 * Compare redirect behavior between old domain and new subdirectory
 */
export async function checkRedirectParity(
  oldUrl: string,
  site: SiteMapping,
  request: APIRequestContext
): Promise<RedirectParityResult> {
  // Build the expected new URL
  const expectedNewUrl = convertToNewUrl(oldUrl, site);

  // Get redirect chains for both
  const [oldChain, newChain] = await Promise.all([
    getRedirectChain(oldUrl, request),
    getRedirectChain(expectedNewUrl, request)
  ]);

  // Check parity
  let hasParity = true;
  let parityIssue: string | undefined;

  // If old URL redirects, new should also redirect
  if (oldChain.redirectCount > 0) {
    if (newChain.redirectCount === 0) {
      hasParity = false;
      parityIssue = 'Old URL redirects but new URL does not';
    } else {
      // Compare final destinations (paths should match)
      const oldFinalPath = extractPath(oldChain.finalUrl);
      const newFinalPath = extractPath(newChain.finalUrl);

      // Remove subdirectory prefix from new path for comparison
      const subdirPrefix = `/${site.subdirectoryPath}`;
      const normalizedNewPath = newFinalPath.startsWith(subdirPrefix)
        ? newFinalPath.slice(subdirPrefix.length) || '/'
        : newFinalPath;

      if (oldFinalPath !== normalizedNewPath) {
        hasParity = false;
        parityIssue = `Redirect destinations don't match: old → ${oldFinalPath}, new → ${normalizedNewPath}`;
      }

      // Check for temporary redirect issues
      if (REDIRECT_CONFIG.failOnTemporaryRedirect) {
        if (oldChain.allPermanent && !newChain.allPermanent) {
          hasParity = false;
          parityIssue = 'Old redirect is permanent but new redirect is temporary';
        }
      }

      // Check for chain length issues
      if (REDIRECT_CONFIG.failOnRedirectChain) {
        if (newChain.redirectCount > 1 && oldChain.redirectCount === 1) {
          hasParity = false;
          parityIssue = `New URL has redirect chain (${newChain.redirectCount} hops) while old had single redirect`;
        }
      }
    }
  } else {
    // Old URL doesn't redirect
    if (newChain.redirectCount > 0) {
      // This might be intentional - new site might add redirects
      // Don't fail, but note it
      parityIssue = 'New URL redirects but old URL did not (may be intentional)';
    }
  }

  return {
    oldUrl,
    expectedNewUrl,
    oldRedirect: oldChain.redirectCount > 0 ? oldChain : null,
    newRedirect: newChain.redirectCount > 0 ? newChain : null,
    hasParity,
    parityIssue
  };
}

/**
 * Detect common redirect patterns that should be tested
 * These are high-value pages that often have redirects
 */
export function getCommonRedirectPaths(): string[] {
  return [
    // Category and section pages (often consolidated)
    '/news',
    '/news/',
    '/local-news',
    '/local-news/',
    '/entertainment',
    '/entertainment/',
    '/sports',
    '/sports/',
    '/opinion',
    '/opinion/',
    '/life',
    '/life/',
    '/business',
    '/business/',

    // Common legacy paths that often redirect
    '/feed',
    '/rss',
    '/atom',
    '/sitemap',

    // Archive patterns
    '/archive',
    '/archives',

    // Section consolidations
    '/community',
    '/events',
    '/calendar',
    '/classifieds',
    '/obituaries',

    // Legacy URL patterns
    '/story',
    '/article'
  ];
}

/**
 * Sample URLs from old site to test for redirect parity
 */
export async function sampleUrlsForRedirectTesting(
  site: SiteMapping,
  request: APIRequestContext,
  sampleSize: number = REDIRECT_CONFIG.sampleSize
): Promise<string[]> {
  const urlsToTest: string[] = [];

  // Start with common redirect paths
  const commonPaths = getCommonRedirectPaths();
  for (const path of commonPaths) {
    urlsToTest.push(`${site.oldDomain}${path}`);
  }

  // Try to get additional URLs from sitemap
  try {
    const sitemapUrl = `${site.oldDomain}${site.sitemapPath || '/sitemap.xml'}`;
    const response = await request.get(sitemapUrl, {
      timeout: 30000,
      failOnStatusCode: false
    });

    if (response.ok()) {
      const body = await response.text();
      // Simple extraction of URLs from sitemap
      const urlMatches = body.match(/<loc>([^<]+)<\/loc>/g);
      if (urlMatches) {
        const urls = urlMatches
          .map(m => m.replace(/<\/?loc>/g, ''))
          .slice(0, sampleSize * 2); // Get extra for filtering

        urlsToTest.push(...urls);
      }
    }
  } catch {
    // Sitemap unavailable, continue with common paths
  }

  // Deduplicate and limit
  const unique = [...new Set(urlsToTest)];
  return unique.slice(0, sampleSize);
}

/**
 * Get a summary of redirect parity results
 */
export function getRedirectParitySummary(results: RedirectParityResult[]): {
  total: number;
  withParity: number;
  withoutParity: number;
  parityPercentage: number;
  issues: Array<{ url: string; issue: string }>;
} {
  const withParity = results.filter(r => r.hasParity).length;
  const withoutParity = results.filter(r => !r.hasParity).length;

  return {
    total: results.length,
    withParity,
    withoutParity,
    parityPercentage: results.length > 0 ? (withParity / results.length) * 100 : 100,
    issues: results
      .filter(r => !r.hasParity && r.parityIssue)
      .map(r => ({ url: r.oldUrl, issue: r.parityIssue! }))
  };
}

/**
 * Format redirect chain for display
 */
export function formatRedirectChain(chain: RedirectChain): string {
  if (chain.redirectCount === 0) {
    return `No redirects: ${chain.originalUrl}`;
  }

  const lines = [`Original: ${chain.originalUrl}`];

  for (let i = 0; i < chain.hops.length; i++) {
    const hop = chain.hops[i];
    const type = hop.isPermanent ? '301' : `${hop.statusCode}`;
    lines.push(`  ${i + 1}. [${type}] → ${hop.to}`);
  }

  lines.push(`Final: ${chain.finalUrl}`);

  if (chain.isTooLong) {
    lines.push('⚠️ Redirect chain exceeded maximum length');
  }

  return lines.join('\n');
}
