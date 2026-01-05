import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for WordPress Migration Testing
 *
 * OPTIMIZATION NOTES:
 * - Uses parallel workers for maximum speed
 * - Chromium-only for consistency (no cross-browser needed for migration testing)
 * - API requests preferred over browser where possible
 * - Configurable retry logic for network flakiness
 */

// Allow filtering to a single site via environment variable
const siteFilter = process.env.SITE_FILTER;

export default defineConfig({
  // Test directory
  testDir: './tests',

  // Run tests in parallel across files
  fullyParallel: true,

  // Fail the build on test.only in CI
  forbidOnly: !!process.env.CI,

  // Retry configuration:
  // - 2 retries in CI for network flakiness
  // - 1 retry locally for quick feedback
  retries: process.env.CI ? 2 : 1,

  // Parallel workers:
  // - CI: Use 4 workers to balance speed and resource usage
  // - Local: Use 6 workers for faster execution
  workers: process.env.CI ? 4 : 6,

  // Reporter configuration for stakeholder visibility
  reporter: [
    // Console output for immediate feedback
    ['list'],
    // HTML report for detailed investigation
    ['html', {
      outputFolder: 'reports/html',
      open: 'never' // Don't auto-open in CI
    }],
    // Allure report for advanced analytics and stakeholder dashboards
    ['allure-playwright', {
      resultsDir: 'reports/allure-results',
      detail: true,
      suiteTitle: true
    }],
    // JSON report for programmatic analysis
    ['json', {
      outputFile: 'reports/results.json'
    }],
    // JUnit for CI integration
    ['junit', {
      outputFile: 'reports/junit.xml'
    }]
  ],

  // Global timeout settings
  timeout: 60000, // 60 seconds per test
  expect: {
    timeout: 10000 // 10 seconds for assertions
  },

  // Shared settings for all projects
  use: {
    // Base URL for the new WordPress installation
    baseURL: 'https://cmg-northwest2.go-vip.net',

    // Collect trace on first retry for debugging
    trace: 'on-first-retry',

    // Screenshot on failure for investigation
    screenshot: 'only-on-failure',

    // Video only on retry to save resources
    video: 'on-first-retry',

    // Reduce flakiness with reasonable timeouts
    actionTimeout: 15000,
    navigationTimeout: 30000,

    // Accept all SSL certificates (useful for staging environments)
    ignoreHTTPSErrors: true,

    // Custom headers to identify test traffic
    extraHTTPHeaders: {
      'X-QA-Test': 'migration-validation',
      'User-Agent': 'Mozilla/5.0 (compatible; MigrationQABot/1.0; +https://qa-team.internal)'
    }
  },

  // Project configuration
  // Using single browser (Chromium) as this is migration testing, not cross-browser testing
  projects: [
    {
      name: 'migration-tests',
      use: {
        ...devices['Desktop Chrome'],
        // Viewport that captures most content
        viewport: { width: 1920, height: 1080 }
      },
      // Optional grep to filter by site name
      ...(siteFilter ? { grep: new RegExp(siteFilter, 'i') } : {})
    }
  ],

  // Output directory for test artifacts
  outputDir: 'reports/test-artifacts',

  // Global setup/teardown if needed
  // globalSetup: './src/global-setup.ts',
  // globalTeardown: './src/global-teardown.ts',
});
