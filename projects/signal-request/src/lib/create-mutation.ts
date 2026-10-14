import {
  HttpClient,
  HttpEventType,
  type HttpEvent,
  type HttpProgressEvent,
  type HttpResponse,
} from '@angular/common/http';
import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  ErrorHandler,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import { retry, throwError, timer, type Observable, type Subscription } from 'rxjs';
import { SIGNAL_REQUEST_CONFIG } from './config';
import { QueryCache } from './cache/query-cache';
import { MutationRegistry } from './cache/mutation-registry';
import { QueryClient } from './cache/query-client';
import { RequestCancelledError, toError, toRequestError, type RequestErrorView } from './errors';
import type { QueryKey } from './cache/key';
import {
  MutationOptions,
  MutationStatus,
  OptimisticTarget,
  RequestValue,
  RunResult,
  SignalMutation,
  type InvalidationTarget,
} from './types';
import { nextRetryDelay, noop, normalizeRetry, resolveRequest, withGlobalHeaders } from './utils';

interface Call {
  cancel(): void;
}

interface MutationFactory {
  <T = unknown, TArgs = void, TContext = undefined>(
    request: (args: TArgs) => RequestValue,
    options?: MutationOptions<T, TArgs, TContext>,
  ): SignalMutation<T, TArgs, TContext>;
}

/**
 * The bare `createMutation` is a `POST`; `.post` / `.put` / `.patch` / `.delete` pick another
 * verb. It never comes from a `method` field in the builder.
 */
export interface CreateMutation extends MutationFactory {
  post: MutationFactory;
  put: MutationFactory;
  patch: MutationFactory;
  delete: MutationFactory;
}

/** A function whose `name` is shown by Angular in "must be called in an injection context" errors. */
function named(name: string): () => void {
  const fn = (): void => {};
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

function mutationFactory(label: string, method: string): MutationFactory {
  return (request, options = {}) =>
    buildMutationFactory(method, request, options, named(label));
}

function buildMutationFactory<T, TArgs, TContext>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs, TContext>,
  caller: () => void,
): SignalMutation<T, TArgs, TContext> {
  let injector = options.injector;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () => buildMutation<T, TArgs, TContext>(method, request, options));
}

const POST = mutationFactory('createMutation', 'POST');

/**
 * Creates an imperative write operation with signal state.
 *
 * Unlike `createRequest` it is never reactive and never fires on its own – you call `run(args)`.
 * It talks to `HttpClient` directly, because `httpResource` is meant for reads (it is eager and
 * cancels the previous request, which is not what you want for writes).
 *
 * The bare call is a `POST`; pick another verb with `.put` / `.patch` / `.delete`.
 *
 * @example
 * ```ts
 * // The args double as a params bag, so the builder can stay a bare url:
 * // `path` fills the placeholder, `body` becomes the request body.
 * readonly save = createMutation.put<User, { path: { id: number }; body: Partial<User> }>(
 *   () => '/users/:id',
 *   { invalidates: () => [this.users], concurrency: 'exhaust' },
 * );
 * await this.save.run({ path: { id: 1 }, body: { name: 'Ada' } });
 * // → PUT /users/1   body: {"name":"Ada"}
 * ```
 */
export const createMutation: CreateMutation = Object.assign(POST, {
  post: mutationFactory('createMutation.post', 'POST'),
  put: mutationFactory('createMutation.put', 'PUT'),
  patch: mutationFactory('createMutation.patch', 'PATCH'),
  delete: mutationFactory('createMutation.delete', 'DELETE'),
}) as CreateMutation;

function buildMutation<T, TArgs, TContext>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs, TContext>,
): SignalMutation<T, TArgs, TContext> {
  const http = inject(HttpClient);
  const config = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const cache = inject(QueryCache);
  const mutations = inject(MutationRegistry);
  /**
   * Only used when `invalidates` is given a key. Injected unconditionally so that a mutation
   * built without one still behaves identically — `inject()` here resolves from the same
   * application injector either way, and there is nothing to lazily.
   */
  const client = inject(QueryClient);
  const retryPolicy = normalizeRetry(options.retry);
  const concurrency = options.concurrency ?? 'parallel';

  const response = signal<T | undefined>(undefined);
  const error = signal<Error | undefined>(undefined);
  /**
   * Timeout of the call that produced `error`. A builder may set its own `timeout`, so the
   * option alone is not enough to tell a deliberate timeout from a plain abort.
   */
  const errorTimeout = signal<number | undefined>(undefined);
  /** The same failure as `error`, classified. */
  const requestError = computed<RequestErrorView | undefined>(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    const timeout = errorTimeout();
    return toRequestError(cause, timeout === undefined ? {} : { timeout });
  });
  const args = signal<TArgs | undefined>(undefined);
  /** Whatever the last call's `onMutate` produced. See `MutationOptions.onMutate`. */
  const context = signal<TContext | undefined>(undefined);
  const progress = signal<HttpProgressEvent | undefined>(undefined);
  const inFlight = signal(0);
  const finished = signal<Exclude<MutationStatus, 'loading'>>('idle');

  const status = computed<MutationStatus>(() => (inFlight() > 0 ? 'loading' : finished()));
  const loading = computed(() => inFlight() > 0);

  const calls = new Set<Call>();
  let exhausted: Promise<T> | undefined;
  let destroyed = false;

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errorHandler.handleError(e);
    }
  };

  /**
 * A query key is an array; a handle is an object with `reload()`.
 *
 * A hand-written guard rather than a bare `Array.isArray`: the built-in narrows its *true* branch
 * to `any[]` and leaves `readonly unknown[]` in the false branch, so `target.reload()` would not
 * type-check on what is left.
 */
const isQueryKey = (target: InvalidationTarget): target is QueryKey => Array.isArray(target);

/** The same discrimination for `target`, which takes a handle or a key. */
const isKeyTarget = (target: OptimisticTarget<unknown> | QueryKey): target is QueryKey =>
  Array.isArray(target);

/**
   * Applies `invalidates` after a successful call.
   *
   * Handles are reloaded directly; keys go through `QueryClient`, which invalidates **every**
   * cached entry under that key — not just the one this mutation happens to hold a reference
   * to. That is the whole reason a key is worth accepting here: the list showing the new row is
   * usually a different component from the one holding the mutation.
   */
  const reloadInvalidated = (): void => {
    const list = typeof options.invalidates === 'function' ? options.invalidates() : options.invalidates;
    for (const target of list ?? []) {
      if (isQueryKey(target)) client.invalidate(target);
      else target.reload();
    }
  };

  /** The mutation's own `response`, shaped like an `OptimisticTarget` so it needs no special case. */
  const selfTarget: OptimisticTarget<T> = {
    response: response.asReadonly(),
    set: (value: T) => response.set(value),
  };

  /**
   * Resolves `target` to something writable.
   *
   * A key goes through `peek`, never `resolve`: an entry nobody is holding a handle for has no
   * request description, and minting one would leave an orphan that can never fetch and that
   * nothing is subscribed to — so nothing would ever collect it either. Returning `undefined`
   * makes the optimistic write a no-op instead, which is the honest outcome: nobody is looking.
   */
  const resolveTarget = (): OptimisticTarget<T> | undefined => {
    const configured = options.target;
    if (configured === undefined) return selfTarget;
    if (!isKeyTarget(configured)) return configured;
    const entry = cache.peek<T>(configured);
    if (!entry) return undefined;
    // Adapted rather than satisfied directly: an entry stores through `setData`, which also moves
    // its timestamps and clears `invalidated`. Going through it keeps a local write indistinguishable
    // from `setData()` on the handle itself.
    return { response: entry.data, set: (value: T) => void entry.setData(value) };
  };

  /**
   * Writes the optimistic value for one call and returns the undo.
   *
   * The undo is a compare-and-swap: it restores the snapshot only when this call's own value is
   * still what the target holds. Without that guard `concurrency: 'parallel'` would let a failing
   * call wipe the value a sibling call had just written — the rollback would then *introduce* a
   * stale value instead of removing a fake one. Under `exhaust` / `switch` only one call is ever in
   * flight, so the guard always passes and the behaviour is a plain restore.
   *
   * A throwing `optimistic` is reported and the call proceeds without one, rather than taking the
   * whole write down before it was sent.
   */
  const applyOptimistic = (callArgs: TArgs): (() => void) => {
    if (!options.optimistic) return noop;
    const target = resolveTarget();
    if (!target) return noop;
    const snapshot = untracked(target.response);
    let next: T;
    try {
      next = options.optimistic(snapshot, callArgs);
    } catch (e) {
      safe(() => errorHandler.handleError(e));
      return noop;
    }
    target.set(next);
    return () => {
      // `undefined` is restored as-is: there was nothing before, and leaving the invented value
      // up would be the one case where the rollback silently does nothing visible.
      if (untracked(target.response) === next) target.set(snapshot as T);
    };
  };

  const rejected = (reason: Error): Promise<T> => {
    const promise = Promise.reject<T>(reason);
    promise.catch(noop);
    return promise;
  };

  /**
   * Runs `onMutate` and returns the context it produced.
   *
   * Deliberately **before** the optimistic write: a hook that snapshots state wants to see the
   * world as it was, before this call changed anything. A rejection fails the call outright —
   * nothing is sent and nothing was shown — because a preparation that could not run means the
   * call was never really made.
   */
  const runOnMutate = async (callArgs: TArgs): Promise<TContext> => {
    if (!options.onMutate) return undefined as TContext;
    return await options.onMutate(callArgs);
  };

  const execute = (callArgs: TArgs, ctx: TContext): Promise<T> => {
    // `TArgs` doubles as a params bag: its `body` / `path` / `headers` keys fill the
    // matching request slots and the rest become the query string. The verb comes from
    // the variant that was called.
    let built: ReturnType<typeof resolveRequest>;
    try {
      built = resolveRequest(request(callArgs), method, config.baseUrl, callArgs);
    } catch (e) {
      return rejected(toError(e)); // a throwing builder must not make run() throw synchronously
    }
    if (!built) return rejected(new RequestCancelledError('The mutation is disabled: its request returned undefined/null/false.'));

    // `method` is already the first argument of `http.request`; the option wins over a builder value.
    const { url, method: _method, ...rest } = built;
    const timeout = options.timeout ?? built.timeout;

    // A function-shaped global `headers` is read at call time, so it picks up the current
    // token even though a mutation has no reactive chain to invalidate.
    const withHeaders = options.headers === undefined ? built : { ...built, headers: options.headers };
    const { headers } = withGlobalHeaders(withHeaders, config.headers);

    let stream: Observable<unknown> = http.request<unknown>(method, url, {
      ...rest,
      headers,
      // `events` is what makes `reportProgress: true` observable. It is the full
      // `HttpEvent` stream, so `next` can be a progress event, the body, or a `Sent` event.
      observe: 'events',
      responseType: options.responseType ?? 'json',
      timeout,
    } as never);
    if (retryPolicy) {
      stream = stream.pipe(
        retry({
          delay: (err: unknown, attemptNo: number) => {
            const delay = nextRetryDelay(retryPolicy, attemptNo, toError(err));
            return delay === undefined ? throwError(() => err) : timer(delay);
          },
        }),
      );
    }

    inFlight.update((n) => n + 1);
    args.set(callArgs);
    context.set(ctx);
    error.set(undefined);
    progress.set(undefined);
    mutations.begin(options.mutationKey);

    const promise = new Promise<T>((resolve, reject) => {
      let settled = false;
      let subscription: Subscription | undefined;
      /** Undoes this call's optimistic write. See `applyOptimistic`. */
      let undo: () => void = noop;

      const call: Call = {
        cancel: () => {
          if (settled) return;
          // A destroyed handle has no observer left to correct, and writing to a dead signal is
          // pure noise; a plain `cancel()` (or a `switch` superseding this call) does roll back,
          // because leaving an invented value on screen is the worse outcome.
          if (!destroyed) undo();
          finish();
          subscription?.unsubscribe();
          reject(new RequestCancelledError());
        },
      };
      const finish = (): void => {
        settled = true;
        calls.delete(call);
        inFlight.update((n) => n - 1);
        mutations.end(options.mutationKey);
        // A settled call has no progress left to report, and leaving the last event behind would
        // pin a `<progress [value]="…">` at its final value. Cleared on every settle path — success,
        // failure and cancel — so `progress()` is `undefined` again until the next call reports.
        progress.set(undefined);
      };
      const isEvent = (raw: unknown): raw is HttpEvent<unknown> =>
        typeof raw === 'object' && raw !== null && 'type' in raw && (raw as { type: unknown }).type !== undefined;

      const succeed = (raw: unknown): void => {
        if (settled) return;
        let value: T;
        try {
          value = options.parse ? options.parse(raw) : (raw as T);
        } catch (e) {
          fail(toError(e));
          return;
        }
        finish();
        response.set(value);
        finished.set('success');
        // Settle order is fixed and worth stating, because the rollback and the refetch both
        // touch the same display: invalidate → onSuccess → onSettled. So a hook that reads the
        // refreshed value sees the fresh list, not the one that is about to be replaced.
        safe(reloadInvalidated);
        safe(() => options.onSuccess?.(value, callArgs, ctx));
        safe(() => config.onSuccess?.(value, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs, ctx));
        resolve(value);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        // The optimistic value never became real, so it must not stay on screen. `undo` is a
        // compare-and-swap, so a value another call wrote in the meantime survives.
        undo();
        finish();
        errorTimeout.set(timeout);
        error.set(err);
        finished.set('error');
        safe(() => options.onError?.(err, callArgs, ctx));
        safe(() => config.onError?.(err, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs, ctx));
        reject(err);
      };
      /**
       * `observe: 'events'` delivers the body inside a `Response` event, with `Sent` and the
       * progress events around it. Everything that is not the body updates `progress`.
       */
      const onEvent = (raw: unknown): void => {
        if (!isEvent(raw)) {
          succeed(raw); // defensive: no `HttpEvent` wrapper
          return;
        }
        switch (raw.type) {
          case HttpEventType.UploadProgress:
          case HttpEventType.DownloadProgress:
            progress.set(raw as HttpProgressEvent);
            return;
          case HttpEventType.Response:
            succeed((raw as HttpResponse<unknown>).body);
            return;
          default:
            return; // `Sent` and anything else carry no body
        }
      };

      calls.add(call);
      // Applied last, so the state above (`args`, cleared `error`, cleared `progress`) is what the
      // template sees together with the optimistic value rather than before it.
      undo = applyOptimistic(callArgs);
      subscription = stream.subscribe({ next: onEvent, error: (e) => fail(toError(e)) });
      if (settled) subscription.unsubscribe();
    });
    promise.catch(noop);
    return promise;
  };

  const cancelAll = (): void => {
    for (const call of [...calls]) call.cancel();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    cancelAll();
  };

  inject(DestroyRef).onDestroy(destroy);

  /**
   * Runs the call, with `onMutate` in front of it when there is one.
   *
   * Without `onMutate` this calls `execute` **synchronously**, which is load-bearing: the request
   * is on the wire before `run()` returns, so `run(); expectOne(url)` in a test works and a
   * `switch`-mode cancel still sees the previous call in the same tick. Routing everything through
   * a promise chain "for symmetry" would push dispatch into a microtask and quietly change that.
   */
  const start = (callArgs: TArgs): Promise<T> => {
    if (!options.onMutate) return execute(callArgs, undefined as TContext);

    return runOnMutate(callArgs).then(
      (ctx) => execute(callArgs, ctx),
      // `onMutate` threw or rejected: the call was never made, so it fails like any other
      // failed call — hooks run, the promise rejects, nothing was sent.
      (reason: unknown) => {
        const failure = toError(reason);
        args.set(callArgs);
        context.set(undefined);
        error.set(failure);
        finished.set('error');
        safe(() => options.onError?.(failure, callArgs, undefined));
        safe(() => config.onError?.(failure, { url: undefined, method }));
        safe(() => options.onSettled?.(callArgs, undefined));
        return rejected(failure);
      },
    );
  };

  const run = (callArgs: TArgs): Promise<T> => {
    if (destroyed) return rejected(new RequestCancelledError('The mutation was destroyed.'));
    switch (concurrency) {
      case 'exhaust': {
        if (exhausted) return exhausted;
        const promise = start(callArgs);
        exhausted = promise;
        const clear = (): void => {
          if (exhausted === promise) exhausted = undefined;
        };
        promise.then(clear, clear);
        return promise;
      }
      case 'switch':
        cancelAll();
        return start(callArgs);
      default:
        return start(callArgs);
    }
  };

  const api = {
    response: response.asReadonly(),
    error: error.asReadonly(),
    requestError,
    loading,
    status,
    args: args.asReadonly(),
    context: context.asReadonly(),
    progress: progress.asReadonly(),
    run: (...a: [TArgs?]) => run(a[0] as TArgs),
    tryRun: (...a: [TArgs?]): Promise<RunResult<T>> =>
      run(a[0] as TArgs).then(
        (value): RunResult<T> => ({ ok: true, response: value }),
        (e): RunResult<T> => ({ ok: false, error: toError(e) }),
      ),
    cancel: cancelAll,
    reset: (): void => {
      response.set(undefined);
      error.set(undefined);
      args.set(undefined);
      context.set(undefined);
      progress.set(undefined);
      if (untracked(inFlight) === 0) finished.set('idle');
    },
    destroy,
  };
  return api as unknown as SignalMutation<T, TArgs, TContext>;
}
