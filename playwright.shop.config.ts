import { defineConfig } from '@playwright/test';

// Browser tests of the customer shop screens against a FAKE backend (tests/shop-e2e/fakeBackend.ts): the real build mode
// (no demo data), served by the Vite dev server. PW_CHANNEL=chrome (default) drives the system Google Chrome.
//   npx playwright test -c playwright.shop.config.ts
export default defineConfig({
  testDir: 'tests/shop-e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4179',
    channel: (process.env.PW_CHANNEL as 'chrome' | 'msedge') ?? 'chrome',
    viewport: { width: 390, height: 844 },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    acceptDownloads: true,
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'npx vite --port 4179 --strictPort', url: 'http://localhost:4179', reuseExistingServer: true, timeout: 120_000 },
});
