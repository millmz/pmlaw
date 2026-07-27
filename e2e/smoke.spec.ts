import { expect, test } from '@playwright/test';

/**
 * M1 smoke: login → Today (Jeff's order, statute split) → Matters (ambiguity)
 * → matter page (notes verbatim) → chat-disabled honesty. Screenshots land in
 * e2e/screenshots/ for the milestone review.
 */

test('login gate: wrong code rejected, right code opens Today', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Access code').fill('wrong');
  await page.getByRole('button', { name: /open pam/i }).click();
  await expect(page.getByText(/isn’t right/i)).toBeVisible();

  await page.getByLabel('Access code').fill('e2e-code');
  await page.getByRole('button', { name: /open pam/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/01-login.png' });
});

test('Today renders Jeff’s order with statute reminders split out', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Today’s calendar')).toBeVisible();
  await expect(page.getByText('Up next')).toBeVisible();
  await expect(page.getByText('Clarkstown', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Overdue — needs a decision')).toBeVisible();
  // Statute section exists, is collapsed, and carries the leave-as-is label.
  const statute = page.locator('details.statute');
  await expect(statute.getByText('tracked — leave as-is')).toBeVisible();
  await expect(statute.getByText('Petrov', { exact: false }).first()).toBeHidden(); // collapsed by default
  await statute.locator('summary').click();
  await expect(statute.getByText('Petrov', { exact: false }).first()).toBeVisible();
  // Watchlist shows the stalled matters.
  await expect(page.getByText('Watchlist — no next step scheduled')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/02-today.png', fullPage: true });
});

test('Matters search flags ambiguity and matter page shows notes verbatim', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Matters' }).click();
  await page.getByLabel('Search matters').fill('Juan');
  await expect(page.getByText('Several matches')).toBeVisible();
  await expect(page.getByText('Delgado', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Santos', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/03-ambiguous.png' });

  await page.getByLabel('Search matters').fill('Grasso');
  await page.getByRole('link', { name: /Grasso/ }).click();
  await expect(page.getByText('Statute of limitations:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Notes' }).click();
  await expect(page.getByText('Demand: $250,000', { exact: false })).toBeVisible();
  await expect(page.getByText('Jeff Millman (JTM), last edited', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/04-matter-notes.png', fullPage: true });
});

test('mobile layout: tab bar navigation works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.locator('.tabbar').getByText('Matters').click();
  await expect(page.getByLabel('Search matters')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/05-mobile-today.png' });
});

test('chat is honest when no API key is configured', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByPlaceholder(/needs an api key/i)).toBeVisible();
  await expect(page.getByPlaceholder(/needs an api key/i)).toBeDisabled();
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Access code').fill('e2e-code');
  await page.getByRole('button', { name: /open pam/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
