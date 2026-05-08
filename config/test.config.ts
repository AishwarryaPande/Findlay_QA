/**
 * Test Configuration - Thresholds and Limits
 *
 * MIGRATION CONTEXT:
 * These settings control test behavior to balance thoroughness with speed.
 * Adjust thresholds based on migration confidence requirements.
 *
 * SPEED OPTIMIZATION:
 * - Limits prevent test explosion on large sites
 * - Thresholds allow acceptable variance during migration
 */

import { TestConfig } from '../src/types';

export const TEST_CONFIG: TestConfig = {
  // =============================================================================
  // CRAWLING LIMITS
  // Controls depth-limited internal link validation
  // =============================================================================
  crawler: {
    // Maximum crawl depth (0 = homepage only, 2 = two levels deep)
    maxDepth: 2,

    // Maximum URLs to process per depth level
    // Prevents explosion on sites with many links
    maxUrlsPerDepth: {
      0: 1,
      1: 100,
      2: 250
    },

    // Maximum total URLs to crawl per site
    // Hard limit to prevent runaway tests
    maxTotalUrlsPerSite: 400,

    // Request timeout for individual page loads
    requestTimeout: 30000,

    // Delay between requests (ms) to avoid rate limiting
    requestDelay: 10,

    // Patterns to exclude from crawling
    // Avoid infinite pagination, archives, and low-value pages
    excludePatterns: [
      '/page/\\d+',           // Pagination
      '/\\d{4}/\\d{2}/',      // Date archives (e.g., /2023/01/)
      '/tag/',                 // Tag archives
      //'/category/',            // Category archives (crawl only first level)
      '/author/',              // Author archives
      '/search/',              // Search results
      '/feed/',                // RSS feeds
      '/wp-json/',             // REST API
      '/wp-admin/',            // Admin area
      '/wp-content/uploads/',  // Direct media file links
      '\\?s=',                 // Search query strings
      '\\?p=',                 // Preview links
      '#',                     // Anchor links (same page)
      '/comments/',            // Comment pages
      '/trackback/',           // Trackbacks
      '/attachment/',          // Attachment pages
      '/amp/',                 // AMP versions
      '/print/',               // Print versions
    ],

    // File extensions to skip (not HTML pages)
    skipExtensions: [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx',
      '.zip', '.rar', '.tar', '.gz',
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
      '.mp3', '.mp4', '.wav', '.avi', '.mov',
      '.css', '.js', '.json', '.xml'
    ]
  },

  // =============================================================================
  // SITEMAP COMPARISON THRESHOLDS
  // Controls when sitemap differences trigger warnings vs failures
  // =============================================================================
  sitemap: {
    // Percentage of missing URLs that triggers a WARNING (vs pass)
    missingUrlWarningThreshold: 1,

    // Percentage of missing URLs that triggers a FAILURE
    missingUrlFailureThreshold: 2,

    // Minimum number of URLs expected in migrated sitemap
    // Fails if new sitemap has fewer URLs than this
    minimumExpectedUrls: 10,

    // Maximum time (ms) to wait for sitemap fetch
    fetchTimeout: 60000,

    // Whether to follow sitemap index files
    followSitemapIndex: true,

    // Maximum number of URLs to compare per sitemap
    // Prevents memory issues on very large sitemaps
    maxUrlsToCompare: 5000
  },

  // =============================================================================
  // REDIRECT PARITY SETTINGS
  // Controls redirect validation behavior
  // =============================================================================
  redirects: {
    // Maximum redirects to follow before failing
    maxRedirectChain: 5,

    // Timeout for redirect checks (ms)
    timeout: 15000,

    // Sample size for redirect testing
    // Tests a random sample of redirected URLs from old site
    sampleSize: 50,

    // Whether to fail on redirect chain (multiple hops)
    failOnRedirectChain: false,

    // Whether to fail on temporary redirects (302/307)
    // Usually want permanent (301) for SEO
    failOnTemporaryRedirect: true
  },

  // =============================================================================
  // ASSET VALIDATION SETTINGS
  // Controls broken asset detection
  // =============================================================================
  assets: {
    // Timeout for asset requests (ms)
    timeout: 10000,

    // Whether to check external assets (images from other domains)
    checkExternalAssets: false,

    // Asset types to validate
    assetTypes: ['image', 'stylesheet', 'script', 'font'],

    // Maximum assets to check per page
    maxAssetsPerPage: 100,

    // Domains that should NEVER appear in asset URLs
    // These are the old domains being migrated FROM
    forbiddenAssetDomains: []
  },

  // =============================================================================
  // SEO VALIDATION SETTINGS
  // Controls SEO sanity check behavior
  // =============================================================================
  seo: {
    // Minimum title length to pass
    minTitleLength: 10,

    // Maximum title length before warning
    maxTitleLength: 70,

    // Whether to fail on missing canonical
    requireCanonical: true,

    // Whether to fail on noindex
    failOnNoindex: true,

    // Whether to fail on nofollow
    failOnNofollow: false,

    // Whether to require H1 tag
    requireH1: true,

    // Maximum H1 tags allowed (more than 1 is often problematic)
    maxH1Tags: 1
  },

  // =============================================================================
  // CONSOLE ERROR SETTINGS
  // Controls JavaScript error detection
  // =============================================================================
  console: {
    // Error levels to capture
    captureLevel: ['error', 'warning'],

    // Whether to fail on any console error
    failOnError: true,

    // Whether to fail on console warnings
    failOnWarning: false,

    // Patterns to ignore (known non-critical errors)
    ignorePatterns: [
      'favicon.ico',
      'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', // Ad blockers
      'ResizeObserver loop limit exceeded',
      'Non-passive event listener',
    ],

    // Whether to capture network failures as console errors
    captureNetworkFailures: true
  },

  // =============================================================================
  // PERFORMANCE SETTINGS
  // Global performance optimizations
  // =============================================================================
  performance: {
    // Number of concurrent requests for API-based tests
    concurrentRequests: 10,

    // Global request timeout
    defaultTimeout: 30000,

    // Retry configuration
    retries: {
      // Number of retry attempts
      attempts: 2,
      // Delay between retries (ms)
      delay: 1000,
      // Whether to use exponential backoff
      exponentialBackoff: true
    }
  }
};

// Export individual configs for convenience
export const CRAWLER_CONFIG = TEST_CONFIG.crawler;
export const SITEMAP_CONFIG = TEST_CONFIG.sitemap;
export const REDIRECT_CONFIG = TEST_CONFIG.redirects;
export const ASSET_CONFIG = TEST_CONFIG.assets;
export const SEO_CONFIG = TEST_CONFIG.seo;
export const CONSOLE_CONFIG = TEST_CONFIG.console;
export const PERFORMANCE_CONFIG = TEST_CONFIG.performance;
