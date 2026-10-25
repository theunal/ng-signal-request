#!/usr/bin/env node
/**
 * Serves the durable-queue e2e build.
 *
 * `serve-dist.mjs` owns the serving; this only names the build and the port, because Playwright's
 * `webServer` command is a shell string and `PORT=... node ...` is not portable to cmd.exe.
 */
process.env['DIST'] = 'dist/queue-e2e/browser';
process.env['PORT'] = '4174';

await import('./serve-dist.mjs');
