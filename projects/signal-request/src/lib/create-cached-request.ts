import { isPlatformBrowser } from '@angular/common';
import type { HttpResourceRequest } from '@angular/common/http';
import { fromEvent, type Subscription } from 'rxjs';
import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  ErrorHandler,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  untracked,
  type ResourceParamsContext,
  type Signal,
} from '@angular/core';
import { CacheEntry, type FetchPlan, type SettleOutcome } from './cache/cache-entry';
import { normalizeKey } from './cache/key';
import { QueryCache } from './cache/query-cache';
import { resolveStructuralSharing } from './cache/structural-sharing';
import { SIGNAL_REQUEST_CONFIG } from './config';
import { RequestCancelledError, toError, toRequestError } from './errors';
import type {
  CachedRequest,
  CachedRequestOptions,
  RefetchOnMount,
  RequestSource,
  RequestStatus,
  RunResult,
  SelectOptions,
} from './types';
import { selectFrom } from './select';
import {
  debouncedSignal,
  nextRetryDelay,
  noop,
  normalizeRetry,
  RESPONSE_TYPE,
  resolveRequest,
  withGlobalHeaders,
  type Kind,
} from './utils';

/**
 * Five minutes.
 *
 * Long enough that coming back to a tab is a cache hit, short enough that a session's worth of
 * dead keys does not sit in memory until the tab closes. Override it per request.
 */
const DEFAULT_GC_TIME = 5 * 60_000;

/** `ctx.chain()` needs an `httpResource` to chain against, and a cached request has none. */
const UNAVAILABLE_CTX: ResourceParamsContext = {
  chain: () => {
    throw new Error(
      'ng-signal-request: ctx.chain() is not available on a cached request. There is no ' +
        '`httpResource` behind the handle — the request belongs to a shared cache entry, which ' +
        'is exactly why it can be shared. Read the upstream handle and put its value in this ' +
        'request’s `key` instead, so the dependency becomes part of the cache identity.',
    );
  },
};

/** The entry a handle currently points at, plus the request it would send. */
interface Plan<T> {
  readonly entry: CacheEntry<T>;
  readonly request: HttpResourceRequest;
}

/** Options as they arrive, before the defaults from `provideSignalRequest` are folded in. */
type OptionSet<T, TParams> = CachedRequestOptions<T, TParams, unknown>;

/**
 * Builds a request handle backed by a shared cache entry.
 *
 * The split from `create-request`'s own path is deliberate and load-bearing: this one owns no
 * `httpResource` and therefore no network call of its own. Everything it shows comes from an
 * entry that other handles may be reading at the same time, and everything it triggers goes
 * through the entry's refcount.
 *
 * The source, `params`, headers, retry, debounce and the lifecycle hooks behave exactly as they do
 * on the uncached path, because the building blocks (`resolveRequest`, `withGlobalHeaders`,
 * `normalizeRetry`, `toRequestError`) are shared rather than reimplemented.
 */
export function buildCachedRequest<T, R, TParams>(
  kind: Kind,
  method: string,
  source: RequestSource<TParams>,
  options: CachedRequestOptions<T, TParams, unknown>,
  caller: () => void,
): CachedRequest<T, R, TParams> {
  const explicit = (options as { injector?: Injector }).injector;
  const injector = explicit ?? injectionContextInjector(caller);
  return runInInjectionContext(injector, () =>
    buildCachedInContext<T, R, TParams>(kind, method, source, options, injector),
  );
}

/**
 * The caller's injector, or the one we are standing in.
 *
 * Split out because `assertInInjectionContext` has to be called *before* anything reads a signal,
 * and returning it separately keeps the happy path free of a non-null assertion.
 */
function injectionContextInjector(caller: () => void): Injector {
  assertInInjectionContext(caller);
  return inject(Injector);
}

function buildCachedInContext<T, R, TParams>(
  kind: Kind,
  method: string,
  source: RequestSource<TParams>,
  options: CachedRequestOptions<T, TParams, unknown>,
  injector: Injector,
): CachedRequest<T, R, TParams> {
  const cache = inject(QueryCache);
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const destroyRef = inject(DestroyRef);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const lazy = options.lazy ?? false;
  const initial = options.initialValue as T | undefined;
  const retryPolicy = normalizeRetry(options.retry ?? globalConfig.retry);
  const debounceMs = isBrowser ? (options.debounce ?? 0) : 0;
  const staleTime = options.staleTime ?? globalConfig.staleTime ?? 0;
  const gcTime = options.gcTime ?? globalConfig.gcTime ?? DEFAULT_GC_TIME;
  const refetchOnMount: RefetchOnMount = options.refetchOnMount ?? globalConfig.refetchOnMount ?? 'stale';
  const refetchOnWindowFocus = options.refetchOnWindowFocus ?? globalConfig.refetchOnWindowFocus ?? false;
  const refetchOnReconnect = options.refetchOnReconnect ?? globalConfig.refetchOnReconnect ?? false;
  const share = resolveStructuralSharing<T>(options.structuralSharing, options.equal as never);

  /* ------------------------------ request building ----------------------------- */

  const params = signal<TParams | undefined>(
    (options as { params?: TParams }).params as TParams | undefined,
  );
  const gateOnParams = Object.hasOwn(options, 'params');

  const evaluate = (p: TParams): HttpResourceRequest | undefined => {
    const built = resolveRequest(
      typeof source === 'function' ? source(p, UNAVAILABLE_CTX) : source,
      method,
      globalConfig.baseUrl,
      gateOnParams ? p : undefined,
    );
    if (built === undefined) return undefined;
    if (options.timeout !== undefined) built.timeout = options.timeout;
    if (options.headers !== undefined) built.headers = options.headers;
    // Read inside the reactive chain for the same reason as the uncached path: a token signal
    // read by global `headers` becomes a dependency, so every live query refetches on change.
    return withGlobalHeaders(built, globalConfig.headers);
  };

  /**
   * The entry, and the request, or `undefined` when the request is disabled.
   *
   * Both come from one computed so they can never disagree: a handle cannot end up pointed at
   * entry A while holding the request it built for entry B.
   */
  const rawPlan = computed<Plan<T> | undefined>(() => {
    const p = params();
    if (gateOnParams && p === undefined) return undefined;
    const request = evaluate(p as TParams);
    if (request === undefined) return undefined;
    // Read inside the computed, so a filter signal in the key re-points the handle. The
    // normalization happens here rather than at call time so `cache.resolve` stays a plain
    // get-or-create.
    const key = normalizeKey(options.key());
    return { entry: cache.resolve<T>(key.raw, options.debugName), request };
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
  /** Last value seen on any entry, so `keepPreviousValue` survives a key change. */
  const lastGood = signal<T | undefined>(initial);

  const buildFetchPlan = (p: Plan<T>): FetchPlan<T> => ({
    request: p.request,
    structuralSharing: share,
    retry: retryPolicy,
    parse: options.parse as ((raw: unknown) => T) | undefined,
    responseType: RESPONSE_TYPE[kind],
  });

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
    const describe = { url: plan()?.request.url, method };
    if (outcome.ok) {
      safe(() => options.onSuccess?.(outcome.value));
      safe(() => globalConfig.onSuccess?.(outcome.value, describe));
    } else {
      safe(() => options.onError?.(outcome.error));
      safe(() => globalConfig.onError?.(outcome.error, describe));
    }
    safe(() => options.onSettled?.());
  };

  const startFetch = (p: Plan<T>): Promise<T | undefined> => p.entry.fetch(buildFetchPlan(p));

  /** What a *first* subscriber should do about this entry. */
  const maybeFetchOnMount = (p: Plan<T>): void => {
    // Someone is already on the wire: joining beats starting a second identical request, and it
    // is what makes two components mounting together cost one round-trip.
    if (p.entry.pending !== undefined) return;
    const wanted =
      refetchOnMount === 'always' ? true : refetchOnMount === false ? false : p.entry.isStale(staleTime);
    if (wanted) void startFetch(p);
  };

  /**
   * Owns the subscription. This is the only `effect` in the cached path, and it has a real side
   * effect to perform: reference counting is not derivable, it has to happen as the handle's
   * entry changes.
   *
   * `onCleanup` is deliberately **not** used for the release. It fires before *every* re-run,
   * and a re-run also happens when only the request changed — same entry, new params — which must
   * not drop the refcount to zero and abort a request the handle is still waiting for.
   */
  effect(() => {
    const current = plan();
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
        current.entry.registerPlan(buildFetchPlan(current));
        subscribed = current.entry;
        if (!lazy) maybeFetchOnMount(current);
        return;
      }
      // Same entry, different request — `params` changed, or a reactive global header did.
      // Refetch, but never duplicate an in-flight one.
      current.entry.registerPlan(buildFetchPlan(current));
      if (!lazy && current.entry.pending === undefined) void startFetch(current);
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

  const status = computed<RequestStatus>(() => {
    const e = entry();
    if (!e) return 'idle';
    // While a retry is scheduled the error is masked, so the handle has to report the wait
    // rather than the failure — the same rule the uncached path applies.
    if (retrying()) return e.hasData() ? 'reloading' : 'loading';
    if (e.isFetching()) return e.hasData() ? 'reloading' : 'loading';
    if (e.error()) return 'error';
    if (e.hasData()) return e.local() ? 'local' : 'resolved';
    return 'idle';
  });

  const error = computed<Error | undefined>(() => (retrying() ? undefined : entry()?.error()));

  const requestError = computed(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    const timeout = entry()?.errorTimeout();
    return toRequestError(cause, timeout === undefined ? {} : { timeout });
  });

  const response = computed<R>(() => {
    const data = entry()?.data();
    if (data !== undefined) return data as R;
    // No value yet. `keepPreviousValue` is what makes a key change (a new page, a new filter) show
    // the old list while the next one loads instead of dropping back to `initialValue`.
    return (options.keepPreviousValue ? lastGood() : initial) as R;
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
    const p = options.pollInterval;
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
        if (!options.pollWhenHidden && typeof document !== 'undefined' && document.hidden) {
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
    if (refetchOnWindowFocus) {
      subs.push(fromEvent(document, 'visibilitychange').subscribe(whenVisible));
      subs.push(fromEvent(window, 'focus').subscribe(whenVisible));
    }
    if (refetchOnReconnect) {
      subs.push(fromEvent(window, 'online').subscribe(refetch));
    }
    destroyRef.onDestroy(() => {
      for (const sub of subs) sub.unsubscribe();
      subs.length = 0;
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
    params,
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
    status,
    retryAttempt: computed(() => entry()?.retryAttempt() ?? 0),
    headers: computed(() => entry()?.headers()),
    statusCode: computed(() => entry()?.statusCode()),
    progress: computed(() => entry()?.progress()),
    isFetching: computed(() => entry()?.isFetching() ?? false),
    dataUpdatedAt: computed(() => entry()?.dataUpdatedAt() ?? 0),
    fetchCount: computed(() => entry()?.fetchCount() ?? 0),
    isStale: () => entry()?.isStale(staleTime) ?? true,

    run: (): Promise<T> => {
      if (destroyed) return rejected(new RequestCancelledError('The request was destroyed.'));
      const current = plan();
      if (!current) return rejected(disabledError());
      return startFetch(current) as Promise<T>;
    },
    tryRun: (): Promise<RunResult<T>> => {
      if (destroyed) return Promise.resolve({ ok: false, error: new RequestCancelledError('The request was destroyed.') });
      const current = plan();
      const promise = current ? startFetch(current) : rejected<T | undefined>(disabledError());
      return promise.then(
        (value): RunResult<T> => ({ ok: true, response: value as T }),
        (e): RunResult<T> => ({ ok: false, error: toError(e) }),
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
  } as unknown as CachedRequest<T, R, TParams>;
}