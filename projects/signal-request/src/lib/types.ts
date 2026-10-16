import type {
  HttpHeaders,
  HttpProgressEvent,
  HttpResourceRef,
  HttpResourceRequest,
} from '@angular/common/http';
import type { RequestErrorView } from './errors';
import type { QueryKey, QueryKeyFactory } from './cache/key';
import type { CacheEntry } from './cache/cache-entry';
import type { StructuralSharingFn } from './cache/structural-sharing';
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
   * Default `staleTime` for **cached** requests. Ignored by requests without a `key`.
   * Default `0` — always stale.
   */
  staleTime?: number;
  /**
   * Default `gcTime` for cached requests. Default 5 minutes.
   */
  gcTime?: number;
  /**
   * Default `refetchOnMount` for cached requests. Default `'stale'`.
   */
  refetchOnMount?: RefetchOnMount;
  /**
   * Default for `refetchOnWindowFocus`, for every request whether keyed or not.
   *
   * Global default `false`, matching the per-request default: a refetch nobody asked for is a
   * surprising thing for a library to do on its own.
   */
  refetchOnWindowFocus?: boolean;
  /**
   * Default for `refetchOnReconnect`, for every request. Global default `false`.
   */
  refetchOnReconnect?: boolean;
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
  /**
   * Re-fetch when the document becomes visible again — a tab switch, or returning from the
   * background. Default `false`. Browser only, and SSR no-ops like `pollInterval` / `debounce`.
   *
   * Listens to `visibilitychange` *and* `focus`, deduped within a tick: mobile browsers do not
   * fire `focus` on a tab switch, desktop ones fire both.
   *
   * A **disabled** request (a source returning `undefined`) is never refetched by this.
   */
  refetchOnWindowFocus?: boolean;
  /**
   * Re-fetch when the browser reports it is back online (`navigator.onLine` flipping to `true`).
   * Default `false`. Browser only.
   *
   * Note that the browser fires `online` when a network interface appears, not when a request is
   * actually routable, so the failure this is meant to recover from can still happen afterwards.
   */
  refetchOnReconnect?: boolean;
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
 *
 * > There is deliberately no `select` option here, even though TanStack Query has one. The
 * > mechanism is worth stating because it is a hard TypeScript limitation rather than a preference:
 * > **there is no partial type-argument inference**. Naming even one type argument makes every
 * > other type parameter fall back to its default instead of being inferred, so
 * > `createRequest<User>(url, { select: (u) => u.name })` can never infer the selection type —
 * > naming `User` has already switched inference off. A selector type parameter with **no** default
 * > is not a way out either: TypeScript then insists it be supplied
 * > (`Expected 3 type arguments, but got 1`). Both probes are recorded in `docs/design.md`.
 * >
 * > The equivalent is `handle.select(…)`, a **method**. `S` is the only type parameter in play at
 * > that call site, nothing was named ahead of it, and it infers perfectly. It also carries an
 * > `equal` for selections that rebuild an object on every response. See "Transforming the
 * > response" in the README.
 */
export type RequestOptions<T, TParams = void, TRaw = unknown> =
  RequestOptionsBase<T, TParams, TRaw> & ([TParams] extends [void] ? unknown : ParamsOption<TParams>);

/** What a cached request does when its **first** subscriber arrives. */
export type RefetchOnMount =
  /** Fetch when there is no data, or when `staleTime` has elapsed. The default. */
  | 'stale'
  /** Always fetch on the first subscribe — after joining an entry that is already fetching, it joins. */
  | 'always'
  /** Never fetch on subscribe. The data is used as it is; `run()` / `reload()` are the only ways to fetch. */
  | false;

/**
 * Options that turn a request into a **cached, shared** one.
 *
 * `key` is the whole opt-in. Without it the handle is built on `httpResource` exactly as in
 * v0.0.x, and every option here is inert — which is why they are additive rather than a second
 * entry point: `createRequest<User[]>('/users', { key: () => ['users'] })` is the same call with
 * one extra property.
 */
export interface CacheOptions<T> {
  /**
   * The cache identity. **Must be sufficient to determine the request**: two handles with the
   * same key share one request, so a key that omits a filter means two different queries collide.
   *
   * ```ts
   * key: () => ['users', { page: page(), q: term() }]   // good
   * key: () => ['users']                               // a page change will NOT refetch
   * ```
   *
   * Called inside a reactive context, so signals it reads re-point the handle at another entry.
   * Object segments compare by value, not identity.
   */
  readonly key: QueryKeyFactory;
  /**
   * How long a value counts as fresh, in ms. `0` — the default — means "always stale", so a
   * subscriber arriving later always refetches.
   *
   * Staleness is only consulted when a handle subscribes and when something invalidates; it is
   * never a timer.
   */
  readonly staleTime?: number;
  /**
   * How long an entry with **no subscribers** is kept before it is dropped, in ms.
   *
   * Default 5 minutes. This is what makes "come back to the list tab" a cache hit rather than a
   * refetch. `0` drops the entry the moment the last subscriber leaves.
   *
   * The gc timer is browser-only: on the server it would only hold stability.
   */
  readonly gcTime?: number;
  /**
   * What to do when this handle becomes the first subscriber of an entry.
   *
   * Default `'stale'`. `'always'` is for detail screens that must be re-checked on every visit;
   * `false` is for data something else owns.
   */
  readonly refetchOnMount?: RefetchOnMount;
  /**
   * Decide what to store for a new response, reusing the previous value where nothing changed.
   *
   * ```ts
   * structuralSharing: (previous, next) => ({ ...next, fetchedAt: previous?.fetchedAt })
   * ```
   *
   * The default walks arrays and plain objects and **keeps the previous reference for every part
   * that did not change**, so an unchanged row does not re-render. Returning `previous` outright
   * means the data signal is never written and no consumer is notified at all.
   *
   * Existing `equal` composes with this: it short-circuits the walk when the two are the same
   * value. Do not mutate cached data — the references you are given may be shared.
   */
  readonly structuralSharing?: StructuralSharingFn<T>;
}

/**
 * Everything `createRequest` accepts, plus the cache options.
 *
 * The `key` is what picks this overload: without it the request is uncached and returns
 * {@link SignalRequest}, with it the request is shared and returns {@link CachedRequest}. One
 * entry point, two behaviours, no second import.
 */
export type CachedRequestOptions<T, TParams = void, TRaw = unknown> =
  RequestOptions<T, TParams, TRaw> & CacheOptions<T>;

/** Options for {@link RequestBase.select}. */
export interface SelectOptions<S> {
  /**
   * Custom equality for the selected value.
   *
   * The default is Angular's `Object.is`, which is right for a primitive and wrong for an object
   * a selector rebuilds on every fetch (`select: (u) => ({ label: u.name })` would notify on every
   * response even when nothing on screen changed). Supply a shallow comparison there.
   */
  equal?: ValueEqualityFn<S>;
}

/**
 * @typeParam T       the data type that `run()` resolves with
 * @typeParam R       the type of `response()` (`T` when `initialValue` is given, else `T | undefined`)
 * @typeParam TParams the type of the writable `params` signal
 */
export interface SignalRequest<T, R = T | undefined, TParams = void> extends RequestBase<T, R, TParams> {
  /** The underlying `httpResource`, for interop (snapshots, chaining, devtools). */
  readonly resource: HttpResourceRef<T | undefined>;
}

/**
 * A handle backed by a shared cache entry.
 *
 * Identical to {@link SignalRequest} except in two ways, both forced by the cache:
 *
 * - **No `resource`.** There is no `httpResource` behind this handle — the request belongs to the
 *   cache entry, which is exactly why it can be shared. Reading `.resource` is a type error
 *   rather than a silent `undefined`, and `ctx.chain` does not apply to this path.
 * - **Freshness is visible.** `isStale` / `isFetching` / `dataUpdatedAt` only mean something
 *   against a shared entry, so they exist only here.
 */
export interface CachedRequest<T, R = T | undefined, TParams = void> extends RequestBase<T, R, TParams> {
  /**
   * Whether the entry owes a fetch by its own clock: no data yet, invalidated, or `staleTime`
   * elapsed since the last value.
   *
   * A plain function, not a signal — freshness depends on the wall clock, and a `computed`
   * would need a timer to be woken by time passing. Reading it in a template re-evaluates on
   * every change detection, which is what a staleness badge wants.
   */
  isStale(): boolean;
  /** Whether the entry is on the network right now. A cache hit is not `loading`. */
  readonly isFetching: Signal<boolean>;
  /** Epoch ms of the last successful fetch, or `0` if there has never been one. */
  readonly dataUpdatedAt: Signal<number>;
  /** How many times this entry has hit the network. Useful for proving a dedup in a test. */
  readonly fetchCount: Signal<number>;
}

/**
 * Everything a request handle has, regardless of whether it is cached.
 *
 * Split out so `SignalRequest` and `CachedRequest` differ in exactly one place: what backs them.
 */
export interface RequestBase<T, R = T | undefined, TParams = void> {
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
  /**
   * A memoized projection of the response — the `select` TanStack Query has as an option, as a
   * method instead.
   *
   * ```ts
   * readonly names = this.users.select((users) => users.map((u) => u.name));
   * // Signal<string[] | undefined>
   * ```
   *
   * ## Why a method and not an option
   *
   * A short answer would be "an option breaks type inference", which is true but does not explain
   * anything. The mechanism is worth stating, because it is a hard TypeScript limitation rather
   * than a defect in this library: **there is no partial type-argument inference.** Naming even one
   * type argument makes every other type parameter fall back to its default instead of being
   * inferred. So `createRequest<User>(url, { select: (u) => u.name })` can never infer the
   * selection type — naming `User` has already switched inference off — and a selector type
   * parameter with no default is not a way out either: TypeScript then demands it be supplied
   * (`Expected 3 type arguments, but got 1`). Both probes are recorded in `docs/design.md`.
   *
   * A method has neither problem. `S` is the only type parameter in play at the call site, nothing
   * was named ahead of it, and it infers perfectly.
   *
   * ## What it adds over writing a `computed`
   *
   * A bare `computed(() => this.users.response()?.map((u) => u.name))` already memoizes and already
   * stops propagation when the result is `Object.is`-equal. What it cannot do is use a *different*
   * equality, which is exactly what a selector returning a rebuilt object needs. It also gives the
   * pattern one documented home instead of a paragraph in the README.
   *
   * The selector is only called when there is data — `undefined` in, `undefined` out — so it never
   * has to guard against an empty response.
   */
  select<S>(selector: (data: T) => S, options?: SelectOptions<S>): Signal<S | undefined>;
  /** Set only after all retries are exhausted. */
  readonly error: Signal<Error | undefined>;
  /**
   * The same failure, narrowed to a discriminated union so you can `switch` on `kind` instead of
   * doing `instanceof` checks — plus one predicate per kind and a `message` for templates.
   * `undefined` whenever `error()` is `undefined`, including while a retry is in flight.
   *
   * ```ts
   * const e = this.list.requestError();
   * if (e?.kind === 'http') e.status;   // number, compiler-checked
   * ```
   *
   * In a template the predicates save the `@switch`:
   *
   * ```html
   * @if (error.http(); as http) { error: {{ http.status }} }
   * @else if (error.network()) { no connection }
   * @else { {{ error.message }} }
   * ```
   */
  readonly requestError: Signal<RequestErrorView | undefined>;
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
}

export type RunResult<T> =
  | { ok: true; response: T; error?: undefined }
  | { ok: false; error: Error; response?: undefined };

/* -------------------------------------------------------------------------- */
/*  Infinite query (createInfiniteRequest)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Options for {@link createInfiniteRequest}.
 *
 * Every page is an ordinary cache entry keyed `base key + page param`, so a paginated list
 * participates in `client.invalidate(['items'])`, `staleTime`, `gcTime` and sharing with a
 * `createRequest` on the same key — without knowing any of that exists.
 */
export interface InfiniteRequestOptions<TPage, TParam> {
  /**
   * The **base** key. The page param is appended to it, so `['items', { page: 3 }]` is the entry
   * for page 3 and `client.invalidate(['items'])` — prefix-matched — reaches every page.
   *
   * Called reactively, exactly like `createRequest`'s `key`. A filter change resets the
   * accumulation; the page entries themselves stay in the cache, which is usually what you want
   * when someone switches a filter back and forth.
   */
  key: () => QueryKey;
  /** The param for page 1. Reused whenever the accumulation restarts. */
  initialPageParam: TParam;
  /**
   * The param for the page after `lastParam`, or `undefined` when there is no next page.
   *
   * Receives the page data as it is cached, which is how a cursor-based API works:
   * `getNextPageParam: (last) => last.cursor`, and `undefined` when the server says it is done.
   */
  getNextPageParam: (lastPage: TPage | undefined, pages: readonly TPage[], lastParam: TParam) => TParam | undefined;
  /**
   * The mirror of `getNextPageParam` for `fetchPreviousPage()`.
   *
   * Optional: most infinite scroll is one-directional, and leaving this out keeps `hasPreviousPage()`
   * permanently `false` rather than pretending a feature exists.
   */
  getPreviousPageParam?: (firstPage: TPage | undefined, pages: readonly TPage[], firstParam: TParam) => TParam | undefined;
  /**
   * Keep at most this many pages in memory, dropping the oldest.
   *
   * The default is unbounded, which is right for cursor pagination and wrong for offset
   * pagination over a large list. Dropping a page releases its cache entry's subscription, so it
   * can be collected on `gcTime` — it is not deleted.
   */
  maxPages?: number;
  /** See `createRequest`. */
  staleTime?: number;
  /** See `createRequest`. */
  gcTime?: number;
  /** Parse each page body. See `createRequest`. */
  parse?: (raw: unknown) => TPage;
  /** Retry each page. Off by default, like every other write. */
  retry?: RetryConfig;
  /** Headers for every page. */
  headers?: HttpResourceRequest['headers'];
  /** Abort a page after this many ms. */
  timeout?: number;
  /** Refetch when the tab becomes visible again. */
  refetchOnWindowFocus?: boolean;
  /** Refetch when the browser reports it is back online. */
  refetchOnReconnect?: boolean;
  /** See `createRequest`'s `equal` — composes with the default structural sharing. */
  equal?: ValueEqualityFn<NoInfer<TPage>>;
  /** See `createRequest`'s `structuralSharing`. */
  structuralSharing?: StructuralSharingFn<TPage>;
  /** Required if called outside an injection context. */
  injector?: Injector;
  /** Debounce for key changes, in ms. Browser only. */
  debounce?: number;
  debugName?: string;
  onSuccess?: (pages: readonly TPage[]) => void;
  onError?: (error: Error) => void;
}

/**
 * What `response()` yields for a given page type.
 *
 * A page that **is** an array flattens into its items; an envelope like `{ items, cursor }` cannot,
 * because the library does not know which of its fields is the list. So the type follows rather
 * than the runtime lying: array pages give their items, envelope pages give the pages.
 */
export type FlattenedPages<TPage> = TPage extends readonly (infer TItem)[]
  ? readonly TItem[]
  : readonly TPage[];

/**
 * A paginated handle.
 *
 * Deliberately not `RequestBase`: `response()` means something different here — the pages
 * themselves rather than whatever the last request returned — and pretending otherwise would be
 * the kind of shape-fitting that makes an API hard to learn.
 */
export interface InfiniteRequest<TPage, TParam> {
  /** Every loaded page, in order, skipping pages that have not resolved yet. */
  readonly pages: Signal<readonly TPage[]>;
  /**
   * What a list template renders.
   *
   * A page that **is** an array flattens into its items; an envelope like `{ items, cursor }` does
   * not, because the library cannot know which of its fields is the list — in that case this is
   * the same as `pages()`.
   */
  readonly response: Signal<FlattenedPages<TPage>>;
  /** The params of the loaded pages, in order. */
  readonly pageParams: Signal<readonly TParam[]>;
  /** The page currently being fetched, if any. */
  readonly loading: Signal<boolean>;
  readonly status: Signal<RequestStatus>;
  readonly error: Signal<Error | undefined>;
  readonly requestError: Signal<RequestErrorView | undefined>;
  /** Whether any page is on the network. */
  readonly isFetching: Signal<boolean>;
  /** Whether the page being appended right now is still loading. */
  readonly isFetchingNextPage: Signal<boolean>;
  /** Whether a page is being prepended. Always `false` without `getPreviousPageParam`. */
  readonly isFetchingPreviousPage: Signal<boolean>;
  /** `undefined` before the first page arrives. */
  readonly dataUpdatedAt: Signal<number>;
  /**
   * A memoized projection of the flattened pages. See `RequestBase.select` for why this is a
   * method rather than an option.
   *
   * Unlike the other handles' `select`, the result is never `undefined`: an empty accumulation is
   * an empty array, not an absent one, so a selector over it always has something to work with.
   */
  select<S>(selector: (data: FlattenedPages<TPage>) => S, options?: SelectOptions<S>): Signal<S>;
  /** Whether `getNextPageParam` says there is a page after the last one. */
  hasNextPage(): boolean;
  /** Whether `getPreviousPageParam` says there is a page before the first one. */
  hasPreviousPage(): boolean;
  /** Loads and appends the next page. Resolves when it has settled. */
  fetchNextPage(): Promise<void>;
  /** Loads and prepends the previous page. Resolves when it has settled. */
  fetchPreviousPage(): Promise<void>;
  /** Re-fetches every loaded page, in order. Returns `false` when there is nothing loaded. */
  reload(): boolean;
  /** Aborts every page fetch in flight. */
  cancel(): void;
  /** Drops every loaded page from the accumulation. The cache entries stay. */
  remove(): void;
  /** Stops everything. Happens automatically with the owning injector. */
  destroy(): void;
  /** The cache entry for one page. Mostly for devtools and tests. */
  readonly entryFor: (param: TParam) => CacheEntry<TPage> | undefined;
}

/* -------------------------------------------------------------------------- */
/*  Aggregation (combine / createRequests)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum a handle has to offer to be aggregated by {@link combine}.
 *
 * Structural rather than a union of the handle types, so `SignalRequest` and `CachedRequest` both
 * qualify without `combine` knowing which is which — and so a stub in a test qualifies too.
 */
export interface Combinable<T> {
  readonly response: Signal<T | undefined>;
  readonly error: Signal<Error | undefined>;
  readonly loading: Signal<boolean>;
  reload(): boolean;
  cancel(): void;
  destroy(): void;
}

/** The per-source response type of a record passed to {@link combine}. */
export type ResponsesOf<TSources> = {
  readonly [K in keyof TSources]: TSources[K] extends Combinable<infer T> ? T | undefined : never;
};

/**
 * What `combine` returns.
 *
 * Deliberately no `destroy()`: `combine` does not own the handles it is given — their injectors
 * do. {@link RequestSet}, which *does* own the handles it builds, has one.
 */
export interface Combined<T> {
  /** Every source's response, in the shape they were combined in. */
  readonly response: Signal<T>;
  /** `true` while **any** source is loading. */
  readonly loading: Signal<boolean>;
  /**
   * `'error'` if any source failed, `'loading'` / `'reloading'` while any is in flight,
   * `'resolved'` once at least one has data, `'idle'` before any has.
   *
   * An aggregate has to answer "is this screen ready?", which is not the same question as
   * "what is the slowest source doing".
   */
  readonly status: Signal<RequestStatus>;
  /** The **first** failure in source order. Five queries on one screen should not mean five toasts. */
  readonly error: Signal<Error | undefined>;
  /** Reloads every source. `true` if any of them accepted. */
  reload(): boolean;
  /** Aborts every source. */
  cancel(): void;
}

/**
 * The dynamic set {@link createRequests} returns: one handle per item, kept in step with the list.
 */
export interface RequestSet<T> extends Combined<readonly (T | undefined)[]> {
  /**
   * The per-item handles, in item order.
   *
   * A handle is built once per item identity and reused across list changes, so reordering a list
   * does not re-subscribe every entry. Identity is `Object.is` on the item by default; pass
   * `key` to `createRequests` when the items are objects whose identity is not stable.
   */
  readonly handles: Signal<readonly Combinable<T>[]>;
  /** Destroys every live handle. Happens automatically with the owning injector. */
  destroy(): void;
}

/* -------------------------------------------------------------------------- */
/*  Mutation (createMutation)                                                 */
/* -------------------------------------------------------------------------- */

export type MutationStatus = 'idle' | 'loading' | 'success' | 'error';

/** Anything with `reload()` – i.e. every `SignalRequest`, `httpResource` or `resource`. */
export interface Reloadable {
  reload(): boolean;
}

/**
 * What `createMutation`'s `invalidates` accepts.
 *
 * A **handle** reloads that one request. A **key** invalidates every cached entry under it,
 * which is what you want when the same data is on screen in several places at once and you do
 * not want to hold a reference to each of those handles.
 *
 * ```ts
 * invalidates: () => [this.detail, ['users'], ['posts', id]]
 * ```
 *
 * They are told apart at runtime by shape: an array is a key, an object with `reload()` is a
 * handle. A query key is always an array, so there is no ambiguity.
 */
export type InvalidationTarget = Reloadable | QueryKey;

/**
 * Somewhere an optimistic value can be written: the mutation's own `response`, or the
 * displayed value of a `createRequest`.
 *
 * Structural on purpose — a `SignalRequest<T>` satisfies it without importing anything.
 */
export interface OptimisticTarget<T> {
  readonly response: Signal<T | undefined>;
  set(value: T): void;
}

export interface MutationOptions<T, TArgs = void, TContext = undefined> {
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
  /**
   * Groups this mutation so it can be found without holding a reference to it.
   *
   * Read by `QueryClient.isMutating(mutationKey)`, which is how a global "saving…" indicator
   * knows something is in flight *somewhere* — a toolbar, an interceptor, a navigation guard.
   *
   * ```ts
   * const save = createMutation(..., { mutationKey: ['todos'] });
   * client.isMutating(['todos']);   // true while any todo mutation is running
   * ```
   *
   * Prefix-matched like a query key, so `['todos']` also covers `['todos', 1]`.
   */
  mutationKey?: QueryKey;
  /**
   * Runs **before** the request is sent and before the optimistic value is written.
   *
   * Whatever it returns is threaded into `onError`, `onSuccess` and `onSettled`, and is readable
   * as `mutation.context()`. Use it for anything the settle hooks need that is not derivable from
   * the args — a snapshot taken at call time rather than at settle time, an id minted before the
   * round-trip.
   *
   * ```ts
   * onMutate: (draft) => ({ previous: list().response() }),
   * onError:  (error, _args, ctx) => list().set(ctx?.previous ?? []),
   * ```
   *
   * Awaited when it returns a promise, so an async preparation delays the request rather than
   * racing it. A rejection here fails the whole call — **nothing is sent**, and the optimistic
   * value is never written.
   */
  onMutate?: (args: TArgs) => TContext | Promise<TContext>;
  /**
   * Requests to `reload()` after a successful call. A function avoids field-ordering problems.
   *
   * Handles are reloaded directly; keys are invalidated, which also refreshes every **other**
   * cached handle under that key and not just this one.
   */
  invalidates?: ReadonlyArray<InvalidationTarget> | (() => ReadonlyArray<InvalidationTarget>);
  /**
   * Value to show **immediately**, before the server answers.
   *
   * ```ts
   * const add = createMutation<Todo[], Todo>(
   *   (draft) => ({ url: '/todos', body: draft }),
   *   {
   *     optimistic: (todos, draft) => [...(todos ?? []), draft],
   *     target: list,            // where the value goes; defaults to this mutation
   *     invalidates: () => [list],
   *   },
   * );
   * ```
   *
   * The previous value is snapshotted and restored automatically when the call **fails** or is
   * cancelled — you never write the undo yourself. On success the server's value replaces it, and
   * `invalidates` pulls the real list as usual.
   *
   * With `concurrency: 'parallel'` the restore is a compare-and-swap: it only happens while this
   * call's own value is still the one on screen, so a sibling call that succeeded in the meantime
   * is never overwritten with a stale snapshot.
   *
   * `target` is optional, and only meaningful together with `optimistic`.
   */
  optimistic?: (current: T | undefined, args: TArgs) => T;
  /**
   * Where `optimistic` writes. Defaults to the mutation's own `response()`.
   *
   * Pass a `createRequest` to make the whole list show the new item immediately and snap back on
   * failure — the common case. The request is left at `local` status; its own loaders take over
   * again on the next source change.
   *
   * Pass a **key** instead, to write into whatever cached entry lives there without holding a
   * reference to it:
   *
   * ```ts
   * { optimistic: (todos, draft) => [...(todos ?? []), draft], target: ['todos'] }
   * ```
   *
   * The entry has to already exist — a handle for that key has to be on screen somewhere. There
   * is no request description to build one from, and creating an orphan would leave an entry that
   * can never fetch and never be collected by anything reading it.
   */
  target?: OptimisticTarget<T> | QueryKey;
  /**
   * Called once for a settled call that succeeded.
   *
   * The signature is `(response, args, context)`; the first two arguments are unchanged from
   * earlier versions, so existing callbacks keep working unchanged.
   */
  onSuccess?: (response: T, args: TArgs, context: TContext | undefined) => void;
  /** Called once for a settled call that failed. Receives whatever `onMutate` returned. */
  onError?: (error: Error, args: TArgs, context: TContext | undefined) => void;
  /** Runs after `onSuccess` / `onError`. Also receives the `onMutate` context. */
  onSettled?: (args: TArgs, context: TContext | undefined) => void;
  injector?: Injector;
  // `reportProgress` is deliberately absent: it is set on the *builder*
  // (`(args) => ({ url, body, reportProgress: true })`), not here, because one mutation may be the
  // upload and another the delete. An option would read as if it applied to every call.
}

export interface SignalMutation<T, TArgs = void, TContext = undefined> {
  readonly response: Signal<T | undefined>;
  readonly error: Signal<Error | undefined>;
  /** The same failure as `error`, narrowed to a discriminated union. See `SignalRequest`. */
  readonly requestError: Signal<RequestErrorView | undefined>;
  readonly loading: Signal<boolean>;
  readonly status: Signal<MutationStatus>;
  /** Arguments of the most recent call. */
  readonly args: Signal<TArgs | undefined>;
  /**
   * Whatever the most recent `onMutate` returned, or `undefined` before the first call.
   *
   * Also handed to `onError` / `onSettled`, but readable here because a template often needs it
   * too — showing the error next to the row it belongs to, for instance.
   */
  readonly context: Signal<TContext | undefined>;
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
