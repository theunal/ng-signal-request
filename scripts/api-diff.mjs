#!/usr/bin/env node
/**
 * Compares the public API surface between two git refs.
 *
 * The README, the CHANGELOG and every design doc make the same kind of claim — "the API of
 * v0.0.4 is a strict subset of 0.1.0", "0 removed". A claim like that is worth exactly as much
 * as the command behind it, and a hand-typed `git show | grep | diff` is not repeatable a month
 * later. This is that command.
 *
 * ```bash
 * pnpm check:api v0.1.0          # working tree against a tag
 * pnpm check:api v0.0.4 v0.1.0   # two tags against each other
 * ```
 *
 * Exits non-zero when a name present in the older ref is missing from the newer one, because that
 * is the only outcome here that is a breaking change. Added names are reported and are fine — an
 * additive release is the normal case.
 *
 * **All five entry points are compared, not only the core.** "No name was removed" is a claim about
 * the published package, and 0.2.0 changed signatures inside `/persist` as well as adding to the
 * core: a diff that only read `src/public-api.ts` would have reported a clean run while quietly not
 * looking at the half of the surface that moved. `/persist/queue` is new in this release, so an
 * older ref legitimately does not have it; that entry is skipped when absent rather than reported
 * as a parse failure.
 *
 * Resolution is textual, not a TypeScript program. Each file is a list of re-export blocks and
 * declarations and nothing else, so the only thing that can go wrong is a shape this regex does not
 * know; that is what the "0 exports found" guard is for, so a parser that silently matches nothing
 * cannot report a clean diff.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The five entry points, in the order the README lists them. */
const API_PATHS = [
  { path: 'projects/signal-request/src/public-api.ts' },
  { path: 'projects/signal-request/devtools/devtools.ts' },
  { path: 'projects/signal-request/persist/persist.ts' },
  { path: 'projects/signal-request/persist/queue/queue.ts', addedInThisRelease: true },
  { path: 'projects/signal-request/testing/testing.ts' },
];

/** Reads an entry point at a ref, or from disk with `--worktree` / no ref. */
function readApi(ref, path) {
  if (ref === undefined || ref === '--worktree') {
    return { label: 'working tree', text: readFileSync(path, 'utf8') };
  }
  try {
    const text = execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { label: ref, text };
  } catch {
    // Distinguish "the ref is wrong" from "this entry point did not exist yet". The first is an
    // operator error and must fail; the second is the expected shape of an older tag for a subpath
    // added in this release.
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], { stdio: 'ignore' });
      return { label: ref, text: null };
    } catch {
      console.error(
        `FAIL  cannot read ${path} at "${ref}". Check the ref exists (git tag --list) and that ` +
          'tags have been fetched (git fetch --tags).',
      );
      process.exit(1);
    }
  }
}

/**
 * Every name a file exports.
 *
 * Handles the three shapes that appear, plus the direct declarations, because the point is to keep
 * working when someone adds a fourth:
 *
 *   export { a, b as c } from './x';
 *   export type { D, E } from './y';
 *   export const f = 1;
 */
function exportedNames(text) {
  const names = new Set();

  for (const block of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of block[1].split(',')) {
      // Drop comments before anything else: a commented-out export is not an export.
      const cleaned = entry
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .trim();
      if (!cleaned) continue;
      // `a as b` exports `b`; a leading `type ` (as in `type F`) is a modifier, not the name.
      const name = cleaned
        .split(/\s+as\s+/)
        .pop()
        .replace(/^type\s+/, '')
        .trim();
      if (name) names.add(name);
    }
  }

  for (const decl of text.matchAll(
    /^export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(decl[1]);
  }

  return names;
}

const [oldRef, newRef] = process.argv.slice(2);
const removedAll = [];

for (const spec of API_PATHS) {
  const path = spec.path;
  const oldApi = readApi(oldRef, path);
  const newApi = readApi(newRef, path);

  if (oldApi.text === null) {
    if (!spec.addedInThisRelease) {
      console.error(
        `FAIL  ${path} is missing at "${oldRef}". Only a subpath added in this release may be ` +
          'absent from an older ref.',
      );
      process.exit(1);
    }
    console.log(`${path}  did not exist at ${oldRef} (new subpath), skipped`);
    continue;
  }

  if (newApi.text === null) {
    console.error(
      `FAIL  ${path} is missing at "${newApi.label}". A published entry point may not disappear.`,
    );
    process.exit(1);
  }

  const before = exportedNames(oldApi.text);
  const after = exportedNames(newApi.text);

  if (before.size === 0 || after.size === 0) {
    console.error(
      `FAIL  found ${before.size} exports in ${path} at ${oldApi.label} and ${after.size} at ` +
        `${newApi.label}. At least one side matched nothing, which means the parser no longer ` +
        'understands the file rather than that the API is empty.',
    );
    process.exit(1);
  }

  const removed = [...before].filter((name) => !after.has(name)).sort();
  const added = [...after].filter((name) => !before.has(name)).sort();
  removedAll.push(...removed.map((name) => `${name} (${path})`));

  console.log(`${path}  ${before.size} -> ${after.size} exports`);
  console.log(`  added   ${added.length}: ${added.join(', ') || '(none)'}`);
  console.log(`  removed ${removed.length}: ${removed.join(', ') || '(none)'}`);
}

if (removedAll.length > 0) {
  console.error(
    `\nFAIL  ${removedAll.length} name(s) exported by ${oldRef ?? 'the older ref'} are missing ` +
      `from ${newRef ?? 'the working tree'}: ${removedAll.join(', ')}. That is a breaking change ` +
      'to a published API.',
  );
  process.exit(1);
}

console.log(
  `\nNo breaking changes: every name in the older surface still exists, in all ${API_PATHS.length} ` +
    'entry points.',
);
