export type BrowserFamily = 'chromium' | 'firefox' | 'webkit';

export interface BrowserDefinition {
  label: string;
  family: BrowserFamily;
  projectName: string;
  channel?: 'chrome' | 'msedge';
  mobileEmulation?: boolean;
}

export const BROWSER_MATRIX: readonly BrowserDefinition[] = [
  { label: 'Chrome', family: 'chromium', projectName: 'chromium-desktop', channel: 'chrome' },
  { label: 'Chrome', family: 'chromium', projectName: 'chromium-tablet', channel: 'chrome' },
  { label: 'Chrome', family: 'chromium', projectName: 'chromium-mobile', channel: 'chrome', mobileEmulation: true },
  { label: 'Edge', family: 'chromium', projectName: 'edge-desktop', channel: 'msedge' },

  { label: 'Firefox', family: 'firefox', projectName: 'firefox-desktop' },
  { label: 'Firefox', family: 'firefox', projectName: 'firefox-tablet' },
  { label: 'Firefox', family: 'firefox', projectName: 'firefox-mobile', mobileEmulation: true },

  { label: 'Safari', family: 'webkit', projectName: 'webkit-desktop' },
  { label: 'Safari iOS', family: 'webkit', projectName: 'webkit-tablet', mobileEmulation: true },
  { label: 'Safari iOS', family: 'webkit', projectName: 'webkit-mobile', mobileEmulation: true }
] as const;
