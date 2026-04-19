import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 180000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3010',
    headless: true,
    screenshot: 'only-on-failure',
  },
});
