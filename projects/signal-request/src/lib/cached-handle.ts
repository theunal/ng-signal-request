import { isPlatformBrowser } from '@angular/common';
import {
  computed,
  DestroyRef,
  effect,
  ErrorHandler,
  inject,
  isDevMode,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { fromEvent, type Subscription } from 'rxjs';
import { type CacheEntry, type EntryPlan, type SettleOutcome } from './cache/cache-entry';
import { normalizeKey, type QueryKeyFactory } from './cache/key';
import { QueryCache } from './cache/query-cache';
import { SIGNAL_REQUEST_CONFIG } from './config';
import { reportedOffline, resolveConnectivity, type NetworkMode } from './connectivity';
import { RequestCancelledError, toError, type RequestErrorView } from './errors';
import { RESTORE_GATE } from './restore-gate';
import { selectFrom } from './select';
import type { RefetchOnMount, RequestStatus, RunResult, SelectOptions } from './types';
import { debouncedSignal, noop } from './utils';

/**
 * Five minutes.
 *
 * Long enough that coming back to a tab is a cache hit, short enough that a session's worth of
 * dead keys does not sit in memory until the tab closes. Override it per request.
 */
export const DEFAULT_GC_TIME = 5 * 60_000;

/** The entry a handle currently points at, plus the transport plan for it. */
export interface CachedPlan<T> {
  readonly entry: CacheEntry<T>;
  readonly plan: EntryPlan<T>;
}

/**
 * Everything the two cached factories — HTTP (`createRequest` with a `key`) and function-based
 * (`createQuery`) — have in common.
 *
 * The engine owns the cache entry, its refcount, the mount/refresh/poll effects and the public
 * state signals. It does **not** know how a fetch is transported: that is the one thing
 * `buildPlan` supplies. Keeping the split here is what makes a keyed `createRequest` and a
 * `createQuery` on one key literally the same subscription machinery rather than two copies that
 * drift.
 */
export interface CachedHandleConfig<T, TParams> {
  /** Which factory built the plan. Used for the type-disagreement warning and the hooks' `method`. */
  readonly kind: 'http' | 'query';
  /** Shown to the global `onSuccess` / `onError` hooks. `QUERY` for a `createQuery`. */
  readonly method: string;
  readonly key: QueryKeyFactory;
  readonly debugName: string | undefined;
  /** The writable params signal the caller created. */
  readonly params: WritableSignal<TParams | undefined>;
  /** Whether `undefined` params mean "disabled" (only when the caller passed a `params` option). */
  readonly gateOnParams: boolean;
  readonly lazy: boolean;
  readonly initialValue: T | undefined;
  readonly keepPreviousValue: boolean;
  readonly staleTime: number;
  readonly gcTime: number;
  readonly maxEntries: number | undefined;
  readonly refetchOnMount: RefetchOnMount;
  readonly refetchOnWindowFocus: boolean;
  readonly refetchOnReconnect: boolean;
  readonly networkMode: NetworkMode;
  readonly waitForRestore: boolean;
  /** Zero on the server, and zero when the caller did not ask. */
  readonly debounceMs: number;
  readonly pollInterval: number | (() => number | false | null | undefined) | undefined;
  readonly pollWhenHidden: boolean;
  readonly onSuccess: ((value: T) => void) | undefined;
  readonly onError: ((error: Error) => void) | undefined;
  readonly onSettled: (() => void) | undefined;
  /** Build the transport for the current params, or `undefined` when the source disabled it. */
  readonly buildPlan: (params: TParams) => EntryPlan<T> | undefined;
  /** Classify a failure for `requestError`. HTTP and query errors mean different things. */
  readonly classifyError: (
    error: Error,
    entry: CacheEntry<T> | undefined,
    offline: boolean | undefined,
  ) => RequestErrorView;
  /** The `{ url, method }` passed to the global hooks. */
  readonly describe: (plan: CachedPlan<T> | undefined) => {
    url: string | undefined;
    method: string;
  };
}

/** The common half of `CachedRequest` and `QueryRequest`. */
export interface CachedHandleCore<T, R, TParams> {
  readonly params: WritableSignal<TParams | undefined>;
  readonly response: Signal<R>;
  select<S>(selector: (data: T) => S, options?: SelectOptions<S>): Signal<S | undefined>;
  readonly error: Signal<Error | undefined>;
  readonly requestError: Signal<RequestErrorView | undefined>;
  readonly success: Signal<boolean>;
  readonly loading: Signal<boolean>;
  readonly initialLoading: Signal<boolean>;
  readonly paused: Signal<boolean>;
  readonly status: Signal<RequestStatus>;
  readonly retryAttempt: Signal<number>;
  readonly isFetching: Signal<boolean>;
  readonly dataUpdatedAt: Signal<number>;
  readonly fetchCount: Signal<number>;
  isStale(): boolean;
  /** The current entry, or `undefined` while the request is disabled. HTTP-specific state reads it. */
  readonly entry: Signal<CacheEntry<T> | undefined>;
  run(): Promise<T>;
  tryRun(): Promise<RunResult<T>>;
  reload(): boolean;
  cancel(): void;
  set(value: T): void;
  update(updater: (current: R) => T): void;
  destroy(): void;
}

/**
 * Entries are warned about once per kind switch, not once per re-evaluation: changing params
 * re-registers a plan on every keypress.
 */
const warnedKinds = new WeakSet();

/**
 * Builds every part of a cached handle that is independent of how the data is fetched.
 *
 * Must run inside an injection context; the caller has already resolved the injector.
 */
export function buildCachedHandleEngine<T, R, TParams>(
  config: CachedHandleConfig<T, TParams>,
): CachedHandleCore<T, R, TParams> {
  const cache = inject(QueryCache);
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const destroyRef = inject(DestroyRef);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  // See `restore-gate.ts`. The default is idle, so a request in an application that never persists
  // reads one constant signal and does nothing else.
  const restoreGate = inject(RESTORE_GATE);

  const {
    lazy,
    initialValue: initial,
    staleTime,
    gcTime,
    refetchOnMount,
    refetchOnWindowFocus,
    refetchOnReconnect,
    networkMode,
    waitForRestore,
    debounceMs,
  } = config;
  const online = resolveConnectivity(networkMode, refetchOnReconnect);

  // Only the per-request value, and only if it is there: the global cap is the cache's own property
  // and it read that itself. `tightenMaxEntries` ignores anything that would raise the cap, which is
  // what keeps the global setting a ceiling and makes the outcome order-independent.
  if (config.maxEntries !== undefined) cache.tightenMaxEntries(config.maxEntries);

  /* ------------------------------- plan building ------------------------------ */

  /**
   * The entry, and the transport, or `undefined` when the request is disabled.
   *
   * Both come from one computed so they can never disagree: a handle cannot end up pointed at
   * entry A while holding the plan it built for entry B.
   */
  const rawPlan = computed<CachedPlan<T> | undefined>(() => {
    const p = config.params();
    if (config.gateOnParams && p === undefined) return undefined;
    const plan = config.buildPlan(p as TParams);
    if (plan === undefined) return undefined;
    // Read inside the computed, so a filter signal in the key re-points the handle. The
    // normalization happens here rather than at call time so `cache.resolve` stays a plain
    // get-or-create.
    const key = normalizeKey(config.key());
    return { entry: cache.resolve<T>(key.raw, config.debugName), plan };
  });

  const plan = debounceMs > 0 ? debouncedSignal(rawPlan, debounceMs) : rawPlan;

  /* ------------------------------- subscription ------------------------------- */

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errorHandler.handleError(e);
    }
  };

  let release: (() => void) | undefined;
  let removeSettleListener: (() => void) | undefined;
  let subscribed: CacheEntry<T> | undefined;
  let destroyed = false;
  /** Set when a restore held this handle's mount fetch — see the subscription effect. */
  let heldFirstFetch = false;
  /** Last value seen on any entry, so `keepPreviousValue` survives a key change. */
  const lastGood = signal<T | undefined>(initial);

  /**
   * Lifecycle hooks, driven by the entry's settle notification rather than by a `.then()` on the
   * fetch promise.
   *
   * Two reasons. Joining an in-flight fetch would otherwise attach a second set of hooks to a
   * call that was already being watched — one network call, two `onSuccess`. And a refetch that
   * the *cache* started, because a mutation invalidated the key, has to run these too: from the
   * user's point of view their component did reload.
   */
  const settleListener = (outcome: SettleOutcome<T>): void => {
    if (destroyed) return;
    const describe = config.describe(plan());
    if (outcome.ok) {
      safe(() => config.onSuccess?.(outcome.value));
      safe(() => globalConfig.onSuccess?.(outcome.value, describe));
    } else {
      safe(() => config.onError?.(outcome.error));
      safe(() => globalConfig.onError?.(outcome.error, describe));
    }
    safe(() => config.onSettled?.());
  };

  const startFetch = (p: CachedPlan<T>): Promise<T | undefined> => p.entry.fetch(p.plan);

  /**
   * What `run()` does, once the request to run is settled.
   *
   * Split out because `run()` may have to wait for a restore first, and the plan has to be read
   * *after* that wait: `params` can change while a slow snapshot is being read, and running the
   * request this handle was pointed at when the call was made would fetch a URL nobody asked for.
   */
  const runNow = (): Promise<T> => {
    if (destroyed) return rejected(new RequestCancelledError('The request was destroyed.'));
    const current = plan();
    if (!current) return rejected(disabledError());
    return startFetch(current) as Promise<T>;
  };

  /** What a *first* subscriber should do about this entry. */
  const maybeFetchOnMount = (p: CachedPlan<T>): void => {
    // Someone is already on the wire: joining beats starting a second identical request, and it
    // is what makes two components mounting together cost one round-trip.
    if (p.entry.pending !== undefined) return;
    const wanted =
      refetchOnMount === 'always'
        ? true
        : refetchOnMount === false
          ? false
          : p.entry.isStale(staleTime);
    if (wanted) void startFetch(p);
  };

  /**
   * Registers the plan and warns when another kind already registered one for this entry.
   *
   * This is the only runtime signal available for a type disagreement: `createRequest<User[]>`
   * and `createQuery<Post>` on one key share an entry, and one of the two callers is wrong. The
   * warning is dev-mode only and once per entry, because the alternative — a type error — would
   * require a shared registry of keys at compile time, which TypeScript does not offer.
   */
  const registerPlan = (entry: CacheEntry<T>, entryPlan: EntryPlan<T>): void => {
    const previous = entry.planKind;
    if (
      isDevMode() &&
      previous !== undefined &&
      previous !== config.kind &&
      !warnedKinds.has(entry)
    ) {
      warnedKinds.add(entry);
      console.warn(
        `ng-signal-request: the cache entry for ${entry.hash} is used by both a ` +
          `${previous === 'http' ? 'createRequest' : 'createQuery'} and a ` +
          `${config.kind === 'http' ? 'createRequest' : 'createQuery'}. They share one entry ` +
          `and one in-flight call, but not a data type; the most recently registered plan decides ` +
          `what is fetched. Use the same factory for a given key.`,
      );
    }
    entry.registerPlan(entryPlan);
  };

  /**
   * Owns the subscription. This is the only `effect` in the cached path, and it has a real side
   * effect to perform: reference counting is not derivable, it has to happen as the handle's
   * entry changes.
   *
   * `onCleanup` is deliberately **not** used for the release. It fires before *every* re-run,
   * and a re-run also happens when only the request changed — same entry, new params — which must
   * not drop the refcount to zero and abort a request the handle is still waiting for.
   *
   * The **restore hold** rides on the same mechanism: `isRestoring` is read *tracked*, above the
   * `untracked` block, so the restore settling re-runs this effect and the held fetch starts
   * there. Nothing else would restart it, which is why the read cannot be untracked.
   */
  effect(() => {
    const current = plan();
    const waiting = waitForRestore && restoreGate.isRestoring();
    untracked(() => {
      if (destroyed) return;
      if (!current) {
        subscribed = undefined;
        return;
      }
      if (subscribed !== current.entry) {
        // Switching entries: remember what the old one held before letting it go.
        const previous = subscribed?.data();
        if (previous !== undefined) lastGood.set(previous);

        release?.();
        release = current.entry.subscribe(gcTime);
        removeSettleListener?.();
        removeSettleListener = current.entry.addSettleListener(settleListener);
        // Registered on every evaluation, so a cache-driven refetch always rebuilds the request
        // from this handle's latest params rather than a snapshot from its first render.
        registerPlan(current.entry, current.plan);
        subscribed = current.entry;
        // A hold belongs to the entry it was taken on. This is a different entry now, and its own
        // mount decision is made below rather than inherited from the one it replaced.
        heldFirstFetch = false;
        if (lazy) return;
        if (waiting) {
          // Held, not skipped: the flag makes the re-run that follows the restore treat this as
          // the mount fetch, so `refetchOnMount` and staleness still decide whether it happens.
          heldFirstFetch = true;
          return;
        }
        maybeFetchOnMount(current);
        return;
      }
      // Same entry, different request — `params` changed, or a reactive global header did.
      // Refetch, but never duplicate an in-flight one.
      registerPlan(current.entry, current.plan);
      if (lazy || waiting) return;
      if (heldFirstFetch) {
        heldFirstFetch = false;
        maybeFetchOnMount(current);
        return;
      }
      if (current.entry.pending === undefined) void startFetch(current);
    });
  });

  destroyRef.onDestroy(() => {
    destroyed = true;
    removeSettleListener?.();
    removeSettleListener = undefined;
    if (release) {
      release();
    } else {
      // The subscription effect never ran — the handle was destroyed before the scheduler
      // flushed it — so there is no refcount for the entry to notice. Cancel whatever this
      // handle started, or the request outlives it.
      plan()?.entry.cancel();
    }
    release = undefined;
    subscribed = undefined;
  });

  /* ---------------------------------- state ----------------------------------- */

  const entry = computed(() => plan()?.entry);
  const retrying = computed(() => (entry()?.retryAttempt() ?? 0) > 0);
  /**
   * The entry's own pause state, not the handle's.
   *
   * That is the whole point of putting it on the entry: two components on one key are two handles
   * and one request, so one of them must not be able to report "waiting" while the other reports
   * "fetching". `false` when there is no entry — a disabled request is idle, not paused.
   */
  const paused = computed(() => entry()?.paused() ?? false);

  const status = computed<RequestStatus>(() => {
    const e = entry();
    if (!e) return 'idle';
    // A paused entry is not fetching, so without this clause it would fall through to `idle` (or
    // to a stale `error`) while its `run()` promise is still pending. It is a wait, and the wait is
    // what `status` has always reported for the other kinds of wait.
    if (e.paused()) return e.hasData() ? 'reloading' : 'loading';
    // While a retry is scheduled the error is masked, so the handle has to report the wait
    // rather than the failure — the same rule the uncached path applies.
    if (retrying()) return e.hasData() ? 'reloading' : 'loading';
    if (e.isFetching()) return e.hasData() ? 'reloading' : 'loading';
    if (e.error()) return 'error';
    if (e.hasData()) return e.local() ? 'local' : 'resolved';
    return 'idle';
  });

  const error = computed<Error | undefined>(() => (retrying() ? undefined : entry()?.error()));

  const requestError = computed<RequestErrorView | undefined>(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    return config.classifyError(cause, entry(), reportedOffline(online));
  });

  const response = computed<R>(() => {
    const data = entry()?.data();
    if (data !== undefined) return data as R;
    // No value yet. `keepPreviousValue` is what makes a key change (a new page, a new filter) show
    // the old list while the next one loads instead of dropping back to `initialValue`.
    return (config.keepPreviousValue ? lastGood() : initial) as R;
  });

  const success = computed(() => {
    const s = status();
    return s === 'resolved' || s === 'local';
  });

  /* ------------------------------- polling / focus ------------------------------ */

  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The poll interval, read **reactively**.
   *
   * A computed rather than an untracked read, so `() => running() ? 2000 : false` re-arms the
   * timer when `running` flips — the whole point of accepting a function here.
   */
  const pollInterval = computed(() => {
    if (!isBrowser) return 0;
    const p = config.pollInterval;
    const value = typeof p === 'function' ? p() : p;
    return typeof value === 'number' && value > 0 ? value : 0;
  });

  /**
   * Re-arms after every settle rather than re-arming itself.
   *
   * A fetch moves the entry through `reloading` and back to `resolved`, so this effect re-runs on
   * exactly the transitions a self-re-arming timer would have to guess. One timer, one owner.
   */
  effect(() => {
    const ms = pollInterval();
    const settled = status();
    untracked(() => {
      clearTimeout(pollTimer);
      pollTimer = undefined;
      if (ms <= 0 || destroyed) return;
      if (settled !== 'resolved' && settled !== 'local' && settled !== 'error') return;
      pollTimer = setTimeout(() => {
        if (!config.pollWhenHidden && typeof document !== 'undefined' && document.hidden) {
          return; // the next settle re-arms it
        }
        const current = plan();
        if (current) void startFetch(current);
      }, ms);
    });
  });

  if (isBrowser && (refetchOnWindowFocus || refetchOnReconnect)) {
    let queued = false;
    const refetch = (): void => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (destroyed) return;
        const current = plan();
        // Disabled means "do not send this"; a background event must not override that.
        if (current) void startFetch(current);
      });
    };
    const whenVisible = (): void => {
      if (document.visibilityState !== 'hidden') refetch();
    };

    const subs: Subscription[] = [];
    const detaches: Array<() => void> = [];
    if (refetchOnWindowFocus) {
      subs.push(fromEvent(document, 'visibilitychange').subscribe(whenVisible));
      subs.push(fromEvent(window, 'focus').subscribe(whenVisible));
    }
    if (refetchOnReconnect) {
      // The manager's reconnect, not a raw `window` listener: it is the same event a paused fetch is
      // released by, so the dedupe below can tell "this reconnect released a request" from "this
      // reconnect should start one".
      detaches.push(online.onReconnect(refetch));
    }
    destroyRef.onDestroy(() => {
      for (const sub of subs) sub.unsubscribe();
      subs.length = 0;
      for (const detach of detaches) detach();
      detaches.length = 0;
    });
  }

  /* --------------------------------- public API -------------------------------- */

  const rejected = <V>(reason: Error): Promise<V> => {
    const promise = Promise.reject<V>(reason);
    promise.catch(noop);
    return promise;
  };

  const disabledError = () =>
    new RequestCancelledError('The request is disabled: its source returned undefined/null/false.');

  return {
    params: config.params,
    response,
    select: <S>(selector: (data: T) => S, opts?: SelectOptions<S>): Signal<S | undefined> =>
      selectFrom<T, S>(response as Signal<T | undefined>, selector, opts?.equal),
    error,
    requestError,
    success,
    loading: computed(() => {
      const s = status();
      return s === 'loading' || s === 'reloading';
    }),
    initialLoading: computed(() => status() === 'loading'),
    paused,
    status,
    retryAttempt: computed(() => entry()?.retryAttempt() ?? 0),
    isFetching: computed(() => entry()?.isFetching() ?? false),
    dataUpdatedAt: computed(() => entry()?.dataUpdatedAt() ?? 0),
    fetchCount: computed(() => entry()?.fetchCount() ?? 0),
    isStale: () => entry()?.isStale(staleTime) ?? true,
    entry,

    run: (): Promise<T> =>
      // A restore in flight means the snapshot is about to fill this entry. Waiting for it is not
      // politeness: the stored value is *older* than the network answer by definition, so racing it
      // buys a double fetch, and the loser is whichever write lands second.
      waitForRestore && restoreGate.isRestoring() ? restoreGate.restored().then(runNow) : runNow(),
    tryRun: (): Promise<RunResult<T>> => {
      if (destroyed)
        return Promise.resolve({
          ok: false,
          error: new RequestCancelledError('The request was destroyed.'),
        });
      const attempt =
        waitForRestore && restoreGate.isRestoring()
          ? restoreGate.restored().then(runNow)
          : runNow();
      return attempt.then(
        (value): RunResult<T> => ({ ok: true, response: value }),
        (e: unknown): RunResult<T> => ({ ok: false, error: toError(e) }),
      );
    },
    reload: (): boolean => {
      if (destroyed) return false;
      const current = plan();
      if (!current) return false;
      void startFetch(current);
      return true;
    },
    /**
     * Aborts the shared fetch.
     *
     * Wider than the uncached `cancel()`, and unavoidably so: there is one request for the key,
     * so cancelling it affects every subscriber. Documented rather than papered over.
     */
    cancel: (): void => {
      entry()?.cancel();
    },
    set: (value: T): void => {
      entry()?.setData(value);
    },
    update: (updater: (current: R) => T): void => {
      const current = entry();
      if (!current) return;
      current.setData(updater(untracked(current.data) as R));
    },
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      release?.();
      release = undefined;
      subscribed = undefined;
      clearTimeout(pollTimer);
      pollTimer = undefined;
      // Deliberately **not** cancelling the request. The entry is shared: if this was the last
      // subscriber its own refcount has already dropped to zero and cancelled the fetch, and if
      // it was not, somebody else is still waiting for it.
    },
  };
}
