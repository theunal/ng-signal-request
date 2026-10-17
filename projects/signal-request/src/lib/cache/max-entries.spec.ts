import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequest, provideSignalRequest, QueryCache, QueryClient } from '../../public-api';
import { cache, settle, setup } from '../../../testing/testing';

/**
 * `maxEntries` — bounding the cache in space.
 *
 * The store is driven directly through `QueryCache.resolve` / `CacheEntry.subscribe` for the
 * eviction tests, because a handle wraps a subscription in an `effect` and the ordering question
 * here ("which entry is the oldest") is about the cache, not about Angular's scheduler. The last
 * test in the file goes through real handles to prove the wiring, since that is what the acceptance
 * criterion is written in terms of.
 */

interface User {
  id: number;
}

/**
 * Deliberately white-box.
 *
 * `recency` is pruned on every removal path, and a missed prune is a leak the public API cannot
 * show — the entry count would look right while the map grew with the number of keys ever seen.
 * Reaching in is the only way to assert it; the cast is the whole cost.
 */
function recencySize(instance: QueryCache): number {
  return (instance as unknown as { recency: Map<string, number> }).recency.size;
}

/** An entry with no observer and a `gcTime` long enough that nothing is collected during a test. */
const GC = 60_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('maxEntries — the cap', () => {
  it('is unlimited until something declares one', () => {
    setup();
    expect(cache().maxEntries).toBe(Infinity);
  });

  it('comes from provideSignalRequest', () => {
    setup([provideSignalRequest({ maxEntries: 250 })]);
    expect(cache().maxEntries).toBe(250);
  });

  it('is floored and never negative, and NaN means unlimited rather than no eviction', () => {
    setup([provideSignalRequest({ maxEntries: 10.7 })]);
    const c = cache();
    expect(c.maxEntries).toBe(10);
    c.tightenMaxEntries(-5);
    expect(c.maxEntries).toBe(0);
    c.tightenMaxEntries(Number.NaN);
    expect(c.maxEntries).toBe(0);
  });

  it('a per-request value can only tighten it, never raise it', () => {
    const { create } = setup([provideSignalRequest({ maxEntries: 4 })]);
    const c = cache();
    expect(c.maxEntries).toBe(4);

    // Asking for more room is ignored: the global value is a ceiling no leaf request can raise.
    create(() => createRequest('/a', { key: () => ['a'], lazy: true, maxEntries: 1000 }));
    expect(c.maxEntries).toBe(4);

    // Asking for less room is honoured, whichever order the requests were built in.
    create(() => createRequest('/b', { key: () => ['b'], lazy: true, maxEntries: 2 }));
    expect(c.maxEntries).toBe(2);
  });
});

describe('maxEntries — eviction', () => {
  it('evicts the least recently used idle entry, and keeps the newest', () => {
    setup([provideSignalRequest({ maxEntries: 3, gcTime: GC })]);
    const c = cache();

    for (let i = 0; i < 5; i++) {
      // Subscribe and immediately unsubscribe: the entry is created, then idle, in a known order.
      c.resolve(['k', i]).subscribe(GC)();
    }

    expect(c.size).toBe(3);
    expect(c.peek(['k', 0])).toBeUndefined();
    expect(c.peek(['k', 1])).toBeUndefined();
    expect(c.peek(['k', 2])).toBeDefined();
    expect(c.peek(['k', 3])).toBeDefined();
    expect(c.peek(['k', 4])).toBeDefined();
  });

  it('never evicts an entry a subscriber is still watching, and overshoots instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setup([provideSignalRequest({ maxEntries: 1, gcTime: GC })]);
    const c = cache();

    const releaseA = c.resolve(['a']).subscribe(GC);
    const releaseB = c.resolve(['b']).subscribe(GC);

    // Both are live, so neither may be taken: the cap is missed rather than a mounted component
    // losing its data.
    expect(c.size).toBe(2);
    expect(c.peek(['a'])).toBeDefined();
    expect(c.peek(['b'])).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('maxEntries');

    // Warned once per episode, not once per insert.
    warn.mockClear();
    const releaseC = c.resolve(['c']).subscribe(GC);
    expect(warn).not.toHaveBeenCalled();
    expect(c.size).toBe(3);

    // Once entries go idle they are collected, and the warning state resets.
    releaseA();
    releaseB();
    releaseC();
    c.resolve(['d']).subscribe(GC)();
    expect(c.size).toBe(1);
  });

  it('stays quiet outside dev mode', () => {
    // `isDevMode()` reads a global, so the branch is reachable — and a branch nobody has run is a
    // branch that could be inverted without anyone noticing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scope = globalThis as { ngDevMode?: boolean };
    const previous = scope.ngDevMode;
    scope.ngDevMode = false;
    try {
      setup([provideSignalRequest({ maxEntries: 1, gcTime: GC })]);
      const c = cache();
      // The same overshoot that warns in dev mode.
      const releaseA = c.resolve(['a']).subscribe(GC);
      const releaseB = c.resolve(['b']).subscribe(GC);
      expect(c.size).toBe(2);
      expect(warn).not.toHaveBeenCalled();
      releaseA();
      releaseB();
    } finally {
      if (previous === undefined) delete scope.ngDevMode;
      else scope.ngDevMode = previous;
    }
  });

  it('refuses an entry with a request in flight even when nobody is watching', () => {
    // The second half of the eviction guard, isolated. `isFetching` is a `WritableSignal` on the
    // entry, so the state is reachable without standing up a request that never settles.
    setup();
    const c = cache();
    const entry = c.resolve(['x']);
    expect(entry.observerCount).toBe(0);

    entry.isFetching.set(true);
    expect(c.evictIdle(['x'])).toBe(0);
    expect(c.peek(['x'])).toBeDefined();

    entry.isFetching.set(false);
    expect(c.evictIdle(['x'])).toBe(1);
    expect(c.peek(['x'])).toBeUndefined();
  });

  it('enforces on insert rather than on release, so a burst of releases is trimmed by the next insert', () => {
    setup([provideSignalRequest({ maxEntries: 2, gcTime: GC })]);
    const c = cache();

    // Four idle entries and a cap of two: nothing has arrived to trigger a trim, and `gcTime` is the
    // only thing that would collect them. This is the honest bound — the cap bounds accumulation,
    // not the peak of what was once simultaneously live.
    for (let i = 0; i < 4; i++) c.resolve(['k', i]).subscribe(GC)();
    expect(c.size).toBe(2);

    c.resolve(['k', 4]).subscribe(GC)();
    expect(c.size).toBe(2);
    expect(c.peek(['k', 4])).toBeDefined();
  });

  it('drops what no longer fits when the cap is lowered later', () => {
    setup([provideSignalRequest({ maxEntries: 10, gcTime: GC })]);
    const c = cache();
    for (let i = 0; i < 6; i++) c.resolve(['k', i]).subscribe(GC)();
    expect(c.size).toBe(6);

    c.tightenMaxEntries(2);
    expect(c.size).toBe(2);
    // Newest first, as always.
    expect(c.peek(['k', 5])).toBeDefined();
    expect(c.peek(['k', 4])).toBeDefined();
    expect(recencySize(c)).toBe(2);
  });
});

describe('maxEntries — collection and memory', () => {
  it('keeps the gc timer of everything it keeps, and clears the timer of everything it takes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([provideSignalRequest({ maxEntries: 2, gcTime: 1000 })]);
    const c = cache();

    for (let i = 0; i < 4; i++) c.resolve(['k', i]).subscribe(1000)();
    expect(c.size).toBe(2);
    // Two survivors, two timers — the two evicted entries left nothing scheduled behind them.
    expect(vi.getTimerCount()).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(c.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds 10,000 distinct keys inside the cap, and leaves no timer behind afterwards', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([provideSignalRequest({ maxEntries: 100, gcTime: 60_000 })]);
    const c = cache();

    let peak = 0;
    for (let i = 0; i < 10_000; i++) {
      c.resolve(['items', i]).subscribe(60_000)();
      peak = Math.max(peak, c.size);
    }

    expect(peak).toBeLessThanOrEqual(100);
    expect(c.size).toBe(100);
    // Exactly one collection timer per surviving entry: the eviction path takes the timer with it.
    expect(vi.getTimerCount()).toBe(100);
    // The bookkeeping map is pruned with the entries, or the leak would just move.
    expect(recencySize(c)).toBe(100);

    c.clear();
    expect(c.size).toBe(0);
    expect(recencySize(c)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates no timer on the server, while still respecting the cap', () => {
    // A server-side timer would only hold stability, so `armGcTimer` never runs there — and eviction
    // must not introduce one, or SSR would start waiting on the cache.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setup([
      { provide: PLATFORM_ID, useValue: 'server' },
      provideSignalRequest({ maxEntries: 1, gcTime: 1000 }),
    ]);
    const c = cache();

    for (let i = 0; i < 5; i++) c.resolve(['k', i]).subscribe(1000)();

    expect(c.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('maxEntries — the QueryClient surface', () => {
  it('reports the size as a live signal', async () => {
    setup([provideSignalRequest({ gcTime: GC })]);
    const client = TestBed.inject(QueryClient);
    const c = cache();

    expect(client.size()).toBe(0);

    const release = c.resolve(['keep']).subscribe(GC);
    await settle();
    expect(client.size()).toBe(1);

    release();
    // Released, but still held until `gcTime` — the signal reports entries, not observers.
    await settle();
    expect(client.size()).toBe(1);

    c.remove(['keep']);
    await settle();
    expect(client.size()).toBe(0);
  });

  it('evict() takes only what nothing is watching, and reports how many went', async () => {
    setup([provideSignalRequest({ gcTime: GC })]);
    const client = TestBed.inject(QueryClient);
    const c = cache();

    const release = c.resolve(['users', 1]).subscribe(GC);
    c.resolve(['users', 2]).subscribe(GC)();
    c.resolve(['todos']).subscribe(GC)();

    expect(client.evict(['users'])).toBe(1);
    expect(c.peek(['users', 1])).toBeDefined();
    expect(c.peek(['users', 2])).toBeUndefined();
    expect(c.peek(['todos'])).toBeDefined();

    // The empty filter is every key.
    expect(client.evict()).toBe(1);
    expect(c.peek(['todos'])).toBeUndefined();
    expect(c.size).toBe(1);

    release();
  });

  it('evict() reports zero when everything matching is in use', () => {
    setup([provideSignalRequest({ gcTime: GC })]);
    const client = TestBed.inject(QueryClient);
    const c = cache();
    const release = c.resolve(['users']).subscribe(GC);

    expect(client.evict(['users'])).toBe(0);
    expect(c.size).toBe(1);
    release();
  });
});

describe('maxEntries — through real handles', () => {
  it('bounds the cache as components come and go', async () => {
    const { http, createChild } = setup([
      provideSignalRequest({ maxEntries: 2, gcTime: GC, staleTime: 60_000 }),
    ]);
    const c = cache();

    for (let i = 0; i < 4; i++) {
      const child = createChild();
      child.create(() =>
        createRequest<User[]>(`/list/${i}`, { key: () => ['list', i], initialValue: [] }),
      );
      await settle();
      http.expectOne(`/list/${i}`).flush([{ id: i }]);
      await settle();
      child.destroy();
      await settle();
      // Never more than the cap, at any point in the loop.
      expect(c.size).toBeLessThanOrEqual(2);
    }

    // The two newest survived; the two oldest were taken as their successors arrived.
    expect(c.size).toBe(2);
    expect(c.peek(['list', 0])).toBeUndefined();
    expect(c.peek(['list', 1])).toBeUndefined();
    expect(c.peek(['list', 2])).toBeDefined();
    expect(c.peek(['list', 3])).toBeDefined();
    http.expectNone(() => true);
  });
});
