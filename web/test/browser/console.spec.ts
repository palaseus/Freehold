import { expect, test } from '@playwright/test';

const destinationAccountId = process.env.FREEHOLD_DESTINATION_ACCOUNT_ID ?? '';

test.beforeAll(() => {
  if (!destinationAccountId) throw new Error('Browser tests require FREEHOLD_DESTINATION_ACCOUNT_ID');
});

test('customer can read accounts, history, schedule, and controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  for (const [href, heading] of [['/transfer', 'Internal transfer'], ['/activity', 'Recorded activity'], ['/statement', 'Account statement'], ['/schedule', 'Scheduled transfers'], ['/controls', 'Transfer controls']] as const) {
    await page.goto(href);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.goto('/transfer');
  const destination = page.getByLabel('Destination account ID');
  await expect(destination).toBeVisible();
  await destination.fill('not-a-uuid');
  await page.getByLabel(/Amount/).fill('1');
  await page.getByRole('button', { name: 'Submit transfer' }).click();
  await expect.poll(() => destination.evaluate((element: HTMLInputElement) => element.validity.patternMismatch)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Transfer recorded.' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Outcome unknown.' })).toHaveCount(0);
});

test('a lost transfer response stays unknown', async ({ page }) => {
  await page.goto('/transfer');
  await page.route('**/api/v1/transfers', route => route.abort());
  await expect(page.getByRole('button', { name: 'Submit transfer' })).toBeEnabled();
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel(/Amount/).fill('1');
  await page.getByRole('button', { name: 'Submit transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Outcome unknown.' })).toBeVisible();
  await expect(page.getByText('UNKNOWN', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transfer recorded.' })).toHaveCount(0);
});

test('a missing session cookie is treated as signed out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your session needs attention.' })).toBeVisible();
  await expect(page.getByText('AVAILABLE TO MOVE')).toHaveCount(0);
});

test('signing out expires the visible session', async ({ page }) => {
  // A second login keeps the stored session valid for the other tests.
  await page.goto('/login');
  await page.getByLabel('Email address').fill(process.env.FREEHOLD_CUSTOMER_EMAIL ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env.FREEHOLD_CUSTOMER_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await page.getByRole('button', { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your session needs attention.' })).toBeVisible();
});

test('a customer cannot open institutional control', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Institution access required.' })).toBeVisible();
  await expect(page.getByText('BACKUP /')).toHaveCount(0);
  await page.goto('/admin/ledger');
  await expect(page.getByRole('heading', { name: 'Institution access required.' })).toBeVisible();
  for (const path of ['/admin/reserves', '/admin/evidence', '/admin/partners', '/admin/platform', '/admin/network', '/admin/program']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Institution access required.' })).toBeVisible();
  }
});

test('a customer can read the sandbox developer page', async ({ page }) => {
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Sandbox API' })).toBeVisible();
  await expect(page.getByText('not-a-real-secret')).toBeVisible();
  await expect(page.getByText('AT_LEAST_ONCE_ATTEMPT_NOT_EXACTLY_ONCE')).toBeVisible();
  await expect(page.getByText('SANDBOX', { exact: true })).toBeVisible();
});

test('mobile layout keeps the account heading on screen', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'mobile viewport only');
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
});
