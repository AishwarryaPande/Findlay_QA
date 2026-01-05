#!/usr/bin/env node

/**
 * Sitemap Path Detector
 *
 * Detects which sitemap path each old site uses (/sitemap.xml vs /sitemap_index.xml)
 * Helps identify sites that need oldSitemapPath/newSitemapPath configuration
 */

const https = require('https');
const { SITES } = require('../config/sites.config.ts');

console.log('🔍 Detecting sitemap paths for all sites...\n');
console.log('Site'.padEnd(25) + 'sitemap.xml'.padEnd(20) + 'sitemap_index.xml'.padEnd(20) + 'Recommendation');
console.log('─'.repeat(90));

async function checkUrl(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'HEAD',
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      resolve({ status: res.statusCode, exists: res.statusCode === 200 });
    });

    req.on('error', () => resolve({ status: 0, exists: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, exists: false });
    });

    req.end();
  });
}

async function checkSite(site) {
  const sitemapXml = await checkUrl(`${site.oldDomain}/sitemap.xml`);
  const sitemapIndexXml = await checkUrl(`${site.oldDomain}/sitemap_index.xml`);

  let recommendation = '';
  if (sitemapXml.exists && !sitemapIndexXml.exists) {
    recommendation = '✅ Use sitemap.xml (default)';
  } else if (!sitemapXml.exists && sitemapIndexXml.exists) {
    recommendation = '⚠️ Use sitemap_index.xml';
  } else if (sitemapXml.exists && sitemapIndexXml.exists) {
    recommendation = '⚠️ Both exist - use sitemap_index.xml';
  } else {
    recommendation = '❌ Neither found!';
  }

  const sitemapStatus = sitemapXml.exists ? `✅ ${sitemapXml.status}` : `❌ ${sitemapXml.status || 'N/A'}`;
  const indexStatus = sitemapIndexXml.exists ? `✅ ${sitemapIndexXml.status}` : `❌ ${sitemapIndexXml.status || 'N/A'}`;

  console.log(
    site.name.padEnd(25) +
    sitemapStatus.padEnd(20) +
    indexStatus.padEnd(20) +
    recommendation
  );

  return {
    site: site.name,
    needsOldSitemapPath: sitemapIndexXml.exists
  };
}

async function main() {
  // Note: Since sites.config.ts uses TypeScript, this is a simplified version
  // You'll need to run this manually or convert to TypeScript

  console.log('\n⚠️  This is a template script. To use it:');
  console.log('1. Check each old site manually:');
  console.log('   - Visit https://www.SITENAME.com/sitemap.xml');
  console.log('   - Visit https://www.SITENAME.com/sitemap_index.xml');
  console.log('2. If sitemap_index.xml exists, add to config:');
  console.log('   oldSitemapPath: \'/sitemap_index.xml\'');
  console.log('   newSitemapPath: \'/sitemap.xml\'');
  console.log('\nOr check the Jetpack/Yoast sitemap in browser for each site.\n');
}

main();
