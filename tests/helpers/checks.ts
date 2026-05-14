import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { Issue } from './reporter';

export interface ViewportLike {
  label: string;
  width: number;
  height: number;
}

function baseIssue(url: string, viewport: string): Omit<Issue, 'type' | 'severity' | 'message'> {
  return { url, viewport };
}

/**
 * Capture issue screenshot, preferring element clip when selector exists.
 */
export async function captureIssueScreenshot(page: Page, issue: Issue, browser: string): Promise<string> {
  const slug = new URL(issue.url).pathname.replace(/\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
  const dir = path.resolve(process.cwd(), 'screenshots', browser, issue.viewport);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}-${issue.type}-${Date.now()}.png`);

  try {
    if (issue.selector) {
      const locator = page.locator(issue.selector).first();
      if (await locator.count()) {
        await locator.screenshot({ path: filePath });
        return filePath;
      }
    }
  } catch {
    // fallback below
  }

  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

/**
 * Check horizontal overflow and overflowing elements.
 */
export async function checkHorizontalOverflow(page: Page, viewport: ViewportLike): Promise<Issue[]> {
  const url = page.url();
  const offenders = await page.evaluate((vpWidth) => {
    const root = document.documentElement;
    const result: Array<{ selector: string; width: number }> = [];

    const all = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.right - 1 > vpWidth || rect.left < -1) {
        const selector = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : ''}`;
        result.push({ selector, width: Math.round(rect.width) });
      }
    }

    return {
      pageOverflow: root.scrollWidth > root.clientWidth,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      offenders: result.slice(0, 20)
    };
  }, viewport.width);

  const issues: Issue[] = [];
  if (offenders.pageOverflow) {
    issues.push({
      type: 'OVERFLOW',
      severity: 'critical',
      message: `Horizontal overflow detected at ${viewport.width}px`,
      ...baseIssue(url, viewport.label)
    });
  }

  if (offenders.bodyOverflowX !== 'hidden' && offenders.pageOverflow) {
    issues.push({
      type: 'OVERFLOW',
      severity: 'warning',
      message: `Body overflow-x is ${offenders.bodyOverflowX}`,
      ...baseIssue(url, viewport.label)
    });
  }

  for (const offender of offenders.offenders) {
    issues.push({
      type: 'OVERFLOW',
      severity: 'critical',
      message: `Element exceeds viewport width (${offender.width}px)`,
      selector: offender.selector,
      ...baseIssue(url, viewport.label)
    });
  }

  return issues;
}

/**
 * Check navigation/header behavior.
 */
export async function checkNavigation(page: Page, viewport: ViewportLike): Promise<Issue[]> {
  const url = page.url();
  const issues: Issue[] = [];

  const headerVisible = await page.locator('header, nav').first().isVisible().catch(() => false);
  if (!headerVisible) {
    issues.push({ type: 'NAV', severity: 'critical', message: 'Header/nav not visible', ...baseIssue(url, viewport.label) });
  }

  const logo = page.locator('header img, .logo img, a[rel="home"] img').first();
  const logoVisible = await logo.isVisible().catch(() => false);
  if (!logoVisible) {
    issues.push({ type: 'NAV', severity: 'warning', message: 'Logo not visible', ...baseIssue(url, viewport.label) });
  }

  const isMobile = viewport.width < 768;
  const hamburger = page.locator('button[aria-label*="menu" i], .menu-toggle, .hamburger, [aria-controls*="menu" i]').first();
  const hasHamburger = await hamburger.isVisible().catch(() => false);

  if (isMobile && !hasHamburger) {
    issues.push({ type: 'NAV', severity: 'warning', message: 'Hamburger not found on mobile', ...baseIssue(url, viewport.label) });
  }

  if (!isMobile && hasHamburger) {
    issues.push({ type: 'NAV', severity: 'info', message: 'Hamburger visible on desktop/tablet', ...baseIssue(url, viewport.label) });
  }

  if (isMobile && hasHamburger) {
    try {
      await hamburger.click({ timeout: 3000 });
      const navLinksVisible = await page.locator('nav a, header a').first().isVisible().catch(() => false);
      if (!navLinksVisible) {
        issues.push({ type: 'NAV', severity: 'critical', message: 'Hamburger click did not reveal nav links', ...baseIssue(url, viewport.label) });
      }
    } catch {
      issues.push({ type: 'NAV', severity: 'warning', message: 'Hamburger not clickable', ...baseIssue(url, viewport.label) });
    }
  }

  return issues;
}

/**
 * Check image integrity and accessibility.
 */
export async function checkImages(page: Page): Promise<Issue[]> {
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  const url = page.url();

  const result = await page.evaluate(() => {
    const broken: string[] = [];
    const missingAlt: string[] = [];
    const overflowing: string[] = [];

    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
    for (const img of imgs) {
      const selector = img.id ? `img#${img.id}` : `img.${img.className || 'no-class'}`;
      if (!img.complete || img.naturalWidth === 0) broken.push(selector);
      if (!img.alt || img.alt.trim().length === 0) missingAlt.push(selector);

      const rect = img.getBoundingClientRect();
      const parent = img.parentElement?.getBoundingClientRect();
      if (parent && rect.width - parent.width > 1) overflowing.push(selector);
    }

    return { broken, missingAlt, overflowing };
  });

  const issues: Issue[] = [];
  result.broken.forEach((selector) => issues.push({ type: 'BROKEN_IMG', severity: 'critical', message: 'Broken image detected', selector, url, viewport: vpLabel }));
  result.overflowing.forEach((selector) => issues.push({ type: 'BROKEN_IMG', severity: 'warning', message: 'Image overflow detected', selector, url, viewport: vpLabel }));
  result.missingAlt.forEach((selector) => issues.push({ type: 'BROKEN_IMG', severity: 'warning', message: 'Image missing alt text', selector, url, viewport: vpLabel }));

  return issues;
}

/**
 * Check text clipping and minimum font size.
 */
export async function checkTextOverflow(page: Page, viewport: ViewportLike): Promise<Issue[]> {
  const url = page.url();
  const findings = await page.evaluate((width) => {
    const textIssues: string[] = [];
    const smallFonts: string[] = [];

    const nodes = Array.from(document.querySelectorAll<HTMLElement>('p, span, li, a, h1, h2, h3, h4'));
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (rect.right > width + 1 || rect.left < -1) textIssues.push(el.tagName.toLowerCase());
      const fontSize = Number.parseFloat(getComputedStyle(el).fontSize);
      if (width < 768 && fontSize < 12) smallFonts.push(el.tagName.toLowerCase());
    }

    return { textIssues, smallFonts, hasH1: !!document.querySelector('h1'), hasH2: !!document.querySelector('h2') };
  }, viewport.width);

  const issues: Issue[] = [];
  if (!findings.hasH1 || !findings.hasH2) {
    issues.push({ type: 'FONT', severity: 'warning', message: 'H1/H2 heading visibility issue', ...baseIssue(url, viewport.label) });
  }
  findings.textIssues.slice(0, 20).forEach((tag) => issues.push({ type: 'FONT', severity: 'warning', message: `Text overflow on <${tag}>`, ...baseIssue(url, viewport.label) }));
  findings.smallFonts.slice(0, 20).forEach((tag) => issues.push({ type: 'FONT', severity: 'warning', message: `Small font (<12px) on mobile for <${tag}>`, ...baseIssue(url, viewport.label) }));

  return issues;
}

/**
 * Check CTA/button visibility and touch target size.
 */
export async function checkButtons(page: Page, viewport: ViewportLike): Promise<Issue[]> {
  const url = page.url();
  const results = await page.evaluate((isMobile) => {
    const tooSmall: string[] = [];
    const overlap: string[] = [];

    const nodes = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      if (isMobile && (rect.width < 44 || rect.height < 44)) {
        tooSmall.push(el.tagName.toLowerCase());
      }
    }

    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = nodes[i].getBoundingClientRect();
      const b = nodes[i + 1].getBoundingClientRect();
      const intersect = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      if (intersect && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0) overlap.push(`${nodes[i].tagName}/${nodes[i + 1].tagName}`);
    }

    return { tooSmall, overlap };
  }, viewport.width < 768);

  const issues: Issue[] = [];
  results.tooSmall.slice(0, 20).forEach((tag) => issues.push({ type: 'LAYOUT', severity: 'warning', message: `Touch target below 44x44 for <${tag}>`, ...baseIssue(url, viewport.label) }));
  results.overlap.slice(0, 10).forEach((pair) => issues.push({ type: 'LAYOUT', severity: 'warning', message: `Clickable overlap detected (${pair})`, ...baseIssue(url, viewport.label) }));
  return issues;
}

/**
 * Check main layout integrity.
 */
export async function checkLayout(page: Page): Promise<Issue[]> {
  const viewport = page.viewportSize();
  const vpLabel = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  const url = page.url();

  const result = await page.evaluate(() => {
    const mainVisible = !!document.querySelector('main');
    const footerVisible = !!document.querySelector('footer');
    const blockingOverlay = Array.from(document.querySelectorAll<HTMLElement>('*')).some((el) => {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed') return false;
      const z = Number.parseInt(style.zIndex || '0', 10);
      const rect = el.getBoundingClientRect();
      return z >= 1000 && rect.width > window.innerWidth * 0.8 && rect.height > 80;
    });

    return { mainVisible, footerVisible, blockingOverlay };
  });

  const issues: Issue[] = [];
  if (!result.mainVisible) issues.push({ type: 'LAYOUT', severity: 'critical', message: 'Main content missing', url, viewport: vpLabel });
  if (!result.footerVisible) issues.push({ type: 'LAYOUT', severity: 'warning', message: 'Footer missing', url, viewport: vpLabel });
  if (result.blockingOverlay) issues.push({ type: 'LAYOUT', severity: 'critical', message: 'Fixed overlay blocking content', url, viewport: vpLabel });
  return issues;
}

/**
 * Check forms responsiveness.
 */
export async function checkForms(page: Page, viewport: ViewportLike): Promise<Issue[]> {
  const url = page.url();
  const result = await page.evaluate((vp) => {
    const tooWide: string[] = [];
    const missingLabels: string[] = [];
    const hiddenSubmit: string[] = [];

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'));
    for (const input of inputs) {
      const rect = input.getBoundingClientRect();
      if (rect.right > vp + 1) tooWide.push(input.tagName.toLowerCase());

      const id = input.getAttribute('id');
      if (id && !document.querySelector(`label[for="${id}"]`)) missingLabels.push(input.tagName.toLowerCase());
    }

    const submits = Array.from(document.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]'));
    for (const submit of submits) {
      const rect = submit.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) hiddenSubmit.push(submit.tagName.toLowerCase());
    }

    return { tooWide, missingLabels, hiddenSubmit };
  }, viewport.width);

  const issues: Issue[] = [];
  result.tooWide.forEach((tag) => issues.push({ type: 'FORM', severity: 'critical', message: `Form element wider than viewport (<${tag}>)`, ...baseIssue(url, viewport.label) }));
  result.missingLabels.forEach((tag) => issues.push({ type: 'FORM', severity: 'warning', message: `Input missing explicit label (<${tag}>)`, ...baseIssue(url, viewport.label) }));
  result.hiddenSubmit.forEach((tag) => issues.push({ type: 'FORM', severity: 'warning', message: `Submit control hidden (<${tag}>)`, ...baseIssue(url, viewport.label) }));

  return issues;
}
