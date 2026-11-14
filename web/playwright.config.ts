import { defineConfig } from '@playwright/test';

const customerState = process.env.FREEHOLD_CUSTOMER_STATE;
const adminState = process.env.FREEHOLD_ADMIN_STATE;
if (!customerState || !adminState) {
  throw new Error('Browser tests require FREEHOLD_CUSTOMER_STATE and FREEHOLD_ADMIN_STATE from scripts/phase6-browser.sh');
}

const desktop = { viewport: { width: 1280, height: 800 } };
const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: './test/browser',
  timeout: 90000,
  expect: { timeout: 45000 },
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.FREEHOLD_WEB_ORIGIN,
    channel: 'chrome',
    trace: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'desktop-public', testMatch: /public\.spec\.ts/, use: desktop },
    { name: 'mobile-public', testMatch: /public\.spec\.ts/, use: mobile },
    { name: 'desktop', dependencies: ['setup'], testIgnore: /admin\.spec\.ts|public\.spec\.ts|auth\.setup\.ts/, use: { ...desktop, storageState: customerState } },
    { name: 'mobile', dependencies: ['setup'], testIgnore: /admin\.spec\.ts|public\.spec\.ts|auth\.setup\.ts/, use: { ...mobile, storageState: customerState } },
    { name: 'desktop-admin', dependencies: ['setup'], testMatch: /admin\.spec\.ts/, use: { ...desktop, storageState: adminState } },
    { name: 'mobile-admin', dependencies: ['setup'], testMatch: /admin\.spec\.ts/, use: { ...mobile, storageState: adminState } },
  ],
});
