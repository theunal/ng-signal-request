#!/usr/bin/env node
/**
 * Lists the functions that v8 coverage never called, per file, from `coverage-final.json`.
 *
 * The sibling of `uncovered-branches.mjs`, and it exists for the same reason: a coverage total says
 * *how much* is missing and nothing about *what*, and a name and a line number are what turn "a
 * function is uncovered" into a decision — reachable through the public API and worth a test, or
 * defensive and worth a sentence in `docs/verification.md`.
 *
 *   pnpm exec ng test --coverage --coverage-reporters=json
 *   node scripts/uncovered-functions.mjs [substring-of-path]
 */
import { readFileSync } from 'node:fs';

const filter = process.argv[2] ?? '';
const coverage = JSON.parse(readFileSync('coverage/signal-request/coverage-final.json', 'utf8'));

let total = 0;
for (const [file, data] of Object.entries(coverage)) {
  if (!file.includes(filter)) continue;
  const misses = [];
  for (const [id, hits] of Object.entries(data.f)) {
    if (hits > 0) continue;
    const map = data.fnMap[id];
    misses.push(`${map.name} @ line ${map.loc.start.line}`);
  }
  if (misses.length === 0) continue;
  total += misses.length;
  console.log(`\n${file.replace(/^.*ng-signal-request[\\/]/, '')}  ${misses.length} uncovered`);
  for (const miss of misses) console.log(`  - ${miss}`);
}
console.log(`\n${total} uncovered functions`);
