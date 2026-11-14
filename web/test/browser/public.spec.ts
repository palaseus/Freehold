import { expect, test } from '@playwright/test';

const customerEmail = process.env.FREEHOLD_CUSTOMER_EMAIL ?? '';

test('unauthenticated pages do not show an account balance', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your session needs attention.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Sign in securely/ })).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Your session needs attention.' })).toBeVisible();
  await expect(page.getByText('AVAILABLE TO MOVE')).toHaveCount(0);
});

test('login form keeps invalid input on the page', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email address')).toHaveAttribute('type', 'email');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email address').fill(customerEmail);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password-value');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('wrong-password-value');
});
