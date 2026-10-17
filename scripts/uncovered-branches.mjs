#!/usr/bin/env node
/**
 * Lists the branches that v8 coverage never took, per file, from `coverage-final.json`.
 *
 * Not part of the build: a throwaway probe used while auditing coverage, written down here because
 * the audit's finding is only useful if it is reproducible.
 *
 *   pnpm exec ng test --coverage --coverage-reporters=json
 *   node scripts/uncovered-branches.mjs [substring-of-path]
 */
import { readFileSync } from 'node:fs';

const filter = process.argv[2] ?? '';
const coverage = JSON.parse(readFileSync('coverage/signal-request/coverage-final.json', 'utf8'));

let total = 0;
for (const [file, data] of Object.entries(coverage)) {
  if (!file.includes(filter)) continue;
  const misses = [];
  for (const [id, map] of Object.entries(data.branchMap)) {
    const counts = data.b[id];
    counts.forEach((hits, index) => {
      if (hits > 0) return;
      const location = map.locations[index] ?? map.loc;
      misses.push(
        `${map.type} @ line ${location.start.line}:${location.start.column} (path ${index})`,
      );
    });
  }
  if (misses.length === 0) continue;
  total += misses.length;
  console.log(`\n${file.replace(/^.*ng-signal-request[\\/]/, '')}  ${misses.length} uncovered`);
  for (const miss of misses) console.log(`  - ${miss}`);
}
console.log(`\n${total} uncovered branch paths`);
