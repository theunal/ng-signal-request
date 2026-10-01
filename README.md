# ng-signal-request

[![npm version](https://img.shields.io/npm/v/ng-signal-request.svg)](https://www.npmjs.com/package/ng-signal-request)
[![npm downloads](https://img.shields.io/npm/dm/ng-signal-request.svg)](https://www.npmjs.com/package/ng-signal-request)
[![CI](https://github.com/theunal/ng-signal-request/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/theunal/ng-signal-request/actions/workflows/npm-publish.yml)
[![license](https://img.shields.io/npm/l/ng-signal-request.svg)](./LICENSE)

A **signal-based HTTP layer** for Angular (v22+). `httpResource` from the
Resource API does the work; on top of it this package adds Promise-based
triggering with `run()`, method variants (`createRequest.post`,
`createMutation.put`, …), retry, debounce, polling, `keepPreviousValue`,
`baseUrl` / `:path` parameters, reactive global headers, normalized errors, a
separate `createMutation` for writes, and a `/testing` entry point.

```ts
import {
  createRequest,
  createMutation,
  provideSignalRequest,
  toRequestError,
} from 'ng-signal-request';
```

## Installation

```bash
npm install ng-signal-request
# or
pnpm add ng-signal-request
```

Peer dependencies: `@angular/core` and `@angular/common` `>=22.0.0 <23.0.0`.
Angular 22 is the floor because `httpResource` ships in `@angular/common/http`
as of 22.0.

The only required setup is `provideHttpClient()`. Interceptors keep working,
because everything goes through `HttpClient`.

```ts
// app.config.ts
import { ApplicationConfig, inject } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideSignalRequest } from 'ng-signal-request';

export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([authInterceptor])),
    provideSignalRequest(() => {
      // The factory runs in an injection context, so inject() works here.
      // The callbacks below run outside one, so capture what they need now.
      const auth = inject(AuthStore);
      const toast = inject(ToastService);
      return {
        baseUrl: 'https://api.example.com', // prepended to every relative url
        retry: 2,                           // default for queries (NOT mutations)
        headers: () => ({                   // reactive — see "Auth" below
          Authorization: `Bearer ${auth.token()}`,
        }),
        onError: (error, { url, method }) => toast.error(`${method} ${url}: ${error.message}`),
      };
    }),
  ],
};
```

`provideSignalRequest` takes either a plain config object or a **factory**
returning one. Use the factory whenever the config needs a service: calling
`inject()` inside `headers` / `onError` / `onSuccess` would throw `NG0203`,
because those callbacks run outside an injection context.

| `provideSignalRequest` option | Description |
| --- | --- |
| `baseUrl` | Prepended to every relative url. Absolute urls are left alone |
| `retry` | Default retry policy **for queries only**. Mutations never retry by default |
| `headers` | `Record<string, string>`, or a function for reactive headers. Merged *under* per-request headers |
| `onError` | Called once per request **or mutation** that ends in a final error, after retries. Good for toasts / logging |
| `onSuccess` | The mirror image: called once per successful request or mutation. For logging / analytics — a toast belongs in the per-call `onSuccess`, where you know what happened |

## Quick start

Requests can be built in a service and instantiated in a component. Passing a
**function** (not a value) for the filters keeps the request reactive, and
creating it in the component's injection context ties its lifetime to the
component — destroy the component and the in-flight request is aborted.

```ts
@Injectable({ providedIn: 'root' })
export class AuthService {
  getList = (params: () => { page: number; q?: string }) =>
    createRequest<Item[]>(() => ({ url: '/items', params: params() }), {
      initialValue: [],        // response() is never undefined
      keepPreviousValue: true, // keep the old list visible while the new one loads
      retry: 2,
    });
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (list.loading()) { loading... }
    @else if (list.requestError(); as error) {
      @switch (error.kind) {
        @case ('http') { error: {{ error.status }} }
        @case ('network') { no connection }
        @case ('timeout') { timed out }
        @default { error: {{ error.message }} }
      }
    }
    @else { {{ list.response().length }} records }
    <button (click)="refresh()">Refresh</button>
  `,
})
export class ListComponent {
  private readonly auth = inject(AuthService);
  readonly params = signal({ page: 1 });

  readonly list = this.auth.getList(() => this.params());

  async refresh() {
    const items = await this.list.run(); // awaitable; rejects on failure
  }
}
```

Setting `params.set({ page: 2 })` re-fires the request on its own and cancels
the previous one.

## `createRequest(source, options?)` — and `.get` / `.post` / `.put` / `.patch` / `.delete`

### The source

| Value | Meaning |
| --- | --- |
| `'/url'` or `{ url, ... }` | static request |
| `() => ...` | **reactive**; re-fires whenever a signal read inside changes |
| a function returning `undefined` / `null` / `false` | request **disabled** (`status() === 'idle'`) |

The request object is the same as Angular's `HttpResourceRequest` (`body`,
`headers`, `context`, `timeout`, `transferCache`, `reportProgress`, …) — minus
`method` — plus:

- **`params`** — tolerates `null` / `undefined` (dropped), `Date` (→ ISO-8601)
  and arrays of those.
- **`path`** — `url: '/users/:id/posts', path: { id: id() }`. If a referenced
  placeholder resolves to `null` / `undefined`, the request is *disabled* — and
  so is a url whose placeholders are still unfilled.

The HTTP verb is **not** part of the request object. It comes from the function
you call:

| Call | Sends |
| --- | --- |
| `createRequest(src, …)` | `GET` |
| `createRequest.get(src, …)` | `GET` |
| `createRequest.post(src, …)` | `POST` |
| `createRequest.put(src, …)` | `PUT` |
| `createRequest.patch(src, …)` | `PATCH` |
| `createRequest.delete(src, …)` | `DELETE` |

Each of those also takes a response type — `.text`, `.blob`, `.arrayBuffer` —
so `createRequest.patch.text(...)` is the full cross product, all of it typed.
Writing `method` in the request object is a **compile error**, and in a `params`
bag it is just an ordinary query value (`?method=PUT`).

> **Non-`GET` variants are still reactive.** `createRequest.post` fires
> immediately and re-fires on every signal its source reads — that is the whole
> point of the primitive, but it is the wrong tool for a button-driven write.
> Use [`createMutation`](#createmutationrequest-options), or `lazy: true`.

### Options

| Option | Description |
| --- | --- |
| `lazy` | `true` → nothing is sent until you call `run()`; later signal changes do **not** re-fire |
| `params` | Initial value of the library-created `params` signal. **Required** when you declare a `TParams` type argument. Its `body` / `path` / `headers` keys fill the request; the rest becomes the query string |
| `initialValue` | Value of `response()` while idle / loading / failed. Makes the type non-nullable |
| `parse` | Validate or map the raw body (`schema.parse` and friends) |
| `headers` | Headers for this request only. Merged over the global defaults, and wins over headers the source itself set |
| `keepPreviousValue` | On a source change, keep showing the previous response until the new one arrives (default `false`) |
| `debounce` | ms; delays source changes. **The very first request is never delayed.** Browser only |
| `retry` | `3` \| `{ count, delay, when }`. Default: network errors, 408/425/429 and every 5xx; exponential back-off 1s, 2s, 4s… capped at 30s |
| `timeout` | Abort after N ms. Surfaces as `{ kind: 'timeout', ms }`. Overrides a `timeout` the source sets; a source-level `timeout` alone is classified the same way. See the caveat below |
| `pollInterval` | ms, or `() => number \| false` (reactive on/off). Browser only |
| `pollWhenHidden` | Keep polling while the tab is hidden (default `false`) |
| `onSuccess` / `onError` / `onSettled` | Lifecycle hooks (`onError` fires once, after retries are exhausted) |
| `equal`, `injector`, `debugName` | Same as `httpResource` |

### Params

Pass a **second type argument** and the library creates a writable `params`
signal for you — you never build one yourself. You also stop writing the
plumbing: three keys are recognised automatically.

| `params` key | goes to |
| --- | --- |
| everything else (`param1`, `q`, `size`, …) | the query string |
| `body` | the request body |
| `path` | fills `:placeholders` in the url |
| `headers` | the request headers |

```ts
interface ListQuery {
  param1: string;
  param2: number;
  q?: string;
  body?: Record<string, unknown> | null;
  path?: { id: number };
}

// GET /items/5?param1=1&param2=10
readonly list = createRequest<Item[], ListQuery>(
  { url: '/items/:id' },
  { params: { path: { id: 5 }, param1: '1', param2: 10 } },
);

// PATCH /items/5   body: {"name":"Ada"}   (nothing leaked into the query)
readonly rename = createRequest.patch<Item[], ListQuery>(
  { url: '/items/:id' },
  { params: { path: { id: 5 }, body: { name: 'Ada' } } },
);
```

The reserved keys are stripped, so `body` and `path` can never leak into the
query string. Where both the source and `params` fill the same slot, **`params`
wins** — except that `body: null` explicitly *clears* a body the source set,
while `body: undefined` leaves it alone. `HttpHeaders` instances and
`[name, value]` pairs are accepted for `headers` and flattened, never dropped.
A header with repeated values (`new HttpHeaders({ 'X-Tag': ['a', 'b'] })`) is
merged as `X-Tag: a, b` — the same string `HttpHeaders.get()` would return.

Writing `params` re-fires the request, because it is read inside the reactive
chain:

```ts
this.list.params.set({ path: { id: 6 }, param1: '2', param2: 20 });
```

Then `success()` gives you the outcome without `try` / `catch`:

```ts
if (this.list.success()) {
  console.log(this.list.response());
} else {
  console.log(this.list.error());
}
```

Declaring `TParams` makes the `params` option **required**, and it is rejected
when no `TParams` is given. That is how the library tells the two cases apart
without guessing: with a params type the request is driven by the signal
(writing `undefined` disables it), without one the source is always evaluated
and the signal is simply ignored — so plain `() => \`/jobs/${id()}\`` sources
keep working untouched.

A url that still contains an unfilled `:placeholder` after the merge also
disables the request, so `/items/:id` is never sent by accident.

The source's **second** argument is Angular's params context, so `ctx.chain()`
is still available:

```ts
createRequest<Post[], { userId: string }>(
  (params, ctx) => ({ url: `/users/${ctx.chain(this.user.resource)!.id}/posts` }),
  { params: { userId: '' } },
);
```

`createMutation` treats its **args** the same way, so the builder can stay a
bare url:

```ts
readonly save = createMutation<User, { path: { id: number }; body: Partial<User> }>(
  () => '/users/:id',
  { concurrency: 'exhaust' },
);

await this.save.run({ path: { id: 1 }, body: { name: 'Ada' } });
// → POST /users/1   body: {"name":"Ada"}
```

### The returned object

| Member | |
| --- | --- |
| `params()` / `params.set()` | the writable params signal (see above) |
| `response()` | latest response (never `undefined` when `initialValue` is given) |
| `success()` | `true` once the last settled attempt succeeded; `false` while idle, loading or retrying |
| `loading()` | loading / reloading / waiting for the next retry |
| `initialLoading()` | only the first load, or one caused by changed params — not reload/refresh/retry |
| `error()` | raw `Error`, set **after retries are exhausted**; stays `undefined` while retrying |
| `requestError()` | the same failure, narrowed to a discriminated union (see "Errors") |
| `status()` | `idle` \| `loading` \| `reloading` \| `resolved` \| `error` \| `local` |
| `retryAttempt()` | `0`, or the current retry number. **Keeps its last value after giving up** |
| `headers()`, `statusCode()`, `progress()` | straight from `httpResource` |
| `run()` | Fire now and resolve with the response. Lazy: new request. Auto: reload, or join the request already in flight |
| `tryRun()` | Like `run()` but never rejects: `{ ok: true, response }` \| `{ ok: false, error }` |
| `reload()` | Re-fetch keeping the current value visible (`reloading`) |
| `cancel()` | Really abort the in-flight request (`idle`). Normal behaviour resumes on a source change or `run()` |
| `set()` / `update()` | Local (optimistic) update, `status() === 'local'` |
| `destroy()` | Stop everything (timers, in-flight request) |
| `resource` | the underlying `httpResource`, for interop (snapshots, `ctx.chain`, devtools) |

Notes on `run()`:

- Concurrent `run()` calls all settle with the **last** request's result
  (`switchMap` semantics).
- Calling `run()` without awaiting it never produces an "unhandled rejection";
  the error is still available through `error()` and `onError`.
- Cancellation, being disabled, and destruction reject with
  `RequestCancelledError`.

## Errors

`error()` is Angular's own `Error | undefined`. That cannot tell a `404` from a
`TypeError: Failed to fetch` without `instanceof` checks at every call site —
and `HttpErrorResponse` is not even `instanceof Error`, so it becomes casts.
`requestError()` sits next to it and narrows the same failure:

```ts
type RequestError =
  | { kind: 'aborted' }
  | { kind: 'timeout'; ms: number }
  | { kind: 'http'; status: number; statusText: string; url: string | null; body: unknown }
  | { kind: 'network'; cause: unknown }
  | { kind: 'unknown'; cause: unknown };
```

`kind` is a literal, so narrowing is checked by the compiler:

```ts
const error = this.list.requestError();

if (error?.kind === 'http') {
  error.status; // number
  error.body; // unknown
}
```

`requestError()` is `undefined` whenever `error()` is — including while a retry
is in flight, where `error` is deliberately masked. `createMutation` has the
same signal.

### `status: 0` is ambiguous

`HttpClient` reports "no response" as `status: 0`, which covers both a network
failure and a cancellation. An abort is only recognized as `aborted` when the
reason names itself `AbortError` / `TimeoutError`; an opaque `status: 0` becomes
`network`. That is also why a timeout has to be *configured* to be reported as
`timeout` rather than `aborted` — Angular's fetch backend aborts with a
`TimeoutError` DOMException, and the configured duration is what fills in `ms`.
Both places count: the `timeout` option, and a `timeout` set on the request
object itself (the `createRequest` source or the `createMutation` builder). When
both are present, the option wins.

Note that `httpResource` cancels by unsubscribing rather than by failing, so
`{ kind: 'aborted' }` mostly comes from your own `cancel()` and from mutations.

### Normalizing your own errors

`toRequestError` is exported, so a hand-written loader gets the same shape:

```ts
import { toRequestError } from 'ng-signal-request';

try {
  await doSomething();
} catch (cause) {
  throw toRequestError(cause, { timeout: 5_000 });
}
```

### The timeout + retry caveat

A timeout reaches the retry policy as a `status: 0` failure, so **it is retried
by default**: `timeout: 5_000` with `retry: 2` can take up to ~15s and show
three loading cycles. Exclude it if that is not what you want:

```ts
retry: { count: 2, when: (e) => (e as HttpErrorResponse).status !== 0 }
```

## `createMutation(builder, options?)` — and `.post` / `.put` / `.patch` / `.delete`

`httpResource` is for reads: it is eager and cancels the previous request,
which is not what a write needs. Mutations therefore talk to `HttpClient`
directly, through their own primitive. They never fire on their own.

```ts
readonly save = createMutation.put<User, Partial<User>>(
  (user) => ({ url: '/users/:id', path: { id: user.id }, body: user }),
  {
    concurrency: 'exhaust',          // double-click protection
    invalidates: () => [this.users], // re-run these queries after success
    onSuccess: (user) => this.toast.show(`${user.name} saved`),
  },
);

await this.save.run({ id: 1, name: 'Ada' }); // save.loading(), save.error(), save.response()
```

As with `createRequest`, the verb comes from the function you call:

| Call | Sends |
| --- | --- |
| `createMutation(builder, …)` | `POST` |
| `createMutation.post(builder, …)` | `POST` |
| `createMutation.put(builder, …)` | `PUT` |
| `createMutation.patch(builder, …)` | `PATCH` |
| `createMutation.delete(builder, …)` | `DELETE` |

There is no `get` variant — a write is not a read. The `run` args double as the
params bag, so `body` / `path` / `headers` are routed for you and everything else
becomes the query string, exactly as in `createRequest`.

| Option | Description |
| --- | --- |
| `concurrency` | `parallel` (default) · `exhaust` (returns the in-flight promise) · `switch` (cancels the previous call, rejecting it with `RequestCancelledError`) |
| `responseType` | `json` \| `text` \| `blob` \| `arraybuffer` |
| `parse` | Validate or map the response body |
| `headers` | Headers for this call, merged over the global defaults |
| `retry` | **Off by default**, because writes are rarely idempotent. The global `retry` is *not* inherited |
| `timeout` | Abort the call after N ms. Wins over a `timeout` returned by the builder; without it, the builder's value is used as is |
| `invalidates` | `Reloadable[]`, or a function returning one. Use the function form to avoid field-ordering problems |
| `onSuccess` / `onError` / `onSettled` | Lifecycle hooks |
| `injector` | Required if called outside an injection context |

The returned handle exposes `response`, `error`, `requestError`, `loading`,
`status`, `args`, `progress`, `run`, `tryRun`, `cancel`, `reset` and `destroy`.

`run()` never throws synchronously. If the builder itself throws (say, a
missing field), the returned promise rejects with that error and nothing is
sent; `tryRun()` resolves with `{ ok: false, error }`. A builder returning
`undefined` / `null` / `false` rejects with `RequestCancelledError`.

### Upload progress

Set `reportProgress: true` on the **builder** (it is per call, not per mutation —
one mutation may be the upload and another the delete):

```ts
const upload = createMutation.post<string, { body: Blob }>(
  (args) => ({ url: '/files', body: args.body, reportProgress: true }),
);

// <progress [value]="upload.progress()?.loaded" [max]="upload.progress()?.total" />
await upload.run({ body: file });
```

`progress()` is `undefined` before the first event and after the call settles.
Angular 22's `HttpClient` defaults to the fetch backend, which cannot report
progress at all, so this needs `provideHttpClient(withXhr())` in `app.config.ts`.

### Tearing one down

`destroy()` aborts everything in flight and makes the handle permanently
unusable — `run()` afterwards rejects with `RequestCancelledError`. You rarely
need it: destroying the owning injector does the same thing. It exists for a
mutation built with an explicit `{ injector }` outside an injection context,
where the handle is the only thing you are holding.

## Auth: reactive headers + a refresh interceptor

`baseUrl` is merged into the url *before* `HttpClient`, so interceptors see the
full url. But an interceptor runs only when a request is already on its way out,
so it cannot make a **satisfied** resource refetch when a token changes. That is
what the global `headers` function is for:

```ts
provideSignalRequest(() => {
  const auth = inject(AuthStore);
  return {
    baseUrl: API,
    headers: () => ({ Authorization: `Bearer ${auth.token()}` }),
  };
});
```

The function is evaluated inside each request's reactive chain, so the token
signal becomes a dependency: when the token changes, every live query refetches
on its own. No `reload()` call anywhere.

> A plain object is a **snapshot**. `headers: { Authorization: \`Bearer ${token()}\` }`
> freezes the value at bootstrap and never updates. Use the function form for
> anything dynamic.

Token *refresh* stays in an interceptor, where it belongs — the concurrency,
storage and loop-guard decisions are yours, not the library's:

```ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStore);
  if (req.context.get(SKIP_AUTH) || !req.url.startsWith(API)) return next(req);

  const authorized = next(req.clone({ setHeaders: { Authorization: `Bearer ${auth.token()}` } }));

  return authorized.pipe(
    catchError((err) =>
      err.status === 401
        ? from(auth.refreshOnce()).pipe(switchMap((token) =>
            next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
          ))
        : throwError(() => err),
    ),
  );
};
```

`refreshOnce()` must share one in-flight refresh (a module-level promise) and
mark itself with `SKIP_AUTH`, otherwise ten parallel 401s trigger ten refreshes
and the refresh request 401s itself. A refresh that happens entirely inside
`HttpClient` is invisible to this library: `status()` stays `loading`,
`retryAttempt()` stays `0`, and `onError` never fires — which is correct, since
a 401 is a hiccup, not a failed attempt.

## Common patterns

```ts
// Search box: 300ms debounce, keep the old results while typing
term = signal('');
results = createRequest<Hit[]>(
  () => (this.term().length >= 2 ? { url: '/search', params: { q: this.term() } } : undefined),
  { debounce: 300, keepPreviousValue: true, initialValue: [] },
);

// Dependent request (Angular 22 ctx.chain): posts waits until user resolves
user  = createRequest<User>('/me');
posts = createRequest<Post[], void>((_params, ctx) => `/users/${ctx.chain(this.user.resource)!.id}/posts`);

// Polling (visible tab only), switched on and off reactively
status = createRequest<Job>(() => `/jobs/${this.id()}`, {
  pollInterval: () => (this.running() ? 2000 : false),
});

// Optimistic update
this.todos.update((list) => [...list, draft]);   // visible immediately
await this.add.run(draft);                       // invalidates pulls the real list
```

## Testing

`ng-signal-request/testing` publishes the helpers, so you do not have to
rediscover the flushing rules:

```ts
import { fail, respond, settle, setup } from 'ng-signal-request/testing';

const { http, create } = setup();
const list = create(() => createRequest<Item[]>('/items'));

await settle();
await respond(http, '/items', [{ id: 1 }]);   // flush + settle
expect(list.response()).toEqual([{ id: 1 }]);

await fail(http, '/items', 500);
expect(list.requestError()?.kind).toBe('http');
```

| Export | |
| --- | --- |
| `setup(extraProviders?)` | Configures TestBed with `HttpClient` + `HttpTestingController`; returns `{ http, create }` where `create` runs in an injection context |
| `settle(rounds = 10)` | Lets effects and async loaders finish. Uses only `TestBed.tick()` and microtasks, so it works under fake timers |
| `respond(http, url, body)` | Answers the next matching request and waits |
| `fail(http, url, status = 500, body?)` | Fails the next matching request (`statusText: 'Error'`, default body `{ message: 'boom' }`) and waits |
| `isHttpError(e)` | `e is HttpErrorResponse` guard |

> `ApplicationRef.whenStable()` is deliberately **not** used by `settle()`: it
> never resolves while a request is in flight (`httpResource` holds a pending
> task), which is exactly what you are trying to test. If you write your own
> helper, remember `expectOne()` **consumes** the request — a second
> `expectOne()` for the same url fails.

Retry tests need fake timers, because the back-off is a real `setTimeout`:

```ts
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());
// …
await fail(http, '/n', 503);
await vi.advanceTimersByTimeAsync(1000);
await settle();
```

## Behavior notes and limits

- `createRequest` / `createMutation` require an **injection context** (field
  initializer, constructor, `runInInjectionContext`) or an explicit
  `{ injector }`. Otherwise you get Angular's usual `NG0203` with a helpful
  function name.
- Lifetime follows the owning injector: created in a component, it dies with
  the component; created in a `providedIn: 'root'` service, with the app. When
  you pass an explicit `{ injector }` instead, **you** own the teardown — call
  `destroy()` (or destroy that injector).
- Writing an explicit `SignalRequest<T>` annotation on the handle **discards**
  the narrowing `initialValue` buys you — `response()` goes back to
  `T | undefined`. Let it infer.
- `retryAttempt()` keeps its value after retries are exhausted, so the UI can
  say "we tried N times". It is reset by a success, a new params key, or `idle`.
- The global `retry` applies to queries only. Mutations must opt in.
- `debounce` cannot be combined with `ctx.chain()` (the chain only works inside
  the resource's own params function); you get an explanatory error. It also
  delays refetches caused by a token change.
- `ctx.chain()` is unavailable in lazy mode for the same reason — the source is
  evaluated by `run()`, not by the resource — and also throws an explanatory
  error instead of chaining against a stale context. It lives on the source's
  **second** argument; the first one is `params`.
- SSR: `pollInterval` and `debounce` are ignored on the server so timers do not
  hold stability. Retry delays and `timeout` do apply.
- SSR + `transferCache`: Angular's transfer cache only replays `GET`. A
  non-`GET` `createRequest` variant therefore does **not** get its response
  carried over from the server — the client re-fetches. If you use a non-`GET`
  variant, prefer `createMutation` for the write, or set
  `includePostRequests: true` in your `provideClientHydration()` config and
  accept that every payload crosses the wire.
- Angular does not abort the network call when the request becomes `undefined`
  (it only discards the result), so `cancel()` writes a local value first to
  force a real abort. After `cancel()`, `response()` falls back to
  `initialValue` (or the last response when `keepPreviousValue: true`).
- Progress: Angular 22's `HttpClient` defaults to the fetch backend, which cannot
  report progress. `progress()` is therefore only ever populated with
  `provideHttpClient(withXhr())` — on `createRequest` via `reportProgress: true`
  in the source, on `createMutation` via the same flag in the builder.
- Requests are **not** deduplicated. Two components asking for the same url each
  fire their own request — that is what makes the lifetime rule above possible.

## API

### `ng-signal-request`

| Export | Description |
| --- | --- |
| `createRequest(source, options?)` | Reactive `GET` query on top of `httpResource` |
| `createRequest.get` / `.post` / `.put` / `.patch` / `.delete` | Verb variants (`.get` is the bare call) |
| `createRequest.<verb>.text` / `.blob` / `.arrayBuffer` | Non-JSON body variants |
| `createMutation(builder, options?)` | Imperative `POST` write with its own lifecycle |
| `createMutation.post` / `.put` / `.patch` / `.delete` | Verb variants (`.post` is the bare call) |
| `provideSignalRequest(config \| () => config)` | Global `baseUrl`, `retry`, `headers`, `onError`, `onSuccess`. The factory form runs in an injection context |
| `SIGNAL_REQUEST_CONFIG` | The `InjectionToken` behind it |
| `RequestCancelledError` | Thrown by `run()` on cancel / disable / destroy |
| `toRequestError(cause, context?)` | Normalizes an `unknown` into a `RequestError` |

### Types

| Export | Description |
| --- | --- |
| `RequestError` | The discriminated failure union |
| `RequestErrorContext` | `{ timeout? }` used for timeout classification |
| `SignalRequest<T, R, TParams>` | Query handle |
| `SignalMutation<T, TArgs>` | Mutation handle |
| `RequestOptions<T, TParams, TRaw>` / `MutationOptions<T, TArgs>` | Option shapes |
| `CreateRequest` / `CreateRequestFn` | The callable variants and their shapes |
| `CreateMutation` | The mutation variant shape |
| `RequestSource` / `RequestValue` / `RequestConfig` / `ParamsOption` | Source and params description |
| `QueryParams` / `QueryValue` / `PathParams` | Parameter helpers |
| `RetryConfig` / `RetryOptions` | Retry policy |
| `RequestStatus` / `MutationStatus` / `RunResult<T>` | Status and result types |
| `Reloadable` / `SignalRequestConfig` | Invalidation and global config shapes |

### `ng-signal-request/testing`

`setup` · `settle` · `respond` · `fail` · `isHttpError`

## Demo

`projects/demo` is a runnable Angular app that exercises every feature against
[jsonplaceholder.typicode.com](https://jsonplaceholder.typicode.com):

```bash
pnpm start        # ng serve demo
pnpm build:demo   # production build -> dist/demo
```

It imports the library by its package name and resolves to **source** (via
`paths` in the root `tsconfig.json`), so it works without building the package
first — no `dist/` needed for `pnpm start`, the editor, or `pnpm typecheck`.
See [`projects/demo/README.md`](projects/demo/README.md).

## Development

Requires Node 22+ and pnpm 12 (see `packageManager`).

```bash
pnpm install
pnpm build       # build the library into dist/signal-request
pnpm test        # unit tests (vitest, headless)
pnpm typecheck   # tsc --noEmit over the lib, spec and demo projects
pnpm watch       # rebuild on change (development configuration)
```

> On Windows, `packageManager` pins a pnpm version newer than the one on
> `PATH`. If `pnpm install` fails with *"is not recognized as an internal or
> external command"*, that pnpm self-management shim is broken — run the
> command through Corepack instead: `corepack pnpm install`.

## Releasing

Publishing is fully automated — no manual `npm publish`. The version comes from
the tag, so nothing has to be bumped in a manifest:

1. `git tag v0.1.0`
2. `git push origin v0.1.0`
3. [GitHub Actions](.github/workflows/npm-publish.yml) derives the version from the tag,
   builds, runs the unit tests and publishes to npm.

Authentication uses npm **Trusted Publishing (OIDC)**, so the repository holds
no npm token, and every release gets a signed **provenance** statement. If the
version already exists on the registry the publish step is skipped, so
re-running a workflow is always safe.

## Links

- [npm package](https://www.npmjs.com/package/ng-signal-request)
- [Issue tracker](https://github.com/theunal/ng-signal-request/issues)
- [License (MIT)](./LICENSE)
