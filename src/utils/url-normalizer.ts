/**
 * URL Normalization Utilities
 *
 * MIGRATION CONTEXT:
 * When comparing old domain URLs to new subdirectory URLs, we need consistent
 * normalization to avoid false positives/negatives in comparisons.
 *
 * Key transformations:
 * - Remove trailing slashes for consistency
 * - Handle protocol differences (http vs https)
 * - Handle www vs non-www
 * - Convert old domain URLs to expected new subdirectory format
 */

import { SiteMapping } from '../types';
import { NEW_BASE_URL } from '../../config/sites.config';

/**
 * Normalize a URL for consistent comparison
 * - Converts to lowercase
 * - Removes trailing slashes (except root)
 * - Removes fragments (#...)
 * - Sorts query parameters
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Lowercase the host
    parsed.hostname = parsed.hostname.toLowerCase();

    // Remove trailing slash from pathname (keep root /)
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    // Remove fragment
    parsed.hash = '';

    // Sort query parameters for consistent comparison
    const params = new URLSearchParams(parsed.searchParams);
    const sortedParams = new URLSearchParams([...params.entries()].sort());
    parsed.search = sortedParams.toString();

    return parsed.toString();
  } catch {
    // If URL parsing fails, return as-is (lowercased)
    return url.toLowerCase();
  }
}

/**
 * Extract the path portion of a URL
 * Useful for comparing paths independent of domain
 */
export function extractPath(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;

    // Normalize trailing slash
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  } catch {
    // If URL parsing fails, try to extract path manually
    const match = url.match(/^https?:\/\/[^/]+(\/.*)?$/);
    return match?.[1] || '/';
  }
}

/**
 * Convert an old domain URL to the expected new subdirectory URL
 *
 * Example:
 * oldUrl: https://www.bainbridgereview.com/news/article-123
 * site: { oldDomain: 'https://www.bainbridgereview.com', subdirectoryPath: 'bainbridgereview' }
 * Returns: https://cmg-northwest2.go-vip.net/bainbridgereview/news/article-123
 */
export function convertToNewUrl(oldUrl: string, site: SiteMapping): string {
  const oldPath = extractPath(oldUrl);

  // Handle root path
  if (oldPath === '/') {
    return `${NEW_BASE_URL}/${site.subdirectoryPath}/`;
  }

  // Combine base URL, subdirectory, and original path
  return `${NEW_BASE_URL}/${site.subdirectoryPath}${oldPath}`;
}

/**
 * Convert a new subdirectory URL back to what the old domain URL would have been
 *
 * Example:
 * newUrl: https://cmg-northwest2.go-vip.net/bainbridgereview/news/article-123
 * site: { oldDomain: 'https://www.bainbridgereview.com', subdirectoryPath: 'bainbridgereview' }
 * Returns: https://www.bainbridgereview.com/news/article-123
 */
export function convertToOldUrl(newUrl: string, site: SiteMapping): string {
  const path = extractPath(newUrl);
  const subdirPrefix = `/${site.subdirectoryPath}`;

  // Remove subdirectory prefix from path
  if (path.startsWith(subdirPrefix)) {
    const remainingPath = path.slice(subdirPrefix.length) || '/';
    return `${site.oldDomain}${remainingPath}`;
  }

  // If path doesn't start with subdirectory, return as-is with old domain
  return `${site.oldDomain}${path}`;
}

/**
 * Check if a URL belongs to the old domain
 */
export function isOldDomainUrl(url: string, site: SiteMapping): boolean {
  try {
    const parsed = new URL(url);
    const oldParsed = new URL(site.oldDomain);

    // Compare hostnames (case-insensitive, handle www)
    const normalizeHost = (host: string) =>
      host.toLowerCase().replace(/^www\./, '');

    return normalizeHost(parsed.hostname) === normalizeHost(oldParsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL belongs to the new subdirectory
 */
export function isNewSubdirectoryUrl(url: string, site: SiteMapping): boolean {
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(NEW_BASE_URL);

    // Check hostname matches
    if (parsed.hostname.toLowerCase() !== baseParsed.hostname.toLowerCase()) {
      return false;
    }

    // Check path starts with subdirectory
    const expectedPrefix = `/${site.subdirectoryPath}`;
    return (
      parsed.pathname === expectedPrefix ||
      parsed.pathname.startsWith(`${expectedPrefix}/`)
    );
  } catch {
    return false;
  }
}

/**
 * Check if a URL crosses into a different subdirectory
 * (contamination detection)
 */
export function isCrossSubdirectoryUrl(
  url: string,
  currentSite: SiteMapping,
  allSites: SiteMapping[]
): boolean {
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(NEW_BASE_URL);

    // Must be on the new base domain
    if (parsed.hostname.toLowerCase() !== baseParsed.hostname.toLowerCase()) {
      return false;
    }

    // Check if it's in a DIFFERENT subdirectory
    for (const site of allSites) {
      if (site.name === currentSite.name) continue;

      const otherPrefix = `/${site.subdirectoryPath}`;
      if (
        parsed.pathname === otherPrefix ||
        parsed.pathname.startsWith(`${otherPrefix}/`)
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is internal to the current site's subdirectory
 */
export function isInternalUrl(url: string, site: SiteMapping): boolean {
  return isNewSubdirectoryUrl(url, site);
}

/**
 * Check if a URL should be excluded from crawling based on patterns
 */
export function shouldExcludeUrl(url: string, excludePatterns: string[]): boolean {
  const path = extractPath(url);

  for (const pattern of excludePatterns) {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(path) || regex.test(url)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a URL has an extension that should be skipped
 */
export function hasSkippableExtension(url: string, skipExtensions: string[]): boolean {
  const path = extractPath(url);
  const lowerPath = path.toLowerCase();

  for (const ext of skipExtensions) {
    if (lowerPath.endsWith(ext.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Get the subdirectory from a URL on the new base domain
 * Returns null if not on base domain or no subdirectory
 */
export function getSubdirectoryFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const baseParsed = new URL(NEW_BASE_URL);

    if (parsed.hostname.toLowerCase() !== baseParsed.hostname.toLowerCase()) {
      return null;
    }

    // Extract first path segment
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[0] || null;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is absolute (has protocol)
 */
export function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Resolve a potentially relative URL against a base URL
 */
export function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Check if URL is for a specific domain (any of the old domains)
 */
export function isOldDomain(url: string, allSites: SiteMapping[]): boolean {
  const domain = extractDomain(url);
  if (!domain) return false;

  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '');

  for (const site of allSites) {
    const oldDomain = extractDomain(site.oldDomain);
    if (oldDomain) {
      const normalizedOldDomain = oldDomain.toLowerCase().replace(/^www\./, '');
      if (normalizedDomain === normalizedOldDomain) {
        return true;
      }
    }
  }

  return false;
}
