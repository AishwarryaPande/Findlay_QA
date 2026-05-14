import { expect, test } from '@playwright/test';
import { TEST_URLS } from '../config/urls';
import { viewportsForGroup } from '../config/viewports';
import {
  captureIssueScreenshot,
  checkButtons,
  checkForms,
  checkHorizontalOverflow,
  checkImages,
  checkLayout,
  checkNavigation,
  checkTextOverflow
} from './helpers/checks';
import { recordIssues, type Issue } from './helpers/reporter';

function projectGroup(projectName: string): 'desktop' | 'tablet' | 'mobile' {
  if (projectName.includes('mobile')) return 'mobile';
  if (projectName.includes('tablet')) return 'tablet';
  return 'desktop';
}

test.describe('Module 1 - Responsiveness QA', () => {
  for (const targetUrl of TEST_URLS) {
    test(`responsive checks :: ${targetUrl}`, async ({ page, browserName }, testInfo) => {
      test.setTimeout(120_000);
      const group = projectGroup(testInfo.project.name);
      const viewports = viewportsForGroup(group);
      const maxIssueScreenshots = Math.max(0, Number.parseInt(process.env.MAX_ISSUE_SCREENSHOTS ?? '1', 10) || 1);

      for (const viewport of viewports) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addStyleTag({ content: '*,:before,:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}' }).catch(() => {});

        const consoleErrors: string[] = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForTimeout(500);

        const issues: Issue[] = [];
        const status = response?.status() ?? 0;
        if (status >= 400) {
          issues.push({
            type: 'LAYOUT',
            severity: 'critical',
            message: `HTTP status ${status}`,
            browser: testInfo.project.name,
            viewport: viewport.label,
            url: targetUrl
          });
          recordIssues(issues);
          console.log(`❌ FAIL  [${testInfo.project.name}][${viewport.label}] ${new URL(targetUrl).pathname} — HTTP ${status}`);
          continue;
        }

        const title = await page.title();
        if (!title.trim()) {
          issues.push({
            type: 'LAYOUT',
            severity: 'warning',
            message: 'Page title is empty',
            browser: testInfo.project.name,
            viewport: viewport.label,
            url: targetUrl
          });
        }

        issues.push(...await checkHorizontalOverflow(page, viewport));
        issues.push(...await checkNavigation(page, viewport));

        await page.evaluate(async () => {
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((resolve) => setTimeout(resolve, 200));
          window.scrollTo(0, 0);
        });

        issues.push(...await checkImages(page));
        issues.push(...await checkTextOverflow(page, viewport));
        issues.push(...await checkButtons(page, viewport));
        issues.push(...await checkLayout(page));
        issues.push(...await checkForms(page, viewport));

        for (const errorText of consoleErrors) {
          issues.push({
            type: 'CONSOLE_ERROR',
            severity: 'warning',
            message: errorText,
            browser: testInfo.project.name,
            viewport: viewport.label,
            url: targetUrl
          });
        }

        let screenshotsCaptured = 0;
        for (const issue of issues) {
          issue.browser = testInfo.project.name;
          issue.viewport = viewport.label;
          issue.url = targetUrl;
          if (screenshotsCaptured < maxIssueScreenshots) {
            issue.screenshotPath = await captureIssueScreenshot(page, issue, testInfo.project.name);
            screenshotsCaptured += 1;
          }
        }

        recordIssues(issues);
        if (issues.some((i) => i.severity === 'critical')) {
          console.log(`❌ FAIL  [${testInfo.project.name}][${viewport.label}] ${new URL(targetUrl).pathname} — ${issues[0]?.message || 'critical issue'}`);
        } else if (issues.length > 0) {
          console.log(`⚠️  WARN  [${testInfo.project.name}][${viewport.label}] ${new URL(targetUrl).pathname} — ${issues[0]?.message}`);
        } else {
          console.log(`✅ PASS  [${testInfo.project.name}][${viewport.label}] ${new URL(targetUrl).pathname}`);
        }

        expect(status).toBeLessThan(500);
      }
    });
  }
});
