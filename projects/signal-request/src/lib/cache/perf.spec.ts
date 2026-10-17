import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideSignalRequest } from '../../public-api';
import { cache, setup } from '../../../testing/testing';

/**
 * The one hot path `maxEntries` touches: `QueryCache.resolve`.
 *
 * `resolve` runs inside every keyed handle's key `computed`, so it is on the critical path of every
 * render that reads a cached request. Phase 1 added two things to it — a `Map` write for the recency
 * stamp, and an eviction pass on insert. The first is meant to be free, and the second is meant to
 * be free *until* the cache is full, at which point it is a scan of at most `cap` entries.
 *
 * ## What this file is and is not
 *
 * The assertions are **ceilings, not targets**: 50 µs per operation, where the real cost is around
 * 1–2 µs. A timing assertion tight enough to notice a 10% change would fail on a busy CI machine and
 * would be deleted within a week, which is worse than no assertion at all. What these catch is a
 * change of *kind* — an accidental O(n²), a listener woken per insert, a signal read per entry.
 *
 * The 10% comparison the project actually cares about is done by reading the numbers, and
 * `pnpm bench` prints them at a size where they mean something:
 *
 * ```bash
 * pnpm bench
 * ```
 *
 * Recorded results and their dates live in `docs/perf.md`. The ceiling scales with `N`, so a machine
 * that is merely slow still passes; a regression that changes the complexity does not.
 */

/** `pnpm bench` raises this; the default keeps `pnpm test` a couple of hundred milliseconds. */
const LARGE = 200_000;
const SMALL = 20_000;
const N = process.env['NG_SIGNAL_REQUEST_BENCH'] === '1' ? LARGE : SMALL;

/** Roughly free, and long enough that nothing is collected mid-measurement. */
const GC = 60_000;

/** 50 µs per operation: ~25× the measured cost, so it only fires on a change of kind. */
const CEILING_PER_OP_US = 50;

function usPerOp(ms: number): number {
  return (ms * 1000) / N;
}

/** Only in a bench run: on a normal `pnpm test` the numbers are not the point and would be noise. */
function report(label: string, ms: number): void {
  if (N !== LARGE) return;
  // `process.stdout.write` rather than `console.log`: vitest wraps the console methods and swallows
  // their output, and the printed number is the entire deliverable of a bench run.
  process.stdout.write(
    `\n[bench] ${label}: ${ms.toFixed(1)} ms over ${N} → ${usPerOp(ms).toFixed(2)} µs/op\n`,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('perf — resolve', () => {
  it('a warm key is a map lookup, and nothing more', () => {
    setup([provideSignalRequest({ maxEntries: 100, gcTime: GC })]);
    const c = cache();
    const first = c.resolve(['warm']);

    const started = performance.now();
    for (let i = 0; i < N; i++) c.resolve(['warm']);
    const ms = performance.now() - started;
    report('resolve, warm key', ms);

    // The short-circuit really is taken — otherwise this would be measuring entry construction.
    expect(c.resolve(['warm'])).toBe(first);
    expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
  });

  it('a create-and-release loop without a cap grows the cache and stays linear', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([provideSignalRequest({ gcTime: GC })]);
    const c = cache();

    const started = performance.now();
    for (let i = 0; i < N; i++) c.resolve(['k', i]).subscribe(GC)();
    const ms = performance.now() - started;
    report('resolve + subscribe + release, no cap', ms);

    expect(c.size).toBe(N);
    expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
    c.clear();
  });

  it('the same loop at the cap pays the eviction scan, and stays linear', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([provideSignalRequest({ maxEntries: 100, gcTime: GC })]);
    const c = cache();

    const started = performance.now();
    for (let i = 0; i < N; i++) c.resolve(['k', i]).subscribe(GC)();
    const ms = performance.now() - started;
    report('resolve + subscribe + release, cap 100', ms);

    // Bounded, and the per-op cost did not explode: the scan is over `cap` entries, not over `i`.
    // If eviction ever scanned the whole key space this ratio would grow with `N` instead.
    expect(c.size).toBe(100);
    expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
    c.clear();
  });

  it('holds a fixed-size cache at a fixed per-op cost, independent of the key count', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([provideSignalRequest({ maxEntries: 100, gcTime: GC })]);
    const c = cache();

    // Warm the cache to the cap first, so the first batch is not paying entry construction.
    for (let i = 0; i < 100; i++) c.resolve(['warm', i]).subscribe(GC)();

    const started = performance.now();
    for (let i = 0; i < N; i++) c.resolve(['k', i]).subscribe(GC)();
    const ms = performance.now() - started;
    report('at-cap inserts, cap 100 pre-warmed', ms);

    expect(c.size).toBe(100);
    expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
    c.clear();
  });
});
