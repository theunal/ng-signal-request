#!/usr/bin/env node
/**
 * Runs the benchmarks that live in the spec suite, at a size where the numbers mean something.
 *
 * The benchmark bodies are ordinary specs under `src/lib/**\/*.spec.ts`, because the Angular unit-test
 * builder is the only thing in this repository that can compile and run library code — the specs get
 * the Angular compiler, the DOM and the DI plumbing for free, and a second harness would be a second
 * thing to keep working. What changes here is scale: `NG_SIGNAL_REQUEST_BENCH=1` raises the loop
 * counts and turns on the per-run report.
 *
 * This is not a `vitest bench`. Vitest's bench mode is a separate command that the Angular builder
 * does not expose, and reaching for it would mean a parallel toolchain for one file. The trade is
 * stated rather than hidden: these are measured by reading the printed numbers, compared against
 * `docs/perf.md`, not by vitest's statistical runner.
 *
 * ```bash
 * pnpm bench
 * ```
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['exec', 'ng', 'test', '--no-coverage'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NG_SIGNAL_REQUEST_BENCH: '1' },
});

if (result.error) {
  console.error(`bench: could not start the test runner — ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
