import type { Page } from '@playwright/test';
import { CWV_THRESHOLDS, rateMetric, type CWVRating } from '../../config/cwv-thresholds';

export interface CWVResult {
  lcp: number;
  fcp: number;
  cls: number;
  ttfb: number;
  tbt: number;
  inp: number;
  speedIndex: number;
  lcpElement?: string;
}

/**
 * Inject CWV observers before navigation.
 */
export async function injectCWVObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __qaErrors?: string[] }).__qaErrors = [];
    window.addEventListener('error', (event) => {
      const state = window as unknown as { __qaErrors?: string[] };
      state.__qaErrors = state.__qaErrors || [];
      state.__qaErrors.push(event.message || 'Unknown JS error');
    });

    (window as unknown as { __qaCWV?: Record<string, number | string> }).__qaCWV = {
      lcp: 0,
      cls: 0,
      fcp: 0,
      tbt: 0,
      inp: 0,
      lcpElement: ''
    };

    const state = window as unknown as { __qaCWV: Record<string, number | string> };

    new PerformanceObserver((entryList) => {
      const entries = entryList.getEntries();
      for (const entry of entries) {
        state.__qaCWV.lcp = Math.max(Number(state.__qaCWV.lcp || 0), entry.startTime);
        const target = (entry as PerformanceEntry & { element?: Element }).element;
        if (target) {
          state.__qaCWV.lcpElement = `${target.tagName.toLowerCase()}${(target as HTMLElement).id ? `#${(target as HTMLElement).id}` : ''}`;
        }
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });

    new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>) {
        if (!entry.hadRecentInput) {
          state.__qaCWV.cls = Number(state.__qaCWV.cls || 0) + Number(entry.value || 0);
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });

    new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          state.__qaCWV.fcp = Number(entry.startTime);
        }
      }
    }).observe({ type: 'paint', buffered: true });

    new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        const blocking = Math.max(0, entry.duration - 50);
        state.__qaCWV.tbt = Number(state.__qaCWV.tbt || 0) + blocking;
      }
    }).observe({ type: 'longtask', buffered: true });
  });
}

/**
 * Throttle network profile using CDP where available.
 */
export async function throttleNetwork(page: Page, profile: 'mobile' | 'desktop'): Promise<void> {
  const context = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<any> };
  if (!context.newCDPSession) return;

  const session = await context.newCDPSession(page);
  await session.send('Network.enable');

  if (profile === 'mobile') {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8
    });
  } else {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: (10 * 1024 * 1024) / 8,
      uploadThroughput: (5 * 1024 * 1024) / 8
    });
  }
}

/**
 * Throttle CPU using CDP where available.
 */
export async function throttleCPU(page: Page, factor: number): Promise<void> {
  const context = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<any> };
  if (!context.newCDPSession) return;

  const session = await context.newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: factor });
}

/**
 * Collect CWV metrics from browser runtime.
 */
export async function collectCWVMetrics(page: Page): Promise<CWVResult> {
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const state = (window as unknown as { __qaCWV?: Record<string, number | string> }).__qaCWV || {};

    const lcp = Number(state.lcp || 0);
    const fcp = Number(state.fcp || performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0);
    const cls = Number(state.cls || 0);
    const ttfb = nav ? nav.responseStart : 0;
    const tbt = Number(state.tbt || 0);
    const inp = Number(state.inp || 0);

    return {
      lcp,
      fcp,
      cls,
      ttfb,
      tbt,
      inp,
      speedIndex: (lcp + fcp) / 2,
      lcpElement: String(state.lcpElement || '')
    };
  });

  return metrics;
}

/**
 * Score CWV metrics into quality buckets.
 */
export function scoreCWV(metrics: CWVResult): Record<keyof typeof CWV_THRESHOLDS, CWVRating> {
  return {
    LCP: rateMetric('LCP', metrics.lcp),
    FCP: rateMetric('FCP', metrics.fcp),
    CLS: rateMetric('CLS', metrics.cls),
    TTFB: rateMetric('TTFB', metrics.ttfb),
    TBT: rateMetric('TBT', metrics.tbt),
    INP: rateMetric('INP', metrics.inp)
  };
}
