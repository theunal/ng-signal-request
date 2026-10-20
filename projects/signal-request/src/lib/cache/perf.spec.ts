import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  createMutation,
  createQuery,
  createRequest,
  OnlineManager,
  provideSignalRequest,
  type QueryFetchPlan,
} from '../../public-api';
import { cache, settle, setup } from '../../../testing/testing';

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
 * The assertions are **ceilings, not targets**: 50 µs per operation in a bench run, where the real
 * cost is around 1–2 µs. A timing assertion tight enough to notice a 10% change would fail on a busy
 * CI machine and would be deleted within a week, which is worse than no assertion at all. What these
 * catch is a change of *kind* — an accidental O(n²), a listener woken per insert, a signal read per
 * entry.
 *
 * The 10% comparison the project actually cares about is done by reading the numbers, and
 * `pnpm bench` prints them at a size where they mean something:
 *
 * ```bash
 * pnpm bench
 * ```
 *
 * Recorded results and their dates live in `docs/perf.md`.
 *
 * Two corrections were made here after a coverage audit, both recorded in `docs/perf.md`: the
 * ceiling does **not** scale with `N` (it never did — the sentence saying so was wrong), and the
 * 5-second default test timeout is too short for a 200,000-iteration loop on a loaded machine, which
 * made `pnpm bench` fail rather than report.
 */

/** `pnpm bench` raises this; the default keeps `pnpm test` a couple of hundred milliseconds. */
const LARGE = 200_000;
const SMALL = 20_000;
const BENCH = process.env['NG_SIGNAL_REQUEST_BENCH'] === '1';
const N = BENCH ? LARGE : SMALL;

/**
 * Per-test timeout.
 *
 * Vitest's default is 5 s, and at `LARGE` iterations the uncapped loop takes about that long on this
 * machine and longer on a busy one — so `pnpm bench` intermittently *timed out* instead of printing
 * its numbers. A benchmark harness that fails when the machine is slow is measuring the machine.
 */
const TIMEOUT_MS = 120_000;

/** Roughly free, and long enough that nothing is collected mid-measurement. */
const GC = 60_000;

/**
 * The absolute ceiling, in µs per operation — and it has to be two numbers, because the same loop
 * costs different amounts in the two ways this file runs.
 *
 * `pnpm bench` runs **without coverage** at `LARGE` iterations. That is the run `docs/perf.md`
 * records, and there 50 µs/op is roughly 25× the measured cost.
 *
 * `pnpm test` runs **with v8 coverage**, which instruments every basic block. Measured on this
 * machine, the capped loop costs ~12 µs/op without coverage and 67–71 µs/op with it: the eviction
 * scan executes ~100 iterations of instrumented code per insert, and the counters, not the work,
 * are what the number is measuring. A 50 µs assertion there is an assertion about the instrument,
 * and it failed exactly that way while this was being written up. Under coverage the ceiling is
 * therefore a sanity bound (~14× the instrumented cost) against a hang or a change of kind.
 *
 * The change-of-kind check that survives both modes is the *shape* assertion below: a loop whose
 * per-op cost grows with the number of keys seen fails it on any machine, coverage or not.
 */
const CEILING_PER_OP_US = BENCH ? 50 : 1000;

/** How much more the second half of a loop may cost per operation than the first. */
const SHAPE_LIMIT = 4;

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

/** The same, for a case whose size is one per entry rather than `N`. */
function reportEach(label: string, ms: number, count: number): void {
  if (N !== LARGE) return;
  process.stdout.write(
    `\n[bench] ${label}: ${ms.toFixed(1)} ms over ${count} → ${((ms * 1000) / count).toFixed(
      2,
    )} µs/entry\n`,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('perf — resolve', () => {
  it(
    'a warm key is a map lookup, and nothing more',
    () => {
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
    },
    TIMEOUT_MS,
  );

  it(
    'a create-and-release loop without a cap grows the cache and stays linear',
    () => {
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
    },
    TIMEOUT_MS,
  );

  it(
    'the same loop at the cap pays the eviction scan, and stays linear',
    () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setup([provideSignalRequest({ maxEntries: 100, gcTime: GC })]);
      const c = cache();

      // Timed in halves so the shape can be asserted as well as the total: the second half is the one
      // that would pay for a scan over the *key space* rather than over the cap.
      const started = performance.now();
      for (let i = 0; i < N / 2; i++) c.resolve(['k', i]).subscribe(GC)();
      const mid = performance.now();
      for (let i = N / 2; i < N; i++) c.resolve(['k', i]).subscribe(GC)();
      const ms = performance.now() - started;
      report('resolve + subscribe + release, cap 100', ms);

      // Bounded, and the per-op cost did not explode: the scan is over `cap` entries, not over `i`.
      // If eviction ever scanned the whole key space this ratio would grow with `N` instead.
      expect(c.size).toBe(100);
      expect(ms - mid).toBeLessThan((mid - started) * SHAPE_LIMIT);
      expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
      c.clear();
    },
    TIMEOUT_MS,
  );

  it(
    'holds a fixed-size cache at a fixed per-op cost, independent of the key count',
    () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setup([provideSignalRequest({ maxEntries: 100, gcTime: GC })]);
      const c = cache();

      // Warm the cache to the cap first, so the first batch is not paying entry construction.
      for (let i = 0; i < 100; i++) c.resolve(['warm', i]).subscribe(GC)();

      const started = performance.now();
      for (let i = 0; i < N / 2; i++) c.resolve(['k', i]).subscribe(GC)();
      const mid = performance.now();
      for (let i = N / 2; i < N; i++) c.resolve(['k', i]).subscribe(GC)();
      const ms = performance.now() - started;
      report('at-cap inserts, cap 100 pre-warmed', ms);

      expect(c.size).toBe(100);
      // Every insert here evicts one, at a cost that does not depend on how many keys came before.
      expect(ms - mid).toBeLessThan((mid - started) * SHAPE_LIMIT);
      expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
      c.clear();
    },
    TIMEOUT_MS,
  );
});

/**
 * The two paths Phase 2 added: releasing a paused entry on reconnect, and replaying a paused queue.
 *
 * Both are bulk operations triggered by one event, so the thing worth measuring is the **total**
 * cost of the event rather than a per-op loop: a reconnect that wakes 1,000 entries at once is the
 * case where a per-entry listener or a synchronous re-render would be felt as a frozen frame.
 *
 * The measurement stops after one microtask, because that is where the work is: `setOnline` stamps
 * the state, and the announcement microtask runs every listener synchronously. `settle()` would add
 * Angular's effect flushing, which belongs to the harness rather than to this code.
 */
describe('perf — reconnect', () => {
  const STORM = BENCH ? 1_000 : 100;
  const QUEUE = BENCH ? 1_000 : 100;

  it(
    'releases every paused entry on one reconnect',
    async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
      const manager = TestBed.inject(OnlineManager);
      manager.setOnline(false);

      const handles = [];
      for (let i = 0; i < STORM; i++) {
        handles.push(
          create(() =>
            createRequest<number>(`/rows/${i}`, {
              key: () => ['rows', i],
              networkMode: 'online',
            }),
          ),
        );
      }
      await settle();
      expect(http.match(() => true)).toHaveLength(0);

      const started = performance.now();
      manager.setOnline(true);
      await Promise.resolve();
      const ms = performance.now() - started;
      reportEach('reconnect, paused entries', ms, STORM);

      const requests = http.match(() => true);
      expect(requests).toHaveLength(STORM);
      for (const request of requests) request.flush(1);
      await settle();

      expect((ms * 1000) / STORM).toBeLessThan(CEILING_PER_OP_US);
      for (const handle of handles) handle.destroy();
    },
    TIMEOUT_MS,
  );

  it(
    'replays a paused mutation queue on one reconnect',
    async () => {
      const { http, create } = setup();
      const manager = TestBed.inject(OnlineManager);
      manager.setOnline(false);
      const save = create(() =>
        createMutation<number, number>((n) => ({ url: '/save', body: { n } }), {
          networkMode: 'online',
          concurrency: 'parallel',
        }),
      );

      // Every promise is kept and caught: a queued call settles only on replay, and cancelling one
      // at teardown must not become an unhandled rejection in the middle of a benchmark.
      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < QUEUE; i++) pending.push(save.run(i).catch(() => undefined));
      await settle();
      expect(http.match(() => true)).toHaveLength(0);

      const started = performance.now();
      manager.setOnline(true);
      await Promise.resolve();
      const ms = performance.now() - started;
      reportEach('mutation replay, queued calls', ms, QUEUE);

      const requests = http.match(() => true);
      expect(requests).toHaveLength(QUEUE);
      for (const request of requests) request.flush(1);
      await settle();
      await Promise.all(pending);

      expect((ms * 1000) / QUEUE).toBeLessThan(CEILING_PER_OP_US);
      save.destroy();
    },
    TIMEOUT_MS,
  );
});

/**
 * The other path the cap now touches: staging a persisted value.
 *
 * `seed` is called once per entry of a snapshot, and it enforces the cap, so the cost of restoring
 * a large snapshot is `values × cap` comparisons rather than `values`. These two cases measure that
 * claim instead of asserting it.
 */
describe('perf — staged seeds', () => {
  it(
    'staging without a cap is one map insert per value',
    () => {
      setup();
      const c = cache();

      const started = performance.now();
      for (let i = 0; i < N; i++) c.seed(['s', i], i, i);
      const ms = performance.now() - started;
      report('seed, no cap', ms);

      expect(c.pendingSeeds).toBe(N);
      expect(c.size).toBe(0);
      expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
      c.clear();
    },
    TIMEOUT_MS,
  );

  it(
    'staging under a cap never exceeds it, and stays linear',
    () => {
      setup([provideSignalRequest({ maxEntries: 100 })]);
      const c = cache();

      const started = performance.now();
      for (let i = 0; i < N / 2; i++) c.seed(['s', i], i, i);
      const mid = performance.now();
      for (let i = N / 2; i < N; i++) c.seed(['s', i], i, i);
      const ms = performance.now() - started;
      report('seed, cap 100', ms);

      expect(c.pendingSeeds).toBe(100);
      // If the drop-and-scan ever became a scan of everything staged rather than of the cap, the
      // second half would grow with `N` and this would fail on any machine.
      expect(ms - mid).toBeLessThan((mid - started) * SHAPE_LIMIT);
      expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
      c.clear();
    },
    TIMEOUT_MS,
  );
});

/**
 * The third path a restore reaches, and the only new one in Phase 3: a seed whose entry **already
 * exists**.
 *
 * A synchronous storage never gets here — hydration finishes before any handle can resolve a key. An
 * asynchronous read that outlived its bound, or an application that turned the hold off, does: the
 * entry has data from the network and the snapshot is older. Deciding what to do about it is a map
 * lookup plus one untracked signal read, and this measures that the decision stays O(1) per seed
 * rather than growing with the snapshot the way a scan of every key would.
 */
describe('perf — late seeds', () => {
  it(
    'applying a seed to an entry that already exists is a read and a write, not a scan',
    () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setup([provideSignalRequest({ gcTime: GC })]);
      const c = cache();
      c.resolve(['late']).subscribe(GC)();

      const started = performance.now();
      for (let i = 0; i < N / 2; i++) c.seed(['late'], i, i * 2 + 1);
      const mid = performance.now();
      for (let i = N / 2; i < N; i++) c.seed(['late'], i, i * 2 + 1);
      const ms = performance.now() - started;
      report('seed into an existing entry', ms);

      expect(c.size).toBe(1);
      expect(c.pendingSeeds).toBe(0);
      // Every one of them was newer than the one before it, so every one was applied.
      expect(c.peek(['late'])?.dataUpdatedAt()).toBe((N - 1) * 2 + 1);
      expect(ms - mid).toBeLessThan((mid - started) * SHAPE_LIMIT);
      expect(usPerOp(ms)).toBeLessThan(CEILING_PER_OP_US);
    },
    TIMEOUT_MS,
  );
});

/**
 * The two costs `createQuery` adds to the cached path.
 *
 * A query shares the entry machinery, so what is new is (a) turning a function's promise into a
 * settled entry, and (b) the dedup that makes a second handle join instead of calling the function
 * again. Both are compared against the same run's ceiling rather than against a number from an
 * older machine.
 */
describe('perf — createQuery', () => {
  const RUNS = BENCH ? 5_000 : 500;
  const JOIN = BENCH ? 20_000 : 2_000;

  it(
    'resolves a Promise source through the entry',
    async () => {
      const { create } = setup();
      const query = create(() =>
        createQuery<number>(async () => 1, { key: () => ['query-run'], lazy: true }),
      );

      const started = performance.now();
      for (let i = 0; i < RUNS; i++) await query.run();
      const ms = performance.now() - started;
      reportEach('createQuery run, promise source', ms, RUNS);

      expect(query.fetchCount()).toBe(RUNS);
      expect((ms * 1000) / RUNS).toBeLessThan(CEILING_PER_OP_US);
    },
    TIMEOUT_MS,
  );

  it(
    'joining an in-flight query is a promise check, not another source call',
    () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setup([provideSignalRequest({ gcTime: GC })]);
      const c = cache();
      const entry = c.resolve<number>(['query-dedup']);
      entry.subscribe(GC);

      let calls = 0;
      const never = new Promise<number>(() => undefined);
      const plan: QueryFetchPlan<number> = {
        kind: 'query',
        structuralSharing: (_previous, next) => next,
        retry: undefined,
        parse: undefined,
        run: () => {
          calls += 1;
          return never;
        },
      };

      const first = entry.fetch(plan);
      first.catch(() => undefined);

      const started = performance.now();
      for (let i = 0; i < JOIN; i++) void entry.fetch(plan);
      const ms = performance.now() - started;
      reportEach('createQuery dedup, joined fetch', ms, JOIN);

      expect(calls).toBe(1);
      expect((ms * 1000) / JOIN).toBeLessThan(CEILING_PER_OP_US);

      entry.cancel();
      c.clear();
    },
    TIMEOUT_MS,
  );
});
