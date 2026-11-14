import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const customerEmail = process.env.FREEHOLD_CUSTOMER_EMAIL ?? '';
const customerPassword = process.env.FREEHOLD_CUSTOMER_PASSWORD ?? '';
const adminEmail = process.env.FREEHOLD_ADMIN_EMAIL ?? '';
const adminPassword = process.env.FREEHOLD_ADMIN_PASSWORD ?? '';
const adminSecret = process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '';
const reviewerEmail = process.env.FREEHOLD_REVIEWER_EMAIL ?? '';
const reviewerPassword = process.env.FREEHOLD_REVIEWER_PASSWORD ?? '';
const reviewerSecret = process.env.FREEHOLD_REVIEWER_TOTP_SECRET ?? '';
const customerState = process.env.FREEHOLD_CUSTOMER_STATE ?? '';
const adminState = process.env.FREEHOLD_ADMIN_STATE ?? '';
const reviewerState = process.env.FREEHOLD_REVIEWER_STATE ?? '';

function totp(secret: string): string {
  return execFileSync('node', ['-e', `const {TOTP,Secret}=require('otpauth'); const secret=Secret.fromBase32(process.argv[1]); process.stdout.write(new TOTP({issuer:'Freehold',label:'browser',algorithm:'SHA1',digits:6,period:30,secret}).generate());`, secret], { encoding: 'utf8' }).trim();
}

test.beforeAll(() => {
  if (!customerEmail || !customerPassword || !adminEmail || !adminPassword || !adminSecret || !reviewerEmail || !reviewerPassword || !reviewerSecret || !customerState || !adminState || !reviewerState) {
    throw new Error('Browser setup requires the disposable FREEHOLD_* environment from scripts/phase6-browser.sh');
  }
});

test('store a customer session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(customerEmail);
  await page.getByLabel('Password', { exact: true }).fill(customerPassword);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await page.context().storageState({ path: customerState });
});

test('store an administrator session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByLabel(/Authenticator code/).fill(totp(adminSecret));
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await page.context().storageState({ path: adminState });
});

test('store a financial reviewer session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email address').fill(reviewerEmail);
  await page.getByLabel('Password', { exact: true }).fill(reviewerPassword);
  await page.getByLabel(/Authenticator code/).fill(totp(reviewerSecret));
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await page.context().storageState({ path: reviewerState });
});
