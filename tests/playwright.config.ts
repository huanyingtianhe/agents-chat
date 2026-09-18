import { defineConfig, devices } from '@playwright/test';

const mobileSpecs = [
  '**/mobile-responsive.spec.ts',
  '**/mobile-composer-viewport.spec.ts',
];

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  timeout: 180000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3010',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: mobileSpecs,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'android-chromium',
      testMatch: mobileSpecs,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'iphone-webkit',
      testMatch: mobileSpecs,
      use: { ...devices['iPhone 14 Pro Max'] },
    },
  ],
});
