import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // One retry in CI only: this suite launches real Chromium processes, and a
  // shared/CI box under memory pressure occasionally stalls a fresh
  // browser context past the timeout with no app-level cause — confirmed by
  // running the whole suite dozens of times back to back without a single
  // repeatable (i.e. non-environmental) failure. Never masks a real bug: a
  // genuine assertion failure fails identically on retry.
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://127.0.0.1:8787', acceptDownloads: true },
  webServer: {
    command: 'npm run build && NODE_ENV=production node dist/server/index.js',
    url: 'http://127.0.0.1:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
