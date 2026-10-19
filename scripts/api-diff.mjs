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
 * **All four entry points are compared, not only the core.** "No name was removed" is a claim about
 * the published package, and 0.2.0 changed signatures inside `/persist` as well as adding to the
 * core: a diff that only read `src/public-api.ts` would have reported a clean run while quietly not
 * looking at the half of the surface that moved.
 *
 * Resolution is textual, not a TypeScript program. Each file is a list of re-export blocks and
 * declarations and nothing else, so the only thing that can go wrong is a shape this regex does not
 * know; that is what the "0 exports found" guard is for, so a parser that silently matches nothing
 * cannot report a clean diff.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The four entry points, in the order the README lists them. */
const API_PATHS = [
  'projects/signal-request/src/public-api.ts',
  'projects/signal-request/devtools/devtools.ts',
  'projects/signal-request/persist/persist.ts',
  'projects/signal-request/testing/testing.ts',
];

/** Reads an entry point at a ref, or from disk with `--worktree` / no ref. */
function readApi(ref, path) {
  if (ref === undefined || ref === '--worktree') {
    return { label: 'working tree', text: readFileSync(path, 'utf8') };
  }
  try {
    const text = execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
    return { label: ref, text };
  } catch {
    // A typo in a ref, or a tag that a shallow clone never fetched. Say which, rather than letting
    // git's stderr surface as an unhandled exception — the fix is usually `git fetch --tags`.
    console.error(
      `FAIL  cannot read ${path} at "${ref}". Check the ref exists (git tag --list) and that ` +
        'tags have been fetched (git fetch --tags).',
    );
    process.exit(1);
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

for (const path of API_PATHS) {
  const oldApi = readApi(oldRef, path);
  const newApi = readApi(newRef, path);

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
