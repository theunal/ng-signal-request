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
import { RequestCancelledError, toError, toRequestError, type RequestError } from './errors';
import type { MutationOptions, MutationStatus, RequestValue, RunResult, SignalMutation } from './types';
import { nextRetryDelay, noop, normalizeRetry, resolveRequest, withGlobalHeaders } from './utils';

interface Call {
  cancel(): void;
}

interface MutationFactory {
  <T = unknown, TArgs = void>(
    request: (args: TArgs) => RequestValue,
    options?: MutationOptions<T, TArgs>,
  ): SignalMutation<T, TArgs>;
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

function buildMutationFactory<T, TArgs>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs>,
  caller: () => void,
): SignalMutation<T, TArgs> {
  let injector = options.injector;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () => buildMutation(method, request, options));
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

function buildMutation<T, TArgs>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs>,
): SignalMutation<T, TArgs> {
  const http = inject(HttpClient);
  const config = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
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
  const requestError = computed<RequestError | undefined>(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    const timeout = errorTimeout();
    return toRequestError(cause, timeout === undefined ? {} : { timeout });
  });
  const args = signal<TArgs | undefined>(undefined);
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

  const reloadInvalidated = (): void => {
    const list = typeof options.invalidates === 'function' ? options.invalidates() : options.invalidates;
    for (const target of list ?? []) target.reload();
  };

  const rejected = (reason: Error): Promise<T> => {
    const promise = Promise.reject<T>(reason);
    promise.catch(noop);
    return promise;
  };

  const execute = (callArgs: TArgs): Promise<T> => {
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
    error.set(undefined);
    progress.set(undefined);

    const promise = new Promise<T>((resolve, reject) => {
      let settled = false;
      let subscription: Subscription | undefined;

      const call: Call = {
        cancel: () => {
          if (settled) return;
          finish();
          subscription?.unsubscribe();
          reject(new RequestCancelledError());
        },
      };
      const finish = (): void => {
        settled = true;
        calls.delete(call);
        inFlight.update((n) => n - 1);
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
        safe(reloadInvalidated);
        safe(() => options.onSuccess?.(value, callArgs));
        safe(() => config.onSuccess?.(value, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs));
        resolve(value);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        finish();
        errorTimeout.set(timeout);
        error.set(err);
        finished.set('error');
        safe(() => options.onError?.(err, callArgs));
        safe(() => config.onError?.(err, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs));
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

  const run = (callArgs: TArgs): Promise<T> => {
    if (destroyed) return rejected(new RequestCancelledError('The mutation was destroyed.'));
    switch (concurrency) {
      case 'exhaust': {
        if (exhausted) return exhausted;
        const promise = execute(callArgs);
        exhausted = promise;
        const clear = (): void => {
          if (exhausted === promise) exhausted = undefined;
        };
        promise.then(clear, clear);
        return promise;
      }
      case 'switch':
        cancelAll();
        return execute(callArgs);
      default:
        return execute(callArgs);
    }
  };

  const api = {
    response: response.asReadonly(),
    error: error.asReadonly(),
    requestError,
    loading,
    status,
    args: args.asReadonly(),
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
      progress.set(undefined);
      if (untracked(inFlight) === 0) finished.set('idle');
    },
    destroy,
  };
  return api as unknown as SignalMutation<T, TArgs>;
}
