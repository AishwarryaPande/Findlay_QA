/**
 * SEO Sanity Check Tests
 *
 * MIGRATION CONTEXT:
 * SEO elements are critical for search engine visibility. After migration:
 * - Canonical tags may point to wrong domain
 * - Titles may be missing or duplicated
 * - noindex may be accidentally applied
 * - H1 tags may be missing
 *
 * WHAT THIS VALIDATES:
 * - <title> exists and is non-empty
 * - Canonical tag exists and points to correct subdirectory
 * - No accidental noindex/nofollow directives
 * - H1 tag is present
 *
 * WHY THIS MATTERS:
 * Incorrect SEO elements can cause search engines to:
 * - Deindex pages
 * - Index wrong URLs
 * - Not crawl the site properly
 * This directly impacts organic traffic after migration.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, buildSiteUrls, NEW_BASE_URL } from '../config/sites.config';
import { SEO_CONFIG } from '../config/test.config';
import { SeoData, SeoIssue } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

/**
 * Extract SEO data from a page
 */
async function extractSeoData(page: any, expectedSubdirectory: string): Promise<SeoData> {
  return page.evaluate((subdirectory: string) => {
    // Get title
    const titleEl = document.querySelector('title');
    const title = titleEl?.textContent?.trim() || null;

    // Get meta description
    const metaDesc = document.querySelector('meta[name="description"]');
    const metaDescription = metaDesc?.getAttribute('content') || null;

    // Get canonical
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    const canonical = canonicalEl?.getAttribute('href') || null;

    // Check if canonical is correct
    const canonicalIsCorrect = canonical
      ? canonical.includes(`/${subdirectory}/`) || canonical.includes(`/${subdirectory}`)
      : false;

    // Get robots meta
    const robotsMeta = document.querySelector('meta[name="robots"]');
    const robotsContent = robotsMeta?.getAttribute('content')?.toLowerCase() || null;

    const hasNoindex = robotsContent?.includes('noindex') || false;
    const hasNofollow = robotsContent?.includes('nofollow') || false;

    // Get H1 tags
    const h1Elements = document.querySelectorAll('h1');
    const h1Tags = Array.from(h1Elements).map(h1 => h1.textContent?.trim() || '');

    return {
      url: window.location.href,
      title,
      titleLength: title?.length || 0,
      metaDescription,
      canonical,
      canonicalIsCorrect,
      hasNoindex,
      hasNofollow,
      h1Tags,
      h1Count: h1Tags.length,
      robotsMeta: robotsContent
    };
  }, expectedSubdirectory);
}

/**
 * Validate SEO data and return issues
 */
function validateSeoData(data: SeoData): SeoIssue[] {
  const issues: SeoIssue[] = [];

  // Title validation
  if (!data.title) {
    issues.push({
      type: 'error',
      code: 'MISSING_TITLE',
      message: 'Page is missing a <title> tag'
    });
  } else if (data.titleLength < SEO_CONFIG.minTitleLength) {
    issues.push({
      type: 'warning',
      code: 'SHORT_TITLE',
      message: `Title is too short (${data.titleLength} chars, minimum: ${SEO_CONFIG.minTitleLength})`,
      actual: data.title
    });
  } else if (data.titleLength > SEO_CONFIG.maxTitleLength) {
    issues.push({
      type: 'warning',
      code: 'LONG_TITLE',
      message: `Title is too long (${data.titleLength} chars, recommended max: ${SEO_CONFIG.maxTitleLength})`,
      actual: data.title
    });
  }

  // Canonical validation
  if (SEO_CONFIG.requireCanonical) {
    if (!data.canonical) {
      issues.push({
        type: 'error',
        code: 'MISSING_CANONICAL',
        message: 'Page is missing a canonical tag'
      });
    } else if (!data.canonicalIsCorrect) {
      issues.push({
        type: 'error',
        code: 'WRONG_CANONICAL',
        message: 'Canonical tag does not point to correct subdirectory URL',
        actual: data.canonical
      });
    }
  }

  // Noindex validation
  if (SEO_CONFIG.failOnNoindex && data.hasNoindex) {
    issues.push({
      type: 'error',
      code: 'HAS_NOINDEX',
      message: 'Page has noindex directive - will not be indexed by search engines',
      actual: data.robotsMeta || undefined
    });
  }

  // Nofollow validation
  if (SEO_CONFIG.failOnNofollow && data.hasNofollow) {
    issues.push({
      type: 'warning',
      code: 'HAS_NOFOLLOW',
      message: 'Page has nofollow directive - search engines will not follow links',
      actual: data.robotsMeta || undefined
    });
  }

  // H1 validation
  if (SEO_CONFIG.requireH1) {
    if (data.h1Count === 0) {
      issues.push({
        type: 'error',
        code: 'MISSING_H1',
        message: 'Page is missing an H1 tag'
      });
    } else if (data.h1Count > SEO_CONFIG.maxH1Tags) {
      issues.push({
        type: 'warning',
        code: 'MULTIPLE_H1',
        message: `Page has ${data.h1Count} H1 tags (recommended: ${SEO_CONFIG.maxH1Tags})`,
        actual: data.h1Tags.join(', ')
      });
    }
  }

  return issues;
}

test.describe('SEO Sanity Checks', () => {
  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('homepage has valid title tag', async ({ page }) => {
        /**
         * WHY: Title is the most important on-page SEO element.
         * It appears in search results and browser tabs.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const title = await page.title();

        // Title should exist
        expect(title, 'Page should have a title').toBeTruthy();

        // Title should not be empty
        expect(title.trim().length, 'Title should not be empty').toBeGreaterThan(0);

        // Title should be reasonable length
        expect(
          title.length,
          `Title should be at least ${SEO_CONFIG.minTitleLength} characters (got: "${title}")`
        ).toBeGreaterThanOrEqual(SEO_CONFIG.minTitleLength);

        // Title should not contain error messages
        const errorIndicators = ['404', 'error', 'not found', 'page not found'];
        const lowerTitle = title.toLowerCase();
        for (const indicator of errorIndicators) {
          expect(
            lowerTitle.includes(indicator),
            `Title should not contain "${indicator}": "${title}"`
          ).toBe(false);
        }

        console.log(`  📄 ${site.name} title: "${title.slice(0, 60)}${title.length > 60 ? '...' : ''}"`);
      });

      test('homepage has correct canonical tag', async ({ page }) => {
        /**
         * WHY: Canonical tags tell search engines which URL is authoritative.
         * Wrong canonical = wrong URL indexed = duplicate content issues.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const canonical = await page.evaluate(() => {
          const el = document.querySelector('link[rel="canonical"]');
          return el?.getAttribute('href') || null;
        });

        // Canonical should exist
        expect(canonical, 'Page should have a canonical tag').toBeTruthy();

        if (canonical) {
          // Canonical should be absolute URL
          expect(
            canonical.startsWith('http'),
            `Canonical should be absolute URL, got: "${canonical}"`
          ).toBe(true);

          // Canonical should point to new subdirectory, not old domain
          expect(
            canonical.includes(site.oldDomain.replace('https://', '').replace('http://', '')),
            `Canonical should not point to old domain: "${canonical}"`
          ).toBe(false);

          // Canonical should point to correct subdirectory
          expect(
            canonical.includes(`/${site.subdirectoryPath}`),
            `Canonical should include subdirectory "/${site.subdirectoryPath}": "${canonical}"`
          ).toBe(true);

          console.log(`  🔗 ${site.name} canonical: ${canonical}`);
        }
      });

      test('homepage does not have noindex directive', async ({ page }) => {
        /**
         * WHY: noindex prevents search engines from indexing the page.
         * Accidentally applied during migration = traffic loss.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        // Check meta robots
        const robotsMeta = await page.evaluate(() => {
          const meta = document.querySelector('meta[name="robots"]');
          return meta?.getAttribute('content')?.toLowerCase() || null;
        });

        if (robotsMeta) {
          expect(
            robotsMeta.includes('noindex'),
            `Homepage should not have noindex: robots="${robotsMeta}"`
          ).toBe(false);
        }

        // Check X-Robots-Tag header (less common but possible)
        // This would require checking response headers which we can do via request

        console.log(`  🤖 ${site.name} robots meta: ${robotsMeta || '(none)'}`);
      });

      test('homepage has H1 tag', async ({ page }) => {
        /**
         * WHY: H1 is the main heading and important for accessibility and SEO.
         * Should be present and match page content.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const h1Data = await page.evaluate(() => {
          const h1s = document.querySelectorAll('h1');
          return {
            count: h1s.length,
            texts: Array.from(h1s).map(h => h.textContent?.trim().slice(0, 100) || '')
          };
        });

        // Should have at least one H1
        expect(
          h1Data.count,
          'Homepage should have at least one H1 tag'
        ).toBeGreaterThanOrEqual(1);

        // Should not have too many H1s
        if (h1Data.count > SEO_CONFIG.maxH1Tags) {
          console.log(`  ⚠️ ${site.name} has ${h1Data.count} H1 tags (recommended: 1)`);
        }

        console.log(`  📰 ${site.name} H1: "${h1Data.texts[0] || '(empty)'}"`);
      });

      test('homepage has meta description', async ({ page }) => {
        /**
         * WHY: Meta description appears in search results.
         * Good descriptions improve click-through rate.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const metaDescription = await page.evaluate(() => {
          const meta = document.querySelector('meta[name="description"]');
          return meta?.getAttribute('content') || null;
        });

        // Meta description should exist
        expect(metaDescription, 'Page should have a meta description').toBeTruthy();

        if (metaDescription) {
          // Should not be too short
          expect(
            metaDescription.length,
            `Meta description should be at least 50 characters (got ${metaDescription.length})`
          ).toBeGreaterThanOrEqual(50);

          // Should not be too long
          if (metaDescription.length > 160) {
            console.log(`  ⚠️ ${site.name} meta description is long (${metaDescription.length} chars)`);
          }
        }

        console.log(`  📝 ${site.name} meta description: ${(metaDescription || '').slice(0, 80)}...`);
      });

      test('comprehensive SEO audit', async ({ page }) => {
        /**
         * WHY: Combined SEO check for a complete picture.
         * Validates all SEO elements together.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const seoData = await extractSeoData(page, site.subdirectoryPath);
        const issues = validateSeoData(seoData);

        // Log all issues
        if (issues.length > 0) {
          console.log(`\n📊 ${site.name} SEO issues:`);
          issues.forEach(issue => {
            const icon = issue.type === 'error' ? '❌' : '⚠️';
            console.log(`  ${icon} [${issue.code}] ${issue.message}`);
            if (issue.actual) {
              console.log(`     Actual: ${issue.actual}`);
            }
          });
        }

        // Fail only on errors, not warnings
        const errors = issues.filter(i => i.type === 'error');
        expect(
          errors.length,
          `Found ${errors.length} SEO errors:\n${errors.map(e => `  - ${e.message}`).join('\n')}`
        ).toBe(0);
      });
    });
  }
});

test.describe('SEO Summary', () => {
  test('SEO health check across all sites', async ({ page }) => {
    /**
     * WHY: Quick overview of SEO health for all sites.
     */
    console.log('\n📊 SEO Health Summary:');
    console.log('─'.repeat(70));
    console.log('Site'.padEnd(25) + 'Title'.padEnd(10) + 'Canonical'.padEnd(12) + 'H1'.padEnd(8) + 'Robots');
    console.log('─'.repeat(70));

    for (const site of sites) {
      const siteUrls = buildSiteUrls(site);

      try {
        await page.goto(siteUrls.newHomepage, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        const seoData = await extractSeoData(page, site.subdirectoryPath);

        const titleStatus = seoData.title ? '✅' : '❌';
        const canonicalStatus = seoData.canonical
          ? (seoData.canonicalIsCorrect ? '✅' : '⚠️ wrong')
          : '❌ missing';
        const h1Status = seoData.h1Count === 1
          ? '✅'
          : seoData.h1Count === 0
          ? '❌'
          : `⚠️ ${seoData.h1Count}`;
        const robotsStatus = seoData.hasNoindex
          ? '❌ noindex'
          : '✅';

        console.log(
          site.name.padEnd(25) +
          titleStatus.padEnd(10) +
          canonicalStatus.padEnd(12) +
          h1Status.padEnd(8) +
          robotsStatus
        );
      } catch (error) {
        console.log(site.name.padEnd(25) + '❌ Failed to load');
      }
    }

    console.log('─'.repeat(70));
  });
});
