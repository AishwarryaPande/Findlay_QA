/**
 * Sitemap Comparison Tests
 *
 * MIGRATION CONTEXT:
 * Sitemaps are critical for SEO and search engine discovery. After migration:
 * - All old URLs should have corresponding new URLs
 * - Sitemap should be accessible at new location
 * - URL count should be comparable (allowing for some variance)
 *
 * WHAT THIS VALIDATES:
 * - New sitemap is accessible
 * - URLs from old sitemap exist in new sitemap
 * - Migration percentage meets threshold
 * - No unexpected root-level URLs
 *
 * WHY THIS MATTERS:
 * If sitemap is broken or missing URLs, search engines won't index content
 * properly. This directly impacts organic traffic recovery after migration.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, buildSiteUrls } from '../config/sites.config';
import { SITEMAP_CONFIG } from '../config/test.config';
import {
  fetchAndParseSitemap,
  compareSitemaps,
  getSitemapComparisonSummary,
  validateSitemapAccessibility
} from '../src/utils/sitemap-parser';
import { SiteMapping } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('Sitemap Comparison', () => {
  // Sitemap tests can take longer due to fetching
  test.setTimeout(120000); // 2 minutes per site

  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('new sitemap is accessible', async ({ request }) => {
        /**
         * WHY: First check - can we even access the sitemap?
         * If not, no further sitemap validation is possible.
         */
        const result = await validateSitemapAccessibility(urls.newSitemap, request);

        console.log(`  📍 ${site.name} new sitemap: ${urls.newSitemap}`);
        console.log(`     Status: ${result.statusCode}`);

        expect(
          result.accessible,
          `Sitemap not accessible: ${urls.newSitemap} (HTTP ${result.statusCode}${result.error ? `, ${result.error}` : ''})`
        ).toBe(true);
      });

      test('new sitemap contains expected URLs', async ({ request }) => {
        /**
         * WHY: Verify the sitemap has content and is properly formatted.
         * Empty or malformed sitemaps break SEO.
         */
        const result = await fetchAndParseSitemap(urls.newSitemap, request);

        console.log(`  📄 ${site.name} sitemap parsed:`);
        console.log(`     URLs found: ${result.urls.length}`);
        console.log(`     Is index: ${result.isSitemapIndex}`);
        if (result.errors.length > 0) {
          console.log(`     Errors: ${result.errors.length}`);
        }

        // Should have some URLs
        expect(
          result.urls.length,
          `Sitemap should have at least ${SITEMAP_CONFIG.minimumExpectedUrls} URLs (got ${result.urls.length})`
        ).toBeGreaterThanOrEqual(SITEMAP_CONFIG.minimumExpectedUrls);

        // All URLs should be under the correct subdirectory
        const wrongPathUrls = result.urls.filter(u =>
          !u.loc.includes(`/${site.subdirectoryPath}/`) &&
          !u.loc.includes(`/${site.subdirectoryPath}?`)
        );

        expect(
          wrongPathUrls.length,
          `Found ${wrongPathUrls.length} URLs not in subdirectory /${site.subdirectoryPath}/:\n${wrongPathUrls.slice(0, 5).map(u => u.loc).join('\n')}`
        ).toBe(0);
      });

      test('old sitemap URLs are present in new sitemap', async ({ request }) => {
        /**
         * WHY: The core migration check - are old URLs properly migrated?
         * Missing URLs mean missing content in search results.
         */
        const comparison = await compareSitemaps(site, request);

        console.log(`\n📊 ${site.name} sitemap comparison:`);
        console.log(getSitemapComparisonSummary(comparison));

        // Check migration percentage
        expect(
          comparison.migrationPercentage,
          `Migration rate ${comparison.migrationPercentage.toFixed(1)}% is below threshold ${100 - SITEMAP_CONFIG.missingUrlFailureThreshold}%`
        ).toBeGreaterThanOrEqual(100 - SITEMAP_CONFIG.missingUrlFailureThreshold);

        // Check status
        if (comparison.status === 'fail') {
          throw new Error(comparison.message);
        }

        if (comparison.status === 'warning') {
          console.log(`  ⚠️ Warning: ${comparison.message}`);
        }
      });

      test('sitemap does not reference old domain', async ({ request }) => {
        /**
         * WHY: Sitemap URLs should point to new subdirectory, not old domain.
         * Old domain URLs in sitemap = broken sitemap.
         */
        const result = await fetchAndParseSitemap(urls.newSitemap, request);
        const oldDomainHost = new URL(site.oldDomain).hostname;

        const oldDomainUrls = result.urls.filter(u => {
          try {
            const host = new URL(u.loc).hostname;
            return host === oldDomainHost ||
                   host === oldDomainHost.replace('www.', '') ||
                   host === `www.${oldDomainHost.replace('www.', '')}`;
          } catch {
            return false;
          }
        });

        expect(
          oldDomainUrls.length,
          `Found ${oldDomainUrls.length} URLs pointing to old domain in sitemap:\n${oldDomainUrls.slice(0, 5).map(u => u.loc).join('\n')}`
        ).toBe(0);
      });

      test('sitemap URLs are accessible', async ({ request }) => {
        // Longer timeout for this test since it checks many URLs
        test.setTimeout(600000); // 10 minutes

        /**
         * WHY: Sitemap URLs should actually work.
         * Validates that listed pages can be reached.
         *
         * SAMPLING STRATEGY: 10% of URLs from each depth level
         * This ensures coverage across homepage, sections, and deep content.
         */
        const result = await fetchAndParseSitemap(urls.newSitemap, request);

        // Group URLs by path depth (after removing subdirectory prefix)
        const urlsByDepth: Map<number, string[]> = new Map();
        const subdirPrefix = `/${site.subdirectoryPath}`;

        for (const entry of result.urls) {
          try {
            const parsed = new URL(entry.loc);
            let path = parsed.pathname;

            // Remove subdirectory prefix to get the relative path
            if (path.startsWith(subdirPrefix)) {
              path = path.slice(subdirPrefix.length) || '/';
            }

            // Calculate depth: count path segments (excluding empty ones)
            const segments = path.split('/').filter(s => s.length > 0);
            const depth = segments.length;

            if (!urlsByDepth.has(depth)) {
              urlsByDepth.set(depth, []);
            }
            urlsByDepth.get(depth)!.push(entry.loc);
          } catch {
            // Skip malformed URLs
          }
        }

        // Sample 10% from each depth level
        const sampleUrls: string[] = [];
        const sampleRate = 0.10; // 10%

        const sortedDepths = [...urlsByDepth.keys()].sort((a, b) => a - b);
        console.log(`  📊 URL distribution by depth:`);

        for (const depth of sortedDepths) {
          const urlsAtDepth = urlsByDepth.get(depth)!;
          const sampleCount = Math.max(1, Math.ceil(urlsAtDepth.length * sampleRate));
          const sampled = urlsAtDepth.slice(0, sampleCount);
          sampleUrls.push(...sampled);
          console.log(`     Depth ${depth}: ${urlsAtDepth.length} URLs → sampling ${sampled.length} (${(sampleCount / urlsAtDepth.length * 100).toFixed(0)}%)`);
        }

        const brokenUrls: Array<{ url: string; status: number; depth: number }> = [];

        // Process URLs in parallel batches for speed
        const batchSize = 20;
        const totalBatches = Math.ceil(sampleUrls.length / batchSize);

        for (let i = 0; i < sampleUrls.length; i += batchSize) {
          const batch = sampleUrls.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;

          if (batchNum % 5 === 0 || batchNum === totalBatches) {
            console.log(`     Processing batch ${batchNum}/${totalBatches}...`);
          }

          const results = await Promise.all(
            batch.map(async (url) => {
              try {
                const response = await request.head(url, {
                  timeout: 10000,
                  failOnStatusCode: false
                });

                if (!response.ok()) {
                  // Calculate depth for reporting
                  const parsed = new URL(url);
                  let path = parsed.pathname;
                  if (path.startsWith(subdirPrefix)) {
                    path = path.slice(subdirPrefix.length) || '/';
                  }
                  const depth = path.split('/').filter(s => s.length > 0).length;
                  return { url, status: response.status(), depth, broken: true };
                }
                return { url, broken: false };
              } catch {
                return { url, status: 0, depth: -1, broken: true };
              }
            })
          );

          for (const result of results) {
            if (result.broken) {
              brokenUrls.push({ url: result.url, status: result.status || 0, depth: result.depth || -1 });
            }
          }
        }

        console.log(`  🔍 Checked ${sampleUrls.length} sitemap URLs (10% per depth): ${sampleUrls.length - brokenUrls.length} OK, ${brokenUrls.length} broken`);

        // Allow some broken URLs but fail if too many
        const brokenPercentage = (brokenUrls.length / sampleUrls.length) * 100;
        expect(
          brokenPercentage,
          `${brokenPercentage.toFixed(0)}% of sampled sitemap URLs are broken:\n${brokenUrls.map(b => `${b.url} (${b.status})`).join('\n')}`
        ).toBeLessThan(20); // Allow up to 20% broken in sample
      });
    });
  }
});

test.describe('Sitemap Summary', () => {
  test.setTimeout(300000); // 5 minutes for summary

  test('sitemap health across all sites', async ({ request }) => {
    /**
     * WHY: Overview of sitemap status for all sites.
     * Helps prioritize which sites need attention.
     */
    console.log('\n📊 Sitemap Health Summary:');
    console.log('─'.repeat(80));
    console.log(
      'Site'.padEnd(25) +
      'New Sitemap'.padEnd(15) +
      'Old URLs'.padEnd(12) +
      'New URLs'.padEnd(12) +
      'Migration %'
    );
    console.log('─'.repeat(80));

    for (const site of sites) {
      const siteUrls = buildSiteUrls(site);

      try {
        // Check accessibility first
        const accessibility = await validateSitemapAccessibility(siteUrls.newSitemap, request);

        if (!accessibility.accessible) {
          console.log(
            site.name.padEnd(25) +
            '❌ Not accessible'.padEnd(15) +
            '-'.padEnd(12) +
            '-'.padEnd(12) +
            '-'
          );
          continue;
        }

        // Compare sitemaps
        const comparison = await compareSitemaps(site, request);

        const statusIcon = comparison.status === 'pass'
          ? '✅'
          : comparison.status === 'warning'
          ? '⚠️'
          : '❌';

        console.log(
          site.name.padEnd(25) +
          `${statusIcon} OK`.padEnd(15) +
          String(comparison.oldUrlCount).padEnd(12) +
          String(comparison.newUrlCount).padEnd(12) +
          `${comparison.migrationPercentage.toFixed(1)}%`
        );
      } catch (error) {
        console.log(
          site.name.padEnd(25) +
          '❌ Error'.padEnd(15) +
          '-'.padEnd(12) +
          '-'.padEnd(12) +
          '-'
        );
      }
    }

    console.log('─'.repeat(80));
  });

  test('identify sites with significant URL loss', async ({ request }) => {
    /**
     * WHY: Highlight sites that need immediate attention.
     * Significant URL loss indicates migration problems.
     */
    const sitesWithIssues: Array<{
      site: string;
      oldCount: number;
      newCount: number;
      missingCount: number;
      percentage: number;
    }> = [];

    for (const site of sites) {
      try {
        const comparison = await compareSitemaps(site, request);

        if (comparison.migrationPercentage < 95) { // Flag if more than 5% missing
          sitesWithIssues.push({
            site: site.name,
            oldCount: comparison.oldUrlCount,
            newCount: comparison.newUrlCount,
            missingCount: comparison.missingUrls.length,
            percentage: comparison.migrationPercentage
          });
        }
      } catch {
        // Skip failed sites
      }
    }

    if (sitesWithIssues.length > 0) {
      console.log('\n⚠️ Sites with significant URL loss (>5% missing):');
      console.log('─'.repeat(70));

      sitesWithIssues
        .sort((a, b) => a.percentage - b.percentage)
        .forEach(s => {
          console.log(
            `${s.site}: ${s.missingCount} URLs missing ` +
            `(${s.oldCount} → ${s.newCount}, ${s.percentage.toFixed(1)}% migrated)`
          );
        });

      console.log('─'.repeat(70));
    } else {
      console.log('\n✅ All sites have >95% URL migration rate');
    }
  });
});
