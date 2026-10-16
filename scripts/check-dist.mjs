#!/usr/bin/env node
/**
 * Post-build checks that are easier to assert than to review.
 *
 * Run after `pnpm build:demo` (and `pnpm build` for the bundle-size report):
 *
 * ```bash
 * pnpm build:demo && pnpm check:dist
 * ```
 *
 * Two things are checked here, and both have been wrong before.
 *
 * 1. **The `/devtools` entry point does not reach a production bundle that does not import it.**
 *    `tsconfig`-level "separate entry point" is a claim; this is the measurement. The demo is
 *    built for production and the resulting bundle is searched for devtools-only strings — while
 *    also asserting that core strings *are* present, because "not found" is otherwise
 *    indistinguishable from "the app does not use the library at all".
 *
 * 2. **The root `README.md` matches the one that ships.** npm publishes
 *    `projects/signal-request/README.md`; the root copy is the one people read on GitHub. They are
 *    kept byte-identical by convention, and a convention that is only enforced by memory drifts.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const failures = [];
const notes = [];

/** Strings that only exist inside `projects/signal-request/devtools/`. */
const DEVTOOLS_MARKERS = ['ngsr-devtools', 'no cached queries', '[ngsr] +', 'snapshotEntries'];

/** Strings that only exist inside `projects/signal-request/src/`. */
const CORE_MARKERS = ['RequestCancelled', 'httpResource', 'createInfiniteRequest'];

/** Gzip budgets per entry point, in KB. Stated in the README, enforced here. */
const BUDGETS = new Map([
  ['ng-signal-request.mjs', 20],
  ['ng-signal-request-devtools.mjs', 15],
  ['ng-signal-request-testing.mjs', 15],
]);

function checkBundleBoundaries(demoDir, distDir) {
  let files;
  try {
    files = readdirSync(demoDir).filter((name) => name.endsWith('.js'));
  } catch {
    failures.push(`no demo build found at ${demoDir} — run \`pnpm build:demo\` first`);
    return;
  }
  if (files.length === 0) {
    failures.push(`no .js files in ${demoDir}`);
    return;
  }

  const bundle = files.map((name) => readFileSync(join(demoDir, name), 'utf8')).join('\n');

  const coreFound = CORE_MARKERS.filter((marker) => bundle.includes(marker));
  if (coreFound.length === 0) {
    failures.push(
      `the demo bundle contains none of the core markers (${CORE_MARKERS.join(', ')}), so the ` +
        'devtools check below would pass for the wrong reason',
    );
  } else {
    notes.push(`core markers present: ${coreFound.join(', ')}`);
  }

  const leaked = DEVTOOLS_MARKERS.filter((marker) => bundle.includes(marker));
  if (leaked.length > 0) {
    failures.push(
      `the /devtools entry point leaked into the demo production bundle (${leaked.join(', ')}) — ` +
        'something under src/ must be importing it',
    );
  } else {
    notes.push(`devtools markers absent: ${DEVTOOLS_MARKERS.join(', ')}`);
  }

  let fesm;
  try {
    fesm = readdirSync(distDir).filter((name) => name.endsWith('.mjs'));
  } catch {
    return;
  }
  for (const name of fesm) {
    const bytes = readFileSync(join(distDir, name));
    const gzipped = gzipSync(bytes).length / 1024;
    notes.push(`${name} ${(bytes.length / 1024).toFixed(1)} KB, ${gzipped.toFixed(1)} KB gzip`);

    const budget = BUDGETS.get(name);
    if (budget !== undefined && gzipped > budget) {
      failures.push(
        `${name} is ${gzipped.toFixed(1)} KB gzip, over its ${budget} KB budget. Either shrink it ` +
          'or raise the budget deliberately in scripts/check-dist.mjs and the README.',
      );
    }
  }
}

function checkReadmeParity(rootReadme, libraryReadme) {
  let a;
  let b;
  try {
    a = readFileSync(rootReadme);
    b = readFileSync(libraryReadme);
  } catch (error) {
    failures.push(`could not read both READMEs: ${error.message}`);
    return;
  }

  if (a.equals(b)) {
    notes.push(`README.md matches the published copy (${a.length} bytes)`);
    return;
  }

  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  failures.push(
    'README.md and projects/signal-request/README.md have diverged ' +
      `(root ${a.length}B ${digest(a)}, library ${b.length}B ${digest(b)}). The library copy is ` +
      'what ships to npm; copy it over:\n' +
      '  Copy-Item projects/signal-request/README.md README.md -Force',
  );
}

const demoBrowser = join('dist', 'demo', 'browser');
checkBundleBoundaries(demoBrowser, join('dist', 'signal-request', 'fesm2022'));
checkReadmeParity('README.md', join('projects', 'signal-request', 'README.md'));

// `statSync` so a typo in a path is a loud failure rather than a silent skip.
for (const path of [demoBrowser, join('dist', 'signal-request', 'fesm2022')]) {
  try {
    statSync(path);
  } catch {
    failures.push(`expected build output is missing: ${path}`);
  }
}

for (const note of notes) console.log(`ok  ${note}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\nFAIL  ${failure}`);
  process.exit(1);
}
console.log('\nAll distribution checks passed.');
