import { expect, test } from '@playwright/test';

/**
 * M2 smoke: login → Today (day tabs, quiet layout, real density) → Tasks
 * (overdue + statute home) → Move-to-chat prefill → Matters ambiguity →
 * notes verbatim → text-size toggle → mobile tabs → chat honesty.
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

test('Today is quiet and big: one day, its tasks, nothing else', async ({ page }) => {
  await login(page);
  // Day tabs present, Today active.
  await expect(page.getByRole('tab', { name: /Today/ })).toBeVisible();
  // Schedule at real density with the first court appearance.
  await expect(page.getByText('Clarkstown', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('6 events')).toBeVisible();
  // Tasks due today at Jeff's real volume.
  await expect(page.getByText('Tasks due today')).toBeVisible();
  await expect(page.locator('.card').filter({ hasText: 'Tasks due today' }).locator('.count')).toHaveText('11');
  // The noise is gone from the home page.
  await expect(page.getByText('Up next')).toHaveCount(0);
  await expect(page.getByText('needs a decision')).toHaveCount(0);
  await expect(page.locator('details.statute')).toHaveCount(0); // statute section lives on /tasks now
  await expect(page.getByText('Watchlist')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/02-today.png', fullPage: true });
});

test('day tabs switch the calendar to that day', async ({ page }) => {
  await login(page);
  // Second tab is tomorrow (a weekday in golden data: Tuesday Jul 28).
  const tabs = page.locator('.daytab');
  await tabs.nth(1).click();
  await expect(page.getByText(/calendar$/).first()).toBeVisible(); // "…, July 28 calendar"
  await expect(page.getByText('Deposition of plaintiff - Okafor', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/03-daytab.png' });
});

test('Tasks page holds due today, overdue split, and statute reminders', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Tasks' }).first().click();
  await expect(page.getByText('Due today')).toBeVisible();
  await expect(page.getByText('Overdue — needs a decision')).toBeVisible();
  await expect(page.getByText('22d late')).toBeVisible();
  const statute = page.locator('details.statute');
  await expect(statute.getByText('tracked — leave as-is')).toBeVisible();
  await statute.locator('summary').click();
  await expect(statute.getByText('Petrov', { exact: false }).first()).toBeVisible();
  // Statute rows carry no Move button; regular rows do.
  await expect(statute.getByRole('button', { name: 'Move to…' })).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/04-tasks.png', fullPage: true });
});

test('Move to… opens chat pre-filled with the reschedule ask', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Tasks' }).first().click();
  await page.getByRole('button', { name: 'Move to…' }).first().click();
  await expect(page).toHaveURL(/\/chat/);
  const input = page.getByLabel('Message PAM');
  await expect(input).toHaveValue(/^Move ".+" to $/);
});

test('Matters (under More) flags ambiguity; notes render verbatim', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Matters' }).click();
  await page.getByLabel('Search matters').fill('Juan');
  await expect(page.getByText('Several matches')).toBeVisible();
  await page.getByLabel('Search matters').fill('Grasso');
  await page.getByRole('link', { name: /Grasso/ }).click();
  await expect(page.getByText('Statute of limitations:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Notes' }).click();
  await expect(page.getByText('Demand: $250,000', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/05-matter-notes.png' });
});

test('text-size toggle enlarges the app and persists', async ({ page }) => {
  await login(page);
  await page.locator('.ts-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-ts', 'lg');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ts', 'lg');
  await page.screenshot({ path: 'e2e/screenshots/06-large-text.png', fullPage: true });
});

test('mobile: four tabs + More, Tasks reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.locator('.tabbar').getByText('Tasks').click();
  await expect(page.getByText('Overdue — needs a decision')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/07-mobile.png', fullPage: true });
});

test('mobile: the orb room fits the phone — no sideways scroll, controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('.tabbar').getByText('PAM').click();
  await expect(page.locator('.orb-canvas')).toBeVisible();
  // Nothing may push the page wider than the phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Command row and input are reachable, and diagnostics reports the
  // gesture-unlock state we rely on for iOS playback.
  await page.getByRole('button', { name: '[ system check ]' }).click();
  await expect(page.locator('.orb-diag')).toContainText('playback unlocked');
  await page.screenshot({ path: 'e2e/screenshots/15-mobile-orb.png' });
});

test('Settlement board renders ranked cases with statuses, liens, and tap-to-call', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settle' }).first().click();
  // Hughes first (most recent negotiation), with the trap case honestly labeled.
  await expect(page.getByText('Marcus Hughes')).toBeVisible();
  await expect(page.getByText('In negotiation').first()).toBeVisible();
  await expect(page.getByText('sending unverified').first()).toBeVisible();
  await expect(page.getByText('$97,000.00')).toBeVisible(); // Okafor lien
  await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/08-settlements.png', fullPage: true });
});

test('the orb room: full-page takeover, reactor canvas, honest diagnostics', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'PAM', exact: true }).click();
  await expect(page).toHaveURL(/\/pam/);
  await expect(page.locator('.orb-canvas')).toBeVisible();
  await expect(page.locator('.rail')).toHaveCount(0); // takeover: no app chrome
  // With no API key, the status line says so instead of pretending.
  await expect(page.locator('.orb-status')).toContainText('API KEY');
  // Voice unavailability surfaces real reasons, not silence:
  await page.getByRole('button', { name: '[ system check ]' }).click();
  await expect(page.locator('.orb-diag')).toContainText('voice path: browser'); // no ElevenLabs key in E2E
  await expect(page.locator('.orb-diag')).toContainText('recognition:');
  await expect(page.locator('.orb-diag')).toContainText('microphone:');
  await page.screenshot({ path: 'e2e/screenshots/13-orb.png' });
  await page.getByText('[ ← back ]').click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('settings: Jeff can edit who PAM is, and it round-trips', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  const identity = page.getByLabel('Who PAM is');
  await expect(identity).toHaveValue(/You are PAM/);
  await identity.fill('You are PAM. E2E_EDIT_SENTINEL.');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.locator('.pill.ok').first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Who PAM is')).toHaveValue(/E2E_EDIT_SENTINEL/);
  await page.screenshot({ path: 'e2e/screenshots/14-settings.png', fullPage: true });
});

test('Hurricane mode: the settings toggle dresses the accents and persists', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await page.getByLabel('Hurricane mode').check();
  await expect(page.locator('body')).toHaveAttribute('data-canes', '1');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-canes', '1');
  await page.goto('/');
  await expect(page.getByText('Tasks due today')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/19-hurricane-mode.png', fullPage: true });
  await page.goto('/settings');
  await page.getByLabel('Hurricane mode').uncheck();
  await expect(page.locator('body')).toHaveAttribute('data-canes', '');
});

test('chat is honest when no API key is configured', async ({ page }) => {
  await login(page);
  await page.locator('.tabbar, .rail').first();
  await page.getByRole('link', { name: 'Chat' }).first().click();
  await expect(page.getByPlaceholder(/needs an api key/i)).toBeVisible();
  await expect(page.getByPlaceholder(/needs an api key/i)).toBeDisabled();
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Access code').fill('e2e-code');
  await page.getByRole('button', { name: /open pam/i }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
