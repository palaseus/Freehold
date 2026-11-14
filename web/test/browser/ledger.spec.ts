import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const destinationAccountId = process.env.FREEHOLD_DESTINATION_ACCOUNT_ID ?? '';
const customerAccountId = process.env.FREEHOLD_CUSTOMER_ACCOUNT_ID ?? '';

test.beforeAll(() => {
  if (!destinationAccountId || !customerAccountId) throw new Error('Browser ledger tests require seeded account ids');
});

async function availableText(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  const amount = page.locator('.account-available .money').first();
  await expect(amount).toBeVisible();
  return (await amount.innerText()).trim();
}

test('a customer transfer posts and the overview reads the new balance', async ({ page }) => {
  const before = await availableText(page);
  await page.goto('/transfer');
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel(/Amount/).fill('1');
  await page.getByRole('button', { name: 'Submit transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Transfer recorded.' })).toBeVisible();
  await expect(page.getByText('COMMITTED', { exact: true })).toBeVisible();
  const after = await availableText(page);
  expect(after).not.toBe(before);
  expect(after).not.toBe('Precision unavailable');
});

test('a statement, CSV, and PDF come from the posted ledger', async ({ page }) => {
  await page.goto('/statement');
  await expect(page.getByRole('heading', { name: 'Account statement' })).toBeVisible();
  await page.getByRole('button', { name: 'Read statement' }).click();
  await expect(page.getByRole('heading', { name: 'Statement', exact: true })).toBeVisible();
  await expect(page.getByText(/INTERNAL_TRANSFER|SANDBOX_FUND/).first()).toBeVisible();
  const query = new URL(page.url()).search || '';
  const csv = await page.request.get(`/api/v1/accounts/${customerAccountId}/statement.csv?from=${new Date().toISOString().slice(0, 7)}-01&to=${new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10)}`);
  expect(csv.status(), query).toBe(200);
  expect(csv.headers()['content-type'] ?? '').toContain('text/csv');
  const csvBody = await csv.text();
  expect(csvBody).toMatch(/INTERNAL_TRANSFER|SANDBOX_FUND/);
  const pdf = await page.request.get(`/api/v1/accounts/${customerAccountId}/statement.pdf?from=${new Date().toISOString().slice(0, 7)}-01&to=${new Date(Date.now() + 32 * 86400000).toISOString().slice(0, 10)}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type'] ?? '').toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString('utf8')).toBe('%PDF-');
});

test('another customer statement and a forged account id are refused', async ({ page }) => {
  const foreign = await page.request.get(`/api/v1/accounts/${destinationAccountId}/statement?from=2026-11-01&to=2026-12-01`);
  expect(foreign.status()).toBe(403);
  const forged = await page.request.get('/api/v1/accounts/00000000-0000-4000-8000-000000000099/statement?from=2026-11-01&to=2026-12-01');
  expect([403, 404]).toContain(forged.status());
  await page.goto('/transfer');
  await page.getByLabel('Destination account ID').fill('00000000-0000-4000-8000-000000000099');
  await page.getByLabel(/Amount/).fill('1');
  await page.getByRole('button', { name: 'Submit transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Request rejected.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transfer recorded.' })).toHaveCount(0);
});

test('a due schedule is executed by the scheduler process', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'The posting is proven once on desktop. Mobile covers the same form.');
  test.setTimeout(180000);
  await page.goto('/schedule');
  await expect(page.getByRole('heading', { name: 'Scheduled transfers' })).toBeVisible();
  const when = new Date(Date.now() + 45_000).toISOString();
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel('Amount in minor units').fill('2');
  await page.getByLabel('Next execution, UTC ISO-8601').fill(when);
  await page.getByRole('button', { name: 'Schedule transfer' }).click();
  await expect(page.getByText(/ONCE \/ ACTIVE/).first()).toBeVisible();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Read again' }).click();
    return page.getByText(/COMPLETED/).count();
  }, { timeout: 120000, intervals: [2000, 2000, 3000] }).toBeGreaterThan(0);
});

test('cancelling a future schedule leaves it unexecuted', async ({ page }) => {
  await page.goto('/schedule');
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel('Amount in minor units').fill('17');
  await page.getByLabel('Next execution, UTC ISO-8601').fill(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
  await page.getByRole('button', { name: 'Schedule transfer' }).click();
  const card = page.locator('article', { hasText: '0.17' }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Cancel before execution' }).click();
  await expect(card).toContainText('CANCELLED');
  await expect(card).not.toContainText('COMPLETED');
});

test('a daily instruction advances and a future daily instruction can be cancelled', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Recurring advancement and cancellation run once on desktop.');
  test.setTimeout(240000);
  await page.goto('/schedule');
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel('Amount in minor units').fill('4');
  await page.getByLabel('Cadence').selectOption('DAILY');
  const when = new Date(Date.now() + 45_000).toISOString();
  await page.getByLabel('Next execution, UTC ISO-8601').fill(when);
  await page.getByRole('button', { name: 'Schedule transfer' }).click();
  const card = page.locator('article', { hasText: '0.04' }).first();
  await expect(card).toContainText('DAILY / ACTIVE');
  const before = ((await card.innerText()).match(/NEXT\s+(\S+)/) ?? [])[1];
  expect(before).toBeTruthy();
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Read again' }).click();
    const text = await card.innerText();
    const next = (text.match(/NEXT\s+(\S+)/) ?? [])[1];
    return text.includes('DAILY / ACTIVE') && text.includes('History:') && next && next !== before ? 'advanced' : 'waiting';
  }, { timeout: 120000, intervals: [2000, 2000, 3000] }).toBe('advanced');
  await page.getByLabel('Amount in minor units').fill('19');
  await page.getByLabel('Cadence').selectOption('DAILY');
  await page.getByLabel('Next execution, UTC ISO-8601').fill(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
  await page.getByRole('button', { name: 'Schedule transfer' }).click();
  const future = page.locator('article', { hasText: '0.19' }).first();
  await expect(future).toBeVisible();
  await future.getByRole('button', { name: 'Cancel before execution' }).click();
  await expect(future).toContainText('CANCELLED');
  await expect(future).not.toContainText('COMPLETED');
});

test('a killed scheduler does not post and the replacement posts once', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The scheduler crash drill runs once and leaves a replacement process.');
  test.setTimeout(240000);
  const pid = Number(process.env.FREEHOLD_SCHEDULER_PID);
  const pidFile = process.env.FREEHOLD_SCHEDULER_PID_FILE ?? '';
  const root = process.env.FREEHOLD_REPO_ROOT ?? '';
  expect(pid).toBeGreaterThan(1);
  expect(pid).not.toBe(process.pid);
  expect(pidFile).not.toBe('');
  expect(root).not.toBe('');
  await page.goto('/schedule');
  await page.getByLabel('Destination account ID').fill(destinationAccountId);
  await page.getByLabel('Amount in minor units').fill('6');
  await page.getByLabel('Next execution, UTC ISO-8601').fill(new Date(Date.now() + 45_000).toISOString());
  await page.getByRole('button', { name: 'Schedule transfer' }).click();
  const card = page.locator('article', { hasText: '0.06' }).first();
  await expect(card).toContainText('ONCE / ACTIVE');
  process.kill(pid, 'SIGKILL');
  await page.waitForTimeout(55_000);
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(card).toContainText('ONCE / ACTIVE');
  await expect(card).not.toContainText('COMPLETED');
  const env = { ...process.env, SCHEDULER_POLL_MS: '1000' };
  delete env.DATABASE_URL;
  delete env.AUTH_DATABASE_URL;
  const child = spawn(process.execPath, ['dist/src/scheduler.js'], { cwd: root, detached: true, stdio: 'ignore', env });
  child.unref();
  expect(child.pid).toBeGreaterThan(1);
  appendFileSync(pidFile, `${child.pid}\n`);
  process.env.FREEHOLD_SCHEDULER_PID = String(child.pid);
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Read again' }).click();
    return card.innerText();
  }, { timeout: 90000, intervals: [1000, 2000, 3000] }).toContain('ONCE / COMPLETED');
  const history = await card.getByText(/History:/).innerText();
  expect(history.match(/COMPLETED/g)?.length).toBe(1);
});

test('saved account controls are read back from the ledger', async ({ page }) => {
  await page.goto('/controls');
  await expect(page.getByRole('heading', { name: 'Transfer controls' })).toBeVisible();
  await page.getByLabel('Personal per-transfer limit, minor units').fill('5000');
  await page.getByRole('button', { name: 'Save controls' }).click();
  await page.reload();
  await expect(page.getByLabel('Personal per-transfer limit, minor units')).toHaveValue('5000');
});

test('mobile schedule and statement pages stay within the viewport', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'mobile viewport only');
  for (const path of ['/schedule', '/statement', '/transfer']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
