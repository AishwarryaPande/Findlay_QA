import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: [
    '**/broken-assets.spec.ts',
    '**/console-errors.spec.ts',
    '**/internal-links.spec.ts',
    '**/redirect-parity.spec.ts',
    '**/seo-checks.spec.ts',
    '**/single-site-qa.spec.ts',
    '**/sitemap-comparison.spec.ts',
    '**/subdirectory-availability.spec.ts'
  ],
  fullyParallel: true,
  timeout: 45_000,
  retries: 2,
  workers: 6,
  globalSetup: './tests/helpers/globalSetup.ts',
  globalTeardown: './tests/helpers/globalTeardown.ts',
  reporter: [['list']],
  use: {
    baseURL: 'https://findlayedu.wpenginepowered.com',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    ignoreHTTPSErrors: true
  },
  outputDir: 'test-results/',
  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1366, height: 768 }
      }
    },
    {
      name: 'chromium-tablet',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        viewport: { width: 1024, height: 768 }
      }
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        channel: 'chrome'
      }
    },
    {
      name: 'edge-desktop',
      use: {
        ...devices['Desktop Edge'],
        channel: 'msedge',
        viewport: { width: 1366, height: 768 }
      }
    },
    {
      name: 'firefox-desktop',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1366, height: 768 }
      }
    },
    {
      name: 'firefox-tablet',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1024, height: 768 }
      }
    },
    {
      name: 'firefox-mobile',
      use: {
        ...devices['Pixel 7']
      }
    },
    {
      name: 'webkit-desktop',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1366, height: 768 }
      }
    },
    {
      name: 'webkit-tablet',
      use: {
        ...devices['iPad (gen 7)']
      }
    },
    {
      name: 'webkit-mobile',
      use: {
        ...devices['iPhone 14']
      }
    }
  ]
});
