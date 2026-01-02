/**
 * Reporter Utility
 *
 * MIGRATION CONTEXT:
 * Provides helper functions for generating consistent, readable output
 * in test reports. Helps stakeholders understand migration status at a glance.
 */

import { SiteMapping, SiteTestSummary, TestCategoryResult } from '../types';

/**
 * Format a site test summary for console output
 */
export function formatSiteSummary(summary: SiteTestSummary): string {
  const lines: string[] = [];

  const statusIcon = summary.overallStatus === 'pass'
    ? '✅'
    : summary.overallStatus === 'partial'
    ? '⚠️'
    : '❌';

  lines.push(`${statusIcon} ${summary.siteName} (/${summary.subdirectory}/)`);
  lines.push(`   Execution time: ${summary.executionTime}ms`);
  lines.push('');

  const categories = Object.entries(summary.results);
  for (const [name, result] of categories) {
    const catIcon = result.status === 'pass'
      ? '✅'
      : result.status === 'warning'
      ? '⚠️'
      : result.status === 'fail'
      ? '❌'
      : '⏭️';

    lines.push(`   ${catIcon} ${name}: ${result.checksPerformed} checks, ${result.failures} failures`);

    if (result.findings.length > 0) {
      result.findings.slice(0, 3).forEach(finding => {
        lines.push(`      - ${finding}`);
      });
    }
  }

  return lines.join('\n');
}

/**
 * Generate a table summary for multiple sites
 */
export function generateSitesTable(summaries: SiteTestSummary[]): string {
  const lines: string[] = [];

  // Header
  lines.push('─'.repeat(80));
  lines.push(
    'Site'.padEnd(25) +
    'Availability'.padEnd(12) +
    'Assets'.padEnd(10) +
    'SEO'.padEnd(8) +
    'Links'.padEnd(8) +
    'Sitemap'.padEnd(10) +
    'Overall'
  );
  lines.push('─'.repeat(80));

  // Data rows
  for (const summary of summaries) {
    const getStatusIcon = (status: string) => {
      switch (status) {
        case 'pass': return '✅';
        case 'warning': return '⚠️';
        case 'fail': return '❌';
        case 'skipped': return '⏭️';
        default: return '?';
      }
    };

    lines.push(
      summary.siteName.padEnd(25) +
      getStatusIcon(summary.results.availability.status).padEnd(12) +
      getStatusIcon(summary.results.assets.status).padEnd(10) +
      getStatusIcon(summary.results.seo.status).padEnd(8) +
      getStatusIcon(summary.results.internalLinks.status).padEnd(8) +
      getStatusIcon(summary.results.sitemap.status).padEnd(10) +
      getStatusIcon(summary.overallStatus)
    );
  }

  lines.push('─'.repeat(80));

  // Summary
  const passed = summaries.filter(s => s.overallStatus === 'pass').length;
  const partial = summaries.filter(s => s.overallStatus === 'partial').length;
  const failed = summaries.filter(s => s.overallStatus === 'fail').length;

  lines.push(`Total: ${summaries.length} sites | ✅ ${passed} passed | ⚠️ ${partial} warnings | ❌ ${failed} failed`);

  return lines.join('\n');
}

/**
 * Generate JSON report data
 */
export function generateJsonReport(summaries: SiteTestSummary[]): object {
  return {
    timestamp: new Date().toISOString(),
    totalSites: summaries.length,
    passed: summaries.filter(s => s.overallStatus === 'pass').length,
    warnings: summaries.filter(s => s.overallStatus === 'partial').length,
    failed: summaries.filter(s => s.overallStatus === 'fail').length,
    sites: summaries.map(s => ({
      name: s.siteName,
      subdirectory: s.subdirectory,
      status: s.overallStatus,
      executionTime: s.executionTime,
      results: s.results
    }))
  };
}

/**
 * Format a URL list for display (truncated if too long)
 */
export function formatUrlList(urls: string[], maxShow = 5): string {
  if (urls.length === 0) return '(none)';

  const shown = urls.slice(0, maxShow);
  const lines = shown.map(url => `  - ${url}`);

  if (urls.length > maxShow) {
    lines.push(`  ... and ${urls.length - maxShow} more`);
  }

  return lines.join('\n');
}

/**
 * Format a percentage with color context
 */
export function formatPercentage(value: number, thresholds: { warning: number; fail: number }): string {
  const formatted = `${value.toFixed(1)}%`;

  if (value >= thresholds.warning) {
    return `✅ ${formatted}`;
  } else if (value >= thresholds.fail) {
    return `⚠️ ${formatted}`;
  } else {
    return `❌ ${formatted}`;
  }
}

/**
 * Format time duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Create a progress bar string
 */
export function progressBar(current: number, total: number, width = 20): string {
  const percentage = total > 0 ? current / total : 0;
  const filled = Math.round(width * percentage);
  const empty = width - filled;

  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${current}/${total}`;
}

/**
 * Log with timestamp
 */
export function logWithTimestamp(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Create a category result object
 */
export function createCategoryResult(
  category: string,
  checksPerformed: number,
  failures: number,
  warnings: number,
  findings: string[]
): TestCategoryResult {
  let status: 'pass' | 'warning' | 'fail' | 'skipped';

  if (failures > 0) {
    status = 'fail';
  } else if (warnings > 0) {
    status = 'warning';
  } else if (checksPerformed === 0) {
    status = 'skipped';
  } else {
    status = 'pass';
  }

  return {
    category,
    status,
    checksPerformed,
    failures,
    warnings,
    findings
  };
}
