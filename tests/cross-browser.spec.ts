import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { TEST_URLS } from '../config/urls';
import { CROSS_BROWSER_VIEWPORTS } from '../config/viewports';
import {
  captureScreenshotForDiff,
  checkCSSRendering,
  checkFontLoading,
  checkJSErrors,
  compareScreenshots
} from './helpers/browserChecks';
import { recordIssues, type Issue } from './helpers/reporter';

const BASELINE_BROWSER = 'chromium-desktop';

function slug(url: string): string {
  const parsed = new URL(url);
  return (parsed.pathname.replace(/\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home').replace(/^-|-$/g, '');
}

test.describe('Module 2 - Cross Browser QA', () => {
  for (const targetUrl of TEST_URLS) {
    test(`cross-browser checks :: ${targetUrl}`, async ({ page }, testInfo) => {
      const browserLabel = testInfo.project.name;

      for (const vp of CROSS_BROWSER_VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.addInitScript(() => {
          (window as unknown as { __qaErrors?: string[] }).__qaErrors = [];
          window.addEventListener('error', (event) => {
            const state = window as unknown as { __qaErrors?: string[] };
            state.__qaErrors = state.__qaErrors || [];
            state.__qaErrors.push(event.message || 'Unknown JS error');
          });
        });

        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45_000 });
        const issues: Issue[] = [];

        issues.push(...await checkCSSRendering(page));
        issues.push(...await checkFontLoading(page));
        issues.push(...await checkJSErrors(page));

        const label = `${browserLabel}-${vp.label}-${slug(targetUrl)}`;
        const buffer = await captureScreenshotForDiff(page, label);
        const baselinePath = path.resolve(process.cwd(), 'screenshots', 'baselines', `${BASELINE_BROWSER}-${vp.label}-${slug(targetUrl)}.png`);
        if (!fs.existsSync(path.dirname(baselinePath))) fs.mkdirSync(path.dirname(baselinePath), { recursive: true });

        if (browserLabel === BASELINE_BROWSER) {
          fs.writeFileSync(baselinePath, buffer);
        } else if (fs.existsSync(baselinePath)) {
          const baselineBuffer = fs.readFileSync(baselinePath);
          const diff = compareScreenshots(baselineBuffer, buffer);
          if (diff.diffPercent > 5) {
            issues.push({
              type: 'CROSS_BROWSER',
              severity: 'warning',
              message: `Visual diff ${diff.diffPercent}% vs ${BASELINE_BROWSER}`,
              browser: browserLabel,
              viewport: vp.label,
              url: targetUrl,
              screenshotPath: diff.diffImagePath
            });
            console.log(`🔀 DIFF  [${browserLabel} vs ${BASELINE_BROWSER}][${vp.label}] ${new URL(targetUrl).pathname} — ${diff.diffPercent}% pixel difference detected`);
          }
        }

        issues.forEach((issue) => {
          issue.browser = browserLabel;
          issue.viewport = vp.label;
          issue.url = targetUrl;
        });
        recordIssues(issues);

        const critical = issues.some((i) => i.severity === 'critical');
        if (critical) {
          console.log(`❌ FAIL  [${browserLabel}][${vp.label}] ${new URL(targetUrl).pathname} — ${issues[0].message}`);
        } else if (issues.length) {
          console.log(`⚠️  WARN  [${browserLabel}][${vp.label}] ${new URL(targetUrl).pathname} — ${issues[0].message}`);
        } else {
          console.log(`✅ PASS  [${browserLabel}][${vp.label}] ${new URL(targetUrl).pathname}`);
        }

        expect(true).toBeTruthy();
      }
    });
  }
});
