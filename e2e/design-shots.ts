import { chromium, type Browser, type Page } from '@playwright/test';

/**
 * Design review shots — every screen, in light, dark and on a phone.
 *   npx tsx e2e/design-shots.ts            (server on :8799, code e2e-code)
 *   SHOT_BASE=… SHOT_CODE=… SHOT_OUT=… SHOT_SCALE=2 npx tsx e2e/design-shots.ts
 */
const BASE = process.env['SHOT_BASE'] ?? 'http://127.0.0.1:8799';
const CODE = process.env['SHOT_CODE'] ?? 'e2e-code';
const OUT = process.env['SHOT_OUT'] ?? 'e2e/screenshots/design';
const SCALE = Number(process.env['SHOT_SCALE'] ?? 1);

const PAGES: [name: string, path: string][] = [
  ['today', '/'],
  ['tasks', '/tasks'],
  ['matters', '/matters'],
  ['settlements', '/settlements'],
  ['activity', '/activity'],
  ['settings', '/settings'],
  ['chat', '/chat'],
];

async function signIn(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Access code').fill(CODE);
  await page.getByRole('button', { name: /open pam/i }).click();
  await page.waitForSelector('.docket-head');
}

async function tour(browser: Browser, tag: string, viewport: { width: number; height: number }, colorScheme: 'light' | 'dark') {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: SCALE });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${tag}-login.png` });
  await signIn(page);
  for (const [name, path] of PAGES) {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
  }
  // A matter, the command palette and the user menu.
  await page.goto(`${BASE}/matters`);
  await page.getByLabel('Search matters').fill('Grasso');
  await page.getByRole('link', { name: /Grasso/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${tag}-matter.png` });
  await page.getByRole('button', { name: 'Notes' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${tag}-matter-notes.png` });
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.docket-head');
  await page.getByRole('button', { name: 'Open search' }).click();
  await page.getByPlaceholder(/Search matters, jump/).fill('hug');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${tag}-palette.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Account and preferences' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${tag}-menu.png` });
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env['PW_CHROMIUM'] ?? '/opt/pw-browsers/chromium' });
  await tour(browser, 'light', { width: 1440, height: 900 }, 'light');
  await tour(browser, 'dark', { width: 1440, height: 900 }, 'dark');
  await tour(browser, 'phone', { width: 390, height: 844 }, 'light');
  await browser.close();
  console.log('done');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
