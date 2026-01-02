/**
 * Redirect Parity Tests
 *
 * MIGRATION CONTEXT:
 * Redirects are often configured on legacy sites for various reasons:
 * - URL restructuring
 * - Section consolidation
 * - SEO improvements
 *
 * After migration, these redirects must be preserved to:
 * - Maintain SEO value of old URLs
 * - Not break bookmarks and external links
 * - Preserve user experience
 *
 * WHAT THIS VALIDATES:
 * - Redirects on old domain have equivalent redirects on new subdirectory
 * - Redirect destinations match (path parity)
 * - Redirect types match (301 vs 302)
 * - No redirect chains introduced
 *
 * WHY THIS MATTERS:
 * Missing redirects mean broken links from external sources.
 * Wrong redirects mean users and search engines land on wrong pages.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, buildSiteUrls, NEW_BASE_URL } from '../config/sites.config';
import { REDIRECT_CONFIG } from '../config/test.config';
import {
  getRedirectChain,
  checkRedirectParity,
  sampleUrlsForRedirectTesting,
  getRedirectParitySummary,
  formatRedirectChain,
  getCommonRedirectPaths
} from '../src/utils/redirect-checker';
import { convertToNewUrl, extractPath } from '../src/utils/url-normalizer';
import { SiteMapping, RedirectParityResult } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('Redirect Parity', () => {
  // Redirect tests can be slower due to network calls
  test.setTimeout(120000); // 2 minutes per site

  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('common redirect paths have parity', async ({ request }) => {
        /**
         * WHY: Common paths like /entertainment, /sports, /news often have
         * redirects. These are high-traffic pages.
         */
        const commonPaths = getCommonRedirectPaths();
        const results: RedirectParityResult[] = [];

        console.log(`\n🔀 ${site.name} testing ${commonPaths.length} common paths for redirect parity`);

        for (const path of commonPaths.slice(0, 15)) { // Limit for speed
          const oldUrl = `${site.oldDomain}${path}`;
          const result = await checkRedirectParity(oldUrl, site, request);
          results.push(result);
        }

        const summary = getRedirectParitySummary(results);

        console.log(`  Tested: ${summary.total} paths`);
        console.log(`  With parity: ${summary.withParity}`);
        console.log(`  Without parity: ${summary.withoutParity}`);

        if (summary.issues.length > 0) {
          console.log(`\n  Issues found:`);
          summary.issues.slice(0, 5).forEach(i => {
            console.log(`    - ${i.url}: ${i.issue}`);
          });
        }

        // At least 80% should have parity
        expect(
          summary.parityPercentage,
          `Redirect parity is ${summary.parityPercentage.toFixed(1)}% (expected >80%)`
        ).toBeGreaterThanOrEqual(80);
      });

      test('homepage does not have unexpected redirect', async ({ request }) => {
        /**
         * WHY: Homepage should load directly without redirects.
         * Unexpected redirects indicate routing issues.
         */
        const chain = await getRedirectChain(urls.newHomepage, request);

        console.log(`  🏠 ${site.name} homepage redirect check`);

        if (chain.redirectCount > 0) {
          console.log(`  Redirect chain found:`);
          console.log(formatRedirectChain(chain).split('\n').map(l => `    ${l}`).join('\n'));
        }

        // Homepage should have minimal redirects (allow 1 for trailing slash normalization)
        expect(
          chain.redirectCount,
          `Homepage has ${chain.redirectCount} redirects:\n${formatRedirectChain(chain)}`
        ).toBeLessThanOrEqual(1);

        // If there is a redirect, it should stay within the subdirectory
        if (chain.redirectCount > 0) {
          const finalPath = extractPath(chain.finalUrl);
          expect(
            finalPath.startsWith(`/${site.subdirectoryPath}`),
            `Homepage redirects outside subdirectory: ${chain.finalUrl}`
          ).toBe(true);
        }
      });

      test('redirects use permanent status codes', async ({ request }) => {
        /**
         * WHY: Permanent (301) redirects pass SEO value.
         * Temporary (302/307) redirects don't consolidate ranking signals.
         */
        const commonPaths = getCommonRedirectPaths().slice(0, 10);
        const temporaryRedirects: Array<{ url: string; status: number }> = [];

        for (const path of commonPaths) {
          const newUrl = `${NEW_BASE_URL}/${site.subdirectoryPath}${path}`;
          const chain = await getRedirectChain(newUrl, request);

          // Check for temporary redirects
          chain.hops.forEach(hop => {
            if (!hop.isPermanent) {
              temporaryRedirects.push({ url: hop.from, status: hop.statusCode });
            }
          });
        }

        if (temporaryRedirects.length > 0) {
          console.log(`  ⚠️ ${site.name} temporary redirects found:`);
          temporaryRedirects.slice(0, 5).forEach(r => {
            console.log(`    - ${r.url} (${r.status})`);
          });
        }

        // Warn if temporary redirects exist, but don't fail
        // Some temporary redirects may be intentional
        if (REDIRECT_CONFIG.failOnTemporaryRedirect) {
          expect(
            temporaryRedirects.length,
            `Found ${temporaryRedirects.length} temporary redirects`
          ).toBe(0);
        }
      });

      test('no redirect chains exist', async ({ request }) => {
        /**
         * WHY: Redirect chains (A→B→C) waste resources and can hurt SEO.
         * After migration, redirects should go directly to destination.
         */
        const commonPaths = getCommonRedirectPaths().slice(0, 10);
        const chains: Array<{ path: string; chain: string[] }> = [];

        for (const path of commonPaths) {
          const newUrl = `${NEW_BASE_URL}/${site.subdirectoryPath}${path}`;
          const result = await getRedirectChain(newUrl, request);

          if (result.redirectCount > 1) {
            chains.push({
              path,
              chain: [result.originalUrl, ...result.hops.map(h => h.to)]
            });
          }
        }

        if (chains.length > 0) {
          console.log(`  ⚠️ ${site.name} redirect chains found:`);
          chains.slice(0, 3).forEach(c => {
            console.log(`    ${c.path}:`);
            c.chain.forEach((url, i) => console.log(`      ${i}. ${url}`));
          });
        }

        // Warn about chains but don't fail unless configured
        if (REDIRECT_CONFIG.failOnRedirectChain) {
          expect(
            chains.length,
            `Found ${chains.length} redirect chains`
          ).toBe(0);
        }
      });

      test('sample URLs maintain redirect behavior', async ({ request }) => {
        /**
         * WHY: Test a broader sample of URLs for redirect parity.
         * Catches issues beyond common paths.
         */
        const sampleUrls = await sampleUrlsForRedirectTesting(site, request, 20);

        console.log(`\n  📋 Testing ${sampleUrls.length} sampled URLs for redirect parity`);

        const results: RedirectParityResult[] = [];

        for (const url of sampleUrls) {
          const result = await checkRedirectParity(url, site, request);
          results.push(result);
        }

        const summary = getRedirectParitySummary(results);

        // Log results
        console.log(`  Total tested: ${summary.total}`);
        console.log(`  With parity: ${summary.withParity}`);
        console.log(`  Without parity: ${summary.withoutParity}`);

        // Show specific issues
        if (summary.issues.length > 0) {
          console.log(`\n  Parity issues:`);
          summary.issues.slice(0, 5).forEach(i => {
            console.log(`    - ${extractPath(i.url)}: ${i.issue}`);
          });
        }

        // 75% parity threshold for sample (more lenient than common paths)
        expect(
          summary.parityPercentage,
          `Redirect parity is ${summary.parityPercentage.toFixed(1)}% (expected >75%)`
        ).toBeGreaterThanOrEqual(75);
      });
    });
  }
});

test.describe('Redirect Summary', () => {
  test.setTimeout(300000); // 5 minutes for summary

  test('redirect health across all sites', async ({ request }) => {
    /**
     * WHY: Overview of redirect status for all sites.
     */
    console.log('\n📊 Redirect Health Summary:');
    console.log('─'.repeat(70));
    console.log(
      'Site'.padEnd(25) +
      'Tested'.padEnd(10) +
      'Parity'.padEnd(12) +
      'Chains'.padEnd(10) +
      'Status'
    );
    console.log('─'.repeat(70));

    for (const site of sites) {
      try {
        const commonPaths = getCommonRedirectPaths().slice(0, 10);
        const results: RedirectParityResult[] = [];
        let chainsCount = 0;

        for (const path of commonPaths) {
          const oldUrl = `${site.oldDomain}${path}`;
          const result = await checkRedirectParity(oldUrl, site, request);
          results.push(result);

          // Check for chains
          const newUrl = `${NEW_BASE_URL}/${site.subdirectoryPath}${path}`;
          const chain = await getRedirectChain(newUrl, request);
          if (chain.redirectCount > 1) chainsCount++;
        }

        const summary = getRedirectParitySummary(results);

        const statusIcon = summary.parityPercentage >= 90
          ? '✅'
          : summary.parityPercentage >= 75
          ? '⚠️'
          : '❌';

        console.log(
          site.name.padEnd(25) +
          String(summary.total).padEnd(10) +
          `${summary.parityPercentage.toFixed(0)}%`.padEnd(12) +
          String(chainsCount).padEnd(10) +
          statusIcon
        );
      } catch (error) {
        console.log(
          site.name.padEnd(25) +
          '-'.padEnd(10) +
          '-'.padEnd(12) +
          '-'.padEnd(10) +
          '❌ Error'
        );
      }
    }

    console.log('─'.repeat(70));
  });

  test('identify critical redirect issues', async ({ request }) => {
    /**
     * WHY: Highlight sites with redirect problems that need fixing.
     */
    const sitesWithIssues: Array<{
      site: string;
      issues: Array<{ path: string; issue: string }>;
    }> = [];

    for (const site of sites) {
      try {
        const commonPaths = getCommonRedirectPaths().slice(0, 10);
        const siteIssues: Array<{ path: string; issue: string }> = [];

        for (const path of commonPaths) {
          const oldUrl = `${site.oldDomain}${path}`;
          const result = await checkRedirectParity(oldUrl, site, request);

          if (!result.hasParity && result.parityIssue) {
            siteIssues.push({ path, issue: result.parityIssue });
          }
        }

        if (siteIssues.length > 0) {
          sitesWithIssues.push({ site: site.name, issues: siteIssues });
        }
      } catch {
        // Skip failed sites
      }
    }

    if (sitesWithIssues.length > 0) {
      console.log('\n⚠️ Sites with redirect parity issues:');
      console.log('─'.repeat(70));

      sitesWithIssues.forEach(s => {
        console.log(`\n${s.site} (${s.issues.length} issues):`);
        s.issues.slice(0, 5).forEach(i => {
          console.log(`  ${i.path}: ${i.issue}`);
        });
        if (s.issues.length > 5) {
          console.log(`  ... and ${s.issues.length - 5} more`);
        }
      });

      console.log('─'.repeat(70));
    } else {
      console.log('\n✅ No critical redirect parity issues found');
    }
  });
});
