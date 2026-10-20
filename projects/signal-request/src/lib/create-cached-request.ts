import { isPlatformBrowser } from '@angular/common';
import type { HttpResourceRequest } from '@angular/common/http';
import {
  assertInInjectionContext,
  computed,
  inject,
  Injector,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type ResourceParamsContext,
} from '@angular/core';
import type { EntryPlan } from './cache/cache-entry';
import { resolveStructuralSharing } from './cache/structural-sharing';
import { buildCachedHandleEngine, DEFAULT_GC_TIME } from './cached-handle';
import { SIGNAL_REQUEST_CONFIG } from './config';
import type { NetworkMode } from './connectivity';
import { toRequestError } from './errors';
import type { CachedRequest, CachedRequestOptions, RequestSource } from './types';
import {
  normalizeRetry,
  RESPONSE_TYPE,
  resolveRequest,
  warnIfNonGetQuery,
  withGlobalHeaders,
  type Kind,
} from './utils';

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

/**
 * Builds a request handle backed by a shared cache entry.
 *
 * The split from `create-request`'s own path is deliberate and load-bearing: this one owns no
 * `httpResource` and therefore no network call of its own. Everything it shows comes from an
 * entry that other handles may be reading at the same time, and everything it triggers goes
 * through the entry's refcount.
 *
 * The subscription machinery is shared with `createQuery` in `cached-handle.ts`; what remains
 * here is the HTTP half — resolving a source into an `HttpResourceRequest`.
 */
export function buildCachedRequest<T, R, TParams>(
  kind: Kind,
  method: string,
  source: RequestSource<TParams>,
  options: CachedRequestOptions<T, TParams>,
  caller: () => void,
): CachedRequest<T, R, TParams> {
  const explicit = (options as { injector?: Injector }).injector;
  const injector = explicit ?? injectionContextInjector(caller);
  return runInInjectionContext(injector, () =>
    buildCachedInContext<T, R, TParams>(kind, method, source, options, caller),
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
  options: CachedRequestOptions<T, TParams>,
  caller: () => void,
): CachedRequest<T, R, TParams> {
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const lazy = options.lazy ?? false;
  const retryPolicy = normalizeRetry(options.retry ?? globalConfig.retry, {
    timeout: options.timeout,
    timeouts: options.retryTimeouts ?? globalConfig.retryTimeouts,
  });
  const debounceMs = isBrowser ? (options.debounce ?? 0) : 0;
  const networkMode: NetworkMode = options.networkMode ?? globalConfig.networkMode ?? 'always';
  const share = resolveStructuralSharing<T>(options.structuralSharing, options.equal);

  warnIfNonGetQuery(method, lazy, caller);

  /* ------------------------------ request building ----------------------------- */

  const params = signal<TParams | undefined>((options as { params?: TParams }).params);
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

  const core = buildCachedHandleEngine<T, R, TParams>({
    kind: 'http',
    method,
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
    buildPlan: (p): EntryPlan<T> | undefined => {
      const request = evaluate(p);
      if (request === undefined) return undefined;
      return {
        request,
        structuralSharing: share,
        retry: retryPolicy,
        parse: options.parse,
        responseType: RESPONSE_TYPE[kind],
        networkMode,
      };
    },
    classifyError: (error, entry, offline) => {
      const timeout = entry?.errorTimeout();
      return toRequestError(error, {
        ...(timeout === undefined ? {} : { timeout }),
        ...(offline === undefined ? {} : { offline }),
      });
    },
    describe: (current) => ({
      url: current?.plan.kind === 'query' ? undefined : current?.plan.request.url,
      method,
    }),
  });

  const { entry, ...base } = core;

  return {
    ...base,
    headers: computed(() => entry()?.headers()),
    statusCode: computed(() => entry()?.statusCode()),
    progress: computed(() => entry()?.progress()),
  };
}
