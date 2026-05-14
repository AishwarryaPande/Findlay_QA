# Playwright QA Suite — Findlay WordPress

Playwright + TypeScript project for:
- responsiveness QA
- cross-browser consistency checks
- Core Web Vitals (CWV) measurement

## Quick Start

```bash
npm install
npx playwright install
npm test
```

## Focused runs

```bash
npm run test:responsive
npm run test:browsers
npm run test:cwv

npm run test:chrome
npm run test:firefox
npm run test:safari
npm run test:mobile
npm run test:desktop
```

## Generated outputs

- reports/qa-report.html
- reports/qa-report.json
- reports/cwv-report.json
- reports/summary.json
- reports/cwv-report.csv
- screenshots/
- test-results/

## Test Categories

### 1. Subdirectory Availability (`npm run test:availability`)
- Validates each subdirectory homepage loads (HTTP 200)
- Detects 404, 500, redirect loops, protocol issues
- Verifies WordPress content structure

### 2. Broken Assets (`npm run test:assets`)
- Detects broken `<img>` sources
- Identifies assets pointing to old domains
- Validates stylesheets and scripts load
- Checks for mixed content (HTTP on HTTPS)

### 3. Console Errors (`npm run test:console`)
- Captures uncaught JavaScript exceptions
- Detects critical network failures
- Identifies CORS errors
- Checks WordPress API endpoints

### 4. Internal Links (`npm run test:links`)
- Depth-limited crawl (up to depth 3)
- Detects 404 links
- Flags cross-subdirectory contamination
- Identifies links to old domains

### 5. SEO Checks (`npm run test:seo`)
- Validates `<title>` exists and is non-empty
- Checks canonical tag points to subdirectory URL
- Detects accidental noindex/nofollow
- Validates H1 presence

### 6. Sitemap Comparison (`npm run test:sitemap`)
- Fetches sitemaps from old and new domains
- Compares URL counts and paths
- Detects missing migrated URLs
- Configurable warning/failure thresholds

### 7. Redirect Parity (`npm run test:redirects`)
- Validates redirects are preserved after migration
- Checks redirect destination paths match
- Detects redirect chains
- Verifies permanent vs temporary redirects

## Configuration

### Adding a New Site

Edit `config/sites.config.ts`:

```typescript
{
  name: 'newsite',
  oldDomain: 'https://www.newsite.com',
  subdirectoryPath: 'newsite',
  sitemapPath: '/sitemap.xml',
  enabled: true,
  priority: 1
}
```

### Adjusting Thresholds

Edit `config/test.config.ts` to modify:
- Crawl depth and URL limits
- Sitemap comparison thresholds
- Redirect validation settings
- SEO requirements

## Running Tests

### All Sites in Parallel
```bash
npm test
```

### Single Site
```bash
# Using environment variable
SITE_FILTER=bainbridgereview npm test

# Using npm script
npm run test:single-site --site=bainbridgereview
```

### Specific Test File
```bash
npx playwright test tests/seo-checks.spec.ts
```

### With Debug Mode
```bash
npm run test:debug
```

### With Headed Browser
```bash
npm run test:headed
```

## Reports

After test runs, multiple report formats are available:

### Standard Reports
- **HTML Report**: `reports/html/index.html` (run `npm run report` to open)
- **JSON Report**: `reports/results.json`
- **JUnit Report**: `reports/junit.xml`

### Allure Reports (Recommended)

Allure provides advanced analytics, beautiful dashboards, and historical tracking - far superior to standard HTML reports for migration validation.

**Viewing Reports (Simple Workflow):**

```bash
# Step 1: Run your tests
npm test
# OR test a single site
npm run test:single-site --site=bellevuereporter

# Step 2: View the interactive Allure report
npm run allure:serve
```

The `allure:serve` command will:
1. Generate the report from test results
2. Start a local web server
3. Automatically open the report in your browser

**Alternative: Generate Static HTML Report**

If you need a static HTML report (for CI/CD or sharing):

```bash
# Generate HTML report to reports/allure-report/
npm run allure:generate

# Open the generated report
npm run allure:open
```

**Available Commands:**
- `npm run allure:serve` - Quick interactive report (recommended for local use)
- `npm run allure:generate` - Generate static HTML report
- `npm run allure:open` - Open previously generated static report
- `npm run allure:clean` - Delete all Allure data (results + reports)

**What You'll See in Allure:**
- **Overview Tab**: Pass/fail statistics, execution time, trends
- **Suites Tab**: Tests grouped by site (all 26 sites visible)
- **Graphs Tab**: Visual charts showing failure distribution
- **Timeline Tab**: Parallel execution visualization
- **Behaviors Tab**: Tests grouped by feature (availability, assets, SEO, etc.)
- **Packages Tab**: File structure view

**Key Features:**
- Screenshots, videos, and traces embedded inline for failures
- Click any failed test to see error details, stack traces, and attachments
- Filter by site name, test status, or category
- Historical trends (if you keep results between runs)
- Export capabilities for stakeholder reports

**Pro Tips:**
- Results are stored in `reports/allure-results/` (gitignored)
- Each test run adds to results - use `allure:clean` to start fresh
- For CI/CD, use `allure:generate` to create artifact-ready reports

## Interpreting Failures

### Availability Failures
- **HTTP 404**: Subdirectory doesn't exist or routing is broken
- **HTTP 500**: Server error, check WordPress logs
- **Redirect loop**: Conflicting redirect rules

### Asset Failures
- **Broken images**: Media not migrated, check uploads directory
- **Old domain assets**: Hardcoded URLs in content, need find/replace
- **Failed stylesheets**: Theme path issues

### Console Error Failures
- **Uncaught exceptions**: JavaScript compatibility issues
- **Network failures**: API endpoint changes
- **CORS errors**: Domain whitelist needs updating

### Link Failures
- **404 links**: Content not migrated or URL structure changed
- **Old domain links**: Internal links not updated
- **Cross-subdirectory**: Links going to wrong site section

### SEO Failures
- **Missing title**: Template issue
- **Wrong canonical**: Canonical still points to old domain
- **Noindex detected**: Accidental robots restriction

### Sitemap Failures
- **Missing URLs**: Content not migrated
- **Low migration percentage**: Bulk content issues
- **Old domain in sitemap**: Sitemap not regenerated

### Redirect Failures
- **No parity**: Redirect rules not migrated
- **Wrong destination**: Path mapping incorrect
- **Redirect chains**: Multiple hops, needs cleanup

## Architecture

```
qa-checks-post-migration/
├── config/
│   ├── sites.config.ts      # Site mappings (26 sites)
│   └── test.config.ts       # Thresholds and limits
├── src/
│   ├── types/               # TypeScript interfaces
│   ├── utils/               # Shared utilities
│   │   ├── url-normalizer.ts
│   │   ├── crawler.ts
│   │   ├── sitemap-parser.ts
│   │   └── redirect-checker.ts
│   └── fixtures/            # Playwright fixtures
├── tests/                   # Test files
└── reports/                 # Generated reports
```

## Performance Optimization

The suite is optimized for speed:
- Parallel test execution across sites
- API requests (not browser) where possible
- Configurable URL limits per depth level
- Smart exclusion of low-value pages (pagination, archives)
- Batched concurrent requests

## CI/CD Integration

The suite generates JUnit XML reports compatible with most CI systems:

```yaml
# GitHub Actions example
- name: Run Migration Tests
  run: npm test

- name: Upload Test Results
  uses: actions/upload-artifact@v3
  with:
    name: test-results
    path: reports/
```

## Troubleshooting

### Tests are slow
- Reduce `maxUrlsPerDepth` in `test.config.ts`
- Run single site with `SITE_FILTER`
- Increase `workers` in `playwright.config.ts`

### Flaky tests
- Increase timeouts in `playwright.config.ts`
- Check network stability
- Review `ignorePatterns` in console config

### Missing reports
- Ensure `reports/` directory exists
- Check for disk space
- Review Playwright output

## Contributing

1. Test changes locally with `npm test`
2. Ensure TypeScript compiles: `npm run typecheck`
3. Add new sites to `config/sites.config.ts`
4. Update thresholds in `config/test.config.ts` as needed

## License

Internal use only - not for distribution.
