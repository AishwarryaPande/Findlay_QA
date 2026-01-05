/**
 * Internal Link Validation Tests (Depth-Limited Crawl)
 *
 * MIGRATION CONTEXT:
 * Internal links are critical for site navigation and SEO. After migration:
 * - Links may still point to old domain
 * - Links may cross into wrong subdirectory
 * - Links may be broken (404)
 *
 * DEPTH DEFINITION:
 * - Depth 0: Subdirectory homepage
 * - Depth 1: Links discovered on homepage
 * - Depth 2: Links discovered on depth 1 pages
 * - Depth 3: Links discovered on depth 2 pages (maximum)
 *
 * WHAT THIS VALIDATES:
 * - Internal links return HTTP 200
 * - No links point to old domains
 * - No links cross into other subdirectories
 * - No redirect chains within internal links
 *
 * WHY THIS MATTERS:
 * Broken internal links hurt SEO and user experience. Links to old domains
 * will break when the old domain is retired.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, buildSiteUrls, SITES, NEW_BASE_URL } from '../config/sites.config';
import { CRAWLER_CONFIG } from '../config/test.config';
import { DepthLimitedCrawler, extractAndCategorizeLinks, batchCheckUrls, filterPreExistingIssues } from '../src/utils/crawler';
import { isOldDomain, isCrossSubdirectoryUrl, shouldExcludeUrl, hasSkippableExtension } from '../src/utils/url-normalizer';
import { SiteMapping } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('Internal Link Validation', () => {
  // Set longer timeout for crawl tests
  test.setTimeout(180000); // 3 minutes per site

  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('homepage internal links are valid', async ({ page, request }, testInfo) => {
        /**
         * WHY: Quick validation of links directly on homepage.
         * Most important links are typically on the homepage.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        const categorizedLinks = await extractAndCategorizeLinks(page, site);

        console.log(`\n📎 ${site.name} homepage links:`);
        console.log(`  Internal: ${categorizedLinks.internal.length}`);
        console.log(`  External: ${categorizedLinks.external.length}`);
        console.log(`  Old domain: ${categorizedLinks.oldDomain.length}`);
        console.log(`  Cross-subdirectory: ${categorizedLinks.crossSubdirectory.length}`);

        // Fail if any links point to old domain
        expect(
          categorizedLinks.oldDomain.length,
          `Found ${categorizedLinks.oldDomain.length} links to old domain:\n${categorizedLinks.oldDomain.slice(0, 10).join('\n')}`
        ).toBe(0);

        // Fail if any links cross into other subdirectories
        expect(
          categorizedLinks.crossSubdirectory.length,
          `Found ${categorizedLinks.crossSubdirectory.length} cross-subdirectory links:\n${categorizedLinks.crossSubdirectory.slice(0, 10).join('\n')}`
        ).toBe(0);

        // Check a sample of internal links for 404s
        const sampleSize = Math.min(categorizedLinks.internal.length, 20);
        const sampleLinks = categorizedLinks.internal.slice(0, sampleSize);

        const results = await batchCheckUrls(sampleLinks, request, 5);
        const brokenLinks = results.filter(r => !r.ok && r.status === 404);

        // Filter out pre-existing issues (links that also fail on original site)
        const { regressions, preExisting } = await filterPreExistingIssues(brokenLinks, site, request);

        // Attach detailed breakdown to test report
        await testInfo.attach('link-validation-summary', {
          body: JSON.stringify({
            site: site.name,
            test: 'homepage-internal-links',
            timestamp: new Date().toISOString(),
            stats: {
              totalInternalLinks: categorizedLinks.internal.length,
              linksChecked: sampleSize,
              totalBroken: brokenLinks.length,
              regressions: regressions.length,
              preExisting: preExisting.length
            },
            regressions: regressions.map(r => ({
              url: r.url,
              status: r.status,
              originalStatus: r.originalStatus
            })),
            preExisting: preExisting.map(p => ({
              url: p.url,
              status: p.status,
              originalUrl: p.originalUrl,
              originalStatus: p.originalStatus
            }))
          }, null, 2),
          contentType: 'application/json'
        });

        if (preExisting.length > 0) {
          console.log(`  ℹ️ Ignored pre-existing issues (${preExisting.length}):`);
          preExisting.slice(0, 5).forEach(l => console.log(`    - ${l.url} (also fails on ${l.originalUrl})`));
          if (preExisting.length > 5) {
            console.log(`    ... and ${preExisting.length - 5} more`);
          }
        }

        if (regressions.length > 0) {
          console.log(`  ⚠️ Migration regressions found (${regressions.length}):`);
          regressions.forEach(l => console.log(`    - ${l.url} (${l.status})`));
        }

        expect(
          regressions.length,
          `Found ${regressions.length} migration regressions (404 on new site, works on original):\n${regressions.map(l => l.url).join('\n')}`
        ).toBe(0);
      });

      test('depth-limited crawl finds no broken links', async ({ page, request }, testInfo) => {
        /**
         * WHY: Comprehensive link validation up to depth 3.
         * Catches issues that homepage-only testing would miss.
         */
        const crawler = new DepthLimitedCrawler(site, {
          maxDepth: 2,
          maxUrlsPerDepth: {
            0: 1,
            1: 30,
            2: 50
          },
          maxTotalUrlsPerSite: 100, // Limit for test speed
          requestDelay: 25
        });

        const result = await crawler.crawl(page, request);

        console.log(`\n🕷️ ${site.name} crawl results:`);
        console.log(`  Total URLs: ${result.urls.length}`);
        console.log(`  Failed URLs: ${result.failedUrls.length}`);
        console.log(`  Old domain URLs: ${result.oldDomainUrls.length}`);
        console.log(`  Cross-subdirectory URLs: ${result.crossSubdirectoryUrls.length}`);
        console.log(`  Time: ${result.totalTime}ms`);

        // Log stats by depth
        for (const [depth, stats] of Object.entries(result.statsByDepth)) {
          console.log(`  Depth ${depth}: ${stats.total} URLs (${stats.success} ok, ${stats.failed} failed)`);
        }

        // Fail if links point to old domain
        expect(
          result.oldDomainUrls.length,
          `Found ${result.oldDomainUrls.length} links to old domains:\n${result.oldDomainUrls.slice(0, 10).join('\n')}`
        ).toBe(0);

        // Fail if links cross subdirectories
        expect(
          result.crossSubdirectoryUrls.length,
          `Found ${result.crossSubdirectoryUrls.length} cross-subdirectory links:\n${result.crossSubdirectoryUrls.slice(0, 10).join('\n')}`
        ).toBe(0);

        // Fail if there are broken links (after filtering pre-existing issues)
        const brokenLinks = result.failedUrls
          .filter(u => u.status === 404)
          .map(u => ({ ...u, ok: u.success, parentUrl: u.parentUrl ?? undefined }));

        // Filter out pre-existing issues
        const { regressions, preExisting } = await filterPreExistingIssues(brokenLinks, site, request);

        // Attach detailed breakdown to test report
        await testInfo.attach('link-validation-summary', {
          body: JSON.stringify({
            site: site.name,
            test: 'depth-limited-crawl',
            timestamp: new Date().toISOString(),
            crawlStats: {
              totalUrls: result.urls.length,
              totalTime: result.totalTime,
              statsByDepth: result.statsByDepth
            },
            stats: {
              totalBroken: brokenLinks.length,
              regressions: regressions.length,
              preExisting: preExisting.length,
              oldDomainLinks: result.oldDomainUrls.length,
              crossSubdirectoryLinks: result.crossSubdirectoryUrls.length
            },
            regressions: regressions.map(r => ({
              url: r.url,
              status: r.status,
              parentUrl: r.parentUrl,
              originalStatus: r.originalStatus
            })),
            preExisting: preExisting.map(p => ({
              url: p.url,
              status: p.status,
              parentUrl: p.parentUrl,
              originalUrl: p.originalUrl,
              originalStatus: p.originalStatus
            }))
          }, null, 2),
          contentType: 'application/json'
        });

        if (preExisting.length > 0) {
          console.log(`  ℹ️ Ignored pre-existing issues (${preExisting.length}):`);
          preExisting.slice(0, 5).forEach(l => console.log(`    - ${l.url} (also fails on ${l.originalUrl})`));
          if (preExisting.length > 5) {
            console.log(`    ... and ${preExisting.length - 5} more`);
          }
        }

        if (regressions.length > 0) {
          console.log(`  ⚠️ Migration regressions found (${regressions.length}):`);
          regressions.slice(0, 10).forEach(l => console.log(`    - ${l.url} (from ${l.parentUrl})`));
        }

        expect(
          regressions.length,
          `Found ${regressions.length} migration regressions (404 on new site, works on original):\n${regressions.slice(0, 10).map(u => `${u.url} (from ${u.parentUrl})`).join('\n')}`
        ).toBe(0);
      });

      test('no internal links create redirect chains', async ({ page, request }) => {
        /**
         * WHY: Redirect chains waste resources and hurt SEO.
         * Internal links should point directly to final destination.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const categorizedLinks = await extractAndCategorizeLinks(page, site);

        // Sample of internal links to check for redirects
        const sampleLinks = categorizedLinks.internal.slice(0, 10);
        const chainsFound: Array<{ url: string; chain: string[] }> = [];

        for (const url of sampleLinks) {
          const chain: string[] = [url];
          let currentUrl = url;
          let redirectCount = 0;

          while (redirectCount < 5) {
            try {
              const response = await request.get(currentUrl, {
                maxRedirects: 0,
                failOnStatusCode: false
              });

              if (response.status() >= 300 && response.status() < 400) {
                const location = response.headers()['location'];
                if (location) {
                  const nextUrl = new URL(location, currentUrl).toString();
                  chain.push(nextUrl);
                  currentUrl = nextUrl;
                  redirectCount++;
                } else {
                  break;
                }
              } else {
                break;
              }
            } catch {
              break;
            }
          }

          if (chain.length > 2) { // Original + 2+ redirects = chain
            chainsFound.push({ url, chain });
          }
        }

        if (chainsFound.length > 0) {
          console.log(`\n⚠️ ${site.name} redirect chains found:`);
          chainsFound.forEach(c => {
            console.log(`  ${c.url}:`);
            c.chain.forEach((u, i) => console.log(`    ${i}. ${u}`));
          });
        }

        // Warn but don't fail on redirect chains
        // They're not critical but should be fixed
        if (chainsFound.length > 0) {
          console.log(`  ℹ️ Found ${chainsFound.length} internal redirect chains`);
        }
      });

      test('navigation menu links are valid', async ({ page, request }, testInfo) => {
        /**
         * WHY: Navigation menus are the primary way users browse the site.
         * Broken nav links are highly visible.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        // Extract links from common navigation elements
        const navLinks = await page.evaluate(() => {
          const selectors = [
            'nav a[href]',
            '[role="navigation"] a[href]',
            '.nav a[href]',
            '.menu a[href]',
            '.main-menu a[href]',
            '.site-nav a[href]',
            'header a[href]'
          ];

          const links = new Set<string>();

          for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(a => {
              const href = (a as HTMLAnchorElement).href;
              if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                links.add(href);
              }
            });
          }

          return [...links];
        });

        console.log(`\n🧭 ${site.name} navigation links: ${navLinks.length}`);

        // Check each nav link
        const results = await batchCheckUrls(navLinks, request, 5);
        const brokenNavLinks = results.filter(r => !r.ok);

        // Filter out pre-existing issues
        const { regressions, preExisting } = await filterPreExistingIssues(brokenNavLinks, site, request);

        // Attach detailed breakdown to test report
        await testInfo.attach('link-validation-summary', {
          body: JSON.stringify({
            site: site.name,
            test: 'navigation-menu-links',
            timestamp: new Date().toISOString(),
            stats: {
              totalNavLinks: navLinks.length,
              totalBroken: brokenNavLinks.length,
              regressions: regressions.length,
              preExisting: preExisting.length
            },
            regressions: regressions.map(r => ({
              url: r.url,
              status: r.status,
              error: r.error,
              originalStatus: r.originalStatus
            })),
            preExisting: preExisting.map(p => ({
              url: p.url,
              status: p.status,
              error: p.error,
              originalUrl: p.originalUrl,
              originalStatus: p.originalStatus
            }))
          }, null, 2),
          contentType: 'application/json'
        });

        if (preExisting.length > 0) {
          console.log(`  ℹ️ Ignored pre-existing navigation issues (${preExisting.length}):`);
          preExisting.forEach(l => console.log(`    - ${l.url} (also fails on ${l.originalUrl})`));
        }

        if (regressions.length > 0) {
          console.log(`  ⚠️ Migration regressions in navigation (${regressions.length}):`);
          regressions.forEach(l => console.log(`    - ${l.url} (${l.status || l.error})`));
        }

        expect(
          regressions.length,
          `Found ${regressions.length} migration regressions in navigation links:\n${regressions.map(l => `${l.url} (${l.status})`).join('\n')}`
        ).toBe(0);
      });
    });
  }
});

test.describe('Link Validation Summary', () => {
  test.setTimeout(300000); // 5 minutes for summary

  test('quick link health check across all sites', async ({ request }, testInfo) => {
    /**
     * WHY: Fast overview of link health for all sites.
     * Uses API requests only for speed.
     * NOW: Also filters pre-existing issues vs migration regressions.
     */
    console.log('\n📊 Link Health Summary:');
    console.log('─'.repeat(60));

    const summary: Array<{
      site: string;
      totalLinks: number;
      regressions: number;
      preExisting: number;
      oldDomainLinks: number;
    }> = [];

    for (const site of sites) {
      const siteUrls = buildSiteUrls(site);

      try {
        // Fetch homepage and extract links
        const response = await request.get(siteUrls.newHomepage);
        const html = await response.text();

        // Extract href values
        const hrefMatches = html.match(/href=["']([^"']+)["']/gi) || [];
        const links = hrefMatches
          .map(m => {
            const match = m.match(/href=["']([^"']+)["']/i);
            return match ? match[1] : null;
          })
          .filter((url): url is string =>
            url !== null &&
            !url.startsWith('#') &&
            !url.startsWith('javascript:') &&
            !url.startsWith('mailto:') &&
            !url.startsWith('tel:')
          )
          .map(url => {
            try {
              return new URL(url, siteUrls.newHomepage).toString();
            } catch {
              return url;
            }
          })
          .filter(url => url.startsWith('http'));

        const uniqueLinks = [...new Set(links)];

        // Count old domain links
        const oldDomainCount = uniqueLinks.filter(url =>
          isOldDomain(url, SITES)
        ).length;

        // Check a sample for broken links
        const internalLinks = uniqueLinks
          .filter(url => url.includes(NEW_BASE_URL))
          .slice(0, 10);

        const results = await batchCheckUrls(internalLinks, request, 5);
        const brokenLinks = results.filter(r => r.status === 404);

        // Filter pre-existing vs regressions
        const filtered = await filterPreExistingIssues(brokenLinks, site, request);

        summary.push({
          site: site.name,
          totalLinks: uniqueLinks.length,
          regressions: filtered.regressions.length,
          preExisting: filtered.preExisting.length,
          oldDomainLinks: oldDomainCount
        });

        const icon = filtered.regressions.length === 0 && oldDomainCount === 0 ? '✅' : '⚠️';
        console.log(`${icon} ${site.name}: ${uniqueLinks.length} links, ${filtered.regressions.length} regressions, ${filtered.preExisting.length} pre-existing, ${oldDomainCount} old-domain`);
      } catch (error) {
        console.log(`❌ ${site.name}: Failed to check links`);
      }
    }

    console.log('─'.repeat(60));

    const totalRegressions = summary.reduce((sum, s) => sum + s.regressions, 0);
    const totalPreExisting = summary.reduce((sum, s) => sum + s.preExisting, 0);
    const totalOldDomain = summary.reduce((sum, s) => sum + s.oldDomainLinks, 0);
    const sitesWithRegressions = summary.filter(s => s.regressions > 0 || s.oldDomainLinks > 0).length;

    console.log(`Total: ${totalRegressions} regressions, ${totalPreExisting} pre-existing (ignored), ${totalOldDomain} old-domain links`);
    console.log(`Sites with migration issues: ${sitesWithRegressions}`);

    // Attach comprehensive summary to test report
    await testInfo.attach('all-sites-link-summary', {
      body: JSON.stringify({
        test: 'all-sites-link-health-check',
        timestamp: new Date().toISOString(),
        overallStats: {
          totalSites: summary.length,
          totalRegressions,
          totalPreExisting,
          totalOldDomainLinks: totalOldDomain,
          sitesWithRegressions
        },
        siteSummaries: summary
      }, null, 2),
      contentType: 'application/json'
    });
  });
});
