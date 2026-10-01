import { isPlatformBrowser } from '@angular/common';
import {
  httpResource,
  type HttpResourceOptions,
  type HttpResourceRef,
  type HttpResourceRequest,
} from '@angular/common/http';
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
import { SIGNAL_REQUEST_CONFIG } from './config';
import { RequestCancelledError, toError, toRequestError } from './errors';
import type {
  RequestOptions,
  RequestSource,
  RequestStatus,
  RunResult,
  SignalRequest,
} from './types';
import {
  nextRetryDelay,
  noop,
  normalizeRetry,
  resolveRequest,
  withGlobalHeaders,
} from './utils';

type Kind = 'json' | 'text' | 'blob' | 'arrayBuffer';

type ResourceFactory = (
  request: (ctx: ResourceParamsContext) => HttpResourceRequest | undefined,
  options: HttpResourceOptions<unknown, unknown>,
) => HttpResourceRef<unknown>;

const FACTORIES: Record<Kind, ResourceFactory> = {
  json: httpResource as unknown as ResourceFactory,
  text: httpResource.text as unknown as ResourceFactory,
  blob: httpResource.blob as unknown as ResourceFactory,
  arrayBuffer: httpResource.arrayBuffer as unknown as ResourceFactory,
};

/** `ctx.chain()` only exists while Angular evaluates the params function of a resource. */
const UNAVAILABLE_CTX: ResourceParamsContext = {
  chain: () => {
    throw new Error(
      'ng-signal-request: ctx.chain() is only available in auto mode without `debounce` ' +
        '(it needs to run inside the resource itself).',
    );
  },
};

/** Marker for "the source function threw" (e.g. `ctx.chain()` of a resource that is not ready). */
const THROWN = Symbol('thrown');

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Trailing-edge debounce for a signal. Skips the very first value. */
function debouncedSignal<V>(source: Signal<V>, ms: number): Signal<V> {
  const out = signal<V>(untracked(source));
  effect((onCleanup) => {
    const value = source();
    if (Object.is(value, untracked(out))) return;
    const timer = setTimeout(() => out.set(value), ms);
    onCleanup(() => clearTimeout(timer));
  });
  return out.asReadonly();
}

function buildRequest<T, R, TParams>(
  kind: Kind,
  method: string,
  source: RequestSource<TParams>,
  options: RequestOptions<T, TParams, unknown>,
  caller: () => void,
): SignalRequest<T, R, TParams> {
  let injector = options.injector;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () =>
    buildInContext<T, R, TParams>(kind, method, source, options, injector),
  );
}

function buildInContext<T, R, TParams>(
  kind: Kind,
  method: string,
  source: RequestSource<TParams>,
  options: RequestOptions<T, TParams, unknown>,
  injector: Injector,
): SignalRequest<T, R, TParams> {
  const globalConfig = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const destroyRef = inject(DestroyRef);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const lazy = options.lazy ?? false;
  const initial = options.initialValue as T | undefined;
  const retryPolicy = normalizeRetry(options.retry ?? globalConfig.retry);
  const debounceMs = isBrowser ? (options.debounce ?? 0) : 0;
  const timeout = options.timeout;

  /* ------------------------------ request pipeline ----------------------------- */

  let ctx: ResourceParamsContext = UNAVAILABLE_CTX;

  /**
   * The writable params signal. The library owns it so the caller never has to build one.
   *
   * Gating on it (`params === undefined` => no request) is enabled only when the caller actually
   * passed a `params` option, which the types make mandatory for every non-`void` `TParams`.
   * Without a `TParams` the source is always evaluated and simply ignores the signal, so common
   * sources like `() => \`/jobs/${id()}\`` keep working untouched.
   */
  const params = signal<TParams | undefined>(
    (options as { params?: TParams }).params as TParams | undefined,
  );
  const gateOnParams = Object.hasOwn(options, 'params');

  /**
   * `params` is only handed to `resolveRequest` when the caller opted into it, so a plain
   * request never has its url/body touched by an unrelated signal.
   */
  const evaluate = (c: ResourceParamsContext, p: TParams): HttpResourceRequest | undefined => {
    const built = resolveRequest(
      typeof source === 'function' ? source(p, c) : source,
      method,
      globalConfig.baseUrl,
      gateOnParams ? p : undefined,
    );
    if (built === undefined) return undefined;
    if (timeout !== undefined) built.timeout = timeout;
    if (options.headers !== undefined) built.headers = options.headers;
    // Called inside the reactive chain on purpose: a global `headers` function that reads a
    // token signal makes the request depend on it, so every live query refetches on change.
    return withGlobalHeaders(built, globalConfig.headers);
  };

  /** lazy mode: the request captured by the last `run()`. */
  const manualRequest = signal<HttpResourceRequest | undefined>(undefined);
  /** auto mode: re-evaluates whenever `params` or a signal used by the source changes. */
  const autoRequest = computed(() => {
    const p = params();
    if (gateOnParams && p === undefined) return undefined;
    return evaluate(ctx, p as TParams);
  });
  const current: Signal<HttpResourceRequest | undefined> = lazy
    ? manualRequest
    : debounceMs > 0
      ? debouncedSignal(autoRequest, debounceMs)
      : autoRequest;

  /** The request object that was cancelled on purpose. It stays suppressed until the source produces a new one. */
  const cancelledRequest = signal<HttpResourceRequest | undefined>(undefined);
  const gated = computed(() => {
    const request = current();
    return request !== undefined && request === cancelledRequest() ? undefined : request;
  });

  /**
   * Only the direct auto mode evaluates the source inside the resource's params function. In lazy
   * and debounced mode the source runs elsewhere, so a captured `ctx` would be stale there; keeping
   * `UNAVAILABLE_CTX` gives a clear error instead of a `chain()` against the wrong context.
   */
  const evaluatesInResource = !lazy && debounceMs === 0;

  const resource = FACTORIES[kind](
    (c) => {
      if (evaluatesInResource) ctx = c;
      return gated();
    },
    {
      parse: options.parse as ((raw: unknown) => unknown) | undefined,
      defaultValue: initial,
      equal: options.equal as ((a: unknown, b: unknown) => boolean) | undefined,
      injector,
      debugName: options.debugName,
    },
  ) as HttpResourceRef<T | undefined>;

  /** Identity of the current request. Never throws. */
  const requestKey = computed<HttpResourceRequest | typeof THROWN | undefined>(() => {
    try {
      return gated();
    } catch {
      return THROWN;
    }
  });

  /* ---------------------------------- state ----------------------------------- */

  const retrying = signal(false);
  const retryAttempt = signal(0);

  const status = computed<RequestStatus>(() => (retrying() ? 'reloading' : resource.status()));
  const error = computed<Error | undefined>(() => (retrying() ? undefined : resource.error()));

  /**
   * The same failure, classified. Derived from the *masked* `error` signal, so it also
   * stays `undefined` while a retry is in flight.
   */
  const requestError = computed(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    // The option overrides the source's `timeout` in `evaluate`, but a source may set one on its own.
    const key = untracked(requestKey);
    const effective = timeout ?? (key && key !== THROWN ? key.timeout : undefined);
    return toRequestError(cause, effective === undefined ? {} : { timeout: effective });
  });
  const loading = computed(() => {
    const s = status();
    return s === 'loading' || s === 'reloading';
  });
  const initialLoading = computed(() => status() === 'loading');

  /**
   * Promise-style counterpart of `error()`: `true` only once the last settled attempt
   * succeeded. Derived from `status()` alone, so it is already `false` while retrying
   * (where `error()` is deliberately masked) and while idle/loading.
   */
  const success = computed(() => {
    const s = status();
    return s === 'resolved' || s === 'local';
  });

  /**
   * Last value that was actually received (or set locally). Written eagerly by the supervisor
   * so `keepPreviousValue` works even if nobody read `response()` while the value was current.
   */
  const lastGood = signal<T | undefined>(initial);

  const response = computed<T | undefined>(() => {
    const s = resource.status();
    if (s === 'resolved' || s === 'local' || s === 'reloading') return resource.value() as T;
    return options.keepPreviousValue ? lastGood() : initial;
  }) as unknown as Signal<R>;

  /* ------------------------------- supervisor --------------------------------- */

  const pending = new Set<Deferred<T>>();
  let destroyed = false;
  let lastKey: unknown = undefined;
  let lastStatus: RequestStatus = 'idle';
  let lastError: Error | undefined;
  let lastValue: unknown = THROWN;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errorHandler.handleError(e);
    }
  };

  const resolvePending = (value: T): void => {
    const all = [...pending];
    pending.clear();
    for (const d of all) d.resolve(value);
  };
  const rejectPending = (reason: unknown): void => {
    const all = [...pending];
    pending.clear();
    for (const d of all) d.reject(reason);
  };

  const resetRetry = (): void => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    attempt = 0;
    lastError = undefined;
    if (untracked(retrying)) retrying.set(false);
    if (untracked(retryAttempt) !== 0) retryAttempt.set(0);
  };

  const resolvePollInterval = (): number => {
    if (!isBrowser) return 0;
    const p = options.pollInterval;
    const value = typeof p === 'function' ? p() : p;
    return typeof value === 'number' && value > 0 ? value : 0;
  };

  const armPoll = (ms: number): void => {
    if (ms <= 0 || destroyed) return;
    pollTimer = setTimeout(() => {
      if (!options.pollWhenHidden && typeof document !== 'undefined' && document.hidden) {
        armPoll(ms);
        return;
      }
      resource.reload();
    }, ms);
  };

  /**
   * The reactive-graph key is the built `HttpResourceRequest`, so it is also where the url and the
   * verb live. `THROWN` is the marker for a source that threw, which has no request to describe.
   */
  const describe = (key: unknown): { url: string | undefined; method: string } => {
    const request = key && key !== THROWN ? (key as HttpResourceRequest) : undefined;
    return { url: request?.url, method: request?.method ?? 'GET' };
  };

  const finalizeError = (err: Error, key: unknown): void => {
    retrying.set(false);
    rejectPending(err);
    safe(() => options.onError?.(err));
    safe(() => globalConfig.onError?.(err, describe(key)));
    safe(() => options.onSettled?.());
  };

  const step = (s: RequestStatus, key: unknown, pollMs: number): void => {
    const keyChanged = key !== lastKey;
    const statusChanged = s !== lastStatus;
    lastKey = key;
    lastStatus = s;

    clearTimeout(pollTimer);
    if (keyChanged) resetRetry();

    switch (s) {
      case 'loading':
      case 'reloading':
        return;

      case 'idle':
        resetRetry();
        rejectPending(new RequestCancelledError('The request was cancelled or is disabled.'));
        return;

      case 'local': {
        resetRetry();
        const value = resource.value() as T;
        lastGood.set(value);
        resolvePending(value);
        return;
      }

      case 'resolved': {
        resetRetry();
        const value = resource.value();
        lastGood.set(value as T);
        if (statusChanged || keyChanged || pending.size > 0 || value !== lastValue) {
          lastValue = value;
          resolvePending(value as T);
          safe(() => options.onSuccess?.(value as T));
          safe(() => globalConfig.onSuccess?.(value, describe(key)));
          safe(() => options.onSettled?.());
        }
        armPoll(pollMs);
        return;
      }

      case 'error': {
        const err = toError(resource.error());
        if (err === lastError) {
          // same failure observed again (e.g. poll interval changed) – keep whatever is scheduled
          if (!untracked(retrying)) armPoll(pollMs);
          return;
        }
        lastError = err;
        const delay = nextRetryDelay(retryPolicy, attempt + 1, err);
        if (delay !== undefined) {
          attempt += 1;
          retryAttempt.set(attempt);
          retrying.set(true);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            resource.reload();
          }, delay);
          return;
        }
        finalizeError(err, key);
        armPoll(pollMs);
        return;
      }
    }
  };

  effect(() => {
    // Order matters: reading the resource first makes Angular evaluate the params function
    // (and therefore `ctx.chain`) before anything else touches the request signals.
    const s = resource.status();
    const key = requestKey();
    const pollMs = resolvePollInterval();
    untracked(() => step(s, key, pollMs));
  });

  const teardown = (): void => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(retryTimer);
    clearTimeout(pollTimer);
    rejectPending(new RequestCancelledError('The request was destroyed.'));
  };
  destroyRef.onDestroy(teardown);

  /* --------------------------------- public API -------------------------------- */

  const enqueue = (): Promise<T> => {
    const promise = new Promise<T>((resolve, reject) => pending.add({ resolve, reject }));
    promise.catch(noop); // fire-and-forget callers get no "unhandled rejection"; `await` still throws
    return promise;
  };

  const rejected = (error: Error): Promise<T> => {
    const promise = Promise.reject<T>(error);
    promise.catch(noop);
    return promise;
  };

  const disabledError = () =>
    new RequestCancelledError('The request is disabled: its source returned undefined/null/false.');

  const run = (): Promise<T> => {
    if (destroyed) return rejected(new RequestCancelledError('The request was destroyed.'));
    resetRetry();
    untracked(() => cancelledRequest.set(undefined));

    if (lazy) {
      let request: HttpResourceRequest | undefined;
      try {
        const p = untracked(params);
        if (gateOnParams && p === undefined) {
          request = undefined;
        } else {
          request = untracked(() => evaluate(UNAVAILABLE_CTX, p as TParams));
        }
      } catch (e) {
        return rejected(toError(e)); // a throwing source must not make run() throw synchronously
      }
      if (!request) return rejected(disabledError());
      const promise = enqueue();
      manualRequest.set(request);
      return promise;
    }

    const raw = untracked(resource.status);
    if (raw === 'idle') return rejected(disabledError());
    const promise = enqueue();
    if (raw !== 'loading' && raw !== 'reloading') resource.reload();
    return promise;
  };

  return {
    params,
    response,
    error,
    requestError,
    success,
    loading,
    initialLoading,
    status,
    retryAttempt: retryAttempt.asReadonly(),
    headers: resource.headers,
    statusCode: resource.statusCode,
    progress: resource.progress,
    resource,

    run,
    tryRun: (): Promise<RunResult<T>> =>
      run().then(
        (value): RunResult<T> => ({ ok: true, response: value }),
        (e): RunResult<T> => ({ ok: false, error: toError(e) }),
      ),

    reload: (): boolean => {
      if (destroyed) return false;
      if (untracked(cancelledRequest) !== undefined) {
        cancelledRequest.set(undefined);
        return true;
      }
      const wasRetrying = untracked(retrying);
      resetRetry();
      return resource.reload() || wasRetrying;
    },

    cancel: (): void => {
      if (destroyed) return;
      if (untracked(retrying)) {
        // waiting for the next retry: stop retrying and surface the last error
        const err = lastError;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        if (err) finalizeError(err, lastKey);
        return;
      }
      const s = untracked(resource.status);
      if (s !== 'loading' && s !== 'reloading') return;
      const request = untracked(current);
      // Angular does not abort the network call when the request turns `undefined` (it only discards
      // the result). Writing a local value aborts it for real; the gate below then brings us to `idle`.
      resource.set(untracked(response) as unknown as T);
      cancelledRequest.set(request);
    },

    set: (value: T): void => resource.set(value),
    update: (updater: (current: R) => T): void => resource.set(updater(untracked(response))),

    destroy: (): void => {
      teardown();
      resource.destroy();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Public function with overloads (mirrors httpResource's shape)             */
/* -------------------------------------------------------------------------- */

/**
 * A `createRequest` bound to one response type. The other three are properties, so
 * `createRequest.post.text(...)` is typed exactly like `createRequest.text(...)`.
 */
export interface CreateRequestFn<TRaw = unknown, TDefault = unknown> {
  <T = TDefault, TParams = void>(
    source: RequestSource<TParams>,
    options: RequestOptions<T, TParams, TRaw> & { initialValue: NoInfer<T> },
  ): SignalRequest<T, T, TParams>;
  <T = TDefault, TParams = void>(
    source: RequestSource<TParams>,
    options?: RequestOptions<T, TParams, TRaw>,
  ): SignalRequest<T, T | undefined, TParams>;
  /** Response body as `string`. */
  text: CreateRequestFn<string, string>;
  /** Response body as `Blob` (downloads). */
  blob: CreateRequestFn<Blob, Blob>;
  /** Response body as `ArrayBuffer`. */
  arrayBuffer: CreateRequestFn<ArrayBuffer, ArrayBuffer>;
}

/**
 * The bare call is `createRequest.get`; the verb is chosen by the property you reach
 * for, never by a `method` field in the source.
 *
 * Anything other than `get` is still **reactive**: it re-fires on every signal the
 * source reads. For writes that must not re-fire on their own, use `createMutation`
 * (or `lazy: true`).
 */
export interface CreateRequest extends CreateRequestFn<unknown, unknown> {
  get: CreateRequestFn<unknown, unknown>;
  post: CreateRequestFn<unknown, unknown>;
  put: CreateRequestFn<unknown, unknown>;
  patch: CreateRequestFn<unknown, unknown>;
  delete: CreateRequestFn<unknown, unknown>;
}

/** A function whose `name` is shown by Angular in "must be called in an injection context" errors. */
function named(name: string): () => void {
  const fn = (): void => {};
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

function createFn(method: string, kind: Kind, caller: () => void) {
  return (source: RequestSource<never>, options: RequestOptions<never, never, unknown> = {}) =>
    buildRequest<never, never, never>(kind, method, source, options, caller);
}

/**
 * One verb × the JSON response type, with the other three response types hanging off it.
 * `label` is the dotted path as the user would type it, so Angular's "must be called in an
 * injection context" error points at the exact call: `createRequest.post.text`.
 */
function createVariant(label: string, method: string): CreateRequestFn<never, never> {
  return Object.assign(createFn(method, 'json', named(label)), {
    text: createFn(method, 'text', named(`${label}.text`)),
    blob: createFn(method, 'blob', named(`${label}.blob`)),
    arrayBuffer: createFn(method, 'arrayBuffer', named(`${label}.arrayBuffer`)),
  }) as unknown as CreateRequestFn<never, never>;
}

const GET_JSON = createVariant('createRequest', 'GET');

/**
 * Creates a reactive HTTP query on top of Angular's `httpResource`.
 *
 * The bare call is a `GET`; pick another verb with `.post` / `.put` / `.patch` / `.delete`,
 * and a response type with `.text` / `.blob` / `.arrayBuffer`.
 *
 * Must run in an injection context (field initializer / constructor / `runInInjectionContext`)
 * or receive `{ injector }`. The request lives as long as that injector (component, service, route).
 *
 * @example Reactive filters, no params type:
 * ```ts
 * readonly page = signal(1);
 * readonly users = createRequest<User[]>(
 *   () => ({ url: '/users', params: { page: this.page() } }),
 *   { initialValue: [], keepPreviousValue: true, retry: 2 },
 * );
 * // template: users.loading(), users.response(), users.error()
 * ```
 *
 * @example With a params type — the library creates the writable `params` signal for you:
 * ```ts
 * // The second type argument is the params type, so `params` becomes a required option.
 * // `path` fills the `:id` placeholder, `body` becomes the request body, everything else
 * // goes to the query string — no mapping function needed.
 * readonly list = createRequest<Item[], ListQuery>(
 *   { url: '/items/:id' },
 *   { params: { path: { id: 5 }, param1: '1', param2: 10 } },
 * );
 *
 * // Elsewhere: writing params re-fires the request.
 * this.list.params.set({ path: { id: 6 }, param1: '2', param2: 20 });
 * this.list.success(); // boolean, no try/catch needed
 * ```
 *
 * @example A verb and a response type:
 * ```ts
 * // POST /search  ->  raw text
 * const search = createRequest.post.text(
 *   (params) => ({ url: '/search', body: params }),
 *   { params: { q: '' }, initialValue: '' },
 * );
 * ```
 */
export const createRequest: CreateRequest = Object.assign(GET_JSON, {
  get: createVariant('createRequest.get', 'GET'),
  post: createVariant('createRequest.post', 'POST'),
  put: createVariant('createRequest.put', 'PUT'),
  patch: createVariant('createRequest.patch', 'PATCH'),
  delete: createVariant('createRequest.delete', 'DELETE'),
}) as unknown as CreateRequest;
