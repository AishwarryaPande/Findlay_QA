#!/usr/bin/env node

/**
 * Analyze Test Results
 *
 * This script parses the Playwright results.json to extract
 * internal link validation results and show regression vs pre-existing breakdown
 */

const fs = require('fs');
const path = require('path');

// Read the results.json file
const resultsPath = path.join(__dirname, '../reports/results.json');

if (!fs.existsSync(resultsPath)) {
  console.error('❌ No results.json file found. Run tests first.');
  process.exit(1);
}

console.log('📊 Analyzing test results...\n');

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

// Filter for internal-links tests
const internalLinkTests = results.suites
  .filter(suite => suite.file?.includes('internal-links.spec.ts'))
  .flatMap(suite => suite.suites || [])
  .flatMap(suite => suite.specs || []);

console.log(`Found ${internalLinkTests.length} internal link test specs\n`);

// Summary data
const summary = {
  totalTests: 0,
  passed: 0,
  failed: 0,
  regressions: [],
  preExisting: [],
  sitesWithIssues: new Set()
};

// Parse each test
for (const spec of internalLinkTests) {
  if (!spec.tests || spec.tests.length === 0) continue;

  for (const test of spec.tests) {
    summary.totalTests++;

    const result = test.results?.[0];
    if (!result) continue;

    if (result.status === 'passed') {
      summary.passed++;
    } else if (result.status === 'failed') {
      summary.failed++;

      // Extract error message
      const errorMessage = result.error?.message || '';

      // Try to extract site name from test title
      const siteMatch = spec.title?.match(/Site: (\w+)/);
      const siteName = siteMatch ? siteMatch[1] : 'unknown';

      // Check if it's about regressions or pre-existing
      if (errorMessage.includes('migration regressions')) {
        const urlMatches = errorMessage.match(/https?:\/\/[^\s)]+/g) || [];
        urlMatches.forEach(url => {
          summary.regressions.push({ site: siteName, url, test: spec.title });
          summary.sitesWithIssues.add(siteName);
        });
      }
    }
  }
}

// Display summary
console.log('═'.repeat(80));
console.log('INTERNAL LINK VALIDATION SUMMARY');
console.log('═'.repeat(80));
console.log(`\n📋 Test Statistics:`);
console.log(`   Total tests: ${summary.totalTests}`);
console.log(`   ✅ Passed: ${summary.passed}`);
console.log(`   ❌ Failed: ${summary.failed}`);
console.log(`\n🔍 Link Issues:`);
console.log(`   Migration regressions: ${summary.regressions.length}`);
console.log(`   Sites with issues: ${summary.sitesWithIssues.size}`);

if (summary.regressions.length > 0) {
  console.log(`\n⚠️  REGRESSIONS FOUND (${summary.regressions.length}):`);
  console.log('─'.repeat(80));

  // Group by site
  const bySite = {};
  summary.regressions.forEach(reg => {
    if (!bySite[reg.site]) bySite[reg.site] = [];
    bySite[reg.site].push(reg);
  });

  Object.keys(bySite).sort().forEach(site => {
    console.log(`\n${site}: ${bySite[site].length} regression(s)`);
    bySite[site].slice(0, 5).forEach(reg => {
      console.log(`  • ${reg.url}`);
    });
    if (bySite[site].length > 5) {
      console.log(`  ... and ${bySite[site].length - 5} more`);
    }
  });
} else {
  console.log(`\n✅ No migration regressions found!`);
}

console.log('\n' + '═'.repeat(80));

// Check for console output in stdout
console.log('\n💡 TIP: For detailed regression vs pre-existing breakdown,');
console.log('   check the console output in the terminal where you ran the tests.');
console.log('   Or look at the HTML report: npm run report\n');
