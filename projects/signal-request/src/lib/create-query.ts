import { isPlatformBrowser } from '@angular/common';
import {
  assertInInjectionContext,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
} from '@angular/core';
import type { EntryPlan } from './cache/cache-entry';
import { resolveStructuralSharing } from './cache/structural-sharing';
import { buildCachedHandleEngine, DEFAULT_GC_TIME } from './cached-handle';
import { SIGNAL_REQUEST_CONFIG } from './config';
import type { NetworkMode } from './connectivity';
import { toQueryRequestError } from './errors';
import type { QueryOptions, QueryRequest, QuerySource } from './types';
import { normalizeRetry } from './utils';

/**
 * Creates a cached query whose data comes from a function rather than `HttpClient`.
 *
 * The source receives the current params and a context with an `AbortSignal`; return a `Promise`
 * or an `Observable`. The handle is the cached one: `QueryCache`, `staleTime`, `gcTime`, dedup,
 * structural sharing, `maxEntries`, `networkMode` / `paused()`, retry, invalidation, persistence,
 * SSR and devtools all work exactly as they do for a keyed `createRequest`.
 *
 * `key` is **required**. A keyed `createRequest` and a `createQuery` on the same key share one
 * entry and one in-flight call; the most recently registered plan decides how a cache-driven
 * refetch runs. They do not share a data type, so using both for one key is a dev-mode warning and
 * an application bug.
 *
 * Must run in an injection context (field initializer / constructor / `runInInjectionContext`) or
 * receive `{ injector }`. The handle lives as long as that injector.
 *
 * @example A non-HTTP source (IndexedDB, WASM, a hand-rolled GraphQL client):
 * ```ts
 * readonly draft = createQuery<Draft | undefined>(
 *   async (_params, { signal }) => {
 *     const db = await openDb({ signal });
 *     return db.get('drafts', 'current');
 *   },
 *   { key: () => ['draft', 'current'], initialValue: undefined },
 * );
 * ```
 *
 * @example An Observable source — the first emission is the value:
 * ```ts
 * readonly clock = createQuery<string>(
 *   () => timer(0, 1000).pipe(map(() => new Date().toISOString())),
 *   { key: () => ['clock'] },
 * );
 * ```
 *
 * @example Params, like `createRequest`:
 * ```ts
 * readonly profile = createQuery<User, { id: number }>(
 *   (params, { signal }) => api.user(params.id, { signal }),
 *   { key: () => ['user', id()], params: { id: 1 } },
 * );
 * ```
 */
export function createQuery<T, TParams = void>(
  source: QuerySource<T, TParams>,
  options: QueryOptions<T, TParams> & { initialValue: NoInfer<T> },
): QueryRequest<T, T, TParams>;
export function createQuery<T, TParams = void>(
  source: QuerySource<T, TParams>,
  options: QueryOptions<T, TParams>,
): QueryRequest<T, T | undefined, TParams>;
export function createQuery<T, TParams = void>(
  source: QuerySource<T, TParams>,
  options: QueryOptions<T, TParams>,
): QueryRequest<T, T | undefined, TParams> {
  const explicit = options.injector;
  let injector = explicit;
  if (!injector) {
    assertInInjectionContext(createQuery);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () => buildInContext<T, TParams>(source, options));
}

function buildInContext<T, TParams>(
  source: QuerySource<T, TParams>,
  options: QueryOptions<T, TParams>,
): QueryRequest<T, T | undefined, TParams> {
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const lazy = options.lazy ?? false;
  const networkMode: NetworkMode = options.networkMode ?? globalConfig.networkMode ?? 'always';
  const retryPolicy = normalizeRetry(options.retry ?? globalConfig.retry);
  const debounceMs = isBrowser ? (options.debounce ?? 0) : 0;
  const share = resolveStructuralSharing<T>(options.structuralSharing, options.equal);

  // Same params contract as the cached HTTP path: the signal exists always, but only gates the
  // request when the caller actually passed `params`.
  const params = signal<TParams | undefined>((options as { params?: TParams }).params);
  const gateOnParams = Object.hasOwn(options, 'params');

  const core = buildCachedHandleEngine<T, T | undefined, TParams>({
    kind: 'query',
    method: 'QUERY',
    key: options.key,
    debugName: options.debugName,
    params,
    gateOnParams,
    lazy,
    initialValue: options.initialValue,
    keepPreviousValue: options.keepPreviousValue ?? false,
    staleTime: options.staleTime ?? globalConfig.staleTime ?? 0,
    gcTime: options.gcTime ?? globalConfig.gcTime ?? DEFAULT_GC_TIME,
    maxEntries: options.maxEntries,
    refetchOnMount: options.refetchOnMount ?? globalConfig.refetchOnMount ?? 'stale',
    refetchOnWindowFocus:
      options.refetchOnWindowFocus ?? globalConfig.refetchOnWindowFocus ?? false,
    refetchOnReconnect: options.refetchOnReconnect ?? globalConfig.refetchOnReconnect ?? false,
    networkMode,
    waitForRestore: options.waitForRestore ?? globalConfig.waitForRestore ?? true,
    debounceMs,
    pollInterval: options.pollInterval,
    pollWhenHidden: options.pollWhenHidden ?? false,
    onSuccess: options.onSuccess,
    onError: options.onError,
    onSettled: options.onSettled,
    buildPlan: (p): EntryPlan<T> => ({
      kind: 'query',
      structuralSharing: share,
      retry: retryPolicy,
      parse: options.parse,
      networkMode,
      run: (signal) => source(p, { signal, params: p }),
    }),
    // A query is not HTTP: only an abort is classified, everything else is `unknown` with the
    // original error as `cause`. See `toQueryRequestError`.
    classifyError: (error) => toQueryRequestError(error),
    describe: () => ({ url: undefined, method: 'QUERY' }),
  });

  const { entry: _entry, ...handle } = core;
  return handle;
}
