import { defineConfig } from '@playwright/test';

/**
 * Real-browser checks for the offline path.
 *
 * Everything offline-related in the unit suite runs against a fake `OnlineManager`, which is the
 * right seam for behaviour but proves nothing about `navigator.onLine`, the browser's `online` /
 * `offline` events, or the order they arrive in. These tests drive `context.setOffline`, which is
 * the browser's own emulation, against the production demo.
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
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
