import { defineConfig } from '@playwright/test';

/**
 * Real-browser checks for two things the unit suite cannot reach.
 *
 * 1. **The offline path.** Everything offline-related in the unit suite runs against a fake
 *    `OnlineManager`, which is the right seam for behaviour but proves nothing about
 *    `navigator.onLine`, the browser's `online` / `offline` events, or the order they arrive in.
 *    Those tests drive `context.setOffline` against the production demo.
 * 2. **The durable mutation queue.** jsdom has no IndexedDB and no Web Locks, so the reload/replay
 *    path only exists in a real browser. It runs against `projects/queue-e2e`, a separate app on a
 *    separate port: `check:dist` requires the production demo to contain none of the
 *    `/persist/queue` markers, and that assertion is worth more than a demo tab.
 *
 * Kept out of `pnpm verify` because it needs a downloaded browser; see `pnpm test:e2e`.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'demo',
      testMatch: '**/offline.spec.ts',
      use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4173' },
    },
    {
      name: 'queue',
      testMatch: '**/queue.spec.ts',
      use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4174' },
    },
  ],
  webServer: [
    {
      command: 'node scripts/serve-dist.mjs',
      cwd: '..',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env['CI'],
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node scripts/serve-queue-e2e.mjs',
      cwd: '..',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env['CI'],
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
