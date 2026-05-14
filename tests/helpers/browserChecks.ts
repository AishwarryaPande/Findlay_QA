import fs from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import type { Issue } from './reporter';

/**
 * Capture screenshot buffer for visual diffing.
 */
export async function captureScreenshotForDiff(page: Page, label: string): Promise<Buffer> {
  const dir = path.resolve(process.cwd(), 'screenshots', 'diff-source');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${label}.png`);
  const buffer = await page.screenshot({ fullPage: true, path: filePath });
  return buffer;
}

/**
 * Compare two screenshots and save diff image.
 */
export function compareScreenshots(bufferA: Buffer, bufferB: Buffer): { diffPercent: number; diffImagePath: string } {
  const imgA = PNG.sync.read(bufferA);
  const imgB = PNG.sync.read(bufferB);

  const width = Math.min(imgA.width, imgB.width);
  const height = Math.min(imgA.height, imgB.height);

  const resizedA = new PNG({ width, height });
  const resizedB = new PNG({ width, height });
  PNG.bitblt(imgA, resizedA, 0, 0, width, height, 0, 0);
  PNG.bitblt(imgB, resizedB, 0, 0, width, height, 0, 0);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(resizedA.data, resizedB.data, diff.data, width, height, { threshold: 0.1 });
  const diffPercent = Number(((diffPixels / (width * height)) * 100).toFixed(2));

  const outDir = path.resolve(process.cwd(), 'screenshots', 'diffs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const diffImagePath = path.join(outDir, `diff-${Date.now()}.png`);
  fs.writeFileSync(diffImagePath, PNG.sync.write(diff));

  return { diffPercent, diffImagePath };
}

/**
 * Check browser CSS rendering basics.
 */
export async function checkCSSRendering(page: Page): Promise<Issue[]> {
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  const url = page.url();

  const result = await page.evaluate(() => {
    const cssVarApplied = getComputedStyle(document.documentElement).getPropertyValue('--wp--preset--color--black') !== '';
    const stickyIssues: string[] = [];
    const grids = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => getComputedStyle(el).display.includes('grid'));
    const flexes = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((el) => getComputedStyle(el).display.includes('flex'));

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (getComputedStyle(el).position === 'sticky' && Number.isNaN(el.getBoundingClientRect().top)) {
        stickyIssues.push(el.tagName.toLowerCase());
      }
    }

    return { cssVarApplied, stickyIssues, hasGrid: grids.length > 0, hasFlex: flexes.length > 0 };
  });

  const issues: Issue[] = [];
  if (!result.cssVarApplied) {
    issues.push({ type: 'CSS_DIFF', severity: 'warning', message: 'CSS custom properties appear unresolved', url, viewport: vpLabel });
  }
  if (!result.hasGrid) {
    issues.push({ type: 'CSS_DIFF', severity: 'info', message: 'No CSS Grid elements detected on page', url, viewport: vpLabel });
  }
  if (!result.hasFlex) {
    issues.push({ type: 'CSS_DIFF', severity: 'info', message: 'No Flex elements detected on page', url, viewport: vpLabel });
  }
  result.stickyIssues.forEach((tag) => issues.push({ type: 'CSS_DIFF', severity: 'warning', message: `Sticky layout issue on <${tag}>`, url, viewport: vpLabel }));

  return issues;
}

/**
 * Gather JS error indicators.
 */
export async function checkJSErrors(page: Page): Promise<Issue[]> {
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  const url = page.url();
  const errors = await page.evaluate(() => {
    const internal = (window as unknown as { __qaErrors?: string[] }).__qaErrors || [];
    return internal;
  });

  return errors.map((message) => ({
    type: 'JS_ERROR' as const,
    severity: 'critical' as const,
    message,
    url,
    viewport: vpLabel
  }));
}

/**
 * Validate font loading state.
 */
export async function checkFontLoading(page: Page): Promise<Issue[]> {
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  const url = page.url();

  const result = await page.evaluate(async () => {
    if ('fonts' in document) {
      await (document as Document & { fonts: FontFaceSet }).fonts.ready;
      return {
        status: (document as Document & { fonts: FontFaceSet }).fonts.status,
        families: Array.from(document.querySelectorAll<HTMLElement>('body, h1, h2, p')).map((el) => getComputedStyle(el).fontFamily)
      };
    }
    return { status: 'unsupported', families: [] as string[] };
  });

  const issues: Issue[] = [];
  if (result.status !== 'loaded') {
    issues.push({ type: 'FONT', severity: 'warning', message: `Fonts not fully loaded (${result.status})`, url, viewport: vpLabel });
  }

  const fallbackLike = result.families.some((family) => /serif|sans-serif/i.test(family) && !/,/.test(family));
  if (fallbackLike) {
    issues.push({ type: 'FONT', severity: 'info', message: 'Potential fallback font substitution detected', url, viewport: vpLabel });
  }

  return issues;
}
