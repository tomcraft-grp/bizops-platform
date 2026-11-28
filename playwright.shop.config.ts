import { defineConfig } from '@playwright/test';

// Browser tests of the customer shop screens against a FAKE backend (tests/shop-e2e/fakeBackend.ts): the real build mode
// (no demo data), served by the Vite dev server. PW_CHANNEL=chrome (default) drives the system Google Chrome.
//   npx playwright test -c playwright.shop.config.ts
// SHOP_PORT=4180 runs it on another port, so a second worktree never reuses (and silently tests) another worktree's dev server.
const PORT = Number(process.env.SHOP_PORT ?? 4179);
export default defineConfig({
  testDir: 'tests/shop-e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: (process.env.PW_CHANNEL as 'chrome' | 'msedge') ?? 'chrome',
    viewport: { width: 390, height: 844 },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    acceptDownloads: true,
    screenshot: 'only-on-failure',
  },
  webServer: { command: `npx vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 120_000 },
});
