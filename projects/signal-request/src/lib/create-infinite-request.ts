import { isPlatformBrowser } from '@angular/common';
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
  type Signal,
} from '@angular/core';
import { fromEvent, type Subscription } from 'rxjs';
import type { HttpResourceRequest } from '@angular/common/http';
import type { CacheEntry, FetchPlan, SettleOutcome } from './cache/cache-entry';
import { normalizeKey } from './cache/key';
import { QueryCache } from './cache/query-cache';
import { resolveStructuralSharing } from './cache/structural-sharing';
import { SIGNAL_REQUEST_CONFIG } from './config';
import { RequestCancelledError, toRequestError } from './errors';
import type {
  FlattenedPages,
  InfiniteRequest,
  InfiniteRequestOptions,
  RequestStatus,
  RequestValue,
  SelectOptions,
} from './types';
import { projectFrom } from './select';
import {
  debouncedSignal,
  normalizeRetry,
  noop,
  RESPONSE_TYPE,
  resolveRequest,
  withGlobalHeaders,
  type Kind,
} from './utils';

/** Matches `createRequest`'s default, so two paths to the same data behave alike. */
const DEFAULT_GC_TIME = 5 * 60_000;

/** One page: which param asked for it, the entry that holds it, and the request it needs. */
interface Page<TPage, TParam> {
  readonly param: TParam;
  readonly entry: CacheEntry<TPage>;
  readonly request: HttpResourceRequest;
}

/**
 * Builds a paginated handle on top of the same cache entries `createRequest` uses.
 *
 * ## Why this is more than the documented recipe
 *
 * The manual recipe was `params` + `keepPreviousValue` + an `update()` accumulator with a
 * hand-written "which page did I already append?" guard. It works, but the guard exists to paper
 * over a real gap: `onSuccess` fires on **every** settle, so reloading a loaded page appends it a
 * second time. Here each page is its own entry keyed `base key + page param`, so a reload
 * *replaces* page N rather than appending it — there is no guard to write and no duplicate state
 * to reason about.
 *
 * ## What falls out of using real entries
 *
 * - `client.invalidate(['items'])` refreshes every page of a paginated list, because the key is a
 *   prefix and nothing here knows or cares.
 * - `staleTime` / `gcTime` apply per page.
 * - Page 1 of a paginated list and a `createRequest` on `['items', 0]` are the *same entry*, so
 *   they dedup against each other.
 *
 * ## The reset problem
 *
 * Changing the filters restarts the accumulation at `initialPageParam`. The page entries are left
 * alone — they are cached data with their own `gcTime`, and they are frequently exactly what
 * someone switching a filter back and forth wants. Resetting means `pageParams()` goes back to one
 * entry, not that the cache forgets anything.
 */
export function buildInfiniteRequest<TPage, TParam>(
  kind: Kind,
  method: string,
  source: (param: TParam) => RequestValue,
  options: InfiniteRequestOptions<TPage, TParam>,
  caller: () => void,
): InfiniteRequest<TPage, TParam> {
  const explicit = (options as { injector?: Injector }).injector;
  const injector = explicit ?? injectionContextInjector(caller);
  return runInInjectionContext(injector, () =>
    buildInfiniteInContext<TPage, TParam>(kind, method, source, options, injector),
  );
}

/**
 * The caller's injector, or the one we are standing in.
 *
 * Split out so `assertInInjectionContext` runs before anything reads a signal, which keeps the
 * happy path free of a non-null assertion.
 */
function injectionContextInjector(caller: () => void): Injector {
  assertInInjectionContext(caller);
  return inject(Injector);
}

/**
 * Flattens the loaded pages when a page is itself an array.
 *
 * The runtime and the type have to agree, so both are guarded by the same condition: a page that
 * is an array contributes its items, anything else contributes itself. An envelope page therefore
 * passes through unchanged — the library has no way to know which of its fields is the list, and
 * guessing would be worse than not flattening.
 */
function flatten(loaded: readonly unknown[]): unknown {
  const out: unknown[] = [];
  for (const page of loaded) {
    if (Array.isArray(page)) {
      for (const item of page as readonly unknown[]) out.push(item);
    } else {
      out.push(page);
    }
  }
  return out;
}

function buildInfiniteInContext<TPage, TParam>(
  kind: Kind,
  method: string,
  source: (param: TParam) => RequestValue,
  options: InfiniteRequestOptions<TPage, TParam>,
  _injector: Injector,
): InfiniteRequest<TPage, TParam> {
  const cache = inject(QueryCache);
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const destroyRef = inject(DestroyRef);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const retryPolicy = normalizeRetry(options.retry, {
    timeout: options.timeout,
    timeouts: options.retryTimeouts ?? globalConfig.retryTimeouts,
  });
  const staleTime = options.staleTime ?? globalConfig.staleTime ?? 0;
  const gcTime = options.gcTime ?? globalConfig.gcTime ?? DEFAULT_GC_TIME;
  const share = resolveStructuralSharing<TPage>(options.structuralSharing, options.equal);
  const debounceMs = isBrowser ? (options.debounce ?? 0) : 0;
  const maxPages = options.maxPages;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errorHandler.handleError(e);
    }
  };

  /* --------------------------------- pages --------------------------------- */

  const baseKey = computed(() => normalizeKey(options.key()));

  /**
   * The loaded page params, **tagged with the base key they belong to**.
   *
   * The tag is what makes the filter reset derivable instead of imperative: reading the accumulator
   * against a key it does not match yields the single starting page, with no signal write and no
   * effect to coordinate. Any *write* reconciles the tag, so the next `fetchNextPage()` after a
   * filter change appends to the new list rather than resurrecting the old one.
   */
  const accumulation = signal<{ readonly base: string; readonly params: readonly TParam[] }>({
    base: '',
    params: [options.initialPageParam],
  });

  const loadedParams = computed<readonly TParam[]>(() => {
    const base = baseKey().hash;
    const state = accumulation();
    return state.base === base ? state.params : [options.initialPageParam];
  });

  const buildPage = (param: TParam): Page<TPage, TParam> => {
    const base = baseKey();
    const built = resolveRequest(source(param), method, globalConfig.baseUrl, undefined);
    if (options.timeout !== undefined && built) built.timeout = options.timeout;
    const withHeaders =
      built === undefined ? undefined : withGlobalHeaders(built, globalConfig.headers);
    if (options.headers !== undefined && withHeaders) withHeaders.headers = options.headers;
    return {
      param,
      entry: cache.resolve<TPage>([...base.raw, param], options.debugName),
      request: withHeaders as HttpResourceRequest,
    };
  };

  const pagesOf = computed<readonly Page<TPage, TParam>[]>(() =>
    loadedParams().map((param) => buildPage(param)),
  );

  const fetchPlan = (page: Page<TPage, TParam>): FetchPlan<TPage> => ({
    request: page.request,
    structuralSharing: share,
    retry: retryPolicy,
    parse: options.parse,
    responseType: RESPONSE_TYPE[kind],
  });

  const rawPages = debounceMs > 0 ? debouncedSignal(pagesOf, debounceMs) : pagesOf;

  /* ------------------------------ subscription ------------------------------ */

  const releases = new Map<string, () => void>();
  let destroyed = false;

  /**
   * Refcount bookkeeping for every page entry.
   *
   * The only effect in this primitive, and it has a real side effect to perform: an entry's
   * `gcTime` countdown and abort-on-last-unsubscribe are reference counted, and nothing else in
   * the library can express "this handle is interested in page 3".
   *
   * `onCleanup` is deliberately not used for the release — it fires before *every* re-run, and a
   * re-run also happens when a page is merely appended, which must not drop that page's refcount
   * to zero and abort the fetch the caller is waiting on.
   */
  effect(() => {
    const current = rawPages();
    untracked(() => {
      if (destroyed) return;
      const live = new Set(current.map((page) => page.entry.hash));

      // Anything no longer loaded loses its subscription: dropped by `maxPages`, or belonging to
      // the previous base key.
      for (const [hash, release] of [...releases]) {
        if (live.has(hash)) continue;
        release();
        releases.delete(hash);
      }

      for (const page of current) {
        const hash = page.entry.hash;
        if (releases.has(hash)) continue;
        const release = page.entry.subscribe(gcTime);
        const removeListener = page.entry.addSettleListener(settleListener);
        page.entry.registerPlan(fetchPlan(page));
        releases.set(hash, () => {
          release();
          removeListener();
        });

        if (page.entry.pending !== undefined) continue; // joining beats opening a second request
        const wanted = page.entry.isStale(staleTime);
        if (wanted) void page.entry.fetch(fetchPlan(page)).catch(noop);
      }
    });
  });

  const settleListener = (outcome: SettleOutcome<TPage>): void => {
    if (destroyed) return;
    if (outcome.ok) safe(() => options.onSuccess?.(pages()));
    else safe(() => options.onError?.(outcome.error));
  };

  destroyRef.onDestroy(() => {
    destroyed = true;
    for (const release of releases.values()) release();
    releases.clear();
  });

  /* ---------------------------------- state ---------------------------------- */

  /**
   * Resolved pages only — a page still loading has no data to show yet.
   *
   * The entry reads are **tracked**, not untracked. That is the whole mechanism: a page arriving
   * does not change `loadedParams()`, so nothing else in this file would re-run if these were
   * untracked, and the accumulated list would silently stop growing on the second page.
   */
  const pages = computed<readonly TPage[]>(() =>
    pagesOf()
      .map((page) => page.entry.data())
      .filter((data): data is TPage => data !== undefined),
  );

  const error = computed<Error | undefined>(() => {
    // First failing page, so the message points at something real rather than an arbitrary one.
    for (const page of pagesOf()) {
      const found = page.entry.error();
      if (found) return found;
    }
    return undefined;
  });

  const retrying = computed(() => pagesOf().some((page) => untracked(page.entry.retryAttempt) > 0));

  const isFetching = computed(() => pagesOf().some((page) => page.entry.isFetching()));

  const hasData = computed(() => pages().length > 0);

  const status = computed<RequestStatus>(() => {
    if (error() && !retrying()) return 'error';
    if (isFetching()) return hasData() ? 'reloading' : 'loading';
    if (hasData()) return 'resolved';
    return 'idle';
  });

  const lastParam = (): TParam | undefined => {
    const loaded = loadedParams();
    return loaded[loaded.length - 1];
  };

  const firstParam = (): TParam | undefined => loadedParams()[0];

  const nextParam = (): TParam | undefined => {
    const param = lastParam();
    if (param === undefined) return undefined;
    const all = pagesOf();
    return options.getNextPageParam(untracked(all[all.length - 1]?.entry.data), pages(), param);
  };

  const previousParam = (): TParam | undefined => {
    const getter = options.getPreviousPageParam;
    if (!getter) return undefined;
    const param = firstParam();
    if (param === undefined) return undefined;
    return getter(untracked(pagesOf()[0]?.entry.data), pages(), param);
  };

  /* ----------------------------------- api ----------------------------------- */

  /** Appends, then fetches the new page and waits for it. */
  const fetchNextPage = async (): Promise<void> => {
    if (destroyed) throw new RequestCancelledError('The request was destroyed.');
    const next = nextParam();
    if (next === undefined) return;

    const page = buildPage(next);
    appendParam(next);
    await settlePage(page);
    trimOldest();
  };

  const fetchPreviousPage = async (): Promise<void> => {
    if (destroyed) throw new RequestCancelledError('The request was destroyed.');
    const previous = previousParam();
    if (previous === undefined) return;
    const page = buildPage(previous);
    prependParam(previous);
    await settlePage(page);
    trimOldest();
  };

  /**
   * Starts the page's fetch unless one is already running, and resolves when it has settled.
   *
   * Awaiting the entry's own promise — not polling, not a timeout — is what makes
   * `await fetchNextPage()` mean "that page is now on screen".
   */
  const settlePage = async (page: Page<TPage, TParam>): Promise<void> => {
    const pending = page.entry.pending;
    const promise = pending ?? page.entry.fetch(fetchPlan(page));
    await promise.catch(noop);
  };

  const writeParams = (next: readonly TParam[]): void => {
    const base = baseKey().hash;
    accumulation.set({ base, params: next });
  };

  const appendParam = (param: TParam): void => {
    const base = baseKey().hash;
    const state = accumulation();
    const current = state.base === base ? state.params : [options.initialPageParam];
    writeParams(current.includes(param) ? current : [...current, param]);
  };

  const prependParam = (param: TParam): void => {
    const base = baseKey().hash;
    const state = accumulation();
    const current = state.base === base ? state.params : [options.initialPageParam];
    writeParams(current.includes(param) ? current : [param, ...current]);
  };

  /**
   * Enforces `maxPages` from the end the user is moving toward.
   *
   * Dropping is a *subscription* release, not a cache delete: the page is still cached and comes
   * back instantly if they scroll to it again. Which end is dropped depends on which end they are
   * fetching from, because "keep the last 5 pages" is not the same as "keep the first 5".
   */
  const trimOldest = (): void => {
    const limit = maxPages;
    if (limit === undefined) return;
    const loaded = [...loadedParams()];
    if (loaded.length <= limit) return;
    writeParams(loaded.slice(loaded.length - limit));
  };

  if (isBrowser && (options.refetchOnWindowFocus || options.refetchOnReconnect)) {
    let queued = false;
    const refetch = (): void => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (destroyed) return;
        for (const page of pagesOf()) void page.entry.fetch(fetchPlan(page)).catch(noop);
      });
    };
    const whenVisible = (): void => {
      if (document.visibilityState !== 'hidden') refetch();
    };

    const subs: Subscription[] = [];
    if (options.refetchOnWindowFocus) {
      subs.push(fromEvent(document, 'visibilitychange').subscribe(whenVisible));
      subs.push(fromEvent(window, 'focus').subscribe(whenVisible));
    }
    if (options.refetchOnReconnect) {
      subs.push(fromEvent(window, 'online').subscribe(refetch));
    }
    destroyRef.onDestroy(() => {
      for (const sub of subs) sub.unsubscribe();
      subs.length = 0;
    });
  }

  /** The flattened pages, computed once so `response` and `select` share the same node. */
  const flattened = computed<FlattenedPages<TPage>>(
    () => flatten(pages()) as FlattenedPages<TPage>,
  );

  return {
    pages,
    response: flattened,
    select: <S>(selector: (data: FlattenedPages<TPage>) => S, opts?: SelectOptions<S>): Signal<S> =>
      projectFrom<FlattenedPages<TPage>, S>(flattened, selector, opts?.equal),
    pageParams: loadedParams,
    loading: computed(() => isFetching()),
    status,
    error,
    requestError: computed(() => {
      const cause = error();
      if (cause === undefined) return undefined;
      return toRequestError(cause);
    }),
    isFetching,
    isFetchingNextPage: computed(() => {
      const param = lastParam();
      if (param === undefined) return false;
      // Tracked on purpose: the whole answer is "is this one entry on the network right now", and
      // the param list does not change when it starts or stops.
      const entry = cache.peek<TPage>([...baseKey().raw, param]);
      return entry ? entry.isFetching() : false;
    }),
    isFetchingPreviousPage: computed(() => {
      if (!options.getPreviousPageParam) return false;
      const param = firstParam();
      if (param === undefined) return false;
      const entry = cache.peek<TPage>([...baseKey().raw, param]);
      return entry ? entry.isFetching() : false;
    }),
    dataUpdatedAt: computed(() => {
      let newest = 0;
      for (const page of pagesOf()) newest = Math.max(newest, page.entry.dataUpdatedAt());
      return newest;
    }),
    hasNextPage: () => nextParam() !== undefined,
    hasPreviousPage: () => previousParam() !== undefined,
    fetchNextPage,
    fetchPreviousPage,
    /**
     * Re-fetches every loaded page **in order**.
     *
     * Sequential rather than parallel on purpose: offset pagination is only coherent when the
     * pages are asked for in sequence, and a page returning a different set is easier to reason
     * about when they are not racing each other.
     */
    reload: (): boolean => {
      if (destroyed) return false;
      const current = pagesOf();
      if (current.length === 0) return false;
      void (async () => {
        for (const page of current) {
          await page.entry.fetch(fetchPlan(page)).catch(noop);
        }
      })();
      return true;
    },
    cancel: (): void => {
      for (const page of pagesOf()) page.entry.cancel();
    },
    /** Drops the accumulation. The page entries stay cached and reusable. */
    remove: (): void => {
      writeParams([]);
    },
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      for (const release of releases.values()) release();
      releases.clear();
      for (const page of pagesOf()) page.entry.cancel();
    },
    entryFor: (param: TParam) => cache.peek<TPage>([...baseKey().raw, param]),
  };
}

/**
 * A `createInfiniteRequest` bound to one response type.
 *
 * Both type arguments live on the **call signature**, exactly as in `CreateRequestFn`, so
 * `createInfiniteRequest<Item>(source, options)` fixes the page shape and leaves the param to be
 * inferred from `source` and `initialPageParam`.
 *
 * `TPage` is the shape of **one page** — an array, or a `{ items, cursor }` envelope, whatever the
 * endpoint returns. Flattening is `response()`'s job, not the caller's.
 */
export interface CreateInfiniteRequestFn<TDefault = unknown> {
  <TPage = TDefault, TParam = unknown>(
    source: (param: TParam) => RequestValue,
    options: InfiniteRequestOptions<TPage, TParam>,
  ): InfiniteRequest<TPage, TParam>;
  /** Response body as `string`. */
  text: CreateInfiniteRequestFn<string>;
  /** Response body as `Blob`. */
  blob: CreateInfiniteRequestFn<Blob>;
  /** Response body as `ArrayBuffer`. */
  arrayBuffer: CreateInfiniteRequestFn<ArrayBuffer>;
}

/**
 * The bare call is a `GET`; `.post` / `.put` / `.patch` / `.delete` pick another verb.
 *
 * The non-`GET` variants exist for symmetry with `createRequest`, and they are a mistake in
 * practice: an infinite query is a read. They are still `createVariant`-generated so the response
 * types line up, but nothing about the design encourages them.
 */
export interface CreateInfiniteRequest extends CreateInfiniteRequestFn {
  get: CreateInfiniteRequestFn;
  post: CreateInfiniteRequestFn;
  put: CreateInfiniteRequestFn;
  patch: CreateInfiniteRequestFn;
  delete: CreateInfiniteRequestFn;
}

/** A function whose `name` is shown by Angular in "must be called in an injection context" errors. */
function named(name: string): () => void {
  const fn = (): void => {};
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

function infiniteFactory(
  label: string,
  method: string,
  kind: Kind,
): CreateInfiniteRequestFn<never> {
  // The `never` round-trip is the same one `createRequest` uses: the public overloads carry all
  // the typing, so the implementation only has to be assignable, not precise.
  const build = <TPage, TParam>(
    source: (param: TParam) => RequestValue,
    options: InfiniteRequestOptions<TPage, TParam>,
  ): InfiniteRequest<TPage, TParam> =>
    buildInfiniteRequest<TPage, TParam>(kind, method, source, options, named(label));

  return build as unknown as CreateInfiniteRequestFn<never>;
}

function createVariant(label: string, method: string): CreateInfiniteRequestFn<never> {
  return Object.assign(infiniteFactory(label, method, 'json'), {
    text: infiniteFactory(`${label}.text`, method, 'text'),
    blob: infiniteFactory(`${label}.blob`, method, 'blob'),
    arrayBuffer: infiniteFactory(`${label}.arrayBuffer`, method, 'arrayBuffer'),
  });
}

const GET_JSON = createVariant('createInfiniteRequest', 'GET');

/**
 * Creates a paginated handle where each page is a real cache entry.
 *
 * Unlike `createRequest`, the `key` is a **base** key: the page param is appended, so
 * `key: () => ['items']` produces entries `['items', 0]`, `['items', 1]`, … That is what makes
 * `client.invalidate(['items'])` — prefix-matched — refresh a paginated list without knowing
 * anything about pagination.
 *
 * ```ts
 * readonly feed = createInfiniteRequest<Item>(
 *   (page) => ({ url: '/items', params: { page, size: 20 } }),
 *   {
 *     key: () => ['items', { filter: filter() }],
 *     initialPageParam: 0,
 *     getNextPageParam: (last, _all, param) => (last.length === 20 ? param + 1 : undefined),
 *     maxPages: 5,
 *   },
 * );
 *
 * feed.pages();            // [Item[], Item[], …]
 * feed.response();         // every item, flattened
 * feed.hasNextPage();      // boolean
 * await feed.fetchNextPage();
 * ```
 *
 * Changing a signal inside `key` restarts the accumulation at `initialPageParam`. The page entries
 * stay cached — usually what you want when someone flips a filter back and forth.
 *
 * @example The manual recipe it replaces
 * ```ts
 * // Before: params + keepPreviousValue + update(), plus a hand-written "did I already append this
 * // page?" guard, because `onSuccess` fires on every settle and a reload would append it twice.
 * //
 * // Now each page is an entry, so a reload *replaces* page N. There is no guard to write.
 * ```
 */
export const createInfiniteRequest: CreateInfiniteRequest = Object.assign(GET_JSON, {
  get: createVariant('createInfiniteRequest.get', 'GET'),
  post: createVariant('createInfiniteRequest.post', 'POST'),
  put: createVariant('createInfiniteRequest.put', 'PUT'),
  patch: createVariant('createInfiniteRequest.patch', 'PATCH'),
  delete: createVariant('createInfiniteRequest.delete', 'DELETE'),
});
