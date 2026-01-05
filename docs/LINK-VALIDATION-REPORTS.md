# Link Validation Reports Guide

## Overview

The internal link validation tests now distinguish between **migration regressions** (new issues) and **pre-existing issues** (problems that also exist on the original site).

## What's Included

### Test Attachments

Each internal link test now generates a JSON attachment with detailed breakdown:

- **Homepage Internal Links** - Sample validation of homepage links
- **Depth-Limited Crawl** - Comprehensive crawl up to depth 3
- **Navigation Menu Links** - Critical navigation validation
- **All Sites Summary** - Quick health check across all 26 sites

### Attachment Content

Each attachment contains:

```json
{
  "site": "courierherald",
  "test": "depth-limited-crawl",
  "timestamp": "2026-01-02T...",
  "stats": {
    "totalBroken": 10,
    "regressions": 2,      // ⚠️ THESE ARE THE ISSUES TO FIX
    "preExisting": 8       // ℹ️ These are ignored (also broken on original)
  },
  "regressions": [
    {
      "url": "https://cmg-northwest2.go-vip.net/courierherald/some-page/",
      "status": 404,
      "parentUrl": "...",
      "originalStatus": 200  // Works on original but fails on migrated
    }
  ],
  "preExisting": [
    {
      "url": "https://cmg-northwest2.go-vip.net/courierherald/vacation-hold/",
      "status": 404,
      "originalUrl": "https://www.courierherald.com/vacation-hold/",
      "originalStatus": 404  // Also fails on original site
    }
  ]
}
```

## How to Access Reports

### 1. HTML Report

```bash
npm run report
```

Then navigate to a test and click on **"Attachments"** to download the JSON files.

### 2. Allure Report

```bash
npm run allure:generate
npm run allure:open
```

Attachments appear as downloadable files in the test details.

### 3. Direct File Access

Attachments are saved in:
```
reports/test-artifacts/<test-id>/link-validation-summary-<hash>.json
```

## Understanding the Results

### ✅ **Test Passes**
- All broken links are pre-existing (also fail on original site)
- OR no broken links found at all

### ❌ **Test Fails**
- One or more links work on original but fail on migrated (regressions)
- These need to be fixed before deployment

### Key Metrics

- **Regressions**: Links broken by migration → **ACTION REQUIRED**
- **Pre-existing**: Links already broken on original → **CAN BE IGNORED**
- **Old Domain Links**: Links still pointing to old domains → **MUST FIX**
- **Cross-subdirectory**: Links crossing into other sites → **MUST FIX**

## Example Workflow

1. **Run tests**:
   ```bash
   npm run test:links
   ```

2. **Check console output** for quick summary:
   ```
   ✅ courierherald: 0 regressions, 3 pre-existing
   ⚠️ heraldnet: 2 regressions, 5 pre-existing
   ```

3. **Open HTML report** for details:
   ```bash
   npm run report
   ```

4. **Download attachments** for specific sites with issues

5. **Fix only the regressions** (ignore pre-existing)

## Analyzing From Previous Run

If you've already run tests and want to extract the data:

```bash
node scripts/analyze-test-results.js
```

This will parse `reports/results.json` and show summary statistics.

## Tips

- Focus on **regressions** - these are migration-introduced issues
- **Pre-existing issues** can be reported separately to content team
- Use the JSON attachments for programmatic analysis or stakeholder reports
- The "All Sites Summary" attachment gives a complete overview
