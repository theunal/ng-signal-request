import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { CacheEntry, type SeedValue } from './cache-entry';
import { matchesFilter, normalizeKey, type QueryKey, type QueryKeyFilter } from './key';

/** Notified whenever an entry is created, written or removed. Devtools subscribe to this. */
export type CacheChangeListener = () => void;

/** A value waiting for its key to be asked for. See {@link QueryCache.seed}. */
type Seed = SeedValue<unknown>;

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
  private readonly activityListeners = new Set<CacheChangeListener>();
  /** Detaches the settle listener of each entry, so a forgotten entry leaves nothing behind. */
  private readonly settleDetachers = new Map<string, () => void>();
  private readonly seeds = new Map<string, Seed>();
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

    // A seeded value is consumed here and nowhere else, which is the whole point of seeding: an
    // entry comes into existence exactly when a handle asks for its key, so a persisted payload
    // that nothing asks for never becomes an entry at all. See `seed`.
    const seed = this.seeds.get(normalized.hash) as SeedValue<T> | undefined;
    if (seed !== undefined) this.seeds.delete(normalized.hash);

    const entry = new CacheEntry<T>(
      normalized,
      this.http,
      debugName,
      this.isBrowser,
      // The entry cannot reach the map, so it is handed the one operation it
      // needs. Without this a `gcTime`-expired entry would sit in the map forever.
      () => this.forget(entry.hash),
      // Handed to the constructor rather than written afterwards: this method runs inside the
      // handle's key `computed`, and a signal write there is `NG0600`. The signals are initialised
      // with the restored value instead, so a seeded entry is never briefly empty.
      seed,
    );
    this.entries.set(normalized.hash, entry as CacheEntry<unknown>);

    this.settleDetachers.set(
      normalized.hash,
      entry.addSettleListener(() => this.notifyActivity()),
    );
    this.notify();
    this.notifyActivity();
    return entry;
  }

  /**
   * Stages a value for `key` to be applied if and when an entry for that key is created.
   *
   * This is the seam a persistence layer writes into — `localStorage` at startup, or a server
   * render's `TransferState` on the client. It is deliberate that this does not create an entry.
   *
   * Writing straight into the cache would be the obvious implementation and it leaks. The cache
   * only arms an entry's `gcTime` timer when its **last observer leaves**, so an entry created for
   * a persisted key that nothing ever reads would have no observers, no timer, and no way to be
   * collected for the life of the injector. Hydrating a hundred keys would pin a hundred entries.
   * Seeding makes the cost proportional to the keys actually used, and a seeded payload nobody asks
   * for is simply replaced by the next `seed` call.
   *
   * The value is applied without touching the network, so a handle that finds its key seeded is
   * immediately `hasData`, and `staleTime` is measured from `dataUpdatedAt` — the moment the value
   * was originally fetched, not the moment it was restored. That is what makes a persisted entry
   * refetch on mount exactly when it is actually old.
   */
  seed(key: QueryKey, value: unknown, dataUpdatedAt: number): void {
    const normalized = normalizeKey(key);
    const existing = this.entries.get(normalized.hash) as CacheEntry<unknown> | undefined;
    if (existing && !existing.isDestroyed) {
      existing.restore(value, dataUpdatedAt);
      return;
    }
    this.seeds.set(normalized.hash, { value, dataUpdatedAt });
  }

  /** How many values are waiting for a key to be asked for. */
  get pendingSeeds(): number {
    return this.seeds.size;
  }

  /** Discards every staged value. Called before a fresh hydrate, so a stale seed cannot outlive it. */
  clearSeeds(): void {
    this.seeds.clear();
  }

  /** The entry for `key`, or `undefined`. Never creates one. */
  peek<T>(key: QueryKey): CacheEntry<T> | undefined {
    const normalized = normalizeKey(key);
    const entry = this.entries.get(normalized.hash) as CacheEntry<T> | undefined;
    return entry && !entry.isDestroyed ? entry : undefined;
  }

  /** Drops an entry from the map without touching it. Private: the gc hook is the only caller. */
  private forget(hash: string): void {
    if (this.entries.delete(hash)) {
      // The entry is going away; its settle listener must go with it or the cache would hold a
      // closure per forgotten key for the life of the injector.
      this.settleDetachers.get(hash)?.();
      this.settleDetachers.delete(hash);
      this.notify();
      this.notifyActivity();
    }
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
    for (const detach of this.settleDetachers.values()) detach();
    this.settleDetachers.clear();
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
    this.notify();
    this.notifyActivity();
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

  /**
   * Registers a listener for *everything*: entries appearing and disappearing, and every settle of
   * every entry.
   *
   * `subscribeChanges` is the narrower one and stays that way, because "the set of entries changed"
   * and "some data changed" are genuinely different questions and a caller that wants one rarely
   * wants the other. A persistence layer wants this one: a write that only fired when the entry set
   * changed would miss every response.
   *
   * Kept as a listener rather than a `Signal<number>` for a reason recorded the hard way in
   * `devtools.ts`: `resolve` calls its notifications synchronously and can itself be running inside
   * a `computed`, so anything hung off these must not write a signal.
   */
  subscribeActivity(listener: CacheChangeListener): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private notify(): void {
    // Copied first: a listener may unsubscribe itself while we are iterating.
    for (const listener of [...this.listeners]) listener();
  }

  private notifyActivity(): void {
    for (const listener of [...this.activityListeners]) listener();
  }
}