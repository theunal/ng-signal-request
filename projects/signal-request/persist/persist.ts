/**
 * `ng-signal-request/persist` — moving cache state across a boundary.
 *
 * There are two boundaries a browser application cares about and they are the same problem: the
 * **reload** boundary (`localStorage`, between one page load and the next) and the **SSR** boundary
 * (`TransferState`, between a server render and its hydration). Both are "take the cache out, put
 * the cache back", so they share one `dehydrate`/`hydrate` pair here rather than inventing two
 * dialects of the same snapshot.
 *
 * A separate entry point for the same reason as `/devtools`: an application that wants neither
 * shares nothing with one that wants both.
 */
import { isPlatformBrowser } from '@angular/common';
import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  inject,
  InjectionToken,
  Injector,
  makeEnvironmentProviders,
  makeStateKey,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  runInInjectionContext,
  signal,
  TransferState,
  untracked,
  type EnvironmentProviders,
  type Signal,
  type StateKey,
} from '@angular/core';
import {
  QueryCache,
  RESTORE_GATE,
  type CacheEntry,
  type QueryKeyFilter,
  type RestoreGate,
} from 'ng-signal-request';

/* -------------------------------------------------------------------------- */
/*  The snapshot                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Shape version of {@link CacheSnapshot}.
 *
 * A snapshot is untrusted input: it may come from a `localStorage` written by an older version of an
 * application, or by a different application entirely, since a storage key is global. A snapshot
 * whose `version` is not this number is **ignored**, not best-effort parsed — a stale payload read
 * as if it were current is a subtle data corruption, and there is no way to detect it after the
 * fact.
 */
export const SNAPSHOT_VERSION = 1;

/** One restored entry. */
export interface CacheSnapshotEntry {
  /** The original key array, so the entry can be recreated for the same requests. */
  readonly key: readonly unknown[];
  /** The value, already through `codec.serialize` if one was supplied. */
  readonly data: unknown;
  /**
   * Epoch ms of the **original fetch**, not of the snapshot. Restoring this is what makes
   * `staleTime` work across a reload: a value persisted an hour ago comes back an hour old, so a
   * handle with `staleTime: 60_000` refetches on mount instead of trusting it.
   */
  readonly dataUpdatedAt: number;
}

/** What {@link dehydrate} produces and {@link hydrate} accepts. */
export interface CacheSnapshot {
  readonly version: number;
  /** Epoch ms the snapshot was taken. Informational; per-entry ages drive every decision. */
  readonly timestamp: number;
  /**
   * An application-defined stamp for the shape *inside* the entries.
   *
   * The version covers the envelope this library defines; it cannot cover what the application put
   * in the responses. Raise this whenever a change makes an old payload mean something different —
   * a renamed field, a changed unit, a new enum member — and a snapshot carrying a different stamp
   * is dropped exactly like one carrying a different `version`.
   *
   * Unlike `version`, changing it is **cheap**: bump the string and every stored snapshot is
   * discarded on the next load. That is the point of having it.
   *
   * ```ts
   * providePersistedCache({ buster: 'posts-v2' });
   * ```
   */
  readonly buster?: string;
  readonly entries: readonly CacheSnapshotEntry[];
}

/**
 * Converts values to and from something JSON can carry.
 *
 * Needed because both boundaries go through `JSON.stringify`, which silently drops `undefined` in
 * objects, turns a `Date` into a string, flattens a `Map` to `{}`, and cannot express a `Blob` or a
 * `Uint8Array` at all. Whether that matters is application-specific, so it is a hook rather than a
 * built-in guess.
 *
 * Both halves are required rather than optional, so an asymmetric codec — the one that writes
 * `Date` objects into storage and reads back strings — cannot be expressed by accident.
 */
export interface SnapshotCodec {
  serialize(value: unknown): unknown;
  deserialize(value: unknown): unknown;
}

/** `include` / `exclude`, the same filter vocabulary `QueryClient` takes. */
export interface SnapshotFilterOptions {
  /** Only these keys. */
  readonly include?: QueryKeyFilter;
  /** Never these keys, even if `include` allows them. */
  readonly exclude?: QueryKeyFilter;
}

/**
 * Decides whether one entry is worth storing.
 *
 * A `(entry) => boolean` rather than a descriptor object because the entry API is already the
 * honest unit: `include` / `exclude` select by **key**, this selects by **state**, and the two
 * questions have nothing to do with each other.
 */
export type DehydratePredicate = (entry: CacheEntry) => boolean;

export interface DehydrateOptions extends SnapshotFilterOptions {
  readonly codec?: SnapshotCodec;
  /** The clock for `timestamp`. Defaults to `Date.now()`; a test passes a fixed number. */
  readonly now?: number;
  /** Written into the snapshot. See {@link CacheSnapshot.buster}. */
  readonly buster?: string;
  /**
   * Which entries to store. Defaults to entries that **have data, are not fetching and are not in
   * an error state** — see {@link defaultDehydrateFilter} for why each clause is there.
   */
  readonly dehydrateFilter?: DehydratePredicate;
}

/**
 * The default {@link DehydratePredicate}.
 *
 * Three clauses, and each one excludes something that would be wrong to restore:
 *
 * - **has data** — an entry that exists because a handle asked for it, but has not answered yet,
 *   has nothing to restore. `dataUpdatedAt` would be `0` too, so it would come back permanently
 *   stale.
 * - **not fetching** — mid-refetch, the signals are a half-state: the new value may arrive while
 *   this is walking the entry, and what lands in storage depends on the order the two ran.
 * - **no error** — an entry that failed a refetch but still holds yesterday's value is *stale
 *   truth*: the server just refused to confirm it. Restoring it would show data on the next load
 *   that this session already knows to be suspect, and the entry's own error would not come with
 *   it, so nothing on the next load could tell the difference. Excluding it also means the
 *   previous good write stays in place rather than being overwritten by the failed state.
 *
 * This is a narrower default than 0.1.0's "anything with data", and deliberately so: it is a
 * behaviour change on the persist path, recorded in the CHANGELOG.
 */
export const defaultDehydrateFilter: DehydratePredicate = (entry) =>
  entry.hasData() && !entry.isFetching() && entry.error() === undefined;

export interface HydrateOptions {
  readonly codec?: SnapshotCodec;
  /**
   * Drop entries whose `dataUpdatedAt` is further back than this, in ms.
   *
   * Not the same thing as `staleTime`, and both are worth having. An entry too old to bother
   * restoring saves a pointless deserialize and render of data nobody wants; an entry restored a
   * moment too late is `stale` and simply refetches, which is `staleTime`'s job. This option only
   * does the first.
   */
  readonly maxAge?: number;
  /** The clock, for `maxAge`. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Discard staged values for keys the snapshot does not carry. Default `true`. */
  readonly replace?: boolean;
  /** The stamp this application is on. A snapshot carrying a different one is dropped. */
  readonly buster?: string;
  /**
   * Turns a snapshot from an **older** `version` into a current one, or discards it by returning
   * `null`.
   *
   * Called once per snapshot, only when its `version` differs from {@link SNAPSHOT_VERSION} —
   * never for a snapshot that is already current. A `migrate` that throws is caught, the snapshot
   * is discarded, and the cache starts empty: a bad migration has to be a cold first paint, never
   * a bootstrapping failure, because the application that would report the error has not started
   * yet.
   *
   * It receives the snapshot as parsed, which means `entries` may be shaped in whatever way the
   * older version wrote — the return value is what this version understands.
   */
  readonly migrate?: (snapshot: CacheSnapshot, fromVersion: number) => CacheSnapshot | null;
}

/** The entries `include` / `exclude` select, using the cache's own matcher. */
function selectEntries(cache: QueryCache, options: SnapshotFilterOptions): readonly CacheEntry[] {
  const included = options.include === undefined ? cache.all() : cache.matching(options.include);
  if (options.exclude === undefined) return included;
  const excluded = new Set(cache.matching(options.exclude).map((entry) => entry.hash));
  return included.filter((entry) => !excluded.has(entry.hash));
}

/**
 * Takes a snapshot of the cache.
 *
 * Which entries go in is {@link DehydrateOptions.dehydrateFilter}'s decision, and its default keeps
 * only entries that have data, are not fetching and are not in an error state — see
 * {@link defaultDehydrateFilter} for why each clause is there.
 *
 * The reads are `untracked` on purpose: a snapshot is a point-in-time observation, and quietly
 * subscribing the caller to every entry in it would be a surprising thing for a "write this to
 * storage" function to do.
 */
export function dehydrate(cache: QueryCache, options: DehydrateOptions = {}): CacheSnapshot {
  const keep = options.dehydrateFilter ?? defaultDehydrateFilter;
  const entries: CacheSnapshotEntry[] = [];

  for (const entry of selectEntries(cache, options)) {
    if (!keep(entry)) continue;
    const data = untracked(entry.data);
    if (data === undefined) continue;
    entries.push({
      key: entry.raw,
      data: options.codec ? options.codec.serialize(data) : data,
      dataUpdatedAt: untracked(entry.dataUpdatedAt),
    });
  }

  return {
    version: SNAPSHOT_VERSION,
    timestamp: options.now ?? Date.now(),
    buster: options.buster,
    entries,
  };
}

/**
 * Stages a snapshot into the cache and returns how many entries were accepted.
 *
 * **Nothing is created here.** Each entry is *seeded*: the value waits for a handle to ask for that
 * key, and is applied the moment the cache creates the entry. That is not an optimisation, it is the
 * difference between a persister that leaks and one that does not — see `QueryCache.seed`. A payload
 * for a key the application never asks for is dropped rather than pinned for the life of the
 * injector.
 *
 * The count is what the snapshot **contributed**, not what survived: the `maxEntries` policy may
 * drop a staged value the moment it is staged, and that is the cache's policy rather than this
 * function's.
 */
export function hydrate(
  cache: QueryCache,
  snapshot: CacheSnapshot | null | undefined,
  options: HydrateOptions = {},
): number {
  // A snapshot from another version, or no snapshot at all, is not an error: it is what a first
  // visit, a cleared storage and a version upgrade all look like. Start clean and answer `0`.
  if (snapshot == null) return 0;

  const accepted = acceptVersion(snapshot, options);
  if (accepted === null) return 0;

  if (options.replace !== false) cache.clearSeeds();

  const now = options.now ?? Date.now();
  let restored = 0;

  for (const entry of accepted.entries) {
    if (options.maxAge !== undefined && now - entry.dataUpdatedAt > options.maxAge) continue;

    const data = options.codec ? options.codec.deserialize(entry.data) : entry.data;
    if (data === undefined) continue;

    cache.seed(entry.key, data, entry.dataUpdatedAt);
    restored++;
  }

  return restored;
}

/**
 * The snapshot this version of the library is willing to read, or `null`.
 *
 * Two gates, in a fixed order, and the order matters: **`version` first, then `buster`.** A
 * `migrate` hook exists to turn an older *shape* into a current one, so it has to see the payload
 * before any question about stamps — and a buster mismatch on a migrated snapshot still has to
 * drop it, because the buster is the application's statement about the *contents*, which a shape
 * migration knows nothing about.
 */
function acceptVersion(snapshot: CacheSnapshot, options: HydrateOptions): CacheSnapshot | null {
  let candidate = snapshot;

  if (candidate.version !== SNAPSHOT_VERSION) {
    const migrate = options.migrate;
    if (migrate === undefined) return null;
    try {
      const migrated = migrate(candidate, candidate.version);
      if (migrated === null) return null;
      candidate = migrated;
    } catch {
      // A migration that throws has to be a cold first paint rather than a bootstrapping failure:
      // the application that would report the error has not started yet.
      return null;
    }
    // A migration that hands back a *different* version has not done its job, and reading it as if
    // it had would put the shape check back where it started.
    if (candidate.version !== SNAPSHOT_VERSION) return null;
  }

  if (options.buster !== undefined && candidate.buster !== options.buster) return null;

  return candidate;
}

/* -------------------------------------------------------------------------- */
/*  The date codec                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A **full** ISO-8601 instant with a zone: `2024-01-01T00:00:00Z`, optionally with milliseconds and
 * an offset. Deliberately strict, for the reason below.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function reviveDates(value: unknown): unknown {
  if (typeof value === 'string') return ISO_INSTANT.test(value) ? new Date(value) : value;
  // Already a `Date`, which happens when a snapshot is handed over in memory rather than through
  // JSON — and `Object.entries(new Date())` is `[]`, so without this guard a `Date` would come back
  // as an empty object. Not hypothetical: it is what the first version of this function did.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(reviveDates);
  if (value !== null && typeof value === 'object') {
    const revived: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) revived[key] = reviveDates(inner);
    return revived;
  }
  return value;
}

/**
 * A codec that turns ISO-8601 strings back into `Date`s.
 *
 * The single most common surprise with persistence: `JSON.stringify` writes a `Date` as a string and
 * nothing brings it back, so after a reload `typeof row.createdAt === 'string'` and the first call
 * to `row.createdAt.getTime()` throws — usually days later, in a code path that only runs on a
 * second visit.
 *
 * The revive pattern deliberately requires a **full** instant with a zone. `"2024-01-01"` is left
 * alone, because it is far more likely to be a plain string — an order number, a slug, a version —
 * than a date, and a resolver eager enough to guess there corrupts data that never was a date.
 *
 * ```ts
 * providePersistedCache({ codec: dateRevivingCodec });
 * ```
 */
export const dateRevivingCodec: SnapshotCodec = {
  // Writing needs nothing: a `Date` already stringifies to a full ISO instant, which is exactly what
  // `deserialize` recognises.
  serialize: (value) => value,
  deserialize: reviveDates,
};

/* -------------------------------------------------------------------------- */
/*  Reload persistence                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The part of the Web Storage API this uses, and the two methods that are allowed to be
 * asynchronous.
 *
 * Narrower than `Storage` on purpose: no `length`, no `key(n)`, no index signature. `getItem`
 * returning `null` rather than `undefined` is kept because that is what `localStorage` does, and
 * therefore what a test double will do without anyone having to think about it.
 *
 * The `Promise` halves are a **widening**: `localStorage`, `sessionStorage` and every `CacheStorage`
 * written against 0.1.0 still satisfy this interface, with no edit and no cast, because a storage
 * that returns a value is a storage that returns "not a promise". That is what makes
 * {@link indexedDbStorage} possible without a second interface, a second option name, or the
 * application having to say which kind it is handing over.
 */
export interface CacheStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface PersistOptions extends SnapshotFilterOptions {
  /**
   * Where to write. Defaults to `localStorage` when it is reachable, and to `null` — persistence
   * disabled — everywhere else, which covers the server, a sandboxed iframe, and a browser with
   * storage blocked. Pass `sessionStorage`, {@link indexedDbStorage}, an in-memory double, or
   * `null` explicitly to override.
   */
  readonly storage?: CacheStorage | null;
  /** The storage key. Defaults to `'ng-signal-request'`. */
  readonly key?: string;
  readonly codec?: SnapshotCodec;
  /** Which entries to store. See {@link DehydrateOptions.dehydrateFilter}. */
  readonly dehydrateFilter?: DehydratePredicate;
  /** Stamped into every snapshot, and required to match on the way back in. */
  readonly buster?: string;
  /** Drop restored entries older than this, in ms. See {@link HydrateOptions.maxAge}. */
  readonly maxAge?: number;
  /** Turn an older snapshot shape into this one. See {@link HydrateOptions.migrate}. */
  readonly migrate?: HydrateOptions['migrate'];
  /**
   * How long a restore may hold the first fetch, in ms. Defaults to `2000`.
   *
   * The bound exists so that a storage which never answers cannot hold a first paint forever. It is
   * a bound on the **hold**, not on the read: a restore that outlives it is still applied when it
   * arrives, and by then it can only fill entries that are still empty — see
   * `CacheEntry.restore`. Set it to `0` to never hold a fetch at all, which is the same thing as
   * `waitForRestore: false` on every request, said once.
   */
  readonly restoreTimeout?: number;
  /**
   * Coalesce writes, in ms. Defaults to `1000`.
   *
   * A trailing debounce, so a burst of responses costs one write rather than one per response. `0`
   * writes synchronously, which is what a test wants and what an application almost never does.
   *
   * A pending write is never simply lost: the persister flushes on `pagehide`, when the tab is
   * hidden, and again when the injector is destroyed.
   */
  readonly debounce?: number;
  /** An injector to run in, when `createPersister` is not called from an injection context. */
  readonly injector?: Injector;
}

/**
 * The handle {@link createPersister} returns.
 *
 * Also a {@link RestoreGate}: the persistence layer *is* the thing that knows whether a restore is
 * in flight, so it implements the core's interface rather than being wrapped in an adapter that
 * would be a second source of truth for the same boolean.
 */
export interface Persister extends RestoreGate {
  /**
   * `false` when there is no usable storage, in which case every method is a no-op.
   *
   * Also flips to `false` if a write is ever refused — a full quota, or Safari's private mode
   * throwing on `setItem` — because a storage that just said no will keep saying no, and an
   * application may want to stop claiming that anything is saved.
   */
  readonly enabled: Signal<boolean>;
  /** The storage key in use, for logging. */
  readonly storageKey: string;
  /**
   * Loads the stored snapshot. Returns how many entries were staged; `0` is normal, not a failure.
   *
   * **The return type widened in 0.2.0**: a storage whose `getItem` returns a promise (IndexedDB)
   * cannot be answered synchronously, so this is `number | Promise<number>`. `await
   * persister.hydrate()` compiles and behaves exactly as before; a caller that used the number
   * directly now gets a compile error rather than a wrong answer, which is the failure worth having.
   */
  hydrate(): number | Promise<number>;
  /** Writes now, ignoring the debounce. */
  persist(): void;
  /** Removes the stored snapshot. The in-memory cache is left alone. */
  clear(): void;
  /**
   * Stops listening.
   *
   * A write whose debounce window is still open is **flushed first**, because the reason to call
   * this is that something is going away — the page, or the injector — and the pending data is the
   * part that cannot be recovered afterwards. The stored snapshot is otherwise left in place.
   */
  destroy(): void;
}

const DEFAULT_PERSIST_KEY = 'ng-signal-request';
const DEFAULT_DEBOUNCE = 1000;
const DEFAULT_RESTORE_TIMEOUT = 2000;

/**
 * `true` for a native promise. Written as `instanceof` rather than a `typeof x.then` probe because
 * both sides of every union here are declared as `Promise`, and a duck-typed thenable that is not
 * one would be a type error at the call site — the check is here to *branch*, not to accept.
 */
function isAsync<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function defaultStorage(): CacheStorage | null {
  try {
    // `undefined` on the server; reachable but *throwing on access* in a sandboxed iframe or with
    // cookies blocked, which is why this is a `try` and not only a `typeof` check.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Persists the cache to storage across reloads.
 *
 * ```ts
 * // app.config.ts — one line, and the whole application's cache survives a reload
 * providers: [provideHttpClient(), providePersistedCache({ maxAge: 24 * 60 * 60_000 })],
 * ```
 *
 * Writes are driven by `QueryCache.subscribeActivity`, so they follow **responses** rather than the
 * appearance of entries. Subscribing to `subscribeChanges` instead is the mistake that makes a
 * persister write an empty snapshot forever: an entry is created *before* it fetches, so the one
 * interesting event — the data arriving — never fires that listener.
 *
 * Storage failures disable the persister instead of throwing. The worst outcome of a failed write is
 * a slower first paint next visit; the worst outcome of an unhandled `QuotaExceededError` inside a
 * fetch's settle listener is a broken application.
 */
export function createPersister(options: PersistOptions = {}): Persister {
  const caller = (): void => {};
  Object.defineProperty(caller, 'name', { value: 'createPersister' });

  let injector = options.injector;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }

  return runInInjectionContext(injector, () => buildPersister(options));
}

function buildPersister(options: PersistOptions): Persister {
  const cache = inject(QueryCache);
  const destroyRef = inject(DestroyRef);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = options.key ?? DEFAULT_PERSIST_KEY;
  const debounce = options.debounce ?? DEFAULT_DEBOUNCE;
  const restoreTimeout = options.restoreTimeout ?? DEFAULT_RESTORE_TIMEOUT;
  const enabled = signal(storage !== null);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  /**
   * Disables the persister, off the current call stack.
   *
   * Deferred because every write is triggered from `subscribeActivity`, and those listeners run
   * synchronously inside `QueryCache.resolve` — which can itself be running inside a handle's key
   * `computed`. Writing a signal there is `NG0600: Writing to signals is not allowed in a computed`,
   * the same trap the devtools fell into. A microtask is outside any evaluation.
   */
  const disable = (): void => {
    if (enabled()) queueMicrotask(() => enabled.set(false));
  };

  /* --------------------------------- restoring -------------------------------- */

  /**
   * How many restores are in flight, as a count rather than a flag.
   *
   * A second `hydrate()` while the first is still reading is legitimate — an application that
   * reloads its snapshot on login does exactly that — and with a boolean the first restore to
   * finish would release the gate for the second, which is the order the gate exists to prevent.
   */
  const restoresInFlight = signal(0);
  /** Settles when the newest restore, and everything that started after it, has settled. */
  let allRestores: Promise<void> = Promise.resolve();
  let releaseAll: (() => void) | undefined;

  const startRestore = (): void => {
    if (restoresInFlight() === 0) {
      allRestores = new Promise<void>((resolve) => {
        releaseAll = resolve;
      });
      // Written **synchronously**, which is the point: a handle created on the next line has to see
      // the restore as in flight, or it fetches in the race this whole mechanism exists to lose
      // slowly. It is also why `hydrate()` must not be called from inside a `computed`.
      restoresInFlight.set(1);
      return;
    }
    restoresInFlight.update((n) => n + 1);
  };

  const endRestore = (): void => {
    restoresInFlight.update((n) => n - 1);
    if (restoresInFlight() === 0) {
      releaseAll?.();
      releaseAll = undefined;
      allRestores = Promise.resolve();
    }
  };

  /**
   * Rejects nothing, and never rejects: a storage that fails is a restore that restored nothing.
   * Callers see `0`, and `enabled` is what reports the failure.
   */
  const dropCorrupt = (): void => {
    try {
      const removed = storage?.removeItem(storageKey);
      if (removed !== undefined && isAsync(removed)) removed.catch(disable);
    } catch {
      disable();
    }
  };

  /** Parses what was in storage and stages it. Shared by the sync and async read paths. */
  const applyRaw = (raw: string | null): number => {
    // A missing key is the normal first visit. Not an error, not worth reporting.
    if (raw === null) return 0;

    let snapshot: CacheSnapshot;
    try {
      snapshot = JSON.parse(raw) as CacheSnapshot;
    } catch {
      // Unparseable content under our key: a corrupt write, or another application using the same
      // key. Drop it rather than leaving a landmine for the next load.
      dropCorrupt();
      return 0;
    }

    return hydrate(cache, snapshot, {
      codec: options.codec,
      maxAge: options.maxAge,
      buster: options.buster,
      migrate: options.migrate,
    });
  };

  /**
   * Runs an asynchronous restore under the gate.
   *
   * The bound releases the **gate**, not the returned promise: the count a caller awaits has to stay
   * truthful, and it costs nothing for it to arrive late — the reads it describes have already
   * started. A restore that outlives the bound still applies, and by then `CacheEntry.restore`'s
   * rule is what keeps it from overwriting anything newer.
   *
   * The timer is armed **only in a browser**. On the server a pending `setTimeout` holds the event
   * loop for its whole duration, which is exactly the stability the library promises not to hold,
   * and a server-side restore cannot hold a render back in any case: nothing there awaits it.
   */
  const runRestore = (work: Promise<number>): Promise<number> => {
    startRestore();

    // Both ends run through this, and it has to be exactly one of them. A count that goes negative
    // is not a visible error — `isRestoring` would still read `false` — but every *later* restore
    // would then start without opening the gate: a hold that quietly stops holding, which is the
    // failure this whole mechanism exists to prevent.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      endRestore();
    };

    if (isBrowser) {
      const timer = setTimeout(release, restoreTimeout);
      void allRestores.then(() => clearTimeout(timer));
    }

    return work.finally(release);
  };

  /* ---------------------------------- writing --------------------------------- */

  /**
   * The tail of the write chain, and `undefined` when nothing is in flight.
   *
   * A synchronous `setItem` is called on this stack — 0.1.0's timing, which is also the only timing
   * a test can assert on — and leaves the chain empty. An asynchronous one is chained, so two writes
   * are never in flight together: an IndexedDB transaction per write is ordered by the browser, but
   * a storage that talks to a server has no such rule, and the last write to *finish* is not
   * necessarily the last one to have been *issued*.
   */
  let chain: Promise<unknown> | undefined;

  /**
   * Hands one payload to the storage. `undefined` for a synchronous storage; a promise that never
   * rejects otherwise, so the chain above cannot be poisoned by one failed write.
   */
  const commit = (payload: string): Promise<void> | undefined => {
    if (storage === null) return undefined;
    try {
      const result = storage.setItem(storageKey, payload);
      return isAsync(result) ? result.catch(disable) : undefined;
    } catch {
      disable();
      return undefined;
    }
  };

  const write = (): void => {
    if (storage === null || destroyed) return;

    let payload: string;
    try {
      payload = JSON.stringify(
        dehydrate(cache, {
          include: options.include,
          exclude: options.exclude,
          codec: options.codec,
          dehydrateFilter: options.dehydrateFilter,
          buster: options.buster,
        }),
      );
    } catch {
      // A cycle in the data, or a `toJSON` that throws. There is no snapshot to be had, so the write
      // is abandoned rather than retried: the next response will try again with new data.
      disable();
      return;
    }

    if (chain !== undefined) {
      chain = chain.then(() => commit(payload));
      return;
    }
    const result = commit(payload);
    if (result !== undefined) chain = result.finally(() => (chain = undefined));
  };

  const schedule = (): void => {
    if (storage === null || destroyed) return;
    if (debounce <= 0) {
      write();
      return;
    }
    // Trailing debounce: reset on every change, so a burst ends in one write. The cost is that a
    // stream which never pauses never writes, which is what the flush points below bound.
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, debounce);
  };

  const unsubscribe = cache.subscribeActivity(schedule);

  const flush = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    write();
  };

  // A debounced write can be outstanding when the page goes away, and a browser gives no second
  // chance. `pagehide` rather than `beforeunload`: the latter is unreliable on mobile and is skipped
  // entirely by the back/forward cache, which is exactly the case that loses the data.
  let detachFlush: (() => void) | undefined;
  if (storage !== null && typeof window !== 'undefined') {
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    detachFlush = () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }

  const stop = (): void => {
    if (destroyed) return;
    // Flush first, and only then stop. `destroy` is normally called from an injector teardown or a
    // page teardown, and the pending write is the one thing worth keeping: a debounce window is
    // still open, and the data in it is about to become unreachable. Order matters — `write` no-ops
    // once `destroyed` is set. The write itself is not awaited: a teardown gives no second chance
    // either way, and blocking it on a promise-returning storage would be worse than racing it.
    flush();
    destroyed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    unsubscribe();
    detachFlush?.();
  };

  destroyRef.onDestroy(stop);

  return {
    enabled: enabled.asReadonly(),
    storageKey,
    isRestoring: computed(() => restoresInFlight() > 0),
    restored: () => allRestores,
    hydrate: (): number | Promise<number> => {
      if (storage === null) return 0;

      let raw: string | null | Promise<string | null>;
      try {
        raw = storage.getItem(storageKey);
      } catch {
        disable();
        return 0;
      }

      if (isAsync(raw)) {
        const work = raw.then(applyRaw, () => {
          // A `getItem` that rejects is a storage that cannot be read — private mode, a blocked
          // database, a closed connection. The same answer as `setItem` throwing: disabled, and
          // `0` entries, because a restore that failed restored nothing.
          disable();
          return 0;
        });
        // `restoreTimeout: 0` means "never hold a first fetch": the read still happens and the
        // values still land — they just do it without anything waiting for them.
        return restoreTimeout > 0 ? runRestore(work) : work;
      }

      return applyRaw(raw);
    },
    persist: write,
    clear: (): void => {
      if (storage === null) return;
      try {
        const removed = storage.removeItem(storageKey);
        if (removed !== undefined && isAsync(removed)) removed.catch(disable);
      } catch {
        disable();
      }
    },
    destroy: stop,
  };
}

/** The active persister, for the rare moments an application needs to act on it — a logout, mostly. */
export const CACHE_PERSISTER = new InjectionToken<Persister>('ng-signal-request: persister');

/**
 * Persists the cache across reloads, wired up as one provider.
 *
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [
 *     provideHttpClient(),
 *     providePersistedCache({ maxAge: 24 * 60 * 60_000, codec: dateRevivingCodec }),
 *   ],
 * });
 * ```
 *
 * Hydration happens during injector creation, which is before any component can resolve a request,
 * so the first render reads restored data instead of a loading state. That ordering is the reason
 * this is a provider and not a call in `main.ts`: there is nothing for a user to get wrong.
 *
 * ```ts
 * // logout
 * inject(CACHE_PERSISTER).clear();
 * ```
 */
export function providePersistedCache(options: PersistOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: CACHE_PERSISTER,
      useFactory: () => {
        const persister = createPersister(options);
        // `hydrate` cannot reject *synchronously* on an asynchronous storage: the answer arrives on
        // a later turn, when this factory has already returned. The only failure with nowhere to go
        // is a `deserialize` that throws — neither a storage failure nor a bad payload — and the
        // sync path lets that one out of the factory. So it is reported rather than dropped.
        const restoring = persister.hydrate();
        if (typeof restoring !== 'number') {
          void restoring.catch((error: unknown) => {
            console.error(
              '[ng-signal-request/persist] A restored snapshot could not be read.',
              error,
            );
          });
        }
        // `destroy` flushes an open debounce window before it stops listening, which is the write
        // that matters: the application is going away and the last responses are still in memory.
        inject(DestroyRef).onDestroy(() => persister.destroy());
        return persister;
      },
    },
    // The core reads this to decide whether to hold a first fetch. `useExisting` rather than a
    // second factory: the gate *is* the persister, and two objects answering "is a restore in
    // flight?" would be one boolean with two answers.
    //
    // This is an environment provider, and the token arrives `providedIn: 'root'` with the idle
    // gate. An explicit provider in the environment injector wins over the implicit root record, so
    // an application that calls this function gets the real gate and one that does not keeps
    // paying nothing.
    { provide: RESTORE_GATE, useExisting: CACHE_PERSISTER },
    // Forces the factory eagerly. Without this the persister would be created by the first
    // `inject(CACHE_PERSISTER)`, which may be long after the first request resolved — and the
    // stored snapshot has to be in place before that.
    provideEnvironmentInitializer(() => void inject(CACHE_PERSISTER)),
  ]);
}

/* -------------------------------------------------------------------------- */
/*  IndexedDB                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_DB_NAME = 'ng-signal-request';
const DEFAULT_DB_STORE = 'cache';

/** {@link indexedDbStorage}'s knobs. Each default is right for a single application. */
export interface IndexedDbStorageOptions {
  /** Database name. Defaults to `'ng-signal-request'`. */
  readonly database?: string;
  /** Object store name. Defaults to `'cache'`. */
  readonly store?: string;
  /** Schema version. Defaults to `1` — raise it when you add a store of your own to the database. */
  readonly version?: number;
  /**
   * The `IDBFactory` to open from. Defaults to the global `indexedDB`.
   *
   * An option rather than a bare global read for two reasons. jsdom has no IndexedDB at all, so
   * without it the only way to exercise this function would be `vi.stubGlobal`, which leaks into
   * every other test in the file; and a worker, an iframe or a second database in one application
   * legitimately wants a different factory.
   */
  readonly factory?: IDBFactory;
}

/**
 * A {@link CacheStorage} backed by IndexedDB.
 *
 * The reason to reach for this over the default `localStorage`: `localStorage` is capped at a few
 * megabytes, is synchronous — so a large snapshot blocks the main thread on every write — and is
 * shared per origin with no notion of size. IndexedDB has none of those problems and one of its
 * own, which is that it cannot answer synchronously. That is why `waitForRestore` exists.
 *
 * ```ts
 * providePersistedCache({ storage: indexedDbStorage(), maxAge: 24 * 60 * 60_000 });
 * ```
 *
 * One connection is opened lazily and reused, and the object store is created on `upgradeneeded`.
 * Every failure — no `indexedDB` (the server, a blocked sandbox), an open that errors, an upgrade
 * another tab is holding open, a quota refusal — **rejects**, which the persister turns into a
 * disabled persister rather than an exception. A storage that cannot be written to must not take
 * down the request that triggered the write.
 *
 * Two things it deliberately does not do: it never closes the connection (there is no owner to hang
 * that off, and a closed connection is noticed and reopened), and it does not version the *data* —
 * that is `CacheSnapshot.version` and `buster`.
 */
export function indexedDbStorage(options: IndexedDbStorageOptions = {}): CacheStorage {
  const databaseName = options.database ?? DEFAULT_DB_NAME;
  const storeName = options.store ?? DEFAULT_DB_STORE;
  const schemaVersion = options.version ?? 1;

  /** The in-flight or settled `open()`, or `undefined` when there is none to reuse. */
  let connection: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    if (factory === undefined) {
      return Promise.reject(
        new Error('ng-signal-request/persist: IndexedDB is not available in this environment.'),
      );
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, schemaVersion);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      };

      request.onsuccess = () => {
        const database = request.result;
        // Another tab upgrading the schema closes this connection, and a dead handle which still
        // looks open is the worst of both worlds. Forgetting it means the next call reopens; the
        // write that was in flight fails, and the next debounce window writes again.
        database.onversionchange = () => {
          database.close();
          connection = undefined;
        };
        database.onclose = () => {
          connection = undefined;
        };
        resolve(database);
      };

      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB refused to open the database.'));
      // A stale tab is holding the previous version open. Failing is the honest answer: the next
      // call retries, once that tab is gone, instead of serving a cache nothing can write to.
      request.onblocked = () =>
        reject(new Error('IndexedDB upgrade blocked by another tab with the database open.'));
    });
  };

  const db = (): Promise<IDBDatabase> => {
    if (connection === undefined) {
      const started = open();
      connection = started;
      // A failed open must not be cached — that is what makes the retry above possible — and the
      // rejection is still delivered to the caller through `started`.
      started.catch(() => {
        if (connection === started) connection = undefined;
      });
    }
    return connection;
  };

  const withStore = <T>(
    mode: IDBTransactionMode,
    request: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    db().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(storeName, mode);
          const pending = request(transaction.objectStore(storeName));
          pending.onsuccess = () => resolve(pending.result);
          pending.onerror = () =>
            reject(pending.error ?? new Error('IndexedDB refused the request.'));
          // The path a quota refusal takes: the request errors, then the transaction aborts.
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB aborted the transaction.'));
        }),
    );

  return {
    // `get` answers `undefined` for a key that is not there; the interface promises `null`. The cast
    // is on the *request* rather than the value because `IDBObjectStore.get` is declared
    // `IDBRequest<any>` and `any` is not allowed to travel: the stored type is one this module chose.
    getItem: (key: string): Promise<string | null> =>
      withStore<unknown>('readonly', (store) => store.get(key) as IDBRequest<unknown>).then(
        (value) => (typeof value === 'string' ? value : null),
      ),
    setItem: (key: string, value: string): Promise<void> =>
      withStore('readwrite', (store) => store.put(value, key)).then(() => undefined),
    removeItem: (key: string): Promise<void> =>
      withStore('readwrite', (store) => store.delete(key)).then(() => undefined),
  };
}

/* -------------------------------------------------------------------------- */
/*  SSR transfer                                                              */
/* -------------------------------------------------------------------------- */

/** Where a server render parks its cache for the browser to pick up. */
export const CACHE_TRANSFER_KEY = makeStateKey<CacheSnapshot>('ng-signal-request');

export interface CacheTransferOptions extends SnapshotFilterOptions {
  /** Override the transfer key, if two applications share one document. */
  readonly key?: StateKey<CacheSnapshot>;
  readonly codec?: SnapshotCodec;
  /** Drop restored entries older than this on the client. See {@link HydrateOptions.maxAge}. */
  readonly maxAge?: number;
}

/**
 * Moves the cache from a server render to the browser.
 *
 * ```ts
 * // app.config.ts, shared by `app.config.server.ts` and `main.ts`
 * providers: [provideClientHydration(), provideHttpClient(), provideCacheTransfer()],
 * ```
 *
 * On the server the snapshot is written when the injector is destroyed — that is, after the render
 * and after any `prefetch` has settled. On the client it is read during injector creation, which is
 * before the first component resolves anything, so hydration renders finished data instead of
 * repeating every request the server already made.
 *
 * The transferred document is readable by anyone who asks for it, so the snapshot is written as it
 * is. Putting a secret in a cached response is the same mistake as putting it in `TransferState` by
 * hand — and the fix is on the server, not in here.
 */
export function provideCacheTransfer(options: CacheTransferOptions = {}): EnvironmentProviders {
  const stateKey = options.key ?? CACHE_TRANSFER_KEY;
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      const cache = inject(QueryCache);
      const transfer = inject(TransferState);

      if (isPlatformBrowser(inject(PLATFORM_ID))) {
        const snapshot = transfer.get(stateKey, null);
        // Read once. Leaving it in place would keep a second copy of the data in the document for
        // nothing, and would re-hydrate every time the injector is created.
        transfer.remove(stateKey);
        if (snapshot !== null) {
          hydrate(cache, snapshot, { codec: options.codec, maxAge: options.maxAge });
        }
        return;
      }

      inject(DestroyRef).onDestroy(() => {
        transfer.set(stateKey, dehydrate(cache, options));
      });
    }),
  ]);
}

/* -------------------------------------------------------------------------- */
/*  SSR prefetch                                                              */
/* -------------------------------------------------------------------------- */

/** The one method `prefetch` needs, so `SignalRequest` and `CachedRequest` both qualify. */
export interface Prefetchable {
  run(): Promise<unknown>;
}

/** What {@link prefetch} managed. */
export interface PrefetchReport {
  /** How many handles resolved. */
  readonly ok: number;
  /**
   * The rejections, in handle order.
   *
   * A `RequestCancelledError` lands here too, which is why this is a report rather than a throw: on
   * the server, a cancelled prefetch is a request the render decided it no longer needed.
   */
  readonly failures: readonly unknown[];
}

/**
 * Runs every handle and waits for all of them, **without rejecting**.
 *
 * ```ts
 * // a server route resolver
 * export const route: ResolveFn<PrefetchReport> = () =>
 *   prefetch([inject(UserService).user, inject(FeedService).feed]);
 * ```
 *
 * The value over `await Promise.all(handles.map((handle) => handle.run()))` is the failure policy,
 * which is the whole point on a server: `Promise.all` rejects on the first failure and the render
 * becomes a 500, even though every other endpoint answered and the page would have rendered fine
 * with one empty panel. `allSettled` plus a report lets the render decide.
 *
 * It deliberately does not wait for `ApplicationRef.whenStable()`: that never resolves while a
 * request is in flight, which is exactly the thing being waited for. The `run()` promise resolving
 * already means the entry has its data.
 *
 * For an `InfiniteRequest`, call `fetchNextPage()` / `reload()` yourself — "prefetch page one" is
 * one `prefetch` call, "prefetch three pages" is a loop, and hiding that behind one function would
 * pick a page count on the caller's behalf.
 */
export async function prefetch(handles: readonly Prefetchable[]): Promise<PrefetchReport> {
  const settled = await Promise.allSettled(handles.map((handle) => handle.run()));

  const failures: unknown[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') failures.push(outcome.reason);
  }

  return { ok: settled.length - failures.length, failures };
}
