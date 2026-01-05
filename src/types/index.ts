/**
 * TypeScript Type Definitions
 *
 * Central type definitions for the migration testing framework.
 * These types ensure consistency across all test files and utilities.
 */

// =============================================================================
// SITE CONFIGURATION TYPES
// =============================================================================

/**
 * Represents a single site mapping from old domain to new subdirectory
 */
export interface SiteMapping {
  /** Human-readable site name (used in test names and filtering) */
  name: string;

  /** Legacy domain URL (without trailing slash) */
  oldDomain: string;

  /** New subdirectory path (without leading/trailing slashes) */
  subdirectoryPath: string;

  /** Path to sitemap relative to domain root (defaults to /sitemap.xml) */
  sitemapPath?: string;

  /** Path to OLD site sitemap (overrides sitemapPath for old site, useful when old/new use different sitemap plugins) */
  oldSitemapPath?: string;

  /** Path to NEW site sitemap (overrides sitemapPath for new site, useful when old/new use different sitemap plugins) */
  newSitemapPath?: string;

  /** Whether this site is included in test runs */
  enabled: boolean;

  /** Test execution priority (higher = run first) */
  priority?: number;

  /** Optional site-specific configuration overrides */
  overrides?: Partial<TestConfig>;
}

/**
 * Complete test configuration
 */
export interface TestConfig {
  crawler: CrawlerConfig;
  sitemap: SitemapConfig;
  redirects: RedirectConfig;
  assets: AssetConfig;
  seo: SeoConfig;
  console: ConsoleConfig;
  performance: PerformanceConfig;
}

// =============================================================================
// CRAWLER TYPES
// =============================================================================

export interface CrawlerConfig {
  maxDepth: number;
  maxUrlsPerDepth: Record<number, number>;
  maxTotalUrlsPerSite: number;
  requestTimeout: number;
  requestDelay: number;
  excludePatterns: string[];
  skipExtensions: string[];
}

/**
 * Represents a crawled URL with its metadata
 */
export interface CrawledUrl {
  /** The URL that was crawled */
  url: string;

  /** Depth level (0 = homepage) */
  depth: number;

  /** URL that linked to this page */
  parentUrl: string | null;

  /** HTTP status code */
  status: number;

  /** Whether the page loaded successfully */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Response time in milliseconds */
  responseTime?: number;

  /** Content type header */
  contentType?: string;
}

/**
 * Result of a crawl operation
 */
export interface CrawlResult {
  /** Site that was crawled */
  site: SiteMapping;

  /** All URLs discovered and processed */
  urls: CrawledUrl[];

  /** URLs that failed to load */
  failedUrls: CrawledUrl[];

  /** URLs that point to old domains (contamination) */
  oldDomainUrls: string[];

  /** URLs that cross into other subdirectories */
  crossSubdirectoryUrls: string[];

  /** Total time taken to crawl */
  totalTime: number;

  /** Statistics by depth level */
  statsByDepth: Record<number, {
    total: number;
    success: number;
    failed: number;
  }>;
}

// =============================================================================
// SITEMAP TYPES
// =============================================================================

export interface SitemapConfig {
  missingUrlWarningThreshold: number;
  missingUrlFailureThreshold: number;
  minimumExpectedUrls: number;
  fetchTimeout: number;
  followSitemapIndex: boolean;
  maxUrlsToCompare: number;
}

/**
 * Parsed sitemap entry
 */
export interface SitemapEntry {
  /** URL location */
  loc: string;

  /** Last modification date */
  lastmod?: string;

  /** Change frequency */
  changefreq?: string;

  /** Priority */
  priority?: string;
}

/**
 * Result of sitemap parsing
 */
export interface SitemapParseResult {
  /** Source URL of the sitemap */
  sourceUrl: string;

  /** All URLs found in sitemap(s) */
  urls: SitemapEntry[];

  /** Whether this was a sitemap index */
  isSitemapIndex: boolean;

  /** Child sitemaps if this was an index */
  childSitemaps?: string[];

  /** Parsing errors if any */
  errors: string[];

  /** Parse time in milliseconds */
  parseTime: number;
}

/**
 * Result of sitemap comparison
 */
export interface SitemapComparisonResult {
  /** Site being compared */
  site: SiteMapping;

  /** Number of URLs in old sitemap */
  oldUrlCount: number;

  /** Number of URLs in new sitemap */
  newUrlCount: number;

  /** URLs present in old but missing in new */
  missingUrls: string[];

  /** URLs present in new but not in old (new content) */
  extraUrls: string[];

  /** URLs that match between old and new */
  matchingUrls: string[];

  /** Percentage of URLs successfully migrated */
  migrationPercentage: number;

  /** Overall comparison status */
  status: 'pass' | 'warning' | 'fail';

  /** Status message */
  message: string;
}

// =============================================================================
// REDIRECT TYPES
// =============================================================================

export interface RedirectConfig {
  maxRedirectChain: number;
  timeout: number;
  sampleSize: number;
  failOnRedirectChain: boolean;
  failOnTemporaryRedirect: boolean;
}

/**
 * Represents a single redirect hop
 */
export interface RedirectHop {
  /** Source URL */
  from: string;

  /** Destination URL */
  to: string;

  /** HTTP status code (301, 302, 307, 308) */
  statusCode: number;

  /** Whether this is a permanent redirect */
  isPermanent: boolean;
}

/**
 * Full redirect chain result
 */
export interface RedirectChain {
  /** Original URL */
  originalUrl: string;

  /** Final destination URL */
  finalUrl: string;

  /** All redirect hops */
  hops: RedirectHop[];

  /** Total number of redirects */
  redirectCount: number;

  /** Whether redirect chain is too long */
  isTooLong: boolean;

  /** Whether all redirects are permanent */
  allPermanent: boolean;
}

/**
 * Result of redirect parity comparison
 */
export interface RedirectParityResult {
  /** Original old domain URL */
  oldUrl: string;

  /** Expected new subdirectory URL */
  expectedNewUrl: string;

  /** Redirect chain on old domain */
  oldRedirect: RedirectChain | null;

  /** Redirect chain on new subdirectory */
  newRedirect: RedirectChain | null;

  /** Whether redirects match (parity) */
  hasParity: boolean;

  /** Explanation of mismatch if any */
  parityIssue?: string;
}

// =============================================================================
// ASSET TYPES
// =============================================================================

export interface AssetConfig {
  timeout: number;
  checkExternalAssets: boolean;
  assetTypes: string[];
  maxAssetsPerPage: number;
  forbiddenAssetDomains: string[];
}

/**
 * Detected asset on a page
 */
export interface PageAsset {
  /** Asset URL */
  url: string;

  /** Asset type (image, script, stylesheet, font) */
  type: 'image' | 'script' | 'stylesheet' | 'font' | 'other';

  /** HTML element that references this asset */
  element: string;

  /** HTTP status code when fetched */
  status?: number;

  /** Whether asset loaded successfully */
  loaded: boolean;

  /** Error message if failed */
  error?: string;

  /** Whether asset points to forbidden domain */
  isForbiddenDomain: boolean;
}

/**
 * Result of asset validation for a page
 */
export interface AssetValidationResult {
  /** Page URL that was checked */
  pageUrl: string;

  /** All assets found on page */
  assets: PageAsset[];

  /** Broken assets (failed to load) */
  brokenAssets: PageAsset[];

  /** Assets pointing to old/forbidden domains */
  forbiddenDomainAssets: PageAsset[];

  /** Overall validation status */
  status: 'pass' | 'fail';
}

// =============================================================================
// SEO TYPES
// =============================================================================

export interface SeoConfig {
  minTitleLength: number;
  maxTitleLength: number;
  requireCanonical: boolean;
  failOnNoindex: boolean;
  failOnNofollow: boolean;
  requireH1: boolean;
  maxH1Tags: number;
}

/**
 * SEO data extracted from a page
 */
export interface SeoData {
  /** Page URL */
  url: string;

  /** Title tag content */
  title: string | null;

  /** Title length */
  titleLength: number;

  /** Meta description content */
  metaDescription: string | null;

  /** Canonical URL */
  canonical: string | null;

  /** Whether canonical points to correct subdirectory */
  canonicalIsCorrect: boolean;

  /** Whether page has noindex directive */
  hasNoindex: boolean;

  /** Whether page has nofollow directive */
  hasNofollow: boolean;

  /** All H1 tags on page */
  h1Tags: string[];

  /** Number of H1 tags */
  h1Count: number;

  /** Robots meta content */
  robotsMeta: string | null;
}

/**
 * Result of SEO validation
 */
export interface SeoValidationResult {
  /** Page URL */
  url: string;

  /** Extracted SEO data */
  data: SeoData;

  /** List of SEO issues found */
  issues: SeoIssue[];

  /** Overall validation status */
  status: 'pass' | 'warning' | 'fail';
}

/**
 * Individual SEO issue
 */
export interface SeoIssue {
  /** Issue type */
  type: 'error' | 'warning';

  /** Issue code for categorization */
  code: string;

  /** Human-readable message */
  message: string;

  /** Actual value that caused the issue */
  actual?: string;

  /** Expected value */
  expected?: string;
}

// =============================================================================
// CONSOLE ERROR TYPES
// =============================================================================

export interface ConsoleConfig {
  captureLevel: string[];
  failOnError: boolean;
  failOnWarning: boolean;
  ignorePatterns: string[];
  captureNetworkFailures: boolean;
}

/**
 * Captured console message
 */
export interface ConsoleMessage {
  /** Message type (error, warning, log, etc.) */
  type: string;

  /** Message text */
  text: string;

  /** URL where message was logged */
  url: string;

  /** Whether this message should fail the test */
  isCritical: boolean;

  /** Whether message matches ignore pattern */
  isIgnored: boolean;
}

/**
 * Result of console error capture
 */
export interface ConsoleErrorResult {
  /** Page URL */
  pageUrl: string;

  /** All captured messages */
  messages: ConsoleMessage[];

  /** Critical errors that should fail tests */
  criticalErrors: ConsoleMessage[];

  /** Warnings (may or may not fail) */
  warnings: ConsoleMessage[];

  /** Network failures captured */
  networkFailures: NetworkFailure[];

  /** Overall status */
  status: 'pass' | 'fail';
}

/**
 * Network request failure
 */
export interface NetworkFailure {
  /** Requested URL */
  url: string;

  /** Resource type */
  resourceType: string;

  /** Failure reason */
  reason: string;

  /** HTTP status if available */
  status?: number;
}

// =============================================================================
// PERFORMANCE TYPES
// =============================================================================

export interface PerformanceConfig {
  concurrentRequests: number;
  defaultTimeout: number;
  retries: {
    attempts: number;
    delay: number;
    exponentialBackoff: boolean;
  };
}

// =============================================================================
// REPORT TYPES
// =============================================================================

/**
 * Summary of test results for a site
 */
export interface SiteTestSummary {
  /** Site name */
  siteName: string;

  /** Subdirectory path */
  subdirectory: string;

  /** Test categories and their results */
  results: {
    availability: TestCategoryResult;
    assets: TestCategoryResult;
    consoleErrors: TestCategoryResult;
    internalLinks: TestCategoryResult;
    seo: TestCategoryResult;
    sitemap: TestCategoryResult;
    redirects: TestCategoryResult;
  };

  /** Overall status */
  overallStatus: 'pass' | 'partial' | 'fail';

  /** Execution time */
  executionTime: number;
}

/**
 * Result for a test category
 */
export interface TestCategoryResult {
  /** Category name */
  category: string;

  /** Status */
  status: 'pass' | 'warning' | 'fail' | 'skipped';

  /** Number of checks performed */
  checksPerformed: number;

  /** Number of failures */
  failures: number;

  /** Number of warnings */
  warnings: number;

  /** Key findings */
  findings: string[];
}
