import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { inject, Injectable, isDevMode, PLATFORM_ID, untracked } from '@angular/core';
import { SIGNAL_REQUEST_CONFIG } from '../config';
import { OnlineManager } from '../connectivity';
import { CacheEntry, type SeedValue } from './cache-entry';
import { matchesFilter, normalizeKey, type QueryKey, type QueryKeyFilter } from './key';

/** Notified whenever an entry is created, written or removed. Devtools subscribe to this. */
export type CacheChangeListener = () => void;

/** A value waiting for its key to be asked for. See {@link QueryCache.seed}. */
type Seed = SeedValue<unknown>;

/**
 * A cap is a count, so it is floored and never negative. `undefined` and `NaN` both mean "no cap" —
 * the second because every comparison against `NaN` is false, which would silently disable eviction
 * if it reached `cap`.
 */
function normalizeCap(cap: number | undefined): number {
  if (cap === undefined || Number.isNaN(cap)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(cap));
}

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
  private readonly entries = new Map<string, CacheEntry>();
  private readonly listeners = new Set<CacheChangeListener>();
  private readonly activityListeners = new Set<CacheChangeListener>();
  /** Detaches the settle listener of each entry, so a forgotten entry leaves nothing behind. */
  private readonly settleDetachers = new Map<string, () => void>();
  /**
   * Values staged by `seed` / `hydrate`, waiting for their key to be asked for.
   *
   * Kept in insertion order, which makes a tie in `dataUpdatedAt` resolve to "whoever was staged
   * first". They count toward the cap like entries do.
   */
  private readonly seeds = new Map<string, Seed>();
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly config = inject(SIGNAL_REQUEST_CONFIG);
  /**
   * The one connectivity source, read by every entry this cache creates.
   *
   * Injected here rather than inside the entry so the entry stays constructible as a plain object —
   * its unit tests build it positionally — and so an application (or a test) that wants a different
   * answer overrides one token rather than every request.
   */
  private readonly connectivity = inject(OnlineManager);

  /* --------------------------------------------------------------------- */
  /*  maxEntries                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * How many idle entries may stay. `Infinity` until something declares a cap.
   *
   * The global value is read straight from {@link SIGNAL_REQUEST_CONFIG} — it is a property of the
   * store, so the store owns it. Per-request values arrive through {@link tightenMaxEntries}, which
   * is the only way a handle can have a say.
   *
   * The cap bounds **entries plus staged seeds** — see {@link enforceCap}.
   */
  private cap = normalizeCap(this.config.maxEntries);

  /** Monotonic counter behind {@link recency}. Plain, because nothing renders it. */
  private useSeq = 0;

  /**
   * When each entry was last used, keyed like {@link settleDetachers}.
   *
   * A parallel map rather than a field on `CacheEntry`, because `CacheEntry` is exported and read by
   * the devtools panel: a bookkeeping detail should not become public API, let alone a column.
   *
   * Ordering is what matters, not the numbers, so it is a counter rather than `Date.now()` — two
   * entries touched in the same millisecond would otherwise tie, and a tie makes eviction order
   * depend on `Map` iteration order.
   */
  private readonly recency = new Map<string, number>();

  /** Set while the cache is over its cap, so an undersized cap does not log on every insert. */
  private capWarned = false;

  /** The effective cap. `Infinity` when nothing configured one. */
  get maxEntries(): number {
    return this.cap;
  }

  /**
   * Narrows the cap, and drops whatever no longer fits.
   *
   * A cap is a budget for the whole cache rather than an allowance for the request that asked for
   * it, so this can only ever **lower** the value — the global setting stays a ceiling that no leaf
   * request can raise. That makes the outcome independent of the order requests are constructed in,
   * which a last-writer-wins rule would not be. See `docs/design-0.2.md`.
   */
  tightenMaxEntries(cap: number): void {
    const next = normalizeCap(cap);
    // `!(next < cap)` also rejects `NaN`, which would otherwise poison every comparison.
    if (!(next < this.cap)) return;
    this.cap = next;
    this.enforceCap(0);
    this.warnIfOverCap();
  }

  /**
   * Removes matching entries that have **no observer and nothing in flight**, and reports how many.
   *
   * The `maxEntries` policy as something a caller can invoke. `remove()` is the unconditional
   * version, for when you know what you are doing; this one refuses to take an entry that a mounted
   * component is reading or that a `run()` is waiting on.
   *
   * The default filter is the empty prefix, which `startsWith` treats as matching everything: that
   * is "trim the cache", which is what a debug screen's button wants.
   */
  evictIdle(filter: QueryKeyFilter = []): number {
    let removed = 0;
    for (const entry of this.matching(filter)) {
      if (!this.isEvictable(entry)) continue;
      entry.evict();
      removed++;
    }
    this.warnIfOverCap();
    return removed;
  }

  /**
   * Whether an entry may be taken: nobody is watching, and no request is waiting on an answer.
   *
   * A paused entry cannot reach the first half of that: the hold lives in `inFlight`, which makes it
   * join-able rather than idle, and an entry loses its last observer only through `release()` — which
   * cancels on the way out and so lets go of the hold first. Anything that ever changes that has to
   * change this clause with it.
   */
  private isEvictable(entry: CacheEntry): boolean {
    return entry.observerCount === 0 && !entry.isFetching();
  }

  /** Drops least-recently-used idle entries until at most `target` remain. */
  private evictUntilAtMost(target: number): void {
    while (this.entries.size > target) {
      const victim = this.leastRecentlyUsedIdle();
      if (victim === undefined) return;
      const before = this.entries.size;
      victim.evict();
      // A teardown that removed nothing would spin this loop forever. `forget` is the only route
      // out and it always deletes, so this is insurance rather than an expected branch.
      if (this.entries.size >= before) return;
    }
  }

  /**
   * Brings **entries and staged seeds together** back under the cap, leaving room for `reserve`
   * entries that are about to be inserted.
   *
   * Staged seeds are counted because they are the same promise the cap bounds: a value being held
   * for a key somebody will ask for. A persisted snapshot that arrives through `hydrate` is exactly
   * as much memory as the entries it will become, and leaving it outside the cap would let a large
   * snapshot bypass the bound entirely — the gap this closes. Seeds are dropped before entries; see
   * {@link dropSeedsToFit} for why, and `docs/design-0.2.md` for the policy.
   */
  private enforceCap(reserve: number): void {
    const target = this.cap - reserve;
    this.dropSeedsToFit(target);
    this.evictUntilAtMost(target);
  }

  /**
   * Drops the oldest staged seeds until `target - entries.size` of them remain.
   *
   * A seed goes before an entry. A seed is a value **no handle has asked for yet this session**, so
   * losing one costs a refetch the next time its key is used; evicting an entry additionally throws
   * away an object handles have already resolved. And the seed is the *cheaper* side to be wrong
   * about, because nothing can be mid-flight on a value that has not been consumed.
   *
   * Oldest `dataUpdatedAt` first, ties going to whoever was staged first. That is the same clock
   * `staleTime` uses, so the seed dropped is the one least likely to have been worth restoring.
   */
  private dropSeedsToFit(target: number): void {
    // Clamped, because the budget can go negative: a cache whose live entries already exceed the cap
    // has no room for seeds at all, and `while (size > -3)` would never terminate.
    const budget = Math.max(0, target - this.entries.size);
    while (this.seeds.size > budget) {
      this.seeds.delete(this.oldestSeed());
    }
  }

  /**
   * The hash of the staged seed with the earliest `dataUpdatedAt`; a tie keeps the first staged.
   *
   * Total rather than `string | undefined` on purpose: the only caller reaches it with a non-empty
   * map, which its loop condition guarantees. An `undefined` return would have to mean "drop
   * nothing", which is precisely the state that would leave the cap unmet — and the sentinel is a
   * key no hash can take (`''`), so a future caller that gets this wrong drops nothing rather than
   * something arbitrary.
   */
  private oldestSeed(): string {
    let oldest = '';
    let earliest = Number.POSITIVE_INFINITY;
    for (const [hash, seed] of this.seeds) {
      if (seed.dataUpdatedAt < earliest) {
        earliest = seed.dataUpdatedAt;
        oldest = hash;
      }
    }
    return oldest;
  }

  private leastRecentlyUsedIdle(): CacheEntry | undefined {
    let best: CacheEntry | undefined;
    let bestSeq = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (!this.isEvictable(entry)) continue;
      const seq = this.recency.get(entry.hash) ?? 0;
      if (seq < bestSeq) {
        bestSeq = seq;
        best = entry;
      }
    }
    return best;
  }

  /**
   * Says so, in dev mode, when the cap cannot be met without taking a live entry.
   *
   * Overshoot is the designed outcome here — the alternative is evicting something a component is
   * rendering — but it is almost always a sign that `maxEntries` is smaller than the working set, and
   * silence would make that a mystery. Logged once per episode rather than once per insert.
   */
  private warnIfOverCap(): void {
    if (this.entries.size <= this.cap) {
      this.capWarned = false;
      return;
    }
    if (this.capWarned || !isDevMode()) return;
    this.capWarned = true;
    console.warn(
      `[ngsr] maxEntries: the cache holds ${this.entries.size} entries against a cap of ${this.cap}. ` +
        'Every entry that could be dropped has a subscriber or a request in flight, so the cache ' +
        'stays over its cap until one goes idle. Raise `maxEntries` if this is not a burst.',
    );
  }

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

    // Before the new entry joins the map, so the entry somebody just asked for is never the one
    // that gets taken. Enforced here — on insert — because this is the only moment the cache grows,
    // and it has to be synchronous for the cap to be a memory bound rather than a report.
    //
    // The consumed seed was already removed from `seeds` above, and the new entry is not in `entries`
    // yet, so the reservation is exactly one place: `enforceCap(1)` leaves room for it and nothing
    // else. That ordering is also what makes it impossible for a resolve to lose its own seed to
    // eviction.
    this.enforceCap(1);

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
      // Trailing, so the positional construction the entry's own tests use keeps working unchanged.
      this.connectivity,
    );
    this.entries.set(normalized.hash, entry as CacheEntry);
    this.recency.set(normalized.hash, ++this.useSeq);

    this.settleDetachers.set(
      normalized.hash,
      entry.addSettleListener(() => {
        // A response makes an entry more valuable than one that has merely sat there, so it moves to
        // the back of the eviction queue. Guarded by `has` because a settle can arrive after the
        // entry was forgotten, and re-adding the stamp would leak a map entry per forgotten key.
        if (this.recency.has(normalized.hash)) this.recency.set(normalized.hash, ++this.useSeq);
        this.notifyActivity();
      }),
    );
    this.notify();
    this.notifyActivity();
    this.warnIfOverCap();
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
   *
   * A staged value counts toward `maxEntries`, so staging one can drop the oldest staged value:
   * `hydrate`ing a snapshot larger than the cap keeps the most recently fetched entries and forgets
   * the rest, rather than parking the whole file in memory. A value that is dropped is not refused —
   * it is simply not there, and its key fetches normally.
   *
   * ### A seed never clobbers newer data
   *
   * When the key **already has an entry**, the value is applied to it directly — but only when that
   * entry has nothing yet, or when the staged value is **strictly newer** than what it holds. A
   * snapshot read asynchronously arrives after the mount fetch it was racing (the hold was turned
   * off, or it timed out), and the stored value is what the *last* session fetched: by definition
   * older than an answer that is on the way back right now. Overwriting would replace fresh data
   * with stale and report it as a restore.
   *
   * The rule is on `dataUpdatedAt` rather than on "is it fetching", because a fetch that already
   * landed leaves no other trace. It also gets a user edit right for free: `setData` stamps the
   * current time, so a snapshot from before it never wins. A tie keeps the entry's value, because at
   * equal timestamps the entry is what handles are reading.
   */
  seed(key: QueryKey, value: unknown, dataUpdatedAt: number): void {
    const normalized = normalizeKey(key);
    const existing = this.entries.get(normalized.hash);
    if (existing && !existing.isDestroyed) {
      // `untracked`: a seed is a write, and reading a signal here would quietly subscribe whoever
      // called `hydrate` to an entry they never asked for.
      const settledAt = untracked(existing.dataUpdatedAt);
      // `0` is "nothing has been written yet" here, the same reading `isStale` gives it. A tie keeps
      // the entry's value: at equal timestamps it is already the one handles are reading.
      if (settledAt === 0 || dataUpdatedAt > settledAt) existing.restore(value, dataUpdatedAt);
      return;
    }
    this.seeds.set(normalized.hash, { value, dataUpdatedAt });
    // Staging a value is a cache write like any other, so the cap is enforced here too: otherwise a
    // snapshot would sit outside the bound Phase 1 established until the first key resolved.
    this.enforceCap(0);
  }

  /**
   * How many values are waiting for a key to be asked for.
   *
   * These count toward {@link maxEntries}, which is why this is worth reading next to
   * {@link size}: `size + pendingSeeds` is what the cap actually bounds.
   */
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
      this.recency.delete(hash);
      this.notify();
      this.notifyActivity();
    }
  }

  /** Every live entry. Iteration order is insertion order. */
  all(): readonly CacheEntry[] {
    return [...this.entries.values()].filter((entry) => !entry.isDestroyed);
  }

  /** Entries matching a filter — see `matchesFilter` for the two accepted shapes. */
  matching(filter: QueryKeyFilter): CacheEntry[] {
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
      this.recency.delete(entry.hash);
      entry.destroy();
    }
    if (matched.length > 0) this.notify();
    return matched.length;
  }

  /**
   * Number of live entries. Asserted by the leak tests.
   *
   * Not the number `maxEntries` compares against — that one includes {@link pendingSeeds}. This
   * stays "entries" so a call site that means entries keeps meaning entries; `size + pendingSeeds`
   * is the capped total.
   */
  get size(): number {
    return this.entries.size;
  }

  /** Empties the cache and destroys every entry. Mainly for tests and devtools. */
  clear(): void {
    for (const detach of this.settleDetachers.values()) detach();
    this.settleDetachers.clear();
    for (const entry of this.entries.values()) entry.destroy();
    this.entries.clear();
    this.recency.clear();
    // Staged values go too. "Empty" has to mean empty: leaving a seed behind would let a cleared
    // cache hand restored data to the next handle that resolved that key, which is a resurrection
    // nobody asked for.
    this.seeds.clear();
    this.capWarned = false;
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
