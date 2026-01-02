/**
 * Broken Assets Detection Tests
 *
 * MIGRATION CONTEXT:
 * When migrating WordPress sites, media URLs and asset paths can break.
 * Common issues:
 * - Images still pointing to old domain
 * - Media files not migrated to new location
 * - Hardcoded asset URLs in content
 *
 * WHAT THIS VALIDATES:
 * - All images load successfully (no 404s)
 * - No assets point to old/legacy domains
 * - Critical stylesheets and scripts load
 *
 * WHY THIS MATTERS:
 * Broken images and missing assets create a poor user experience and
 * indicate incomplete migration. They also impact SEO.
 */

import { test, expect } from '../src/fixtures/test-fixtures';
import { getEnabledSites, NEW_BASE_URL, buildSiteUrls } from '../config/sites.config';
import { ASSET_CONFIG } from '../config/test.config';
import { SiteMapping, PageAsset } from '../src/types';

// Get all sites to test
const sites = getEnabledSites();

test.describe('Broken Assets Detection', () => {
  for (const site of sites) {
    test.describe(`Site: ${site.name}`, () => {
      const urls = buildSiteUrls(site);

      test('homepage images load successfully', async ({ page, request }) => {
        /**
         * WHY: Images are the most visible broken assets.
         * Broken images immediately signal a problem to users.
         */
        // Track failed image requests
        const failedImages: Array<{ url: string; status?: number; error?: string }> = [];

        // Listen for failed requests before navigation
        page.on('requestfailed', req => {
          if (req.resourceType() === 'image') {
            failedImages.push({
              url: req.url(),
              error: req.failure()?.errorText || 'Unknown failure'
            });
          }
        });

        // Listen for completed requests to catch 404s
        page.on('response', response => {
          if (response.request().resourceType() === 'image' && !response.ok()) {
            failedImages.push({
              url: response.url(),
              status: response.status()
            });
          }
        });

        // Navigate to homepage
        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        // Also check images that might not have loaded yet (lazy loading)
        const imageSrcs = await page.evaluate(() => {
          const images = document.querySelectorAll('img[src], img[data-src]');
          return Array.from(images).map(img => ({
            src: (img as HTMLImageElement).src || img.getAttribute('data-src') || '',
            loaded: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
          }));
        });

        // Count unloaded images (excluding lazy-loaded that haven't triggered yet)
        const unloadedImages = imageSrcs.filter(img =>
          img.src && !img.loaded && !img.src.startsWith('data:')
        );

        // Log results
        console.log(`  📷 ${site.name}: ${imageSrcs.length} images found, ${failedImages.length} failed to load`);

        // Fail if there are broken images
        expect(
          failedImages.length,
          `Found ${failedImages.length} broken images:\n${failedImages.slice(0, 5).map(i => `  - ${i.url} (${i.status || i.error})`).join('\n')}${failedImages.length > 5 ? `\n  ... and ${failedImages.length - 5} more` : ''}`
        ).toBe(0);
      });

      test('no assets point to old domain', async ({ page }) => {
        /**
         * WHY: Assets still pointing to old domain indicate incomplete migration.
         * These will break when old domain is taken down.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        // Extract all asset URLs from the page
        const assetUrls = await page.evaluate(() => {
          const urls: Array<{ url: string; element: string }> = [];

          // Images
          document.querySelectorAll('img[src]').forEach(img => {
            urls.push({ url: (img as HTMLImageElement).src, element: 'img' });
          });

          // Stylesheets
          document.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
            urls.push({ url: (link as HTMLLinkElement).href, element: 'stylesheet' });
          });

          // Scripts
          document.querySelectorAll('script[src]').forEach(script => {
            urls.push({ url: (script as HTMLScriptElement).src, element: 'script' });
          });

          // Background images in inline styles
          document.querySelectorAll('[style*="background"]').forEach(el => {
            const style = el.getAttribute('style') || '';
            const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
            if (urlMatch) {
              urls.push({ url: urlMatch[1], element: 'inline-style' });
            }
          });

          return urls;
        });

        // Check for old domain references
        const oldDomainHost = new URL(site.oldDomain).hostname;
        const oldDomainAssets = assetUrls.filter(asset => {
          try {
            const assetHost = new URL(asset.url).hostname;
            return assetHost === oldDomainHost ||
                   assetHost === oldDomainHost.replace('www.', '') ||
                   assetHost === `www.${oldDomainHost.replace('www.', '')}`;
          } catch {
            return false;
          }
        });

        // Log results
        if (oldDomainAssets.length > 0) {
          console.log(`  ⚠️ ${site.name}: ${oldDomainAssets.length} assets still point to old domain:`);
          oldDomainAssets.slice(0, 5).forEach(a => console.log(`    - ${a.element}: ${a.url}`));
        }

        // Fail if any assets point to old domain
        expect(
          oldDomainAssets.length,
          `Found ${oldDomainAssets.length} assets pointing to old domain ${site.oldDomain}:\n${oldDomainAssets.slice(0, 10).map(a => `  - [${a.element}] ${a.url}`).join('\n')}`
        ).toBe(0);
      });

      test('critical stylesheets load', async ({ page }) => {
        /**
         * WHY: Missing CSS makes the page unusable.
         * WordPress themes rely on stylesheets for layout.
         */
        const failedStylesheets: string[] = [];

        page.on('response', response => {
          if (
            response.request().resourceType() === 'stylesheet' &&
            !response.ok()
          ) {
            failedStylesheets.push(response.url());
          }
        });

        page.on('requestfailed', req => {
          if (req.resourceType() === 'stylesheet') {
            failedStylesheets.push(req.url());
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        // Check that some stylesheets loaded
        const stylesheetCount = await page.evaluate(() =>
          document.querySelectorAll('link[rel="stylesheet"]').length
        );

        expect(stylesheetCount, 'Page should have stylesheets').toBeGreaterThan(0);
        expect(
          failedStylesheets.length,
          `Failed to load ${failedStylesheets.length} stylesheets:\n${failedStylesheets.join('\n')}`
        ).toBe(0);
      });

      test('critical scripts load', async ({ page }) => {
        /**
         * WHY: Missing JavaScript breaks interactive features.
         * WordPress plugins and themes depend on JS.
         */
        const failedScripts: string[] = [];

        page.on('response', response => {
          if (
            response.request().resourceType() === 'script' &&
            !response.ok()
          ) {
            failedScripts.push(response.url());
          }
        });

        page.on('requestfailed', req => {
          if (req.resourceType() === 'script') {
            failedScripts.push(req.url());
          }
        });

        await page.goto(urls.newHomepage, {
          waitUntil: 'networkidle',
          timeout: 60000
        });

        expect(
          failedScripts.length,
          `Failed to load ${failedScripts.length} scripts:\n${failedScripts.slice(0, 10).join('\n')}`
        ).toBe(0);
      });

      test('no mixed content warnings', async ({ page }) => {
        /**
         * WHY: HTTP resources on HTTPS pages trigger browser warnings.
         * Can cause assets to be blocked entirely.
         */
        await page.goto(urls.newHomepage, {
          waitUntil: 'domcontentloaded'
        });

        // Check for HTTP resources in an HTTPS page
        const httpResources = await page.evaluate(() => {
          const resources: Array<{ type: string; url: string }> = [];

          // Images
          document.querySelectorAll('img[src^="http://"]').forEach(img => {
            resources.push({ type: 'img', url: (img as HTMLImageElement).src });
          });

          // Stylesheets
          document.querySelectorAll('link[rel="stylesheet"][href^="http://"]').forEach(link => {
            resources.push({ type: 'stylesheet', url: (link as HTMLLinkElement).href });
          });

          // Scripts
          document.querySelectorAll('script[src^="http://"]').forEach(script => {
            resources.push({ type: 'script', url: (script as HTMLScriptElement).src });
          });

          // iframes
          document.querySelectorAll('iframe[src^="http://"]').forEach(iframe => {
            resources.push({ type: 'iframe', url: (iframe as HTMLIFrameElement).src });
          });

          return resources;
        });

        expect(
          httpResources.length,
          `Found ${httpResources.length} HTTP resources on HTTPS page (mixed content):\n${httpResources.slice(0, 10).map(r => `  - [${r.type}] ${r.url}`).join('\n')}`
        ).toBe(0);
      });
    });
  }
});

test.describe('Asset Validation Summary', () => {
  test('batch validate critical assets across all sites', async ({ request }) => {
    /**
     * WHY: Quick validation of key assets across all sites.
     * Uses API requests for speed.
     */
    const results: Array<{
      site: string;
      totalAssets: number;
      brokenAssets: number;
      oldDomainAssets: number;
    }> = [];

    console.log('\n📊 Asset Validation Summary:');
    console.log('─'.repeat(60));

    for (const site of sites) {
      const siteUrls = buildSiteUrls(site);

      try {
        // Fetch homepage HTML
        const response = await request.get(siteUrls.newHomepage);
        const html = await response.text();

        // Extract image URLs
        const imgMatches = html.match(/src=["']([^"']+\.(jpg|jpeg|png|gif|webp|svg)[^"']*)["']/gi) || [];
        const imageUrls = imgMatches
          .map(m => {
            const match = m.match(/src=["']([^"']+)["']/i);
            return match ? match[1] : null;
          })
          .filter((url): url is string => url !== null)
          .map(url => {
            try {
              return new URL(url, siteUrls.newHomepage).toString();
            } catch {
              return url;
            }
          })
          .slice(0, 20); // Limit for speed

        let brokenCount = 0;
        let oldDomainCount = 0;
        const oldDomainHost = new URL(site.oldDomain).hostname;

        // Check each image
        for (const imgUrl of imageUrls) {
          try {
            const imgHost = new URL(imgUrl).hostname;
            if (imgHost.includes(oldDomainHost.replace('www.', ''))) {
              oldDomainCount++;
            }
          } catch {
            // Invalid URL
          }

          try {
            const imgResponse = await request.head(imgUrl, {
              timeout: 5000,
              failOnStatusCode: false
            });
            if (!imgResponse.ok()) {
              brokenCount++;
            }
          } catch {
            brokenCount++;
          }
        }

        results.push({
          site: site.name,
          totalAssets: imageUrls.length,
          brokenAssets: brokenCount,
          oldDomainAssets: oldDomainCount
        });

        const icon = brokenCount === 0 && oldDomainCount === 0 ? '✅' : '⚠️';
        console.log(`${icon} ${site.name}: ${imageUrls.length} images, ${brokenCount} broken, ${oldDomainCount} old-domain`);
      } catch (error) {
        console.log(`❌ ${site.name}: Failed to check assets`);
      }
    }

    console.log('─'.repeat(60));

    const totalBroken = results.reduce((sum, r) => sum + r.brokenAssets, 0);
    const totalOldDomain = results.reduce((sum, r) => sum + r.oldDomainAssets, 0);

    console.log(`Total: ${totalBroken} broken assets, ${totalOldDomain} old-domain assets`);

    // This is a summary test - individual site tests will handle specific failures
    // Here we just warn about high numbers
    if (totalBroken > 0 || totalOldDomain > 0) {
      console.log('\n⚠️ Asset issues detected. See individual site tests for details.');
    }
  });
});
