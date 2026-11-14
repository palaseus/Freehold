import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const submittedTotp = new Map<string, string>();

function totp(secret: string): string {
  return execFileSync('node', ['-e', `const {TOTP,Secret}=require('otpauth'); const secret=Secret.fromBase32(process.argv[1]); process.stdout.write(new TOTP({issuer:'Freehold',label:'browser',algorithm:'SHA1',digits:6,period:30,secret}).generate());`, secret], { encoding: 'utf8' }).trim();
}

async function authenticatorCode(page: Page, secret: string): Promise<string> {
  const code = totp(secret);
  if (submittedTotp.get(secret) !== code) return code;
  // Redis keeps a used counter for 120 seconds. A second login in the same
  // 30-second step is rejected, so wait until the authenticator advances.
  await page.waitForTimeout(31000 - (Date.now() % 30000));
  const fresh = totp(secret);
  if (fresh === code) throw new Error('Authenticator code did not advance');
  return fresh;
}

async function signIn(page: Page, email: string, password: string, secret: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto('/login');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const code = await authenticatorCode(page, secret);
    submittedTotp.set(secret, code);
    await page.getByLabel(/Authenticator code/).fill(code);
    const login = page.waitForResponse(response =>
      response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign in securely' }).click();
    const response = await login;
    const overview = page.getByRole('heading', { name: 'Account overview' });
    if (response.ok()) {
      await expect(overview).toBeVisible();
      // Later cases must reuse the refreshed session, rather than repeatedly
      // reauthenticating the expired setup session against the login limiter.
      const state = email === process.env.FREEHOLD_ADMIN_EMAIL ? process.env.FREEHOLD_ADMIN_STATE
        : email === process.env.FREEHOLD_REVIEWER_EMAIL ? process.env.FREEHOLD_REVIEWER_STATE : undefined;
      if (state) await page.context().storageState({ path: state });
      return;
    }
    expect(response.status(), 'Only an expired or reused authenticator code may be retried').toBe(401);
    if (attempt === 1) throw new Error('Administrator login failed after a fresh authenticator code');
    await page.waitForTimeout(31000 - (Date.now() % 30000));
  }
}

async function openControl(page: Page, email: string, password: string, secret: string) {
  await page.goto('/admin');
  const expired = page.getByRole('heading', { name: 'Verify your access again.' });
  const ready = page.getByRole('heading', { name: 'Institutional control' });
  await expect(ready).toBeVisible();
  if (await expired.isVisible()) {
    await signIn(page, email, password, secret);
    await page.goto('/admin');
    await expect(expired).toBeHidden();
  }
  await expect(ready).toBeVisible();
}

test('an administrator sees measured health and non-filing reports', async ({ page }) => {
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  await expect(page.getByText('BACKUP / UNAVAILABLE', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Deployment' })).toBeVisible();
  await expect(page.getByText(/DEPLOYMENT STATUS \/ (NOT_READY|INCOMPLETE|UNAVAILABLE)/)).toBeVisible();
  await expect(page.getByText('LAST VERIFIED BACKUP / UNAVAILABLE')).toBeVisible();
  await expect(page.getByText('RECOVERY DRILL / UNAVAILABLE', { exact: true })).toBeVisible();
  await expect(page.getByText('DEADLOCK RETRIES / UNAVAILABLE')).toBeVisible();
  await expect(page.getByText('CREDENTIAL EXPIRATION / UNAVAILABLE')).toBeVisible();
  await expect(page.getByText('No issuance authority is active')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flags, policies, and cases' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'COMPLIANCE CASES' })).toBeVisible();
  await page.getByLabel('REPORT').selectOption('income-statement');
  await expect(page.getByText('NOT_A_REGULATORY_FILING')).toBeVisible();
  await expect(page.getByText('NOT_AVAILABLE').first()).toBeVisible();
  await page.getByLabel('REPORT').selectOption('balance-sheet');
  await expect(page.getByText('NOT_AVAILABLE').first()).toBeVisible();
});

test('an administrator reads simulated reserves, evidence, and prospective partners', async ({ page }) => {
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  await page.goto('/admin/reserves');
  await expect(page.getByRole('heading', { name: 'Simulated reserve position' })).toBeVisible();
  await expect(page.getByText('Simulated reserves are not real assets.')).toBeVisible();
  await expect(page.getByText('NOT_RUN_ON_THIS_SCREEN')).toBeVisible();
  await expect(page.getByText('External reserve evidence: NOT_REQUIRED.')).toBeVisible();
  await expect(page.getByText('No failed simulated settlement is stored.')).toBeVisible();
  const control = `P11-${Date.now()}`;
  const partnerName = `Prospective ${Date.now()}`;
  await page.goto('/admin/evidence');
  await expect(page.getByRole('heading', { name: 'Evidence room' })).toBeVisible();
  await expect(page.getByText('NOT_A_COMPLIANCE_DETERMINATION')).toBeVisible();
  await page.getByLabel('Control identifier').fill(control);
  await page.getByLabel('Regulatory citation').fill('12 U.S.C. 5901');
  await page.getByLabel('Source document').fill('Public Law 119-27');
  await page.getByLabel('Technical control').fill('Issuance stays simulated');
  await page.getByLabel('Linked test').fill('test/phase11-monetary.mjs');
  await page.getByLabel('Responsible role').fill('COMPLIANCE_OFFICER');
  await page.getByLabel('Deficiency').fill('External backing is not attached');
  await page.getByLabel('Evidence expiration').fill('2027-01-18');
  await page.getByRole('button', { name: 'Open control record' }).click();
  const opened = page.locator('article').filter({ hasText: control });
  await expect(opened).toBeVisible();
  await expect(opened.getByText('Technical NOT_RUN.')).toBeVisible();
  await expect(opened.getByText('Legal LEGAL_REVIEW_REQUIRED.')).toBeVisible();
  await expect(opened.getByText('Certification NOT_CERTIFIED.')).toBeVisible();
  await expect(opened.getByText('Regulatory NOT_SUBMITTED.')).toBeVisible();
  const recordLine = await opened.locator('p.mono').innerText();
  const evidenceId = recordLine.replace('Record ', '').trim();
  await page.getByLabel('Evidence identifier').fill(evidenceId);
  await page.getByLabel('Note').fill('Same person cannot review this record');
  await page.getByRole('button', { name: 'Record review note' }).click();
  await expect(page.getByText('MONETARY_SELF_APPROVAL')).toBeVisible();
  await page.goto('/admin/partners');
  await expect(page.getByRole('heading', { name: 'Prospective partners' })).toBeVisible();
  await expect(page.getByText('No banking partner is approved.')).toBeVisible();
  await page.getByLabel('Legal name').fill(partnerName);
  await page.getByRole('button', { name: 'Record a prospective partner' }).click();
  const partner = page.locator('article').filter({ hasText: partnerName });
  await expect(partner.getByText('Relationship: not confirmed.')).toBeVisible();
  await partner.getByRole('button', { name: 'Record IDENTITY for this partner' }).click();
  await expect(partner.getByText('IDENTITY: Recorded, not confirmed.')).toBeVisible();
  await expect(partner.getByText('Relationship: not confirmed.')).toBeVisible();
});

test('an administrator opens two simulated institutional tenants', async ({ page }) => {
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  await page.goto('/admin/platform');
  await expect(page.getByRole('heading', { name: 'Simulated institutional sandbox' })).toBeVisible();
  await expect(page.getByText('These tenants do not share accounts, customers, or ledger records.')).toBeVisible();
  await expect(page.getByText('Live rails are off.')).toBeVisible();
  const stamp = Date.now();
  const north = `north-${stamp}`;
  const harbor = `harbor-${stamp}`;
  await page.getByLabel('Tenant code').fill(north);
  await page.getByLabel('Legal name').fill(`Northwind Sandbox ${stamp}`);
  await page.getByRole('button', { name: 'Open simulated institution' }).click();
  await expect(page.getByText(`Northwind Sandbox ${stamp}`)).toBeVisible();
  await page.getByLabel('Tenant code').fill(harbor);
  await page.getByLabel('Legal name').fill(`Harbor Sandbox ${stamp}`);
  await page.getByRole('button', { name: 'Open simulated institution' }).click();
  await expect(page.getByText(`Harbor Sandbox ${stamp}`)).toBeVisible();
  await expect(page.getByText('Live authorized: no.').first()).toBeVisible();
  const dashboard = page.waitForResponse(
    response => response.url().includes('/v1/institution/network/dashboard') && response.request().method() === 'GET',
    { timeout: 45000 },
  );
  await page.goto('/admin/network');
  const dashboardResponse = await dashboard;
  expect(dashboardResponse.ok(), `dashboard HTTP ${dashboardResponse.status()}`).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Simulated financial network' })).toBeVisible();
  await expect(page.getByText('Live rails are off.')).toBeVisible();
  await expect(page.getByText('SIMULATED NETWORK', { exact: true })).toBeVisible();
  await expect(page.getByText('No simulated network cycle is recorded.')).toBeVisible();
  await expect(page.getByText('Independent verification stored: no.')).toBeVisible();
  await expect(page.getByText('Live authorized: no.').first()).toBeVisible();
  const programDashboard = page.waitForResponse(
    response => response.url().includes('/v1/institution/program/dashboard') && response.request().method() === 'GET',
    { timeout: 45000 },
  );
  await page.goto('/admin/program');
  const programResponse = await programDashboard;
  expect(programResponse.ok(), `program dashboard HTTP ${programResponse.status()}`).toBeTruthy();
  await expect(page.getByRole('heading', { name: 'Simulated programmable finance' })).toBeVisible();
  await expect(page.getByText('SIMULATED PROGRAM', { exact: true })).toBeVisible();
  await expect(page.getByText('Preview is not execution.')).toBeVisible();
  await expect(page.getByText('Live rails are off.')).toBeVisible();
  await expect(page.getByText('No simulated workflow is recorded.')).toBeVisible();
  await page.getByLabel('Maximum exposure').fill('2500');
  await page.getByRole('button', { name: 'Build definition' }).click();
  const definitionPreview = page.locator('pre');
  await expect(definitionPreview).toBeVisible();
  const declaration = JSON.parse(await definitionPreview.innerText());
  expect(declaration.definition.language).toBe('fh-workflow-1');
  expect(declaration.maxExposureMinor).toBe('2500');
  expect(declaration.preview).toBe(true);
  expect(declaration.executed).toBe(false);
  expect(declaration.committedSandboxAccounting).toBe(false);
  await expect(page.getByText('This preview did not post.')).toBeVisible();
  await page.goto('/developers');
  await expect(page.getByRole('heading', { name: 'Sandbox API' })).toBeVisible();
  await expect(page.getByText('not-a-real-secret')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Simulated network' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Programmable sandbox' })).toBeVisible();
  await expect(page.getByText('AT_LEAST_ONCE_ATTEMPT_NOT_EXACTLY_ONCE')).toBeVisible();
});

test('an operator opens an operational incident', async ({ page }) => {
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  await page.getByRole('button', { name: 'Evaluate monitor' }).click();
  await expect(page.getByText('backup-telemetry').first()).toBeVisible();
  await expect(page.getByText(/Unavailable is not a recent backup/).first()).toBeVisible();
  await page.getByLabel('Incident title').fill('Reconciliation watch');
  await page.getByLabel('Incident summary').fill('Operational drill. This is not a customer misconduct case.');
  await page.getByRole('button', { name: 'Open incident' }).click();
  await expect(page.getByText('OPERATIONAL / OPEN / HIGH').first()).toBeVisible();
  await page.getByLabel('Investigation note').fill('Containment is observation only.');
  await page.getByRole('button', { name: 'Record containment' }).click();
  await expect(page.getByText('OPERATIONAL / CONTAINED / HIGH').first()).toBeVisible();
});

test('a freeze requires a second operator', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name.startsWith('mobile'), 'Dual control is exercised once on desktop.');
  const payee = process.env.FREEHOLD_PAYEE_EMAIL ?? '';
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  await page.getByLabel(/FIND ACCOUNT/).fill(payee);
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Request freeze' }).click();
  await page.getByLabel('Reason for this request').fill('Browser dual-control drill.');
  await page.getByRole('button', { name: 'Submit for independent approval' }).click();
  await expect(page.getByText('Request recorded.')).toBeVisible();
  const reviewerContext = await browser.newContext({ storageState: process.env.FREEHOLD_REVIEWER_STATE });
  const reviewer = await reviewerContext.newPage();
  await openControl(reviewer, process.env.FREEHOLD_REVIEWER_EMAIL ?? '', process.env.FREEHOLD_REVIEWER_PASSWORD ?? '', process.env.FREEHOLD_REVIEWER_TOTP_SECRET ?? '');
  await reviewer.getByRole('button', { name: 'Approve' }).click();
  await expect(reviewer.getByText(/FREEZE_ACCOUNT \/ APPROVED|FREEZE_ACCOUNT \/ EXECUTED/).first()).toBeVisible();
  await page.reload();
  await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
  const execute = page.getByRole('button', { name: 'Execute approved action' });
  await expect(execute).toBeVisible();
  await execute.click();
  await expect(page.getByText(/FREEZE_ACCOUNT \/ EXECUTED/).first()).toBeVisible();
  await page.getByLabel(/FIND ACCOUNT/).fill(payee);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('FROZEN', { exact: true }).first()).toBeVisible();
  await reviewerContext.close();
});

test('emergency suspension blocks a transfer until an independent resume', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-admin', 'Suspension runs once on desktop and resumes before later tests.');
  test.setTimeout(180000);
  const reason = 'Browser emergency drill. Not a customer incident.';
  let resumed = false;
  try {
    await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
    const suspend = page.getByRole('button', { name: 'Suspend financial writes' });
    await expect(suspend).toBeVisible();
    page.once('dialog', dialog => dialog.accept(reason));
    await page.getByRole('button', { name: 'Suspend financial writes' }).click();
    await expect(page.getByText(`SUSPENDED / ${reason}`)).toBeVisible();
    const customerContext = await browser.newContext({ storageState: process.env.FREEHOLD_CUSTOMER_STATE });
    const customer = await customerContext.newPage();
    await customer.goto('/transfer');
    await customer.getByLabel('Destination account ID').fill(process.env.FREEHOLD_OPEN_DESTINATION_ACCOUNT_ID ?? '');
    await customer.getByLabel(/Amount/).fill('3');
    await customer.getByRole('button', { name: 'Submit transfer' }).click();
    await expect(customer.getByRole('heading', { name: 'Outcome unknown.' })).toBeVisible();
    await expect(customer.getByRole('paragraph').filter({ hasText: /^FINANCIAL_WRITES_SUSPENDED$/ })).toBeVisible();
    await expect(customer.getByRole('definition').filter({ hasText: /^FINANCIAL_WRITES_SUSPENDED$/ })).toBeVisible();
    await expect(customer.getByRole('heading', { name: 'Transfer recorded.' })).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept('Browser recovery evidence for dual-controlled resume.'));
    await page.getByRole('button', { name: 'Request dual-controlled resume' }).click();
    const reviewerContext = await browser.newContext({ storageState: process.env.FREEHOLD_REVIEWER_STATE });
    const reviewer = await reviewerContext.newPage();
    await openControl(reviewer, process.env.FREEHOLD_REVIEWER_EMAIL ?? '', process.env.FREEHOLD_REVIEWER_PASSWORD ?? '', process.env.FREEHOLD_REVIEWER_TOTP_SECRET ?? '');
    await reviewer.getByRole('button', { name: 'Approve' }).click();
    await expect(reviewer.getByText(/RESUME_WRITES \/ APPROVED/).first()).toBeVisible();
    await page.reload();
    await openControl(page, process.env.FREEHOLD_ADMIN_EMAIL ?? '', process.env.FREEHOLD_ADMIN_PASSWORD ?? '', process.env.FREEHOLD_ADMIN_TOTP_SECRET ?? '');
    await page.getByRole('button', { name: 'Execute approved action' }).click();
    await expect(page.getByText('ACTIVE / FINANCIAL WRITES ENABLED')).toBeVisible();
    resumed = true;
    await customer.getByRole('button', { name: 'Retry identical request' }).click();
    await expect(customer.getByRole('heading', { name: 'Transfer recorded.' })).toBeVisible();
    await reviewerContext.close();
    await customerContext.close();
  } finally {
    if (!resumed && process.env.FREEHOLD_PG_URL && process.env.FREEHOLD_REPO_ROOT) {
      execFileSync(process.execPath, ['-e', `const {Client}=require('pg'); (async()=>{const c=new Client({connectionString:process.env.FREEHOLD_PG_URL}); await c.connect(); try { await c.query("UPDATE freehold.institutional_control SET writes_suspended=false, resumed_at=clock_timestamp(), suspension_reason=NULL, suspended_by=NULL, suspended_at=NULL WHERE singleton AND writes_suspended"); } finally { await c.end(); }})().catch(()=>{process.stderr.write('resume safety net failed\\n'); process.exit(1);});`], { cwd: process.env.FREEHOLD_REPO_ROOT, env: process.env });
    }
  }
});
