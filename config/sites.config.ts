/**
 * Site Mappings Configuration
 *
 * MIGRATION CONTEXT:
 * 26 legacy WordPress sites have been consolidated into a single WordPress
 * installation using subdirectories. Each entry maps an old domain to its
 * new subdirectory path.
 *
 * TO ADD A NEW SITE:
 * 1. Add a new entry to the SITES array below
 * 2. Ensure the oldDomain does NOT include trailing slash
 * 3. Ensure subdirectoryPath does NOT include leading/trailing slashes
 * 4. Run tests for the new site: npm run test:single-site --site=sitename
 */

import { SiteMapping } from '../src/types';

// Base URL for the new WordPress installation
export const NEW_BASE_URL = 'https://cmg-northwest2.go-vip.net';

/**
 * All 26 site mappings
 * Each site has:
 * - name: Human-readable identifier (used in test names and filtering)
 * - oldDomain: The legacy domain (without trailing slash)
 * - subdirectoryPath: The new subdirectory path (without leading/trailing slashes)
 * - sitemapPath: Path to sitemap (defaults to /sitemap.xml)
 * - enabled: Whether to include in test runs (useful for phased rollout)
 * - priority: Test execution priority (higher = run first)
 */
export const SITES: SiteMapping[] = [
  {
    name: 'bainbridgereview',
    oldDomain: 'https://www.bainbridgereview.com',
    subdirectoryPath: 'bainbridgereview',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'bellevuereporter',
    oldDomain: 'https://www.bellevuereporter.com',
    subdirectoryPath: 'bellevuereporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'bothell-reporter',
    oldDomain: 'https://www.bothell-reporter.com',
    subdirectoryPath: 'bothell-reporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'courierherald',
    oldDomain: 'https://www.courierherald.com',
    subdirectoryPath: 'courierherald',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'federalwaymirror',
    oldDomain: 'https://www.federalwaymirror.com',
    subdirectoryPath: 'federalwaymirror',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'forksforum',
    oldDomain: 'https://www.forksforum.com',
    subdirectoryPath: 'forksforum',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'heraldnet',
    oldDomain: 'https://www.heraldnet.com',
    subdirectoryPath: 'heraldnet',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'homernews',
    oldDomain: 'https://www.homernews.com',
    subdirectoryPath: 'homernews',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'islandssounder',
    oldDomain: 'https://www.islandssounder.com',
    subdirectoryPath: 'islandssounder',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'islandsweekly',
    oldDomain: 'https://www.islandsweekly.com',
    subdirectoryPath: 'islandsweekly',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'juneauempire',
    oldDomain: 'https://www.juneauempire.com',
    subdirectoryPath: 'juneauempire',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'kentreporter',
    oldDomain: 'https://www.kentreporter.com',
    subdirectoryPath: 'kentreporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'kirklandreporter',
    oldDomain: 'https://www.kirklandreporter.com',
    subdirectoryPath: 'kirklandreporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'kitsapdailynews',
    oldDomain: 'https://www.kitsapdailynews.com',
    subdirectoryPath: 'kitsapdailynews',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'mi-reporter',
    oldDomain: 'https://www.mi-reporter.com',
    subdirectoryPath: 'mi-reporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'peninsulaclarion',
    oldDomain: 'https://www.peninsulaclarion.com',
    subdirectoryPath: 'peninsulaclarion',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'peninsuladailynews',
    oldDomain: 'https://www.peninsuladailynews.com',
    subdirectoryPath: 'peninsuladailynews',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'redmond-reporter',
    oldDomain: 'https://www.redmond-reporter.com',
    subdirectoryPath: 'redmond-reporter',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'sanjuanjournal',
    oldDomain: 'https://www.sanjuanjournal.com',
    subdirectoryPath: 'sanjuanjournal',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'sequimgazette',
    oldDomain: 'https://www.sequimgazette.com',
    subdirectoryPath: 'sequimgazette',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'southwhidbeyrecord',
    oldDomain: 'https://www.southwhidbeyrecord.com',
    subdirectoryPath: 'southwhidbeyrecord',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'tacomadailyindex',
    oldDomain: 'https://www.tacomadailyindex.com',
    subdirectoryPath: 'tacomadailyindex',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'thedailyworld',
    oldDomain: 'https://www.thedailyworld.com',
    subdirectoryPath: 'thedailyworld',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'valleyrecord',
    oldDomain: 'https://www.valleyrecord.com',
    subdirectoryPath: 'valleyrecord',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'vashonbeachcomber',
    oldDomain: 'https://www.vashonbeachcomber.com',
    subdirectoryPath: 'vashonbeachcomber',
    sitemapPath: '/sitemap.xml',
    enabled: true,
    priority: 1
  },
  {
    name: 'whidbeynewstimes',
    oldDomain: 'https://www.whidbeynewstimes.com',
    subdirectoryPath: 'whidbeynewstimes',
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
  return {
    oldHomepage: site.oldDomain,
    newHomepage: `${NEW_BASE_URL}/${site.subdirectoryPath}/`,
    oldSitemap: `${site.oldDomain}${site.sitemapPath || '/sitemap.xml'}`,
    newSitemap: `${NEW_BASE_URL}/${site.subdirectoryPath}${site.sitemapPath || '/sitemap.xml'}`
  };
}
