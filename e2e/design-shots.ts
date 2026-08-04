import { chromium } from '@playwright/test';

const BASE = 'http://127.0.0.1:8799';
const OUT = '/home/user/pmlaw/e2e/screenshots';

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

  // Login page, light
  let page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/10-login-page.png` });

  // Dark mode: today + settlements
  const dark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  page = await dark.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Access code').fill('e2e-code');
  await page.getByRole('button', { name: /open pam/i }).click();
  await page.waitForSelector('.masthead');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/11-today-dark.png` });
  await page.goto(`${BASE}/settlements`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/12-settlements-dark.png`, fullPage: true });

  await browser.close();
  console.log('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
