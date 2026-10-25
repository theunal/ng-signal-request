#!/usr/bin/env node
/**
 * A static server for a production build, used by the Playwright checks.
 *
 * Playwright cannot toggle a browser offline against `ng serve` without also toggling the dev
 * server's HMR socket, and the e2e is about the production bundle anyway. This is deliberately
 * dependency-free: `pnpm test:e2e` is a browser check, not a reason to add a web server.
 *
 * `DIST` and `PORT` exist because there are two apps under test: the demo (the default,
 * `dist/demo/browser` on 4173) and the durable-queue app (`dist/queue-e2e/browser` on 4174),
 * which cannot be the same bundle - `check:dist` requires the demo not to contain the queue.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const root = join(import.meta.dirname, '..', process.env.DIST ?? 'dist/demo/browser');
const port = Number(process.env.PORT ?? 4173);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

if (!existsSync(join(root, 'index.html'))) {
  console.error(
    `no production build at ${root} - run \`pnpm build:demo\` or \`pnpm build:e2e-queue\` first`,
  );
  process.exit(1);
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  // `normalize` plus a root check: a request for `../../package.json` is a miss, not a file.
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(root, relative);
  if (!file.startsWith(root + sep) && file !== root) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // Single-page application: every unknown path is the shell.
    file = join(root, 'index.html');
  }
  response.writeHead(200, {
    'content-type': MIME.get(extname(file)) ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`demo on http://127.0.0.1:${port}`);
});
