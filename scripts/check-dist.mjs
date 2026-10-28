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
 * Three things are checked here, and each has been wrong before.
 *
 * 1. **The `/devtools`, `/persist`, `/persist/queue` and `/persist/queue/sw` entry points do not
 *    reach a production bundle that does not import them.** `tsconfig`-level "separate entry point"
 *    is a claim; this is
 *    the measurement. The demo is built for production and the resulting bundle is searched for
 *    entry-point-only strings — while also asserting that core strings *are* present, because "not
 *    found" is otherwise indistinguishable from "the app does not use the library at all".
 *
 * 2. **No entry point's own bundle contains another one's strings.** The demo measures the boundary
 *    the way an application experiences it; this measures it one level up, in the FESM files, so a
 *    cross-entry `import` is caught even when nothing in the demo exercises the pair.
 *
 * 3. **The root `README.md` matches the one that ships.** npm publishes
 *    `projects/signal-request/README.md`; the root copy is the one people read on GitHub. They are
 *    kept byte-identical by convention, and a convention that is only enforced by memory drifts.
 *
 * Gzip budgets per entry point live here too, and are stated in the README: the two copies are kept
 * in step by hand, deliberately, because a budget that only exists in a script is a budget nobody
 * reading the README knows about.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const failures = [];
const notes = [];

/** Strings that only exist inside `projects/signal-request/devtools/`. */
const DEVTOOLS_MARKERS = ['ngsr-devtools', 'no cached queries', '[ngsr] +', 'snapshotEntries'];

/** Strings that only exist inside `projects/signal-request/persist/`. */
const PERSIST_MARKERS = [
  'providePersistedCache',
  'provideCacheTransfer',
  'dateRevivingCodec',
  'indexedDbStorage',
];

/** Strings that only exist inside `projects/signal-request/persist/queue/`. */
const QUEUE_MARKERS = [
  'ng-signal-request: persisted mutation queue options',
  'ng-signal-request:mutation-queue',
  'noHandlerWarnAfterMs',
];

/**
 * Strings that only exist inside `projects/signal-request/persist/queue/sw/`.
 *
 * The sync tag, the storage key and most IndexedDB errors are shared with the page queue, so the
 * marker has to be a string the worker alone produces. Only the entry-point-prefixed error is
 * unique; the generic upgrade/request errors also exist in `/persist`.
 */
const SW_MARKERS = ['ng-signal-request/persist/queue/sw: IndexedDB is not available.'];

/** Strings that only exist inside `projects/signal-request/src/`. */
const CORE_MARKERS = [
  'RequestCancelled',
  'httpResource',
  'createInfiniteRequest',
  // The core seam `/persist` plugs into. If this one goes missing, the gate has been re-exported
  // from somewhere else and the entry-point boundary has moved.
  'ng-signal-request: restore gate',
];

/**
 * What each entry point's own bundle must not contain.
 *
 * The demo bundle below measures the boundary the way an application experiences it — tree-shaking
 * of a production build. This measures it one level up, in the FESM files themselves, so a
 * cross-entry `import` is caught even when nothing in the demo exercises the pair.
 */
const FORBIDDEN_IN = new Map([
  [
    'ng-signal-request.mjs',
    [...DEVTOOLS_MARKERS, ...PERSIST_MARKERS, ...QUEUE_MARKERS, ...SW_MARKERS],
  ],
  ['ng-signal-request-persist.mjs', [...DEVTOOLS_MARKERS, ...QUEUE_MARKERS, ...SW_MARKERS]],
  // `/persist/queue` imports `/persist` for `indexedDbStorage`, so persist markers are allowed
  // here. It must not pull the panel or the worker helper in.
  ['ng-signal-request-persist-queue.mjs', [...DEVTOOLS_MARKERS, ...SW_MARKERS]],
  // The worker helper is deliberately dependency-free: no core, no Angular, no page queue code.
  [
    'ng-signal-request-persist-queue-sw.mjs',
    [...DEVTOOLS_MARKERS, ...PERSIST_MARKERS, ...CORE_MARKERS],
  ],
  ['ng-signal-request-devtools.mjs', [...PERSIST_MARKERS, ...QUEUE_MARKERS, ...SW_MARKERS]],
  [
    'ng-signal-request-testing.mjs',
    [...DEVTOOLS_MARKERS, ...PERSIST_MARKERS, ...QUEUE_MARKERS, ...SW_MARKERS],
  ],
]);

/** Gzip budgets per entry point, in KB. Stated in the README, enforced here. */
const BUDGETS = new Map([
  ['ng-signal-request.mjs', 23.5],
  ['ng-signal-request-devtools.mjs', 15],
  ['ng-signal-request-testing.mjs', 15],
  ['ng-signal-request-persist.mjs', 15],
  ['ng-signal-request-persist-queue.mjs', 15],
  // Measured at 3.75 KB gzip; the worker is deliberately small and dependency-free.
  ['ng-signal-request-persist-queue-sw.mjs', 4.5],
]);

/**
 * What an application pays, in KB gzip over a control app that does not import the library.
 *
 * Per-entry-point budgets measure what we ship; these measure what is retained. They are different
 * numbers, so an app that imports one factory can pay for more than that factory (see
 * `docs/verification.md`, Step C). The probes are the only way to notice that getting worse, and
 * the only honest way to state a size in the README.
 */
const PROBE_BUDGETS = new Map([
  ['request', 22.5],
  ['keyed', 22.5],
  ['full', 26.5],
  // Not a core tree-shaking probe: this app renders `<ngsr-devtools />`, so its delta is the
  // positive control for the secondary entry point. Kept in the same harness so the panel has a
  // measured budget instead of only a unit test.
  ['devtools', 32.5],
]);

/**
 * Regression limits, tighter than the release budgets above.
 *
 * The budgets were set before the factory tables were marked pure and are deliberately left
 * unchanged here; these limits are the new measured values plus about 3%. They are the check that
 * the unkeyed `request` probe actually keeps the reduction instead of drifting back toward the
 * cached engine one import at a time. `full` is not lower than its budget because its extra
 * surface is the point of the probe.
 */
const PROBE_LIMITS = new Map([
  ['request', 18.4],
  ['keyed', 19.2],
  ['full', 26],
  // The panel is the positive control; this limit still catches a regression in the core part of
  // the same probe, which is why it moved with `request` rather than staying at 32.5.
  ['devtools', 28.8],
]);

function checkProbeSizes() {
  const names = ['none', 'request', 'keyed', 'full', 'devtools'];
  const sizes = new Map();
  const text = new Map();
  for (const name of names) {
    const path = join('dist', 'probes', name, 'browser', 'main.js');
    try {
      const bytes = readFileSync(path);
      sizes.set(name, gzipSync(bytes).length / 1024);
      text.set(name, bytes.toString('utf8'));
    } catch {
      failures.push(
        `no probe build at ${path} - run \`pnpm build\` and then \`pnpm build:probes\``,
      );
      return;
    }
  }

  // A probe that does not contain the library would make every delta below a lie.
  const control = text.get('none');
  const request = text.get('request');
  if (control.includes('RequestCancelled') || control.includes('httpResource')) {
    failures.push('the control probe contains library code, so the deltas below are meaningless');
  }
  if (!request.includes('RequestCancelled')) {
    failures.push(
      'the request probe does not contain the library, so the deltas below are meaningless',
    );
  }

  const base = sizes.get('none');
  notes.push(`probe none ${base.toFixed(2)} KB gzip (control)`);
  for (const name of ['request', 'keyed', 'full', 'devtools']) {
    const size = sizes.get(name);
    const delta = size - base;
    const budget = PROBE_BUDGETS.get(name);
    const limit = PROBE_LIMITS.get(name);
    notes.push(
      `probe ${name} ${size.toFixed(2)} KB gzip, +${delta.toFixed(2)} over control ` +
        `(limit ${limit}, budget ${budget})`,
    );
    if (delta > budget) {
      failures.push(
        `probe ${name} costs +${delta.toFixed(2)} KB gzip over an app without the library, ` +
          `over its ${budget} KB budget. Shrink it or raise the budget deliberately in ` +
          'scripts/check-dist.mjs and the README.',
      );
    } else if (delta > limit) {
      failures.push(
        `probe ${name} costs +${delta.toFixed(2)} KB gzip over an app without the library, ` +
          `over its ${limit} KB regression limit (still under the ${budget} KB release budget). ` +
          'Find what got retained; do not raise this limit to make the build pass.',
      );
    }
  }
}

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

  const leakedPersist = PERSIST_MARKERS.filter((marker) => bundle.includes(marker));
  if (leakedPersist.length > 0) {
    failures.push(
      `the /persist entry point leaked into the demo production bundle (${leakedPersist.join(', ')}) ` +
        '— something under src/ must be importing it',
    );
  } else {
    notes.push(`persist markers absent: ${PERSIST_MARKERS.join(', ')}`);
  }

  const leakedQueue = QUEUE_MARKERS.filter((marker) => bundle.includes(marker));
  if (leakedQueue.length > 0) {
    failures.push(
      `the /persist/queue entry point leaked into the demo production bundle (${leakedQueue.join(', ')}) ` +
        '— something under src/ must be importing it',
    );
  } else {
    notes.push(`queue markers absent: ${QUEUE_MARKERS.join(', ')}`);
  }

  const leakedSw = SW_MARKERS.filter((marker) => bundle.includes(marker));
  if (leakedSw.length > 0) {
    failures.push(
      `the /persist/queue/sw entry point leaked into the demo production bundle (${leakedSw.join(', ')}) ` +
        '— the page must never import the worker helper',
    );
  } else {
    notes.push(`service-worker markers absent: ${SW_MARKERS.join(', ')}`);
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

    const forbidden = (FORBIDDEN_IN.get(name) ?? []).filter((marker) =>
      bytes.includes(marker, 0, 'utf8'),
    );
    if (forbidden.length > 0) {
      failures.push(
        `${name} contains ${forbidden.join(', ')}, which belongs to another entry point — a ` +
          'cross-entry import has pulled it in.',
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
checkProbeSizes();
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
