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
import { QueryCache, type CacheEntry, type QueryKeyFilter } from 'ng-signal-request';

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

export interface DehydrateOptions extends SnapshotFilterOptions {
  readonly codec?: SnapshotCodec;
  /** The clock for `timestamp`. Defaults to `Date.now()`; a test passes a fixed number. */
  readonly now?: number;
}

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
 * Only entries that have data are included. An entry that exists because a handle asked for it but
 * has not fetched yet has nothing to restore, and persisting its absence would only mean writing a
 * longer file to read back the same nothing.
 *
 * The reads are `untracked` on purpose: a snapshot is a point-in-time observation, and quietly
 * subscribing the caller to every entry in it would be a surprising thing for a "write this to
 * storage" function to do.
 */
export function dehydrate(cache: QueryCache, options: DehydrateOptions = {}): CacheSnapshot {
  const entries: CacheSnapshotEntry[] = [];

  for (const entry of selectEntries(cache, options)) {
    const data = untracked(entry.data);
    if (data === undefined) continue;
    entries.push({
      key: entry.raw,
      data: options.codec ? options.codec.serialize(data) : data,
      dataUpdatedAt: untracked(entry.dataUpdatedAt),
    });
  }

  return { version: SNAPSHOT_VERSION, timestamp: options.now ?? Date.now(), entries };
}

/**
 * Stages a snapshot into the cache and returns how many entries were accepted.
 *
 * **Nothing is created here.** Each entry is *seeded*: the value waits for a handle to ask for that
 * key, and is applied the moment the cache creates the entry. That is not an optimisation, it is the
 * difference between a persister that leaks and one that does not — see `QueryCache.seed`. A payload
 * for a key the application never asks for is dropped rather than pinned for the life of the
 * injector.
 */
export function hydrate(
  cache: QueryCache,
  snapshot: CacheSnapshot | null | undefined,
  options: HydrateOptions = {},
): number {
  // A snapshot from another version, or no snapshot at all, is not an error: it is what a first
  // visit, a cleared storage and a version upgrade all look like. Start clean and answer `0`.
  if (snapshot == null || snapshot.version !== SNAPSHOT_VERSION) return 0;

  if (options.replace !== false) cache.clearSeeds();

  const now = options.now ?? Date.now();
  let restored = 0;

  for (const entry of snapshot.entries) {
    if (options.maxAge !== undefined && now - entry.dataUpdatedAt > options.maxAge) continue;

    const data = options.codec ? options.codec.deserialize(entry.data) : entry.data;
    if (data === undefined) continue;

    cache.seed(entry.key, data, entry.dataUpdatedAt);
    restored++;
  }

  return restored;
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
 * The part of the Web Storage API this uses.
 *
 * Narrower than `Storage` on purpose: no `length`, no `key(n)`, no index signature. `getItem`
 * returning `null` rather than `undefined` is kept because that is what `localStorage` does, and
 * therefore what a test double will do without anyone having to think about it.
 */
export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistOptions extends SnapshotFilterOptions {
  /**
   * Where to write. Defaults to `localStorage` when it is reachable, and to `null` — persistence
   * disabled — everywhere else, which covers the server, a sandboxed iframe, and a browser with
   * storage blocked. Pass `sessionStorage`, an in-memory double, or `null` explicitly to override.
   */
  readonly storage?: CacheStorage | null;
  /** The storage key. Defaults to `'ng-signal-request'`. */
  readonly key?: string;
  readonly codec?: SnapshotCodec;
  /** Drop restored entries older than this, in ms. See {@link HydrateOptions.maxAge}. */
  readonly maxAge?: number;
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

/** The handle {@link createPersister} returns. */
export interface Persister {
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
  /** Loads the stored snapshot. Returns how many entries were staged; `0` is normal, not a failure. */
  hydrate(): number;
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
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const storageKey = options.key ?? DEFAULT_PERSIST_KEY;
  const debounce = options.debounce ?? DEFAULT_DEBOUNCE;
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

  const write = (): void => {
    if (storage === null || destroyed) return;
    const snapshot = dehydrate(cache, {
      include: options.include,
      exclude: options.exclude,
      codec: options.codec,
    });
    try {
      storage.setItem(storageKey, JSON.stringify(snapshot));
    } catch {
      disable();
    }
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
    // once `destroyed` is set.
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
    hydrate: (): number => {
      if (storage === null) return 0;

      let raw: string | null;
      try {
        raw = storage.getItem(storageKey);
      } catch {
        disable();
        return 0;
      }
      // A missing key is the normal first visit. Not an error, not worth reporting.
      if (raw === null) return 0;

      let snapshot: CacheSnapshot | null;
      try {
        snapshot = JSON.parse(raw) as CacheSnapshot;
      } catch {
        // Unparseable content under our key: a corrupt write, or another application using the same
        // key. Drop it rather than leaving a landmine for the next load.
        try {
          storage.removeItem(storageKey);
        } catch {
          disable();
        }
        return 0;
      }

      return hydrate(cache, snapshot, { codec: options.codec, maxAge: options.maxAge });
    },
    persist: write,
    clear: (): void => {
      if (storage === null) return;
      try {
        storage.removeItem(storageKey);
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
        persister.hydrate();
        // `destroy` flushes an open debounce window before it stops listening, which is the write
        // that matters: the application is going away and the last responses are still in memory.
        inject(DestroyRef).onDestroy(() => persister.destroy());
        return persister;
      },
    },
    // Forces the factory eagerly. Without this the persister would be created by the first
    // `inject(CACHE_PERSISTER)`, which may be long after the first request resolved — and the
    // stored snapshot has to be in place before that.
    provideEnvironmentInitializer(() => void inject(CACHE_PERSISTER)),
  ]);
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
