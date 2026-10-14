import { computed, inject, Injectable, type Signal } from '@angular/core';
import type { CacheEntry } from './cache-entry';
import type { QueryKey, QueryKeyFilter } from './key';
import { MutationRegistry } from './mutation-registry';
import { QueryCache } from './query-cache';

/**
 * How a local write should be computed.
 *
 * A function keeps the read and the write atomic even if something else writes the entry in
 * between — which is exactly what happens when several mutations settle in the same tick.
 */
export type Updater<T> = T | ((previous: T | undefined) => T | undefined);

/**
 * The imperative cache API: invalidate by key, read and write by key, drive refetches.
 *
 * Injectable rather than a singleton so it is reachable from a service, a component, an
 * interceptor or a mutation — anywhere. It is a thin, typed shell over {@link QueryCache}: the
 * cache knows *how* entries work, and this knows *what a user means* by "everything under
 * `users`".
 *
 * ```ts
 * private readonly client = inject(QueryClient);
 *
 * this.client.invalidate(['users']);            // refetches ['users', …] on screen
 * this.client.invalidate((s) => s === 'todos'); // a predicate over each segment
 * this.client.setData(['users', 1], (list) => list?.filter((u) => !u.banned));
 * ```
 */
@Injectable({ providedIn: 'root' })
export class QueryClient {
  private readonly cache = inject(QueryCache);
  private readonly mutations = inject(MutationRegistry);

  /**
   * Entries queued for a refetch this tick, keyed by hash.
   *
   * Keyed rather than an array because the whole point is coalescing: three mutations that each
   * invalidate `['users']` in the same tick must produce **one** refetch, not three.
   */
  private readonly pending = new Map<string, CacheEntry<unknown>>();
  private scheduled = false;

  /**
   * Marks matching entries as owing a fetch, and refetches the ones somebody is watching.
   *
   * Unsubscribe entries are only *marked*: nothing is watching them, so there is nothing to
   * refetch for, and the next subscriber will see `isStale()` and fetch on its own.
   *
   * Returns how many entries matched, so a caller can tell "nothing matched" from "matched but
   * not visible yet".
   */
  invalidate(filter: QueryKeyFilter): number {
    const matched = this.cache.matching(filter);
    for (const entry of matched) entry.markInvalidated();
    this.schedule(matched);
    return matched.length;
  }

  /**
   * Refetches matching entries without marking them stale.
   *
   * Use `invalidate` unless you specifically mean "refresh the screen but keep calling this data
   * fresh" — that is a distinction worth making deliberately.
   */
  refetch(filter: QueryKeyFilter): number {
    const matched = this.cache.matching(filter);
    this.schedule(matched);
    return matched.length;
  }

  /** Aborts the in-flight request of every matching entry. */
  cancel(filter: QueryKeyFilter): number {
    const matched = this.cache.matching(filter);
    for (const entry of matched) entry.cancel();
    return matched.length;
  }

  /** The cached value for an exact key, or `undefined`. Never creates an entry. */
  getData<T>(key: QueryKey): T | undefined {
    return this.cache.peek<T>(key)?.data();
  }

  /**
   * Writes a value into an entry without going to the network.
   *
   * A fresh value also makes the entry no longer stale — a local write *is* the truth until
   * something invalidates it. Use `invalidate` afterwards when the server needs to be told.
   *
   * The entry must already exist: there is no request description to build one from, and a
   * handle has to have been here first for there to be a value to update.
   */
  setData<T>(key: QueryKey, updater: Updater<T>): T | undefined {
    const entry = this.cache.peek<T>(key);
    if (!entry) return undefined;
    const next =
      typeof updater === 'function' ? (updater as (previous: T | undefined) => T | undefined)(entry.data()) : updater;
    return next === undefined ? undefined : entry.setData(next);
  }

  /** Removes matching entries, aborting anything in flight. */
  remove(filter: QueryKeyFilter): number {
    return this.cache.remove(filter);
  }

  /**
   * Whether anything is on the network.
   *
   * With a filter: whether anything **matching** is fetching. Without: whether anything at all
   * is, which is the global "is a request in progress" indicator.
   */
  isFetching(filter?: QueryKeyFilter): boolean {
    const matched = filter === undefined ? this.cache.all() : this.cache.matching(filter);
    return matched.some((entry) => entry.isFetching());
  }

  /** How many entries match. Zero is a legitimate answer, not an error. */
  count(filter: QueryKeyFilter): number {
    return this.cache.matching(filter).length;
  }

  /** Empties the cache. Mostly for tests and devtools. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * How many **mutations** are in flight.
   *
   * A signal, because the answer changes on its own — a toolbar that shows a spinner has nothing
   * to re-read to find out. With a filter it counts only mutations whose `mutationKey` matches, so
   * `client.isMutating(['todos'])` answers "is a todo being written?" without the caller holding
   * a reference to any of them.
   */
  isMutating(filter?: QueryKeyFilter): Signal<boolean> {
    if (filter === undefined) return this.mutations.isMutating;
    const count = this.mutations.countMatching(filter);
    return computed(() => count() > 0);
  }

  /** The number of mutations in flight, optionally filtered by `mutationKey`. */
  mutatingCount(filter?: QueryKeyFilter): Signal<number> {
    return filter === undefined ? this.mutations.count : this.mutations.countMatching(filter);
  }

  /**
   * Queues entries for a refetch, collapsing everything queued in this tick into one pass.
   *
   * A microtask rather than a timer: invalidation is usually followed by the UI settling in the
   * same turn, and the user should not see a frame where half the queries have already
   * refetched and half have not.
   */
  private schedule(entries: readonly CacheEntry<unknown>[]): void {
    for (const entry of entries) this.pending.set(entry.hash, entry);
    if (this.scheduled) return;
    this.scheduled = true;

    queueMicrotask(() => {
      this.scheduled = false;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const entry of batch) {
        // An entry with no observers has nobody to show a refetch to. It stays marked invalid,
        // so whoever subscribes next fetches.
        if (entry.isIdle) continue;
        void entry.refetch();
      }
    });
  }
}