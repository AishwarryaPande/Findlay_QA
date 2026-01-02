/**
 * JavaScript Console Error Detection Tests
 *
 * MIGRATION CONTEXT:
 * JavaScript errors can indicate:
 * - Missing or misconfigured plugins
 * - Broken integrations
 * - Path issues after migration
 * - API endpoint changes
 *
 * WHAT THIS VALIDATES:
 * - No uncaught JavaScript exceptions
 * - No critical network failures
 * - No blocked resource errors
 *
 * WHY THIS MATTERS:
 * Console errors break interactive features and may indicate deeper
 * configuration issues that need fixing post-migration.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, buildSiteUrls } from '../config/sites.config';
import { CONSOLE_CONFIG } from '../config/test.config';
import { ConsoleMessage, NetworkFailure } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('JavaScript Console Error Detection', () => {
  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('homepage has no critical JavaScript errors', async ({ page }) => {
        /**
         * WHY: Uncaught JS errors break page functionality.
         * Common causes: missing dependencies, wrong paths, API failures.
         */
        const consoleErrors: Array<{ type: string; text: string }> = [];
        const pageErrors: string[] = [];

        // Collect console errors
        page.on('console', msg => {
          if (msg.type() === 'error') {
            const text = msg.text();

            // Check if should be ignored
            const isIgnored = CONSOLE_CONFIG.ignorePatterns.some(pattern =>
              text.includes(pattern)
            );

            if (!isIgnored) {
              consoleErrors.push({ type: 'console.error', text });
            }
          }
        });

        // Collect uncaught exceptions
        page.on('pageerror', error => {
          const text = error.message || error.toString();

          const isIgnored = CONSOLE_CONFIG.ignorePatterns.some(pattern =>
            text.includes(pattern)
          );

          if (!isIgnored) {
            pageErrors.push(text);
          }
        });

        // Navigate to homepage
        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        // Wait a bit for any delayed JS execution
        await page.waitForTimeout(2000);

        // Log any errors found
        if (consoleErrors.length > 0 || pageErrors.length > 0) {
          console.log(`\n⚠️ ${site.name} console errors:`);
          consoleErrors.forEach(e => console.log(`  [console.error] ${e.text.slice(0, 200)}`));
          pageErrors.forEach(e => console.log(`  [uncaught] ${e.slice(0, 200)}`));
        }

        // Fail on uncaught exceptions (these are critical)
        expect(
          pageErrors.length,
          `Found ${pageErrors.length} uncaught JavaScript exceptions:\n${pageErrors.slice(0, 5).map(e => `  - ${e}`).join('\n')}`
        ).toBe(0);

        // Fail on console errors if configured to do so
        if (CONSOLE_CONFIG.failOnError) {
          expect(
            consoleErrors.length,
            `Found ${consoleErrors.length} console errors:\n${consoleErrors.slice(0, 5).map(e => `  - ${e.text}`).join('\n')}`
          ).toBe(0);
        }
      });

      test('homepage has no critical network failures', async ({ page }) => {
        /**
         * WHY: Failed network requests indicate missing resources or
         * misconfigured endpoints after migration.
         */
        const networkFailures: Array<{ url: string; type: string; error: string }> = [];

        page.on('requestfailed', request => {
          const url = request.url();
          const resourceType = request.resourceType();
          const error = request.failure()?.errorText || 'Unknown failure';

          // Skip certain resource types that might be blocked by browser
          if (['ping', 'preflight', 'cspviolationreport'].includes(resourceType)) {
            return;
          }

          // Skip if matches ignore pattern
          const isIgnored = CONSOLE_CONFIG.ignorePatterns.some(pattern =>
            url.includes(pattern) || error.includes(pattern)
          );

          if (!isIgnored) {
            networkFailures.push({ url, type: resourceType, error });
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        // Log network failures
        if (networkFailures.length > 0) {
          console.log(`\n⚠️ ${site.name} network failures:`);
          networkFailures.slice(0, 10).forEach(f =>
            console.log(`  [${f.type}] ${f.url.slice(0, 100)} - ${f.error}`)
          );
        }

        // Critical resource types that should not fail
        const criticalFailures = networkFailures.filter(f =>
          ['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(f.type)
        );

        expect(
          criticalFailures.length,
          `Found ${criticalFailures.length} critical network failures:\n${criticalFailures.slice(0, 10).map(f => `  - [${f.type}] ${f.url}`).join('\n')}`
        ).toBe(0);
      });

      test('no deprecated API warnings', async ({ page }) => {
        /**
         * WHY: Deprecated API warnings indicate code that may break in
         * future browser versions. Good to catch during migration.
         */
        const deprecationWarnings: string[] = [];

        page.on('console', msg => {
          if (msg.type() === 'warning') {
            const text = msg.text().toLowerCase();
            if (
              text.includes('deprecated') ||
              text.includes('will be removed') ||
              text.includes('no longer supported')
            ) {
              deprecationWarnings.push(msg.text());
            }
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        // Log warnings (informational, don't fail)
        if (deprecationWarnings.length > 0) {
          console.log(`\nℹ️ ${site.name} deprecation warnings:`);
          deprecationWarnings.slice(0, 5).forEach(w =>
            console.log(`  - ${w.slice(0, 200)}`)
          );
        }

        // Just log, don't fail (deprecation warnings are informational)
        // expect(deprecationWarnings.length).toBe(0);
      });

      test('no CORS errors', async ({ page }) => {
        /**
         * WHY: CORS errors indicate that API or asset domains haven't been
         * properly configured after migration.
         */
        const corsErrors: string[] = [];

        page.on('console', msg => {
          const text = msg.text();
          if (
            text.includes('CORS') ||
            text.includes('Cross-Origin') ||
            text.includes('blocked by CORS policy') ||
            text.includes('Access-Control-Allow-Origin')
          ) {
            corsErrors.push(text);
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        if (corsErrors.length > 0) {
          console.log(`\n⚠️ ${site.name} CORS errors:`);
          corsErrors.forEach(e => console.log(`  - ${e.slice(0, 200)}`));
        }

        expect(
          corsErrors.length,
          `Found ${corsErrors.length} CORS errors:\n${corsErrors.slice(0, 5).map(e => `  - ${e}`).join('\n')}`
        ).toBe(0);
      });

      test('no 404 errors for WordPress API endpoints', async ({ page }) => {
        /**
         * WHY: WordPress REST API endpoints are essential for many features.
         * 404s indicate routing issues in the new subdirectory structure.
         */
        const api404s: string[] = [];

        page.on('response', response => {
          const url = response.url();
          if (
            url.includes('/wp-json/') &&
            response.status() === 404
          ) {
            api404s.push(url);
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        if (api404s.length > 0) {
          console.log(`\n⚠️ ${site.name} WordPress API 404s:`);
          api404s.forEach(url => console.log(`  - ${url}`));
        }

        expect(
          api404s.length,
          `Found ${api404s.length} WordPress API 404 errors:\n${api404s.join('\n')}`
        ).toBe(0);
      });
    });
  }
});

test.describe('Console Error Summary', () => {
  test('aggregate console error check across all sites', async ({ page }) => {
    /**
     * WHY: Provides a quick overview of console health across all sites.
     * Useful for identifying patterns and priorities.
     */
    const summary: Array<{
      site: string;
      errors: number;
      warnings: number;
      networkFailures: number;
    }> = [];

    console.log('\n📊 Console Error Summary:');
    console.log('─'.repeat(60));

    for (const site of sites) {
      const siteUrls = buildSiteUrls(site);
      let errors = 0;
      let warnings = 0;
      let networkFailures = 0;

      page.on('console', msg => {
        if (msg.type() === 'error') errors++;
        if (msg.type() === 'warning') warnings++;
      });

      page.on('pageerror', () => errors++);
      page.on('requestfailed', () => networkFailures++);

      try {
        await page.goto(siteUrls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });
      } catch {
        errors++;
      }

      summary.push({ site: site.name, errors, warnings, networkFailures });

      const icon = errors === 0 ? '✅' : errors <= 2 ? '⚠️' : '❌';
      console.log(`${icon} ${site.name}: ${errors} errors, ${warnings} warnings, ${networkFailures} network failures`);

      // Reset listeners for next site
      page.removeAllListeners('console');
      page.removeAllListeners('pageerror');
      page.removeAllListeners('requestfailed');
    }

    console.log('─'.repeat(60));

    const totalErrors = summary.reduce((sum, s) => sum + s.errors, 0);
    const sitesWithErrors = summary.filter(s => s.errors > 0).length;

    console.log(`Total: ${totalErrors} errors across ${sitesWithErrors} sites`);

    // Individual tests handle specific failures
    // This is just a summary
  });
});
