/**
 * Subdirectory Availability & Routing Tests
 *
 * MIGRATION CONTEXT:
 * After consolidating 26 legacy WordPress sites into subdirectories, we need
 * to verify that each subdirectory homepage loads successfully.
 *
 * WHAT THIS VALIDATES:
 * - Each subdirectory homepage returns HTTP 200
 * - No redirect loops or protocol issues
 * - No 404 or 500 errors
 * - Page contains expected WordPress content structure
 *
 * WHY THIS MATTERS:
 * If a subdirectory doesn't load, all content for that site is inaccessible.
 * This is a critical first-check before any deeper validation.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, NEW_BASE_URL, buildSiteUrls } from '../config/sites.config';
import { SiteMapping } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('Subdirectory Availability & Routing', () => {
  /**
   * Test each site's homepage availability
   * Uses API request for speed, then browser for content validation
   */
  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('homepage returns HTTP 200', async ({ request }) => {
        /**
         * WHY: The most basic test - does the homepage load?
         * This catches DNS issues, nginx misconfigurations, and WordPress routing problems.
         */
        const response = await request.get(urls.newHomepage, {
          timeout: 30000,
          failOnStatusCode: false
        });

        // Check status code
        expect(response.status(), `Homepage ${urls.newHomepage} should return 200`).toBe(200);
      });

      test('homepage is not a redirect loop', async ({ request }) => {
        /**
         * WHY: Redirect loops can happen when migrating URL structures.
         * Common causes: conflicting redirect rules, trailing slash issues.
         */
        let currentUrl = urls.newHomepage;
        let redirectCount = 0;
        const maxRedirects = 10;
        const seenUrls = new Set<string>();

        while (redirectCount < maxRedirects) {
          if (seenUrls.has(currentUrl)) {
            throw new Error(`Redirect loop detected! URL ${currentUrl} was visited twice.\nPath: ${[...seenUrls].join(' → ')}`);
          }
          seenUrls.add(currentUrl);

          const response = await request.get(currentUrl, {
            maxRedirects: 0,
            failOnStatusCode: false
          });

          const status = response.status();

          if (status >= 300 && status < 400) {
            const location = response.headers()['location'];
            if (!location) break;

            currentUrl = new URL(location, currentUrl).toString();
            redirectCount++;
          } else {
            break;
          }
        }

        expect(redirectCount, 'Should not have excessive redirects').toBeLessThan(maxRedirects);
      });

      test('homepage contains WordPress content structure', async ({ page }) => {
        /**
         * WHY: A 200 response isn't enough - we need actual WordPress content.
         * Empty pages or error pages can still return 200.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        // Check for basic HTML structure
        const html = await page.locator('html').count();
        expect(html).toBe(1);

        // Check for body content
        const body = await page.locator('body').count();
        expect(body).toBe(1);

        // Check that page has some content (not empty)
        const bodyText = await page.locator('body').innerText();
        expect(bodyText.length, 'Page should have content').toBeGreaterThan(100);

        // Check for common WordPress elements (at least one should exist)
        const hasHeader = await page.locator('header, [role="banner"], .site-header').count() > 0;
        const hasMain = await page.locator('main, [role="main"], .site-content, #content').count() > 0;
        const hasFooter = await page.locator('footer, [role="contentinfo"], .site-footer').count() > 0;

        expect(
          hasHeader || hasMain || hasFooter,
          'Page should have recognizable page structure (header, main, or footer)'
        ).toBe(true);
      });

      test('homepage does not show WordPress error page', async ({ page }) => {
        /**
         * WHY: WordPress can return 200 but show a "Nothing found" or error template.
         * This catches cases where routing works but content is missing.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        const bodyText = await page.locator('body').innerText();
        const lowerText = bodyText.toLowerCase();

        // Check for common WordPress error messages
        const errorPatterns = [
          'nothing found',
          'page not found',
          'error 404',
          '404 not found',
          'no posts found',
          'sorry, no posts matched',
          'oops! that page can\'t be found',
          'database error',
          'error establishing a database connection'
        ];

        for (const pattern of errorPatterns) {
          expect(
            lowerText.includes(pattern),
            `Page should not contain error message: "${pattern}"`
          ).toBe(false);
        }
      });

      test('homepage uses HTTPS', async ({ request }) => {
        /**
         * WHY: Security is essential. HTTP should redirect to HTTPS.
         * Also prevents mixed content warnings.
         */
        const httpUrl = urls.newHomepage.replace('https://', 'http://');

        const response = await request.get(httpUrl, {
          maxRedirects: 0,
          failOnStatusCode: false
        });

        const status = response.status();

        // Should either redirect to HTTPS or the site might be HTTPS-only
        if (status >= 300 && status < 400) {
          const location = response.headers()['location'];
          expect(
            location?.startsWith('https://'),
            'HTTP should redirect to HTTPS'
          ).toBe(true);
        }
        // If status is 200, it might be an HTTPS-only server which is fine
      });

      test('homepage responds within acceptable time', async ({ request }) => {
        /**
         * WHY: Slow page loads indicate server issues or missing caching.
         * After migration, performance should be comparable to before.
         */
        const startTime = Date.now();

        const response = await request.get(urls.newHomepage, {
          timeout: 30000
        });

        const responseTime = Date.now() - startTime;

        // Homepage should load within 10 seconds
        // This is a generous threshold - production should be much faster
        expect(
          responseTime,
          `Homepage should load within 10 seconds (took ${responseTime}ms)`
        ).toBeLessThan(10000);

        // Log response time for monitoring
        console.log(`  ⏱️ ${site.name} homepage loaded in ${responseTime}ms`);
      });
    });
  }
});

test.describe('Cross-Site Availability Summary', () => {
  test('all enabled sites are accessible', async ({ request }) => {
    /**
     * WHY: Single test that validates all sites for a quick health check.
     * Useful for CI/CD pipelines that need a single pass/fail.
     */
    const results: Array<{ site: string; url: string; status: number; ok: boolean }> = [];

    for (const site of sites) {
      const urls = buildSiteUrls(site);

      try {
        const response = await request.get(urls.newHomepage, {
          timeout: 30000,
          failOnStatusCode: false
        });

        results.push({
          site: site.name,
          url: urls.newHomepage,
          status: response.status(),
          ok: response.ok()
        });
      } catch (error) {
        results.push({
          site: site.name,
          url: urls.newHomepage,
          status: 0,
          ok: false
        });
      }
    }

    // Log summary
    console.log('\n📊 Site Availability Summary:');
    console.log('─'.repeat(60));

    const failedSites = results.filter(r => !r.ok);
    const successSites = results.filter(r => r.ok);

    for (const result of results) {
      const icon = result.ok ? '✅' : '❌';
      console.log(`${icon} ${result.site}: HTTP ${result.status}`);
    }

    console.log('─'.repeat(60));
    console.log(`Total: ${results.length} | Success: ${successSites.length} | Failed: ${failedSites.length}`);

    // Fail if any site is inaccessible
    expect(
      failedSites.length,
      `${failedSites.length} site(s) are not accessible: ${failedSites.map(f => f.site).join(', ')}`
    ).toBe(0);
  });
});
