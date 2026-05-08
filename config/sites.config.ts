/**
 * Site Mappings Configuration
 *
 * PROJECT CONTEXT:
 * This suite is configured for a single WordPress site (no subdirectory mapping).
 */

import { SiteMapping } from '../src/types';

// Base URL for the new WordPress installation
export const NEW_BASE_URL = 'https://findlayedu.wpenginepowered.com';

/**
 * Single-site mapping.
 *
 * NOTE:
 * `subdirectoryPath` is intentionally empty because this project validates the
 * root domain directly, not /subdirectory routes.
 */
export const SITES: SiteMapping[] = [
  {
    name: 'findlayedu',
    oldDomain: 'https://findlayedu.wpenginepowered.com',
    subdirectoryPath: '',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  }
];

/**
 * All old domains as a flat array (for asset validation)
 */
export const OLD_DOMAINS: string[] = SITES.map(site => {
  const url = new URL(site.oldDomain);
  return url.hostname;
});

/**
 * Get enabled sites only
 * Used by test files to filter out disabled sites
 */
export function getEnabledSites(): SiteMapping[] {
  return SITES.filter(site => site.enabled);
}

/**
 * Get a specific site by name
 * Returns undefined if not found
 */
export function getSiteByName(name: string): SiteMapping | undefined {
  return SITES.find(site => site.name.toLowerCase() === name.toLowerCase());
}

/**
 * Get sites sorted by priority (highest first)
 * Higher priority sites are tested first
 */
export function getSitesByPriority(): SiteMapping[] {
  return [...getEnabledSites()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

/**
 * Build full URLs for a site
 */
export function buildSiteUrls(site: SiteMapping) {
  // Support separate sitemap paths for old and new sites
  const oldSitemapPath = site.oldSitemapPath || site.sitemapPath || '/sitemap.xml';
  const newSitemapPath = site.newSitemapPath || site.sitemapPath || '/sitemap.xml';

  const normalizedSubdirectory = (site.subdirectoryPath || '').replace(/^\/+|\/+$/g, '');
  const newRoot = normalizedSubdirectory
    ? `${NEW_BASE_URL}/${normalizedSubdirectory}`
    : NEW_BASE_URL;

  return {
    oldHomepage: site.oldDomain,
    newHomepage: `${newRoot}/`,
    oldSitemap: `${site.oldDomain}${oldSitemapPath}`,
    newSitemap: `${newRoot}${newSitemapPath}`
  };
}
