import type {
  HttpHeaders,
  HttpProgressEvent,
  HttpResourceRef,
  HttpResourceRequest,
} from '@angular/common/http';
import type { RequestError } from './errors';
import type {
  Injector,
  ResourceParamsContext,
  Signal,
  ValueEqualityFn,
  WritableSignal,
} from '@angular/core';

/* -------------------------------------------------------------------------- */
/*  Request description                                                       */
/* -------------------------------------------------------------------------- */

export type QueryPrimitive = string | number | boolean;
type QueryItem = QueryPrimitive | Date | null | undefined;

/** A query-string value. `null` / `undefined` entries are dropped, `Date` becomes ISO-8601. */
export type QueryValue = QueryItem | ReadonlyArray<QueryItem>;
export type QueryParams = Record<string, QueryValue>;

/**
 * Values for `:placeholders` inside `url`.
 * If any placeholder that appears in the url resolves to `null`/`undefined`
 * the request is treated as *disabled* (it simply does not fire).
 */
export type PathParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Same shape as Angular's `HttpResourceRequest`, minus `method`, plus:
 *  - `params` tolerates `null` / `undefined` / `Date` / arrays of those
 *  - `path` fills `:placeholders` in `url`
 *
 * `method` is deliberately **not** part of a request description: the HTTP verb is
 * chosen by the function you call — `createRequest.get` / `.post` / `createMutation.put` / …
 * Writing `method` here is a type error, and in a `params` bag it is just a query value.
 */
export interface RequestConfig extends Omit<HttpResourceRequest, 'params' | 'method'> {
  params?: QueryParams | HttpResourceRequest['params'];
  path?: PathParams;
}

/** What a request source may evaluate to. `null` / `undefined` / `false` => disabled. */
export type RequestValue = string | RequestConfig | null | undefined | false;

/**
 * - static value: request is built once
 * - function: reactive, re-evaluated whenever a signal read inside changes
 *   (including the `params` signal the library creates for `TParams`).
 *
 * A function source receives the current params as its **first** argument and Angular's
 * params context as its **second**, so `ctx.chain(otherResource)` keeps working:
 *
 * ```ts
 * createRequest<Post[], { userId: string }>(
 *   (params, ctx) => ({ url: `/users/${ctx.chain(this.user.resource)!.id}/posts` }),
 * );
 * ```
 */
export type RequestSource<TParams = void> =
  | RequestValue
  | ((params: NoInfer<TParams>, ctx: ResourceParamsContext) => RequestValue);

/* -------------------------------------------------------------------------- */
/*  Status                                                                    */
/* -------------------------------------------------------------------------- */

/** Same vocabulary as Angular's `ResourceStatus`. */
export type RequestStatus = 'idle' | 'loading' | 'reloading' | 'resolved' | 'error' | 'local';

/* -------------------------------------------------------------------------- */
/*  Retry                                                                     */
/* -------------------------------------------------------------------------- */

export interface RetryOptions {
  /** Maximum number of *re*-tries after the first failure. */
  count: number;
  /**
   * Delay before each retry in ms. `attempt` starts at 1.
   * Default: exponential back-off 1s, 2s, 4s ... capped at 30s.
   */
  delay?: number | ((attempt: number, error: Error) => number);
  /**
   * Decide whether an error is worth retrying.
   * Default: network errors (status 0), 408, 425, 429 and every 5xx.
   */
  when?: (error: Error, attempt: number) => boolean;
}

/** `3` is shorthand for `{ count: 3 }`. `false` / `0` disables retrying. */
export type RetryConfig = number | RetryOptions | false;

/* -------------------------------------------------------------------------- */
/*  Global configuration                                                      */
/* -------------------------------------------------------------------------- */

export interface SignalRequestConfig {
  /** Prepended to every relative url (`/users` => `https://api.x.com/users`). */
  baseUrl?: string;
  /** Default retry policy for queries (`createRequest`). Mutations never retry by default. */
  retry?: RetryConfig;
  /**
   * Headers added to every request. A plain object is used as-is; a **function** is
   * re-evaluated inside each request's reactive chain, so signals it reads (a token, a locale)
   * make every live request refetch when they change.
   *
   * A plain object is a snapshot — reading a token into one freezes it, which is almost never
   * what you want. Prefer the function form for anything dynamic.
   */
  headers?: Record<string, string> | (() => Record<string, string>);
  /**
   * Called once for every request or mutation that ends in a final error, after retries.
   * Ideal for toasts / logging.
   */
  onError?: (error: Error, request: { url: string | undefined; method: string }) => void;
  /**
   * The mirror image of `onError`: called once for every request or mutation that succeeds.
   * Use it for logging, analytics or cache warming — a toast belongs in the per-call
   * `onSuccess`, where you know what actually happened.
   */
  onSuccess?: (response: unknown, request: { url: string | undefined; method: string }) => void;
}

/* -------------------------------------------------------------------------- */
/*  Query (createRequest)                                                     */
/* -------------------------------------------------------------------------- */

interface RequestOptionsBase<T, TParams, TRaw> {
  /**
   * `false` (default): fires automatically and re-fires whenever a signal used in the source changes.
   * `true`: nothing happens until you call `run()`. Later signal changes do NOT re-fire.
   */
  lazy?: boolean;
  /** Value of `response()` while idle / loading / failed. Makes `response` non-nullable. */
  initialValue?: NoInfer<T>;
  /**
   * Headers for this request only. Merged over the global defaults from `provideSignalRequest`,
   * and wins over headers the source itself set.
   */
  headers?: HttpResourceRequest['headers'];
  /** Validate / map the raw body (e.g. `schema.parse` from Zod). */
  parse?: (raw: TRaw) => T;
  /**
   * When the source changes, keep showing the previous response until the new one arrives
   * (no flicker for pagination / filters). Default `false`.
   */
  keepPreviousValue?: boolean;
  /** Debounce (ms) for source changes. The very first request is never delayed. Browser only. */
  debounce?: number;
  /** Retry failed requests. Falls back to the global `retry` setting. */
  retry?: RetryConfig;
  /**
   * Abort the request after this many ms. A timeout shows up as
   * `requestError() === { kind: 'timeout', ms }`, not `{ kind: 'aborted' }`.
   *
   * Note that a timeout reaches `retry` as a `status: 0` failure, so it is retried by
   * default — `timeout: 5000` with `retry: 2` can therefore take up to ~15s. Exclude it
   * with `retry: { when: (e) => (e as HttpErrorResponse).status !== 0 }` if that is not
   * what you want.
   */
  timeout?: number;
  /**
   * Re-fetch every N ms after each settled request. Pass a function to make it reactive
   * (`() => visible() ? 5000 : false`). Browser only.
   */
  pollInterval?: number | (() => number | false | null | undefined);
  /** Keep polling while the tab is hidden. Default `false`. */
  pollWhenHidden?: boolean;
  onSuccess?: (response: T) => void;
  onError?: (error: Error) => void;
  /** Runs after `onSuccess` / `onError`. */
  onSettled?: () => void;
  /** Custom equality for the response value. */
  equal?: ValueEqualityFn<NoInfer<T>>;
  /** Required if `createRequest` is called outside an injection context. */
  injector?: Injector;
  debugName?: string;
}

/**
 * Initial value of the `params` signal the library creates for you.
 *
 * Writing `undefined` disables the request (`status() === 'idle'`).
 */
export interface ParamsOption<TParams> {
  params: TParams;
}

/**
 * Options for `createRequest`.
 *
 * `params` is **required as soon as you declare a `TParams` type argument** and must not appear
 * when you do not. That is how the library tells the two cases apart at runtime without
 * guessing:
 *
 * - `createRequest<User>('/me')` — no `TParams`, so the source is always evaluated.
 * - `createRequest<Item[], ListQuery>((p) => …, { params: { … } })` — `TParams` given, so the
 *   request is driven by the params signal and `params.set()` re-fires it.
 */
export type RequestOptions<T, TParams = void, TRaw = unknown> =
  RequestOptionsBase<T, TParams, TRaw> & ([TParams] extends [void] ? unknown : ParamsOption<TParams>);

/**
 * @typeParam T       the data type that `run()` resolves with
 * @typeParam R       the type of `response()` (`T` when `initialValue` is given, else `T | undefined`)
 * @typeParam TParams the type of the writable `params` signal
 */
export interface SignalRequest<T, R = T | undefined, TParams = void> {
  /**
   * Writable params signal, **created by the library** from `TParams` — you never build it
   * yourself. Read it in the source, write to it with `params.set()`.
   *
   * Setting it re-fires the request (unless `lazy: true`), because the source reads it inside
   * the reactive chain. `undefined` means "no request".
   */
  readonly params: WritableSignal<TParams | undefined>;
  /** Latest response. */
  readonly response: Signal<R>;
  /** Set only after all retries are exhausted. */
  readonly error: Signal<Error | undefined>;
  /**
   * The same failure, narrowed to a discriminated union so a template can `switch` on
   * `kind` instead of doing `instanceof` checks. `undefined` whenever `error()` is
   * `undefined` — including while a retry is in flight, where `error` is masked.
   *
   * ```ts
   * const e = this.list.requestError();
   * if (e?.kind === 'http') e.status;   // number
   * ```
   */
  readonly requestError: Signal<RequestError | undefined>;
  /**
   * `true` when the last settled attempt succeeded — the promise-style counterpart of
   * `error()`: no `try`/`catch` needed.
   *
   * `false` while idle, loading, reloading and retrying.
   */
  readonly success: Signal<boolean>;
  /** `true` while loading, reloading or waiting for the next retry. */
  readonly loading: Signal<boolean>;
  /** `true` only for the very first load / a load caused by changed params (not for reload/refresh/retry). */
  readonly initialLoading: Signal<boolean>;
  readonly status: Signal<RequestStatus>;
  /** 0 when not retrying, otherwise the current retry number (1-based). */
  readonly retryAttempt: Signal<number>;
  readonly headers: Signal<HttpHeaders | undefined>;
  readonly statusCode: Signal<number | undefined>;
  readonly progress: Signal<HttpProgressEvent | undefined>;

  /**
   * Fire the request now and resolve with the response.
   * - lazy: evaluates the source and starts a new request
   * - auto: reloads (or joins the request that is already in flight)
   * Rejects with the error (or `RequestCancelledError`). Fire-and-forget calls never cause
   * "unhandled rejection" noise; errors are still available through `error()`.
   */
  run(): Promise<T>;
  /** Like `run()` but never rejects. */
  tryRun(): Promise<RunResult<T>>;
  /** Re-fetch keeping the current value visible (status `reloading`). Returns `false` if not possible right now. */
  reload(): boolean;
  /** Abort the in-flight request (status -> `idle`). A source change or `run()` resumes normal behaviour. */
  cancel(): void;
  /** Overwrite the response locally (optimistic update). Status becomes `local`. */
  set(value: T): void;
  update(updater: (current: R) => T): void;
  /** Stop everything (timers, in-flight request). Happens automatically with the owning injector. */
  destroy(): void;
  /** The underlying `httpResource`, for interop (snapshots, chaining, devtools). */
  readonly resource: HttpResourceRef<T | undefined>;
}

export type RunResult<T> =
  | { ok: true; response: T; error?: undefined }
  | { ok: false; error: Error; response?: undefined };

/* -------------------------------------------------------------------------- */
/*  Mutation (createMutation)                                                 */
/* -------------------------------------------------------------------------- */

export type MutationStatus = 'idle' | 'loading' | 'success' | 'error';

/** Anything with `reload()` – i.e. every `SignalRequest`, `httpResource` or `resource`. */
export interface Reloadable {
  reload(): boolean;
}

export interface MutationOptions<T, TArgs = void> {
  /**
   * What happens when `run()` is called while another call is in flight.
   * - `parallel` (default): every call is sent
   * - `exhaust`: ignored, the in-flight promise is returned (double-click protection)
   * - `switch`: the previous call is aborted (its promise rejects with `RequestCancelledError`)
   */
  concurrency?: 'parallel' | 'exhaust' | 'switch';
  responseType?: 'json' | 'text' | 'blob' | 'arraybuffer';
  parse?: (raw: unknown) => T;
  /** Headers for this call. Merged over the global defaults from `provideSignalRequest`. */
  headers?: HttpResourceRequest['headers'];
  /** Retry policy. Off by default because writes are rarely idempotent. */
  retry?: RetryConfig;
  /** Abort the call after this many ms. Surfaced as `requestError() === { kind: 'timeout' }`. */
  timeout?: number;
  /** Requests to `reload()` after a successful call. A function avoids field-ordering problems. */
  invalidates?: ReadonlyArray<Reloadable> | (() => ReadonlyArray<Reloadable>);
  onSuccess?: (response: T, args: TArgs) => void;
  onError?: (error: Error, args: TArgs) => void;
  onSettled?: (args: TArgs) => void;
  injector?: Injector;
  // `reportProgress` is deliberately absent: it is set on the *builder*
  // (`(args) => ({ url, body, reportProgress: true })`), not here, because one mutation may be the
  // upload and another the delete. An option would read as if it applied to every call.
}

export interface SignalMutation<T, TArgs = void> {
  readonly response: Signal<T | undefined>;
  readonly error: Signal<Error | undefined>;
  /** The same failure as `error`, narrowed to a discriminated union. See `SignalRequest`. */
  readonly requestError: Signal<RequestError | undefined>;
  readonly loading: Signal<boolean>;
  readonly status: Signal<MutationStatus>;
  /** Arguments of the most recent call. */
  readonly args: Signal<TArgs | undefined>;
  /**
   * Latest progress event, when the call asked for it (`reportProgress: true` on the builder).
   * `undefined` before the first event and after the call settles.
   *
   * Needs `provideHttpClient(withXhr())`; see `SignalMutation.progress`.
   */
  readonly progress: Signal<HttpProgressEvent | undefined>;
  run(...args: undefined extends TArgs ? [args?: TArgs] : [args: TArgs]): Promise<T>;
  tryRun(...args: undefined extends TArgs ? [args?: TArgs] : [args: TArgs]): Promise<RunResult<T>>;
  /** Abort all in-flight calls. */
  cancel(): void;
  /** Back to `idle`, clears response / error. */
  reset(): void;
  /**
   * Abort everything and make the handle permanently unusable — `run()` afterwards rejects.
   *
   * Destroying the owning injector does the same thing on its own, so you rarely call this.
   * It exists for a mutation built with an explicit `{ injector }` outside an injection context,
   * where the handle is the only thing you hold.
   */
  destroy(): void;
}
