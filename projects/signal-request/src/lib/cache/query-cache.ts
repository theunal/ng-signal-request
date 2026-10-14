import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { CacheEntry } from './cache-entry';
import { matchesFilter, normalizeKey, type QueryKey, type QueryKeyFilter } from './key';

/** Notified whenever an entry is created, written or removed. Devtools subscribe to this. */
export type CacheChangeListener = () => void;

/**
 * The store. One per application instance.
 *
 * It owns nothing but a `Map` and the `HttpClient` — all the interesting
 * behaviour lives in `CacheEntry`. That split is deliberate: a handle never talks
 * to this class directly, it goes through the entry it resolved, so there is
 * exactly one object that can be asked "is this fetching?".
 *
 * ### Why `providedIn: 'root'` is per-request enough on the server
 *
 * On the server this must not be shared across requests: two users rendering
 * `/users` at the same moment would otherwise see each other's data. `root` means
 * the root **environment injector of the application**, and every
 * `bootstrapApplication` / `renderApplication` call creates its own — so each
 * server-rendered application already gets an isolated cache, with no factory and
 * nothing for the user to remember to provide.
 */
@Injectable({ providedIn: 'root' })
export class QueryCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly listeners = new Set<CacheChangeListener>();
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * The entry for `key`, created on first use.
   *
   * `debugName` is taken from whichever handle created the entry, so the devtools
   * panel shows a name without every handle having to agree on one.
   */
  resolve<T>(key: QueryKey, debugName?: string): CacheEntry<T> {
    const normalized = normalizeKey(key);
    const existing = this.entries.get(normalized.hash) as CacheEntry<T> | undefined;
    if (existing && !existing.isDestroyed) return existing;

    const entry = new CacheEntry<T>(
      normalized,
      this.http,
      debugName,
      this.isBrowser,
      // The entry cannot reach the map, so it is handed the one operation it
      // needs. Without this a `gcTime`-expired entry would sit in the map forever.
      () => this.forget(entry.hash),
    );
    this.entries.set(normalized.hash, entry as CacheEntry<unknown>);
    this.notify();
    return entry;
  }

  /** The entry for `key`, or `undefined`. Never creates one. */
  peek<T>(key: QueryKey): CacheEntry<T> | undefined {
    const normalized = normalizeKey(key);
    const entry = this.entries.get(normalized.hash) as CacheEntry<T> | undefined;
    return entry && !entry.isDestroyed ? entry : undefined;
  }

  /** Drops an entry from the map without touching it. Private: the gc hook is the only caller. */
  private forget(hash: string): void {
    if (this.entries.delete(hash)) this.notify();
  }

  /** Every live entry. Iteration order is insertion order. */
  all(): readonly CacheEntry<unknown>[] {
    return [...this.entries.values()].filter((entry) => !entry.isDestroyed);
  }

  /** Entries matching a filter — see `matchesFilter` for the two accepted shapes. */
  matching(filter: QueryKeyFilter): CacheEntry<unknown>[] {
    return this.all().filter((entry) =>
      matchesFilter({ hash: entry.hash, segments: entry.segments, raw: entry.raw }, filter),
    );
  }

  /**
   * Marks every matching entry as owing a fetch.
   *
   * Marking is separate from fetching on purpose. Phase 2 layers a `QueryClient`
   * on top that batches these into one pass and drives the refetches, so nothing
   * in the store has to know when a refetch is due.
   */
  markInvalidated(filter: QueryKeyFilter): number {
    const matched = this.matching(filter);
    for (const entry of matched) entry.markInvalidated();
    if (matched.length > 0) this.notify();
    return matched.length;
  }

  /**
   * Removes every matching entry and destroys it.
   *
   * Destroying aborts an in-flight fetch and rejects whatever promise was waiting
   * on it, so a removal during a load surfaces as a `RequestCancelledError`
   * rather than a hang.
   */
  remove(filter: QueryKeyFilter): number {
    const matched = this.matching(filter);
    for (const entry of matched) {
      this.entries.delete(entry.hash);
      entry.destroy();
    }
    if (matched.length > 0) this.notify();
    return matched.length;
  }

  /** Number of live entries. Asserted by the leak tests. */
  get size(): number {
    return this.entries.size;
  }

  /** Empties the cache and destroys every entry. Mainly for tests and devtools. */
  clear(): void {
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
    this.notify();
  }

  /**
   * Registers a change listener.
   *
   * This is the seam the devtools panel hangs off, and it is why the devtools
   * entry point can be a separate bundle without the store knowing it exists.
   */
  subscribeChanges(listener: CacheChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    // Copied first: a listener may unsubscribe itself while we are iterating.
    for (const listener of [...this.listeners]) listener();
  }
}