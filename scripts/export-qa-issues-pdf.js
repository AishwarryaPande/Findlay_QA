const path = require('node:path');
const { chromium } = require('@playwright/test');

(async () => {
  const root = process.cwd();
  const htmlPath = path.resolve(root, 'reports', 'qa-issues-detail.html');
  const pdfPath = path.resolve(root, 'reports', 'qa-issues-detail-with-images.pdf');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'screen' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
  });
  await browser.close();

  // eslint-disable-next-line no-console
  console.log(pdfPath);
})();
