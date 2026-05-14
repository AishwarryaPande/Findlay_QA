export type ViewportGroup = 'desktop' | 'tablet' | 'mobile';

export interface QAViewport {
  label: string;
  group: ViewportGroup;
  width: number;
  height: number;
}

export const VIEWPORTS: readonly QAViewport[] = [
  { label: 'desktop-1920x1080', group: 'desktop', width: 1920, height: 1080 },
  { label: 'desktop-1440x900', group: 'desktop', width: 1440, height: 900 },
  { label: 'desktop-1366x768', group: 'desktop', width: 1366, height: 768 },
  { label: 'desktop-1280x800', group: 'desktop', width: 1280, height: 800 },

  { label: 'tablet-1024x768', group: 'tablet', width: 1024, height: 768 },
  { label: 'tablet-768x1024', group: 'tablet', width: 768, height: 1024 },
  { label: 'tablet-820x1180', group: 'tablet', width: 820, height: 1180 },
  { label: 'tablet-912x1368', group: 'tablet', width: 912, height: 1368 },

  { label: 'mobile-390x844', group: 'mobile', width: 390, height: 844 },
  { label: 'mobile-375x667', group: 'mobile', width: 375, height: 667 },
  { label: 'mobile-414x896', group: 'mobile', width: 414, height: 896 },
  { label: 'mobile-360x800', group: 'mobile', width: 360, height: 800 },
  { label: 'mobile-412x915', group: 'mobile', width: 412, height: 915 },
  { label: 'mobile-320x568', group: 'mobile', width: 320, height: 568 }
] as const;

export const CROSS_BROWSER_VIEWPORTS: readonly QAViewport[] = [
  { label: 'desktop-1366x768', group: 'desktop', width: 1366, height: 768 },
  { label: 'mobile-375x667', group: 'mobile', width: 375, height: 667 }
] as const;

export function viewportsForGroup(group: ViewportGroup): QAViewport[] {
  return VIEWPORTS.filter((v) => v.group === group);
}
