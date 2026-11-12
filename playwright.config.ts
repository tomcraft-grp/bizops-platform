import { defineConfig } from '@playwright/test';

// E2E runs against the PRODUCTION build served locally. It drives the system Google Chrome (PW_CHANNEL=chrome; set PW_CHANNEL=msedge to use Edge). Edge headless failed to launch on the development machine.
// The clock is pinned per test (see tests/e2e/helpers.ts) so the seeded business, dates and screenshots are reproducible.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'qa/results/e2e.json' }]],
  snapshotPathTemplate: 'qa/VISUAL_BASELINES/{arg}-{projectName}{ext}',
  use: {
    baseURL: 'http://localhost:4173',
    channel: (process.env.PW_CHANNEL as 'chrome' | 'msedge') ?? 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Bangkok',
    acceptDownloads: true,
  },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [{ name: 'chrome-desktop' }],
});
