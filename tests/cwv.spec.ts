import { test } from '@playwright/test';
import { TEST_URLS } from '../config/urls';
import { CROSS_BROWSER_VIEWPORTS } from '../config/viewports';
import { type CWVRating, rateMetric } from '../config/cwv-thresholds';
import { collectCWVMetrics, injectCWVObservers, scoreCWV, throttleCPU, throttleNetwork } from './helpers/cwv';
import { recordCWVResults, recordIssues, type CWVResult, type Issue } from './helpers/reporter';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregateRating(metrics: { lcp: number; fcp: number; cls: number; ttfb: number; tbt: number; inp: number }): CWVRating {
  const ratings: CWVRating[] = [
    rateMetric('LCP', metrics.lcp),
    rateMetric('FCP', metrics.fcp),
    rateMetric('CLS', metrics.cls),
    rateMetric('TTFB', metrics.ttfb),
    rateMetric('TBT', metrics.tbt),
    rateMetric('INP', metrics.inp)
  ];

  if (ratings.includes('poor')) return 'poor';
  if (ratings.includes('needs-improvement')) return 'needs-improvement';
  return 'good';
}

test.describe('Module 3 - Core Web Vitals', () => {
  for (const targetUrl of TEST_URLS) {
    test(`cwv checks :: ${targetUrl}`, async ({ page }, testInfo) => {
      const browserLabel = testInfo.project.name;

      for (const vp of CROSS_BROWSER_VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await injectCWVObservers(page);

        if (vp.group === 'mobile') {
          await throttleNetwork(page, 'mobile');
          await throttleCPU(page, 4);
        }

        const runs: CWVResult[] = [];

        for (let run = 1; run <= 3; run += 1) {
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45_000 });

          await page.mouse.move(120, 120);
          const firstInteractive = page.locator('a, button, input, [role="button"]').first();
          if (await firstInteractive.count()) {
            await firstInteractive.click({ timeout: 5000 }).catch(() => {});
          }

          await page.evaluate(async () => {
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise((resolve) => setTimeout(resolve, 300));
            window.scrollTo(0, 0);
          });

          const metrics = await collectCWVMetrics(page);
          runs.push({
            url: targetUrl,
            browser: browserLabel,
            viewport: vp.label,
            run,
            metrics,
            rating: aggregateRating(metrics)
          });
        }

        const medianMetrics = {
          lcp: median(runs.map((r) => r.metrics.lcp)),
          fcp: median(runs.map((r) => r.metrics.fcp)),
          cls: median(runs.map((r) => r.metrics.cls)),
          ttfb: median(runs.map((r) => r.metrics.ttfb)),
          tbt: median(runs.map((r) => r.metrics.tbt)),
          inp: median(runs.map((r) => r.metrics.inp)),
          speedIndex: median(runs.map((r) => r.metrics.speedIndex))
        };

        const ratings = scoreCWV({ ...medianMetrics });
        const cwvIssues: Issue[] = [];

        for (const [metric, rating] of Object.entries(ratings)) {
          if (rating === 'poor' || rating === 'needs-improvement') {
            const key = metric.toLowerCase() as keyof typeof medianMetrics;
            cwvIssues.push({
              type: `CWV_${metric}` as Issue['type'],
              severity: rating === 'poor' ? 'critical' : 'warning',
              message: `${metric} is ${rating}`,
              browser: browserLabel,
              viewport: vp.label,
              url: targetUrl,
              cwvMetric: metric,
              cwvValue: Number(medianMetrics[key]),
              cwvRating: rating
            });
          }
        }

        const medianResult: CWVResult = {
          url: targetUrl,
          browser: browserLabel,
          viewport: vp.label,
          run: 0,
          metrics: medianMetrics,
          rating: aggregateRating(medianMetrics)
        };

        recordCWVResults([medianResult]);
        recordIssues(cwvIssues);

        console.log(
          `📊 CWV   [${browserLabel}][${vp.group}] ${new URL(targetUrl).pathname} — LCP: ${(medianMetrics.lcp / 1000).toFixed(2)}s ${ratings.LCP === 'good' ? '✅' : '⚠️'}  CLS: ${medianMetrics.cls.toFixed(3)} ${ratings.CLS === 'good' ? '✅' : '⚠️'}  FCP: ${(medianMetrics.fcp / 1000).toFixed(2)}s ${ratings.FCP === 'good' ? '✅' : '⚠️'}`
        );
      }
    });
  }
});
