export const CWV_THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 },
  FCP: { good: 1800, poor: 3000 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 800, poor: 1800 },
  TBT: { good: 200, poor: 600 },
  INP: { good: 200, poor: 500 }
} as const;

export type CWVMetricName = keyof typeof CWV_THRESHOLDS;
export type CWVRating = 'good' | 'needs-improvement' | 'poor';

export function rateMetric(metric: CWVMetricName, value: number): CWVRating {
  const threshold = CWV_THRESHOLDS[metric];
  if (value <= threshold.good) return 'good';
  if (value <= threshold.poor) return 'needs-improvement';
  return 'poor';
}
