/**
 * URL list for single-site QA checks.
 *
 * Paste your full URL list into RAW_URLS (one URL per line).
 * The parser below will:
 * - Trim whitespace
 * - Ignore empty lines
 * - Ignore non-URL text
 * - De-duplicate entries
 */

export const RAW_URLS = `
https://findlayedu.wpenginepowered.com/
https://findlayedu.wpenginepowered.com/about/accessibility-statement/
https://findlayedu.wpenginepowered.com/about/accreditations/
https://findlayedu.wpenginepowered.com/about/city-of-findlay/
https://findlayedu.wpenginepowered.com/about/parking-and-transportation/
https://findlayedu.wpenginepowered.com/about/state-authorizations/education-programs-state-authorizations/
https://findlayedu.wpenginepowered.com/about/fast-facts/
https://findlayedu.wpenginepowered.com/about/hea-disclosure/
https://findlayedu.wpenginepowered.com/about/institutional-research/
https://findlayedu.wpenginepowered.com/about/state-authorizations/licensure-program-state-authorizations/
https://findlayedu.wpenginepowered.com/about/state-authorizations/nursing-state-authorizations/
https://findlayedu.wpenginepowered.com/about/state-authorizations/pharmacy-state-authorizations/
https://findlayedu.wpenginepowered.com/about/privacy-policy/
https://findlayedu.wpenginepowered.com/about/state-authorizations/
https://findlayedu.wpenginepowered.com/about/mission-vision
https://findlayedu.wpenginepowered.com/about/history/
https://findlayedu.wpenginepowered.com/about/history/christian-heritage/
https://findlayedu.wpenginepowered.com/about/history/derrick-the-oiler/
https://findlayedu.wpenginepowered.com/about/history/historical-timeline/
https://findlayedu.wpenginepowered.com/about/history/history-of-uf-and-cggc/
https://findlayedu.wpenginepowered.com/about/history/traditions/
https://findlayedu.wpenginepowered.com/about/leadership/
https://findlayedu.wpenginepowered.com/about/leadership/about-the-president/
https://findlayedu.wpenginepowered.com/about/leadership/board-of-trustees/
https://findlayedu.wpenginepowered.com/about/leadership/cabinet/
https://findlayedu.wpenginepowered.com/academics/
https://findlayedu.wpenginepowered.com/academics/program-finder/
https://findlayedu.wpenginepowered.com/academics/undergraduate/associate-degrees/
https://findlayedu.wpenginepowered.com/about/centers-and-institutes/
https://findlayedu.wpenginepowered.com/academics/core/
https://findlayedu.wpenginepowered.com/academics/graduate/
https://findlayedu.wpenginepowered.com/academics/non-degree-programs/
https://findlayedu.wpenginepowered.com/academics/research/
https://findlayedu.wpenginepowered.com/academics/undergraduate/
https://findlayedu.wpenginepowered.com/admissions-aid/
https://findlayedu.wpenginepowered.com/admissions-aid/first-year-students/requirements-and-deadlines/
https://findlayedu.wpenginepowered.com/admissions-aid/check-application-status/
https://findlayedu.wpenginepowered.com/admissions-aid/college-credit-plus/
https://findlayedu.wpenginepowered.com/admissions-aid/first-year-students/
https://findlayedu.wpenginepowered.com/admissions-aid/first-year-students/accepted-next-steps/
https://findlayedu.wpenginepowered.com/admissions-aid/international-students/
https://findlayedu.wpenginepowered.com/admissions-aid/military-services/
https://findlayedu.wpenginepowered.com/admissions-aid/request-information/
https://findlayedu.wpenginepowered.com/admissions-aid/transfer-students/
https://findlayedu.wpenginepowered.com/admissions-aid/undecided-major/
https://findlayedu.wpenginepowered.com/admissions-aid/accommodations/
https://findlayedu.wpenginepowered.com/admissions-aid/oiler-scholarship/
https://findlayedu.wpenginepowered.com/admissions-aid/virtual-tour/
https://findlayedu.wpenginepowered.com/academics/business-humanities/
https://findlayedu.wpenginepowered.com/academics/course-catalog/
https://findlayedu.wpenginepowered.com/academics/education/
https://findlayedu.wpenginepowered.com/admissions-aid/families/
https://findlayedu.wpenginepowered.com/admissions-aid/tuition-fees/
https://findlayedu.wpenginepowered.com/admissions-aid/scholarships/
https://findlayedu.wpenginepowered.com/academics/health-professions/
https://findlayedu.wpenginepowered.com/academics/honors/
https://findlayedu.wpenginepowered.com/academics/programs/
https://findlayedu.wpenginepowered.com/academics/shafer-library/
https://findlayedu.wpenginepowered.com/academics/writing-center/
https://findlayedu.wpenginepowered.com/campus-life/
https://findlayedu.wpenginepowered.com/academics/online/
https://findlayedu.wpenginepowered.com/academics/pharmacy/
https://findlayedu.wpenginepowered.com/academics/sciences/
https://findlayedu.wpenginepowered.com/part-time-faculty-directory
`;

export const TARGET_BASE_URL = 'https://findlayedu.wpenginepowered.com';

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    // Normalize host/protocol casing and strip trailing whitespace artifacts.
    return parsed.toString().replace(/\s+/g, '');
  } catch {
    return trimmed;
  }
}

export function parseUrlList(raw: string): string[] {
  const unique = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const candidate = normalizeUrl(line);
    if (!candidate || !isLikelyUrl(candidate)) {
      continue;
    }

    unique.add(candidate);
  }

  return [...unique];
}

export const URLS_TO_TEST: string[] = parseUrlList(RAW_URLS);
