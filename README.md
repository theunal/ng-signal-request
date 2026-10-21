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
`key`-based shared cache with invalidation, mutations with optimistic writes, a
`select()` projection, `combine` / `createRequests`, and separate `/testing`,
`/devtools` and `/persist` entry points.

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
        retry: 2, // default for queries (NOT mutations)
        headers: () => ({
          // reactive — see "Auth" below
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

| `provideSignalRequest` option | Description                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                     | Prepended to every relative url. Absolute urls are left alone                                                                                                         |
| `retry`                       | Default retry policy **for queries only**. Mutations never retry by default                                                                                           |
| `retryTimeouts`               | Whether an elapsed `timeout` counts as worth retrying. Default `true` (0.1.x behaviour). See "The timeout + retry caveat"                                             |
| `headers`                     | `Record<string, string>`, or a function for reactive headers. Merged _under_ per-request headers                                                                      |
| `onError`                     | Called once per request **or mutation** that ends in a final error, after retries. Good for toasts / logging                                                          |
| `onSuccess`                   | The mirror image: called once per successful request or mutation. For logging / analytics — a toast belongs in the per-call `onSuccess`, where you know what happened |

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
      initialValue: [], // response() is never undefined
      keepPreviousValue: true, // keep the old list visible while the new one loads
      retry: 2,
    });
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (list.loading()) {
      loading...
    } @else if (list.requestError(); as error) {
      @if (error.http(); as http) {
        error: {{ http.status }}
      } @else if (error.network()) {
        no connection
      } @else if (error.timeout()) {
        timed out
      } @else {
        {{ error.message }}
      }
    } @else {
      {{ list.response().length }} records
    }
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

| Value                                               | Meaning                                                      |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `'/url'` or `{ url, ... }`                          | static request                                               |
| `() => ...`                                         | **reactive**; re-fires whenever a signal read inside changes |
| a function returning `undefined` / `null` / `false` | request **disabled** (`status() === 'idle'`)                 |

The request object is the same as Angular's `HttpResourceRequest` (`body`,
`headers`, `context`, `timeout`, `transferCache`, `reportProgress`, …) — minus
`method` — plus:

- **`params`** — tolerates `null` / `undefined` (dropped), `Date` (→ ISO-8601)
  and arrays of those.
- **`path`** — `url: '/users/:id/posts', path: { id: id() }`. If a referenced
  placeholder resolves to `null` / `undefined`, the request is _disabled_ — and
  so is a url whose placeholders are still unfilled.

The HTTP verb is **not** part of the request object. It comes from the function
you call:

| Call                           | Sends    |
| ------------------------------ | -------- |
| `createRequest(src, …)`        | `GET`    |
| `createRequest.get(src, …)`    | `GET`    |
| `createRequest.post(src, …)`   | `POST`   |
| `createRequest.put(src, …)`    | `PUT`    |
| `createRequest.patch(src, …)`  | `PATCH`  |
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

| Option                                | Description                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lazy`                                | `true` → nothing is sent until you call `run()`; later signal changes do **not** re-fire                                                                                                                |
| `params`                              | Initial value of the library-created `params` signal. **Required** when you declare a `TParams` type argument. Its `body` / `path` / `headers` keys fill the request; the rest becomes the query string |
| `initialValue`                        | Value of `response()` while idle / loading / failed. Makes the type non-nullable                                                                                                                        |
| `parse`                               | Validate or map the raw body (`schema.parse` and friends)                                                                                                                                               |
| `headers`                             | Headers for this request only. Merged over the global defaults, and wins over headers the source itself set                                                                                             |
| `keepPreviousValue`                   | On a source change, keep showing the previous response until the new one arrives (default `false`)                                                                                                      |
| `debounce`                            | ms; delays source changes. **The very first request is never delayed.** Browser only                                                                                                                    |
| `retry`                               | `3` \| `{ count, delay, when }`. Default: network errors, 408/425/429 and every 5xx; exponential back-off 1s, 2s, 4s… capped at 30s                                                                     |
| `timeout`                             | Abort after N ms. Surfaces as `{ kind: 'timeout', ms }`. Overrides a `timeout` the source sets; a source-level `timeout` alone is classified the same way. See the caveat below                         |
| `retryTimeouts`                       | Whether this request's `timeout` is retried. Default `true` (0.1.x behaviour); the global value is the fallback. See the caveat below                                                                   |
| `pollInterval`                        | ms, or `() => number \| false` (reactive on/off). Browser only                                                                                                                                          |
| `pollWhenHidden`                      | Keep polling while the tab is hidden (default `false`)                                                                                                                                                  |
| `refetchOnWindowFocus`                | Re-fetch when the tab becomes visible again (default `false`). Browser only                                                                                                                             |
| `refetchOnReconnect`                  | Re-fetch when the browser reports it is back online (default `false`). Browser only                                                                                                                     |
| `onSuccess` / `onError` / `onSettled` | Lifecycle hooks (`onError` fires once, after retries are exhausted)                                                                                                                                     |
| `equal`, `injector`, `debugName`      | Same as `httpResource`                                                                                                                                                                                  |

#### Refetching when the user comes back

```ts
readonly list = createRequest<Item[]>('/items', {
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: 2,
});
```

`refetchOnWindowFocus` listens to `visibilitychange` **and** `focus`, deduped
within a tick. Desktop browsers fire both when you alt-tab back; mobile ones fire
only `visibilitychange`, so listening to `focus` alone would silently do nothing
on a phone. A document that is still hidden never refetches.

`refetchOnReconnect` listens to the browser's `online` event. Note that the
browser fires it when a network interface appears, not when a request is
actually routable, so the failure this is meant to recover from can still
happen afterwards.

Neither ever refetches a **disabled** request: a source returning `undefined`
means "do not send this", and a background event must not override that. Both
are browser-only and no-op during SSR, like `pollInterval` and `debounce`.

### Params

Pass a **second type argument** and the library creates a writable `params`
signal for you — you never build one yourself. You also stop writing the
plumbing: three keys are recognised automatically.

| `params` key                               | goes to                          |
| ------------------------------------------ | -------------------------------- |
| everything else (`param1`, `q`, `size`, …) | the query string                 |
| `body`                                     | the request body                 |
| `path`                                     | fills `:placeholders` in the url |
| `headers`                                  | the request headers              |

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
wins** — except that `body: null` explicitly _clears_ a body the source set,
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

| Member                                    |                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `params()` / `params.set()`               | the writable params signal (see above)                                                                         |
| `response()`                              | latest response (never `undefined` when `initialValue` is given)                                               |
| `select(fn, options?)`                    | memoized projection of `response()` — the `select` TanStack has as an option (see "Transforming the response") |
| `success()`                               | `true` once the last settled attempt succeeded; `false` while idle, loading or retrying                        |
| `loading()`                               | loading / reloading / waiting for the next retry                                                               |
| `initialLoading()`                        | only the first load, or one caused by changed params — not reload/refresh/retry                                |
| `error()`                                 | raw `Error`, set **after retries are exhausted**; stays `undefined` while retrying                             |
| `requestError()`                          | the same failure, narrowed to a discriminated union, with per-kind predicates and a `message` (see "Errors")   |
| `status()`                                | `idle` \| `loading` \| `reloading` \| `resolved` \| `error` \| `local`                                         |
| `retryAttempt()`                          | `0`, or the current retry number. **Keeps its last value after giving up**                                     |
| `headers()`, `statusCode()`, `progress()` | straight from `httpResource`                                                                                   |
| `run()`                                   | Fire now and resolve with the response. Lazy: new request. Auto: reload, or join the request already in flight |
| `tryRun()`                                | Like `run()` but never rejects: `{ ok: true, response }` \| `{ ok: false, error }`                             |
| `reload()`                                | Re-fetch keeping the current value visible (`reloading`)                                                       |
| `cancel()`                                | Really abort the in-flight request (`idle`). Normal behaviour resumes on a source change or `run()`            |
| `set()` / `update()`                      | Local (optimistic) update, `status() === 'local'`                                                              |
| `destroy()`                               | Stop everything (timers, in-flight request)                                                                    |
| `resource`                                | the underlying `httpResource`, for interop (snapshots, `ctx.chain`, devtools)                                  |

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
  | { kind: 'network'; cause: unknown; offline?: true }
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

### In a template: predicates instead of `@switch`

Every kind also gets a predicate that returns the error **itself** when that
is its kind, and `undefined` otherwise — plus a one-line `message`:

```ts
error.http(); // RequestErrorOf<'http'> | undefined
error.timeout(); // RequestErrorOf<'timeout'> | undefined
error.message; // string — 'HTTP 404 Not Found', 'Timed out after 5000ms', …
```

`@if (error.http(); as http)` binds the alias to the exact union member, so
`http.status` is a `number` and not `number | undefined`:

```html
@if (error.http(); as http) { error: {{ http.status }} } @else if (error.network()) { no connection
} @else if (error.timeout()) { timed out } @else { {{ error.message }} }
```

`@switch` only works as a statement, so it cannot be used inside an
interpolation; the predicates can:

```html
<span class="badge">{{ error.http() ? 'HTTP ' + error.http()!.status : error.kind }}</span>
```

Three things worth knowing:

- **`kind` is still there, and still the right tool for TypeScript.** The
  predicates exist for templates. `if (e.kind === 'http')` keeps its
  compiler-checked narrowing; `e.status` on a `timeout` error is still a type
  error rather than a silent `undefined`.
- **`message` is best-effort display copy** — a badge, a tooltip, a log line.
  Branch on `kind`, never on that string: it is English, not localizable, and
  not a stable contract.
- **They are plain methods on a shared prototype, not signals.** A failure is
  not a time-varying value, so a signal would add a reactive-graph edge
  without adding reactivity — while costing an allocation per kind per error.
  Being prototype members also keeps them out of `JSON.stringify`, object
  spread and `toEqual`, so an error still serializes as plain data.

`requestError()` is `undefined` whenever `error()` is — including while a retry
is in flight, where `error` is deliberately masked. `createMutation` has the
same signal.

### `status: 0` is ambiguous

`HttpClient` reports "no response" as `status: 0`, which covers both a network
failure and a cancellation. An abort is only recognized as `aborted` when the
reason names itself `AbortError` / `TimeoutError`; an opaque `status: 0` becomes
`network`. That is also why a timeout has to be _configured_ to be reported as
`timeout` rather than `aborted` — Angular's fetch backend aborts with a
`TimeoutError` DOMException, and the configured duration is what fills in `ms`.
Both places count: the `timeout` option, and a `timeout` set on the request
object itself (the `createRequest` source or the `createMutation` builder). When
both are present, the option wins.

One thing _is_ known rather than guessed: when the browser itself says it has no
connection, the `network` member carries `offline: true`, so a UI can say "you
are offline" instead of "check your connection":

```ts
const error = this.list.requestError();

if (error.network()?.offline) {
  // navigator.onLine === false — the browser is certain, so this is worth saying
}
```

The field is present **only** in that case: absent when the browser believes it
is online (a CORS block and a dropped socket arrive here too, and neither means
"offline"), and absent on the server, where there is no `navigator` to ask. There
is no `false`, which is why the type is `offline?: true` rather than
`offline?: boolean` — an absence is not a claim.

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

A timeout reaches the retry policy as a `status: 0` failure, which by status
alone is indistinguishable from a dropped connection — so **it is retried by
default**: `timeout: 5_000` with `retry: 2` can take about 15s and show three
loading cycles before reporting the timeout. That default is unchanged from
0.1.x, and in dev mode the library warns you when you combine the two options and
say nothing about the timeout.

> **This default changes in 0.3.0**, to `false`. It is not changed here because a
> retry policy is not something to alter underneath a caller in a minor release —
> the timing of every failing request would move. Set `retryTimeouts` explicitly
> (either value) before then and the change is a non-event. The CHANGELOG's
> Deprecated section has the same note.

`retryTimeouts: false` is the way out — the timeout is reported as soon as it
happens:

```ts
// one request, { kind: 'timeout', ms: 5_000 } as soon as the 5s elapses
createRequest<User[]>('/users', { timeout: 5_000, retry: 2, retryTimeouts: false });
```

It can be set globally (`provideSignalRequest({ retryTimeouts: false })`) and
overridden per request, and it is deliberately narrow: a genuine network failure
still retries, because that is the case retries exist for. An explicit
`retry: { when }` wins over both, since it answers the same question:

```ts
retry: { count: 2, when: (e) => (e as HttpErrorResponse).status !== 0 }
```

## Cache

By default nothing is shared: every `createRequest` is its own `httpResource`,
with its own request and its own lifetime. That is still the default, because
the lifetime rule is a feature — a component that dies takes its request with
it.

Give a request a `key` and it becomes **cached**. Every handle built with the
same key shares one entry, one request and one value.

```ts
readonly users = createRequest<User[]>(
  () => ({ url: '/users', params: { page: this.page() } }),
  { key: () => ['users', { page: this.page() }], staleTime: 30_000, initialValue: [] },
);
```

Two components with that key now cost **one** request, and both see the same
value. Object segments compare by value, so `{ page: 1 }` from two places is one
entry.

| Option              | Default        | Meaning                                                            |
| ------------------- | -------------- | ------------------------------------------------------------------ |
| `key`               | —              | **The opt-in.** Must be sufficient to determine the request        |
| `staleTime`         | `0`            | How long a value counts as fresh. `0` = always stale               |
| `gcTime`            | `5 min`        | How long an entry with no subscribers is kept                      |
| `maxEntries`        | unlimited      | A cap for the whole cache. See below                               |
| `refetchOnMount`    | `'stale'`      | `'stale'` · `'always'` · `false`                                   |
| `waitForRestore`    | `true`         | Hold the first fetch while a restore is in flight. See Persistence |
| `structuralSharing` | walk-and-reuse | What to store when nothing changed                                 |

A key is always a **function**, so it is read inside the handle's reactive
chain: a filter signal in the key re-points the handle at another entry. A
function _inside_ a key throws — it would make a new function every evaluation,
so the entry would never be reused and the cache would grow without ever
hitting.

A cached handle has **no `.resource`**. There is no `httpResource` behind it —
that is exactly why the request can be shared — so `.resource` is a type error
rather than a silent `undefined`, and `ctx.chain()` gets an explanatory error
instead of chaining against nothing.

### Dependent queries on a cached handle

The replacement for `ctx.chain()` on the cached path is better than a
workaround: put the thing the request depends on into its **key**. The dependency
is then part of the cache identity, so two upstream values can never share one
downstream entry.

```ts
readonly post = createRequest<Post>(
  () => `/posts/${this.id()}`,
  { key: () => ['post', this.id()] },
);

readonly comments = createRequest<Comment[]>(
  () =>
    // Nothing to ask for until the post has a value: no request, and no entry either.
    this.post.response() ? `/posts/${this.post.response()!.id}/comments` : undefined,
  { key: () => ['comments', this.post.response()?.id] },
);
```

Two halves, and both matter. The **source** returns `undefined` while there is
nothing to depend on, which is how a request is disabled: it is not sent, and no
entry is created for the not-yet-meaningful key. The **key** carries the upstream
value, so switching to another post re-points the handle at another pair of
entries and the previous pair stays a cache hit until `gcTime`.

### Bounding the cache in space — `maxEntries`

`gcTime` bounds the cache in **time**. It does not bound it in **space**: a
typeahead keyed on the query string, a virtualised list keyed on the row id, or
a detail screen keyed on the record id all produce a new key per interaction, and
inside one 5-minute window that is unbounded.

```ts
provideSignalRequest({ maxEntries: 500 });
```

```ts
createRequest('/users', { key: () => ['users'], maxEntries: 100 });
```

The policy is one sentence: **evict the least recently used entry that has no
subscriber and nothing in flight.** Both guards are load-bearing. An entry with a
subscriber is someone's rendered data; taking it would turn a cache hit back into
a spinner. An entry with a request in flight has a `run()` promise waiting on it.
If neither applies to anything, the cache **overshoots** rather than mangling a
live component, and says so in dev mode:

```
[ngsr] maxEntries: the cache holds 32 entries against a cap of 25. Every entry
that could be dropped has a subscriber or a request in flight, …
```

Enforcement happens **as entries arrive**, synchronously, so the cap is a memory
bound rather than a report. The consequence worth knowing: a burst of components
unmounting does not immediately trim the cache — the next new entry does. Between
those two moments `gcTime` is still the only thing collecting, which is exactly
what it was before.

Staged values count toward the cap as well. `seed` / `hydrate` park a persisted
value until a handle asks for its key, and that parking area is bounded by the
same `maxEntries` — otherwise a single large snapshot would sit outside the bound
for a whole session. When the total is over, **staged values go before entries**,
oldest fetch first: a staged value is one nothing has asked for yet, so losing it
costs a refetch the next time its key is used, whereas taking an entry throws away
data a handle has already resolved. `pendingSeeds` reports how many are waiting,
and `size() + pendingSeeds` is the number `maxEntries` actually bounds.

A per-request `maxEntries` can only **tighten** the global one, never raise it.
There is one cache per application and nothing owns a subset of it, so a
per-request cap is a budget for the whole cache: the smallest value anyone
declared wins, and the global value is a ceiling no leaf request can exceed. That
makes the outcome independent of the order requests are constructed in. The cost
is honest and worth stating: a screen that genuinely needs more room than the
global setting has to raise the global value.

```ts
const client = inject(QueryClient);

client.size(); // Signal<number> — the whole cache
client.evict(['users']); // number — idle ['users', …] entries only
client.evict(); // number — every idle entry
```

`size()` is a signal, coalesced to a microtask because the notifications it
follows fire from inside a key `computed`. `evict()` is the rule above as
something you can run by hand; `remove()` stays the unconditional one, and
`QueryCache.maxEntries` tells you the effective cap.

### Invalidating by key

`QueryClient` is the imperative half. Inject it anywhere.

```ts
private readonly client = inject(QueryClient);

this.client.invalidate(['users']);             // refetches ['users', …] on screen
this.client.invalidate((s) => s === 'todos');  // a predicate over each segment
this.client.getData<User[]>(['users', 1]);      // read without a handle
this.client.setData(['users', 1], (list) => …); // write without a handle
this.client.isFetching();                       // global or per filter
this.client.size();                             // how many entries, as a signal
this.client.evict(['users']);                   // drop the idle ones under ['users']
```

`['users']` is a **prefix**, not an equality test: it reaches `['users', 1]` and
`['users', { page: 2 }]` alike. That is the whole point of the key being a
segment array rather than an opaque id.

Several invalidations in the same tick collapse into one refetch per entry, so
three mutations landing together do not produce three network calls. Entries
nobody is watching are only _marked_ — the next subscriber fetches.

### `createMutation` invalidating keys

`invalidates` now takes keys alongside handles, which removes the "I have to
hold a reference to every component showing this list" problem:

```ts
readonly save = createMutation<User, Partial<User>>(
  (user) => ({ url: '/users', body: user }),
  { invalidates: () => [this.detail, ['users']] }, // a handle, or a key
);
```

Handles are reloaded; keys are invalidated, so **every** cached handle under
that key refreshes, not just the one this mutation happens to reference.

### `onMutate`, and the settle context

`onMutate` runs **before** the request goes out and before the optimistic value
is written. Whatever it returns is threaded into the settle hooks and is
readable as `mutation.context()`.

```ts
const save = createMutation<number, Todo, { attemptedAt: number }>(
  (draft) => ({ url: '/todos', body: draft }),
  {
    onMutate: (draft) => ({ attemptedAt: Date.now() }),
    onError: (error, _args, ctx) => log.warn(error, ctx?.attemptedAt),
  },
);
```

The order is fixed and worth knowing, because the rollback and the refetch both
touch the same display:

|     |                                                                           |
| --- | ------------------------------------------------------------------------- |
| 1   | `onMutate(args)` — may be async; awaited before anything else             |
| 2   | the optimistic value is written into `target`                             |
| 3   | the request is sent                                                       |
| 4   | on success: `invalidates` → `onSuccess` → `onSettled`                     |
| 4   | on failure: the optimistic value is rolled back → `onError` → `onSettled` |

A throwing or rejecting `onMutate` fails the whole call: **nothing is sent**,
nothing was shown, `onError` runs and `run()` rejects.

> **`TContext` is only inferred when you write no type arguments at all.**
> TypeScript fills any type argument you leave out with its _default_, so
> `createMutation<number, string>(…)` locks `TContext` to `undefined` before
> `onMutate` is looked at. Either name it —
> `createMutation<number, string, MyContext>(…)` — or let it all be inferred.

### Optimistic writes by key

`target` also takes a key, so the mutation does not need a reference to the
handle showing the list:

```ts
{
  optimistic: (todos, draft) => [...(todos ?? []), draft],
  target: ['todos'],
  invalidates: () => [['todos']],
}
```

The entry has to already exist — a handle for that key must be on screen
somewhere. Minting one here would leave an orphan that can never fetch and that
nothing is subscribed to, so a missing entry makes the optimistic write a no-op
instead.

### `mutationKey` and `isMutating`

`mutationKey` groups a mutation so it can be found without a reference, and
`isMutating` answers "is anything being written?" as a **signal**, because that
changes on its own:

```ts
const save = createMutation(..., { mutationKey: ['todos'] });

client.isMutating();             // Signal<boolean> — anything
client.isMutating(['todos']);    // Signal<boolean> — only todo mutations
client.mutatingCount()();        // Signal<number>
```

Prefix-matched like a query key. This is what a global "saving…" indicator or a
navigation guard needs — neither holds references to your mutations.

### What is different from a cached `httpResource`

- **Structural sharing keeps the previous reference when nothing changed**, so
  the data signal is never written and no consumer is notified. Existing
  `equal` composes as a short-circuit.
- **The last subscriber leaving cancels the in-flight request**, even with data
  cached. Cached data is untouched; the next subscriber refetches.
- **`cancel()` is wider than usual**: one key means one request, so cancelling
  it affects every subscriber of that key.
- **`gcTime`'s timer is browser-only.** On the server it would only hold
  stability.

### Infinite scroll

There is a `createInfiniteRequest`. What it does **not** have is a page cache of
its own — each page is an ordinary cache entry keyed `base key + page param`,
which is what makes the rest of this page work on a paginated list for free.

```ts
readonly feed = createInfiniteRequest<Item>(
  (page) => ({ url: '/items', params: { page, size: 20 } }),
  {
    key: () => ['items', { filter: filter() }],
    initialPageParam: 0,
    getNextPageParam: (last, _all, param) => (last.length === 20 ? param + 1 : undefined),
    maxPages: 5,
    retry: 2,
    timeout: 10_000,
    retryTimeouts: false,
  },
);

feed.pages();                 // [Item[], Item[], …]
feed.response();              // every item, flattened
feed.hasNextPage();
await feed.fetchNextPage();
```

Because the entries are `['items', 0]`, `['items', 1]`, …, `client.invalidate(['items'])`
— prefix-matched — refreshes **every** page without knowing anything about
pagination. Page 1 of a paginated list and a `createRequest` on `['items', 0]`
are the same entry and dedup against each other.

| Member                                              |                                                     |
| --------------------------------------------------- | --------------------------------------------------- |
| `pages()`                                           | Every loaded page, in order                         |
| `response()`                                        | The pages, **flattened** when a page is an array    |
| `pageParams()`                                      | The params of the loaded pages                      |
| `fetchNextPage()` / `fetchPreviousPage()`           | Load one more. Resolve when that page has settled   |
| `hasNextPage()` / `hasPreviousPage()`               | What the getters say                                |
| `isFetchingNextPage()` / `isFetchingPreviousPage()` | Which page is loading                               |
| `reload()`                                          | Re-fetch every loaded page, **in order**            |
| `remove()`                                          | Drop the accumulation. The page entries stay cached |

Three things worth knowing:

- **`getPreviousPageParam` is optional, and its absence is visible.**
  `hasPreviousPage()` is permanently `false` rather than pretending the feature
  exists.
- **`response()` flattens only when a page is an array.** An envelope like
  `{ items, cursor }` is returned as-is, because the library cannot know which
  of its fields is the list — and the return type follows, so
  `InfiniteRequest<Item[], P>` gives `readonly Item[]` while
  `InfiniteRequest<Envelope, P>` gives `readonly Envelope[]`.
- **Changing a signal in `key` restarts the accumulation, not the cache.** The
  old page entries stay, with their own `gcTime`, because they are usually
  exactly what someone flipping a filter back and forth wants. `maxPages`
  drops a page the same way — it releases the subscription, it does not delete.
- **`remove()` is a view reset, not a reload.** It drops the accumulation, and
  because the accumulation is what subscribes to the page entries, nothing
  re-subscribes to page one afterwards. To start over in one step, **change the
  key** — a run counter in the key resets the accumulation and leaves the old
  pages cached:

  ```ts
  private readonly run = signal(0);
  readonly feed = createInfiniteRequest<Item>(source, {
    key: () => ['items', this.run()],
    // …
  });
  restart() { this.run.update((n) => n + 1); }
  ```

  This is why `reload()` and `remove()` are separate methods rather than one
  `reset()`: `reload()` re-fetches the pages that are loaded, `remove()` empties
  the view, and only a key change means "start from the beginning".

This replaces the hand-written recipe that used to live here. That recipe
needed an `appendedPage` guard because `onSuccess` fires on **every** settle
and a reload would append a page twice. With one entry per page, a reload
_replaces_ page N, and there is no guard to write.

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

| Call                                | Sends    |
| ----------------------------------- | -------- |
| `createMutation(builder, …)`        | `POST`   |
| `createMutation.post(builder, …)`   | `POST`   |
| `createMutation.put(builder, …)`    | `PUT`    |
| `createMutation.patch(builder, …)`  | `PATCH`  |
| `createMutation.delete(builder, …)` | `DELETE` |

There is no `get` variant — a write is not a read. The `run` args double as the
params bag, so `body` / `path` / `headers` are routed for you and everything else
becomes the query string, exactly as in `createRequest`.

| Option                                | Description                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`                         | `parallel` (default) · `exhaust` (returns the in-flight promise) · `switch` (cancels the previous call, rejecting it with `RequestCancelledError`) |
| `mutationKey`                         | Groups this mutation so `QueryClient.isMutating([...])` can find it without a reference                                                            |
| `onMutate`                            | Runs before the request and the optimistic write; its return value becomes the `context`                                                           |
| `optimistic` / `target`               | Show the result before the server answers, and **restore it automatically** if the call fails or is cancelled. See below                           |
| `responseType`                        | `json` \| `text` \| `blob` \| `arraybuffer`                                                                                                        |
| `parse`                               | Validate or map the response body                                                                                                                  |
| `headers`                             | Headers for this call, merged over the global defaults                                                                                             |
| `retry`                               | **Off by default**, because writes are rarely idempotent. The global `retry` is _not_ inherited                                                    |
| `timeout`                             | Abort the call after N ms. Wins over a `timeout` returned by the builder; without it, the builder's value is used as is                            |
| `retryTimeouts`                       | Whether this call's `timeout` is retried. Default `true`; the global value is the fallback. See "The timeout + retry caveat"                       |
| `invalidates`                         | `Reloadable[]`, or a function returning one. Use the function form to avoid field-ordering problems                                                |
| `onSuccess` / `onError` / `onSettled` | Lifecycle hooks                                                                                                                                    |
| `injector`                            | Required if called outside an injection context                                                                                                    |

The returned handle exposes `response`, `error`, `requestError`, `loading`,
`status`, `args`, `progress`, `run`, `tryRun`, `cancel`, `reset` and `destroy`.

`run()` never throws synchronously. If the builder itself throws (say, a
missing field), the returned promise rejects with that error and nothing is
sent; `tryRun()` resolves with `{ ok: false, error }`. A builder returning
`undefined` / `null` / `false` rejects with `RequestCancelledError`.

### Optimistic update with automatic rollback

`optimistic` writes the value you return into `target` the moment `run()` is
called — before the request is even sent — and restores the previous value by
itself when the call **fails or is cancelled**. You never write the undo.

```ts
readonly add = createMutation<Todo[], Todo>(
  (draft) => ({ url: '/todos', body: draft }),
  {
    optimistic: (todos, draft) => [...(todos ?? []), draft],  // on screen immediately
    target: this.list,          // any createRequest; defaults to this mutation's own response
    concurrency: 'exhaust',     // double-click protection
    invalidates: () => [this.list], // …on success only
  },
);

await this.add.run(draft);
// list() shows `draft` immediately
// → server 500: list() snaps back on its own
// → server 200: invalidates refetches and the real list replaces it
```

Three details worth knowing:

- **`target` is optional.** Without it the optimistic value lands on the
  mutation's own `response()` — useful for a standalone "saving…" label.
  With a `createRequest` you get the list case above, which is what you want
  most of the time.
- **The restore is a compare-and-swap.** It only happens while this call's own
  value is still the one on screen. Under `concurrency: 'parallel'` two calls
  can be in flight, and without that guard a failing call would overwrite the
  value a sibling call had just written with a stale snapshot.
- **`destroy()` does not roll back.** A destroyed handle has no observer left
  to correct. A plain `cancel()` and a `switch` superseding the call both do.

`optimistic` is separate from `createRequest`'s `set()` / `update()`: those are
how _you_ write a local value by hand, `optimistic` is how you attach a write to
one and get the undo for free.

### Upload progress

Set `reportProgress: true` on the **builder** (it is per call, not per mutation —
one mutation may be the upload and another the delete):

```ts
const upload = createMutation.post<string, { body: Blob }>((args) => ({
  url: '/files',
  body: args.body,
  reportProgress: true,
}));

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

## `createQuery(source, options)` - a cached query for data that is not HTTP

`createRequest` assumes `HttpClient`. `createQuery` keeps the same cache, the same
lifecycle and the same handle, but the source is a function you write — for
IndexedDB, `localStorage`, a hand-rolled GraphQL client, a WASM module, or any
promise or observable you already have:

```ts
const draft = createQuery<Draft | undefined>(
  async (_params, { signal }) => {
    const db = await openDb({ signal });
    return db.get('drafts', 'current');
  },
  { key: () => ['draft', 'current'], initialValue: undefined },
);
```

The source is `(params, ctx) => Promise<T> | Observable<T>` and `key` is
**required**: without an identity there is nothing to share. `ctx` carries
`signal: AbortSignal` and the same `params` value as the first argument, so a
source that declares no parameters can still read them from the context. Options
are the cached subset — `staleTime`, `gcTime`, `maxEntries`, `refetchOnMount`,
`structuralSharing`, `equal`, `parse`, `select`, `networkMode`, `retry`,
`initialValue`, `lazy`, `debounce`, polling, the refetch switches and the hooks.
`headers`, `statusCode`, `progress`, `timeout` and `responseType` do not exist,
because the function may not have made an HTTP call at all.

The handle is a `QueryRequest` and behaves like `CachedRequest` everywhere else:
`response`, `status`, `error`, `success`, `loading`, `paused`, `run()`,
`tryRun()`, `reload()`, `cancel()`, `set()`, `update()`, `select()` and the
devtools entry are all the same code. Two handles on one key share one entry and
one in-flight call.

```ts
// Params work exactly like the cached HTTP path: changing them refetches,
// setting them to `undefined` disables the query.
const profile = createQuery<User, { id: number }>((params) => api.user(params.id), {
  key: () => ['user', id()],
  params: { id: 1 },
});
```

### The abort signal

The signal is aborted when the last subscriber leaves, when `cancel()` is called,
or when the handle is destroyed. Pass it to `fetch`, to IndexedDB, or to whatever
else supports cancellation. A result that arrives after the abort is dropped: it
never writes to the entry, so a component that unmounted cannot be resurrected by
a slow promise.

### Observable sources

The **first** emission is the value and the entry unsubscribes after it. This is a
cache, not a stream: later emissions are ignored, and streaming is not part of
0.2.0 (see [Known limitations](#known-limitations)). Completion without an
emission is an error rather than an empty success.

```ts
const clock = createQuery<string>(() => timer(0, 1000).pipe(map(() => new Date().toISOString())), {
  key: () => ['clock'],
});
```

### Sharing an entry with `createRequest`

A keyed `createRequest` and a `createQuery` on the same key share one entry and
one in-flight call. Whichever registered its plan last decides how a cache-driven
refetch runs — the same "last plan wins" rule two keyed requests already follow.
They do **not** share a data type; using both for one key is an application bug,
and dev mode warns once per entry.

### Errors

A query is not HTTP, so its classifier does not guess: an abort-like value is
`{ kind: 'aborted' }`, and everything else is `{ kind: 'unknown', cause }` — even
a `TypeError`, which the HTTP path treats as a network failure. `error()` still
has the original `Error`.

## Offline

Connectivity is **opt-in**, and opting in is one option. The default,
`networkMode: 'always'`, is what every version before 0.2.0 did: send the request,
and let it fail loudly if there is no network.

```ts
const todos = createRequest<Todo[]>('/todos', {
  key: () => ['todos'],
  networkMode: 'online',
});

const add = createMutation<Todo, string>((title) => ({ url: '/todos', body: { title } }), {
  networkMode: 'online',
});

// or for the whole application
provideSignalRequest({ networkMode: 'online' });
```

| Mode                   | First attempt                                                                      | Retries while offline                                         | Mutations                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `'always'` _(default)_ | sent                                                                               | sent, after the usual back-off                                | sent                                                                                  |
| `'online'`             | held; starts once on reconnect                                                     | wait for a connection — no timer, and **no attempt is spent** | queued, replayed in call order on reconnect                                           |
| `'offlineFirst'`       | sent, because a service worker, the HTTP cache or a proxy may be able to answer it | wait for a connection                                         | sent — a mutation has no first-attempt/retry distinction, so it behaves as `'always'` |

A held request is **paused, not failed**: nothing throws, `status()` is `'loading'`
before it has ever loaded and `'reloading'` when there is a value to keep showing,
and the promise returned by `run()` stays pending until the request starts or
`cancel()` rejects it with `RequestCancelledError`. Every handle exposes it:

```ts
todos.paused(); // Signal<boolean>
client.isPaused(); // any cached entry
client.isPaused(['todos']); // entries matching the filter
client.isAnythingPaused(); // queries or queued mutations
```

`QueryClient.isPaused` covers **queries** only — a queued mutation reports its own
`paused()` — and is the counterpart of `isFetching`, so a banner can read the bare
call and a per-screen banner the filtered one. `isAnythingPaused()` is the global
"is this app waiting for a connection?" read, combining the two; it takes no filter,
because a query key cannot describe a mutation key.

### `OnlineManager` — one source of truth

`OnlineManager` is the injectable the library reads. Its `online()` is a **signal**
(the state) and its `onReconnect(listener)` is an **event** (the edge); a reconnect
must refetch once, while an offline mount must not refetch on every read of the
state. The state starts from `navigator.onLine`, follows the window's `online` /
`offline` events, coalesces a burst within one tick into one announcement, and
removes its listeners when the injector is destroyed. On the server it is always
online, with no listener and no timer, so a render cannot be held.

```ts
const online = inject(OnlineManager).online; // Signal<boolean>
```

`Connectivity` is the interface behind it (`online` + `onReconnect`), and
`ALWAYS_ONLINE` is the idle implementation used when nothing else is provided — a
handle on `'always'` reads neither, so the default costs nothing.

```ts
// A banner driven by the same state the library acts on.
@Component({
  template: `@if (!online()) {
    <p>Offline — changes will be sent when you reconnect.</p>
  }`,
})
export class OfflineBanner {
  readonly online = inject(OnlineManager).online;
}
```

The state means **an interface is up**, which is not the same claim as "a request
will be routed": DNS, a captive portal, a VPN or the route to your API can all fail
with an interface present. Treat `'online'` as permission to stop holding, not as a
guarantee — the request that starts on reconnect can still fail, and `RequestError`
still says how.

### Mutations queued offline

With `networkMode: 'online'`, `run()` while offline does not send and does not
reject: the call is queued, `paused()` is `true`, `status()` is `'loading'`, the
promise stays pending, and the call counts as in flight (`isMutating()` is `true`).
On the next reconnect the queue is replayed **in the order the calls were made**,
honouring the same `concurrency` mode as an online call:

- `parallel` (the default) replays every queued call.
- `exhaust` returns the promise of the call already queued instead of adding one.
- `switch` cancels the previously queued call with `RequestCancelledError`.

`onMutate` and the optimistic write run at `run()`, so the UI updates immediately;
`onSuccess` and `invalidates` run after the replayed call actually succeeds. The
optimistic write is rolled back only on a final failure or a cancellation. A replay
that fails because the connection dropped again goes **back into the queue** rather
than reporting an error — the next reconnect is the retry.

```ts
const add = createMutation<Todo, string>((title) => ({ url: '/todos', body: { title } }), {
  networkMode: 'online',
  optimistic: (list, title) => [{ title }, ...(list ?? [])],
});

add.run('Buy milk'); // offline: queued, list already shows it, promise pending
add.cancel(); // rejects with RequestCancelledError, list rolls back
```

The queue lives in memory and **does not survive a reload** — see Known limitations.
`'offlineFirst'` is query-only: a mutation has no cached value to show first, so
`MutationOptions.networkMode` is typed as `Exclude<NetworkMode, 'offlineFirst'>`.

## Auth: reactive headers + a refresh interceptor

`baseUrl` is merged into the url _before_ `HttpClient`, so interceptors see the
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

Token _refresh_ stays in an interceptor, where it belongs — the concurrency,
storage and loop-guard decisions are yours, not the library's:

```ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthStore);
  if (req.context.get(SKIP_AUTH) || !req.url.startsWith(API)) return next(req);

  const authorized = next(req.clone({ setHeaders: { Authorization: `Bearer ${auth.token()}` } }));

  return authorized.pipe(
    catchError((err) =>
      err.status === 401
        ? from(auth.refreshOnce()).pipe(
            switchMap((token) =>
              next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })),
            ),
          )
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
user = createRequest<User>('/me');
posts = createRequest<Post[], void>(
  (_params, ctx) => `/users/${ctx.chain(this.user.resource)!.id}/posts`,
);

// Polling (visible tab only), switched on and off reactively
status = createRequest<Job>(() => `/jobs/${this.id()}`, {
  pollInterval: () => (this.running() ? 2000 : false),
});

// Optimistic update, with the undo handled for you
this.add = createMutation<Todo[], Todo>((draft) => ({ url: '/todos', body: draft }), {
  optimistic: (todos, d) => [...(todos ?? []), d],
  target: this.todos,
  invalidates: () => [this.todos],
});
```

### Aggregating several requests

`combine` merges handles into one aggregate. The trivial case is a one-line
`computed`; the reason it exists is the parts that are not — `loading`, `error`,
`status` and `reload` across a set, which every caller would otherwise write by
hand and get subtly wrong.

```ts
readonly user  = createRequest<User>('/me');
readonly posts = createRequest<Post[]>('/posts');

readonly view = combine({ user: this.user, posts: this.posts });
view.response();  // { user: User | undefined; posts: Post[] | undefined }
view.loading();   // any of them
view.error();     // the first failure, in source order
view.status();    // 'loading' | 'reloading' | 'resolved' | 'error' | 'idle'
view.reload();    // all of them
```

An array is combined positionally:

```ts
readonly rows = combine(ids.map((id) => this.rowFor(id)));  // readonly (Row | undefined)[]
```

Three things the aggregate gets right that a hand-written one usually does not:

- **`reload()` asks every source.** `some()`-style short-circuiting reports
  success while leaving half the screen stale.
- **`error()` is the _first_ failure in source order**, and it goes away when
  that failure does. Five queries on one screen should not mean five toasts.
- **`status()` is `'reloading'` only when nothing is _missing_.** One source
  still empty means the screen is not ready, however much of it is filled in.

`combine` does not own the handles you give it — their injectors destroy them —
so it has no `destroy()`.

### `createRequests` — a request per item

For a list that grows and shrinks, `createRequests` keeps one handle per item:

```ts
readonly rows = createRequests(
  () => this.selectedIds(),
  (id) => createRequest<Row[]>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
);

rows.response();  // readonly (Row[] | undefined)[], in item order
rows.handles();   // the per-item handles
rows.loading();   // any of them
```

A handle is built once per item **identity** and reused, so adding one id to a
list of twenty touches one handle, not twenty — with the cache, tearing down and
re-subscribing every entry on every keystroke would drop each one to zero
observers and immediately rejoin it. Identity is `Object.is` on the item, which
is right for the usual list of ids; pass `key` when the items are objects whose
identity is not stable:

```ts
createRequests(() => this.rows(), (row) => …, { key: (row) => row.id })
```

Items that leave the list have their handle destroyed, which releases the cache
entry's subscription. The entry itself survives, with its own `gcTime` — an item
scrolling out of a selection is not a reason to evict data.

### Transforming the response

Use `.select()`. It is a **method** rather than an option, and the reason is a
hard TypeScript limitation rather than taste: there is no _partial type-argument
inference_. Naming one type argument makes every other type parameter fall back
to its default instead of being inferred:

```ts
createRequest<User[]>(url, { select: (users) => users.length }); // never infers `number`
```

Naming `User[]` there has already switched inference off, and a selector type
parameter with no default is not a way out — TypeScript then insists you supply
it (`Expected 3 type arguments, but got 1`). A method has neither problem, since
`S` is the only type parameter in play at that call site:

```ts
readonly users  = createRequest<User[]>('/users', { initialValue: [] });
readonly names  = this.users.select((users) => users.map((u) => u.name));
// Signal<string[] | undefined>
```

The selector is only called when there is data — `undefined` in, `undefined` out
— so it never needs an "is there anything yet" guard.

A bare `computed(() => this.users.response()?.map((u) => u.name))` already
memoizes and already stops propagation when the result is `Object.is`-equal. What
it cannot do is use a _different_ equality, which is exactly what a selector
returning a rebuilt object needs:

```ts
readonly view = this.user.select(
  (u) => ({ label: u.name, tone: u.banned ? 'bad' : 'ok' }),
  { equal: (a, b) => a.label === b.label && a.tone === b.tone },
);
```

Without that `equal`, a response that changed some unrelated field still wakes
every consumer, because `{ label, tone }` is a new object every time.

`select` also exists on `createInfiniteRequest`, where it always has something to
project — an empty accumulation is `[]`, not `undefined`, so its result is never
`undefined` either.

## Testing

`ng-signal-request/testing` publishes the helpers, so you do not have to
rediscover the flushing rules:

```ts
import { fail, respond, settle, setup } from 'ng-signal-request/testing';

const { http, create } = setup();
const list = create(() => createRequest<Item[]>('/items'));

await settle();
await respond(http, '/items', [{ id: 1 }]); // flush + settle
expect(list.response()).toEqual([{ id: 1 }]);

await fail(http, '/items', 500);
expect(list.requestError()?.kind).toBe('http');
```

| Export                                 |                                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `setup(extraProviders?)`               | Configures TestBed with `HttpClient` + `HttpTestingController`; returns `{ http, create }` where `create` runs in an injection context |
| `settle(rounds = 10)`                  | Lets effects and async loaders finish. Uses only `TestBed.tick()` and microtasks, so it works under fake timers                        |
| `respond(http, url, body)`             | Answers the next matching request and waits                                                                                            |
| `fail(http, url, status = 500, body?)` | Fails the next matching request (`statusText: 'Error'`, default body `{ message: 'boom' }`) and waits                                  |
| `isHttpError(e)`                       | `e is HttpErrorResponse` guard                                                                                                         |

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

On the **cached** path, add `'setInterval'` and `'clearInterval'` to `toFake`:
RxJS' async scheduler drives a delayed retry through an interval, so faking only
`setTimeout` leaves the retry sitting on a real timer, and the test hangs waiting
for a request that never arrives.

## Coverage

`pnpm test` runs v8 coverage and fails if the totals drop below the thresholds in
`angular.json` (`90%` statements, `85%` branches, `90%` functions, `90%` lines).
Current totals are ~97% statements, ~93% branches, ~98% functions and ~99% lines,
so the distance to the threshold is the regression margin rather than the target.
The gate is verified rather than trusted: raising a threshold above the current
number fails the run with
`ERROR: Coverage for lines (…) does not meet global threshold`.

The exact figures, the commands behind them, and what they do _not_ prove are in
[`docs/verification.md`](docs/verification.md). The `resolve()` benchmark, with a
measured before/after for the `maxEntries` work, is in
[`docs/perf.md`](docs/perf.md).

## Persistence across reloads

`ng-signal-request/persist` writes the cache to storage and reads it back, so a
reload starts with data instead of a spinner:

```ts
bootstrapApplication(App, {
  providers: [
    provideHttpClient(),
    providePersistedCache({
      maxAge: 24 * 60 * 60_000, // don't restore what is a day old
      codec: dateRevivingCodec, // ISO strings -> Date, on the way back
    }),
  ],
});
```

That is the whole setup. `providePersistedCache` hydrates during injector
creation — before any component exists, and therefore before any request can
resolve — so the first render reads restored data. There is no ordering rule to
get right and nothing to remember in `main.ts`.

| Option                |                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`             | Defaults to `localStorage` where it is reachable, `null` (disabled) everywhere else. Pass `sessionStorage`, `indexedDbStorage()`, an in-memory object, or `null`.  |
| `key`                 | Storage key. Default `'ng-signal-request'`.                                                                                                                        |
| `include` / `exclude` | Which keys are written — the same filter vocabulary `QueryClient.invalidate` takes. `exclude` wins.                                                                |
| `dehydrateFilter`     | Which entries are written, by state. Default: has data, is not fetching, is not in an error state. Pass `anyDataDehydrateFilter` for 0.1.0's "anything with data". |
| `codec`               | `{ serialize, deserialize }`, for values JSON cannot carry.                                                                                                        |
| `maxAge`              | Entries older than this are not restored.                                                                                                                          |
| `buster`              | An application-defined stamp for the shape _inside_ the entries. A mismatch drops the snapshot.                                                                    |
| `migrate`             | `(snapshot, fromVersion) => snapshot \| null`, for a snapshot from an older shape.                                                                                 |
| `debounce`            | Write coalescing, default `1000` ms.                                                                                                                               |
| `restoreTimeout`      | How long a restore may hold the first fetch, default `2000` ms. `0` never holds it.                                                                                |

Three details are worth knowing, because each is a bug that is easy to ship:

- **Entries are restored lazily.** `hydrate` stages values; an entry is created
  only when a handle actually asks for the key. Writing straight into the cache
  would create an entry per persisted key at startup, and an entry with no
  observer never gets a `gcTime` timer, so a hundred restored keys would pin a
  hundred entries for the life of the tab.
- **`dataUpdatedAt` is restored with the value.** A value persisted an hour ago
  comes back an hour old, so `staleTime: 60_000` refetches on mount instead of
  trusting it. Calling `setData` here would stamp `Date.now()` and the data
  would look fresh forever.
- **Writes follow responses**, via `QueryCache.subscribeActivity`. A persister
  listening to `subscribeChanges` hears an entry _appear_ — before it has
  fetched — and would write that empty snapshot and never correct it.

```ts
// logout
inject(CACHE_PERSISTER).clear();
```

`createPersister(options)` is the manual form, with `hydrate()` · `persist()` ·
`clear()` · `destroy()`, an `enabled` signal that goes `false` — and every method
a no-op — when there is no usable storage, or when storage starts refusing writes
(`QuotaExceededError`, Safari private mode), and `isRestoring` / `restored()` for
the ordering rule below.

`hydrate()` returns a `number` — how many entries were staged — or a
`Promise<number>`, and **which one is derived from the storage you passed**, not
declared by you. `localStorage`, `sessionStorage` and any storage that returns a
value are read on the current stack, so `const n = createPersister({ storage:
localStorage }).hydrate()` is a `number`, exactly as in 0.1.0; `indexedDbStorage()`
returns an `AsyncCacheStorage`, so its `hydrate()` is a promise, and `await` works on
both. Two spellings keep the union `number | Promise<number>`, because neither can
know what the storage is: annotating the interface (`const p: Persister = …`) and
`inject(CACHE_PERSISTER)`. Say nothing and TypeScript knows. The token spelling is
the one **accepted compile-time break** from 0.1.0; write
`await inject(CACHE_PERSISTER).hydrate()` or use `createPersister({ storage })`
and let inference answer. Nothing changes at runtime.

### Asynchronous storage, and the restore gate

`localStorage` answers immediately, which is why restored data is in place before
anything can look. A storage that cannot — IndexedDB, a `fetch` from a service
worker, anything promise-shaped — answers _after_ the first mount, and the mount has
already started a request of its own by then. Two answers for one key, and nothing
deciding which is the truth.

`indexedDbStorage()` is the ready-made asynchronous storage, for the case
`localStorage` cannot serve: it is capped at a few megabytes, it blocks the main
thread on every write, and it has no notion of size.

```ts
providePersistedCache({
  storage: indexedDbStorage(), // { database, store, version, factory }
  maxAge: 24 * 60 * 60_000,
});
```

The ordering rule is `waitForRestore`, on by default: **while a restore is in
flight, the first fetch of a key waits for it and then decides again.** A seed that
arrived fresh means no fetch at all; a seed that arrived stale means the fetch
happens as usual. `run()` waits too, and re-reads its own plan afterwards, so it
fetches the params as they are when the restore lands rather than the ones it was
called with. Nothing else is held — `reload()`, `invalidate()`, polling and refocus
refetches are explicit instructions that happen after mount.

```ts
// a screen where a paint matters more than the stored value
createRequest<User[]>('/users', { key: () => ['users'], waitForRestore: false });
```

Three things follow from that, and all three are deliberate:

- **The wait is bounded**, by `restoreTimeout` (2000 ms). A storage that never
  answers must not hold a first paint. Reaching the bound opens the gate and applies
  nothing; a read that lands later still seeds, under the rule below.
- **A late seed never clobbers newer data.** A snapshot is what the _last_ session
  fetched, so it is older than an answer already on the wire by construction.
  `cache.seed()` applies a value to an existing entry only when that entry has no
  data yet or the value is strictly newer, so a slow restore can fill a gap but
  cannot undo a response. (`CacheEntry.setData()` remains the way to force a value
  in — it says so, by stamping `Date.now()` and marking the write local.)
- **Writes are serialized.** A promise-returning `setItem` is chained behind the
  previous one, so two writes are never outstanding together; a rejected write
  disables the persister through the same path as a throwing one.

### Snapshot versioning: `buster` and `migrate`

`SNAPSHOT_VERSION` is this library's envelope, and it has not moved: the 0.2.0
additions are optional fields, so a snapshot written by 0.1.0 is still a valid one
to read. The shape _inside_ the entries is yours, and it changes more often than
this library's does.

```ts
providePersistedCache({
  buster: 'posts-v2', // change the string, and every older payload is dropped
  migrate: (snapshot, fromVersion) => (fromVersion === 0 ? upgradeV0(snapshot) : null),
});
```

`buster` is the cheap one: raise it and every snapshot from before it is discarded
on the next load — which is the correct answer when a response's _meaning_ changed
and no migration could know. `migrate` is for a snapshot whose _shape_ changed; it
runs only when the version differs, and a throw or a `null` return discards the
snapshot rather than failing bootstrap. The application that would report such an
error has not started yet, so a bad migration is a cold first paint, not a broken
app. A `buster` mismatch drops a migrated snapshot too: a shape migration knows
nothing about what you put in the responses.

## SSR

`provideCacheTransfer()` moves the cache from a server render into the browser
through `TransferState`, so hydration renders finished data rather than
repeating every request the server already made:

```ts
// app.config.ts — shared by app.config.server.ts and main.ts
export const appConfig: ApplicationConfig = {
  providers: [provideClientHydration(), provideHttpClient(), provideCacheTransfer()],
};
```

On the server it writes the snapshot when the injector is destroyed; on the
client it reads it during injector creation, exactly like the persister. Both
boundaries are the same `dehydrate` / `hydrate` pair, so a codec written for one
works for the other.

The other half is warming the cache during the render:

```ts
// a route resolver
export const userRoute: ResolveFn<PrefetchReport> = () => {
  const users = inject(UsersStore);
  return prefetch([users.list, users.stats]);
};
```

`prefetch` runs every handle and **never rejects**: it resolves with
`{ ok, failures }`. `Promise.all` would reject on the first failure and turn a
render into a 500, even when every other endpoint answered and the page would
have rendered fine with one empty panel. It deliberately does not wait for
`whenStable()` — that never resolves while a request is in flight, which is
exactly what is being waited for.

## Compared with TanStack Query's Angular adapter

The honest framing first: TanStack Query is the reference implementation of this
category, a framework-agnostic core with adapters for React, Vue, Svelte, Solid
and Angular. Adopting it is never a mistake, and if you need what is in the list
below, it is the one to use. The question this table answers is narrower — what
you give up when you stay inside Angular.

| Concern              | Here                                                                                                                                                         | TanStack Query (Angular)                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Runtime dependencies | `tslib` and the Angular peers only                                                                                                                           | `@tanstack/query-core` plus the adapter                                              |
| Describing a request | The request _is_ the options — `url`, `params`, `path`, `headers`, `reportProgress` are routed for you — or, with `createQuery`, a function source           | A `queryFn` you write, plus a `queryKey`                                             |
| Non-HTTP sources     | `createQuery`: IndexedDB, storage, GraphQL, a WASM call, any promise or observable, on the same cache and handle as an HTTP request                          | `queryFn`, which is the only way a query works                                       |
| Uncached requests    | First class: no `key` means Angular's `httpResource`, its own lifetime, no cache entry                                                                       | Not a concept — every query has a key and a cache entry                              |
| Infinite queries     | `createInfiniteRequest`, **one entry per page**, so prefix invalidation and cross-component sharing work on a feed                                           | `injectInfiniteQuery`, one entry per list                                            |
| `select`             | A **method**: `.select(fn, { equal })`, so the handle's own `response()` is untouched                                                                        | An option on the query observer                                                      |
| Persistence          | `/persist`: sync or async storage, a codec, `maxAge`, key filters, `buster`/`migrate`, and a `TransferState` path for SSR                                    | `persistQueryClient`: async storages, `maxAge`, busters, migrations                  |
| Devtools             | `/devtools`, 4.0 KB gzip, per-entry preview, timings, observers, retries and actions, imported in dev only                                                   | A mature panel with a query explorer, timeline and plugins                           |
| Bounding the cache   | `maxEntries`, LRU over idle entries only, with a per-request value that can tighten it                                                                       | `gcTime` per query, plus explicit removal                                            |
| Invalidating by key  | `invalidates: [['users']]` refreshes every open `['users', …]` query                                                                                         | `invalidateQueries({ queryKey })`                                                    |
| SSR                  | `providedIn: 'root'` already means one cache per render, with `TransferState` hydration                                                                      | A `QueryClient` you create per request in the server handler                         |
| Errors               | A normalized `RequestError` view with per-kind predicates (`http()`, `timeout()`, `network()`, …) and a `message` getter, so templates do not need `@switch` | `Error`, narrowed by hand                                                            |
| Timeouts             | `timeout` per request, classified as its own kind, and `retryTimeouts: false` to stop a timeout from being retried as a `status: 0` failure                  | No built-in timeout; abandoned by composing an `AbortSignal`                         |
| Offline              | `networkMode` on queries and mutations, a paused state, and an in-memory mutation queue replayed in call order on reconnect                                  | `onlineManager` + `networkMode`, paused mutations, and persisted mutation resumption |
| Framework scope      | Angular 22                                                                                                                                                   | React, Vue, Svelte, Solid, Angular                                                   |

Where TanStack Query is simply ahead, with no clever reframing:

- **Offline mutations that survive a reload.** Both libraries queue a mutation made
  offline and replay it on reconnect. TanStack's persistence plugins can also write
  that queue to storage, so the write survives a page close; here the queue is
  in-memory by design (see Known limitations), and an application that needs more
  keeps its own outbox.
- **Persistence breadth.** `/persist` has `localStorage`-shaped storages plus
  `indexedDbStorage()`, with `maxAge`, `buster`, `migrate` and key/state filters.
  `persistQueryClient` still has more storage adapters, and a broader
  subscribe-and-write model, and it is the mature one of the two.
- **A `queryFn` is the default, not an alternative.** `createQuery` closes the
  functional gap — any promise or observable is a query now, and it shares entries
  with the HTTP path — but TanStack's function-first design means its docs, its
  typed `queryOptions` helper and its plugin ecosystem all assume it. Here the
  declarative HTTP request is still the primary path and `createQuery` is the way
  out when your data is not behind `HttpClient`. Observable sources are also
  first-emission-only here; neither library streams into one cached value.
- **Devtools polish and ecosystem.** The panel now answers value, timings,
  observers, retries and seed origin, and has the cache actions a debugging
  session needs. TanStack's explorer, timeline, persisted settings and plugin
  ecosystem are still deeper, and it has years of answered questions behind it.

Where this library is ahead, in an Angular-only codebase:

- **No added runtime dependency**, and `httpResource` does the work when there is
  nothing to share, so the uncached path is the Angular team's code, not ours.
- **Requests are declarative.** `params` routes itself to the query string,
  `{id}` in `path` is interpolated, `headers` merge with the global ones, and
  `reportProgress` finds an XHR backend. None of that is `queryFn` code.
- **Keyless is a first-class mode.** Most screens have requests nobody shares;
  you do not have to invent a key for them, or reason about an entry that
  outlives the component that asked for it.
- **One handle either way.** `createRequest(url)` and
  `createRequest(url, { key })` are the same type; the difference is a key.
- **Per-handle `select` and `equal`**, so each consumer keeps its own projection
  and its own equality without touching the shared value.
- **SSR with nothing to remember**: `root` in this library is per render.

Vocabularies, so the two do not fight in your head:

| TanStack Query                                                                        | Here                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `queryKey`                                                                            | `key`                                                                                                            |
| `queryFn`                                                                             | the source: a `url`, a `(params, ctx) => url`, or `createQuery`'s `(params, ctx) => Promise<T> \| Observable<T>` |
| `staleTime`, `gcTime`, `refetchOnMount`, `refetchOnWindowFocus`, `refetchOnReconnect` | the same names, the same meanings                                                                                |
| `enabled: false`                                                                      | `params` set to `undefined` — `status() === 'idle'`                                                              |
| `placeholderData` / `keepPreviousData`                                                | `keepPreviousValue`                                                                                              |
| `initialData`, `initialDataUpdatedAt`                                                 | `initialValue`, and `cache().seed(key, value, dataUpdatedAt)`                                                    |
| `queryClient.setQueryData` / `getQueryData`                                           | `client.setData` / `client.getData`, `cache().peek`                                                              |
| `useIsMutating` / `mutationKey`                                                       | `client.isMutating(filter)` / `mutationKey`                                                                      |
| `onMutate` + manual rollback                                                          | `optimistic` + automatic rollback                                                                                |
| `onlineManager.setEventListener` / `onlineManager.setOnline`                          | `OnlineManager.setOnline` (a test seam; the window events are wired already)                                     |
| `networkMode: 'online' / 'offlineFirst' / 'always'`                                   | the same names; `offlineFirst` is query-only, mutations accept `online` / `always`                               |
| `useIsFetching`                                                                       | `client.isFetching`, and `client.isPaused` for the offline case                                                  |
| `hydrate` / `dehydrate`                                                               | `hydrate` / `dehydrate` in `/persist`                                                                            |
| `queryClient.invalidateQueries`                                                       | `client.invalidate`, `invalidates` on a mutation                                                                 |

## Upgrading from 0.0.x

**Nothing you wrote has to change.** 0.1.0 is additive: the public API of 0.0.4 is
still there, name for name, and a handle with no `key` behaves exactly as it did.
That is checked rather than asserted — diffing the export list of `public-api.ts`
between the `v0.0.4` tag and 0.1.0 gives **0 removed, 40 added**.

What is new is everything on this page from "Cache" onwards: `key`, `QueryCache`,
`QueryClient`, `invalidates` by key, `mutationKey` / `isMutating`, `optimistic`
by key, `createInfiniteRequest`, `select()`, `combine()`, `createRequests()`,
`/devtools` and `/persist`.

Two documented behaviours changed, and both were corrections rather than new
rules — if you read the old README, this is the diff:

| The old README said                                                                                      | Now                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Requests are **not** deduplicated — two components asking for the same url each fire their own request" | Still true **without a `key`**. Give the request a `key` and one entry is shared, so two components cost one request |
| "There is no `select` option and no infinite-query primitive. Both are deliberate"                       | `select()` is a method on every handle; `createInfiniteRequest` exists — see "Infinite scroll"                       |

One widening: `invalidates` used to accept `Reloadable` handles only. It now
accepts **keys as well**, told apart by shape (an array is a key, an object with
`reload` is a handle), so existing arrays-of-handles keep working unchanged.

If you use `@tanstack/angular-query-experimental`, the table in the previous
section is the migration map; there is no codemod, because the shapes are close
enough that the translation is mechanical.

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
  **second** argument; the first one is `params`. On the **cached** path it is
  unavailable outright, and the error says what to do instead: put the upstream
  value in the key (see "Dependent queries on a cached handle").
- Two combinations print a dev-mode warning, once each per page load, because
  neither is visible at the call site and neither can be a type error without
  splitting an API in two: a `timeout` combined with retry (see "The timeout +
  retry caveat"), and a **non-`lazy`, non-`GET` `createRequest`**. The second one
  is reactive like every other query, so `createRequest.post(...)` re-fires
  whenever a signal its source reads changes — for a write, use `createMutation`
  or `lazy: true`.
- SSR: `pollInterval`, `debounce` and `networkMode` are ignored on the server so
  timers do not hold stability and a render is never paused. Retry delays and
  `timeout` do apply.
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
- A request **without** a `key` is not deduplicated and has no shared cache: two
  components asking for the same url each fire their own request, which is what
  makes the lifetime rule above possible. Giving the request a `key` is the
  opt-in to sharing — see "Cache" above.
- Everything else that used to be missing is now here: `select()` is a method on
  every handle (see "Transforming the response"), `createInfiniteRequest` is the
  infinite-query primitive (see "Infinite scroll"), `combine` / `createRequests`
  aggregate handles, and `/persist` restores the cache across a reload.

## Known limitations

Stated plainly, because a limitation you find out about in production is a bug
report and one you read here is a design decision.

- **The offline mutation queue does not survive a reload.** With
  `networkMode: 'online'`, calls made while offline are replayed on reconnect —
  but they live in the handle's memory. A user who closes the tab (or reloads) with
  writes queued loses them, while the optimistic writes they saw are gone with the
  page. Persisting the queue would need a stable identity for every mutation
  (`mutationKey` is optional and not unique), a write format the library can migrate,
  and a decision about replaying a write whose optimistic state no longer exists;
  those are a storage feature, not a connectivity one, and 0.2.0 does not pretend to
  have them. If losing a write is unacceptable, disable the form while offline,
  keep your own outbox in IndexedDB, or use a service worker's background sync.
- **Importing one factory keeps the whole primary entry point in your bundle.** The
  factories live in one module with module-level tables, so an app that only calls
  `createRequest` still retains the cached path, the infinite path and the mutation
  queue: measured at about **+17.9 KB gzip** over an app without the library, against
  about **+23.8 KB** for the full surface. This is a tree-shaking limitation, not a
  claim that the unused features are free; fixing it needs a module per factory,
  which is a public-API decision for a later release. The measured numbers and the
  budgets are in [Bundle](#bundle).
- **A `createQuery` Observable is a value, not a stream.** The first emission settles
  the entry and the subscription is torn down; later emissions are ignored. There is
  no way to append to a cached value from a live source — streaming would need a
  different cache shape and an answer to what `response()` means while it grows, and
  0.2.0 does not have one.
- **`online` means an interface appeared, not that a request will be routed.** A
  captive portal, a VPN that is down, a DNS failure or an unreachable API all look
  online. `'online'` is permission to stop holding; the request that starts can
  still fail, and `RequestError` classifies it.
- **`onMutate`'s context type is not inferred once you write type arguments.**
  `createMutation` infers `TContext` from `onMutate`, but TypeScript fills any
  type argument you skip with its **default**, so `createMutation<Todo, Draft>(…)`
  locks `TContext` to `undefined` before `onMutate` is looked at. Write it
  explicitly — `createMutation<Todo, Draft, Snapshot>(…)` — or write no type
  arguments at all and let everything infer. A returning `onMutate` in the skipped
  form is a compile error rather than a silently-`unknown` context; capturing the
  options object in a type parameter would do the latter, which is why it is not
  done. (`select()` is a method for the same underlying reason.)
- **An asynchronous restore delays the first fetch of _every_ key, not only of the
  keys the snapshot turns out to carry.** A snapshot is one blob — the set of keys
  inside it is unknown until it has been read and parsed, which is the same instant
  the persister starts seeding — so the gate cannot be asked "does this key have
  stored data?" before the fetch is held. The outcome for a key that has nothing
  stored is unchanged (it still fetches, and still does not fetch _against_ restored
  data); what differs is that its first fetch is delayed by one storage read. The
  delay is bounded by `restoreTimeout`, does not apply to `waitForRestore: false` or
  to a synchronous storage, and is the price of not being able to ask earlier.
- **An asynchronous write is not awaited on teardown.** A promise-returning
  `setItem` is fired when the page is hidden and when the injector is destroyed, but
  nothing blocks on it: a page teardown gives no second chance either way, and
  blocking it would be worse than racing it. `localStorage` writes synchronously
  there, so this only concerns storages that answer with a promise.
- **Two writes can still interleave inside your storage** if its `setItem` resolves
  out of order. `ng-signal-request` serializes its own calls; it cannot serialize
  yours.
- **`indexedDbStorage()` keeps its connection open for the life of the page.** There
  is no owner to hang a `close()` on, and another tab's upgrade closes it anyway —
  noticed, forgotten and reopened on the next call.
- **Errors are HTTP-shaped.** A `queryFn`-style source — GraphQL, IndexedDB, a
  WASM call — is not a query here. Everything goes through `HttpClient`.
- **`status: 0` stays ambiguous.** A CORS block, an extension, offline and a
  transport failure the browser will not name all arrive as `status: 0`. What can
  be distinguished is distinguished (`aborted`, `timeout`, `offline`); nothing is
  invented, and `offline` is present only when the browser is certain.
- **The lint config is strict, and three of its rules are narrowed.** `typescript-eslint`'s
  `strictTypeChecked` plus type-aware linting plus `angular-eslint`, with a written
  reason next to every rule that is not on: `restrict-template-expressions` allows
  numbers and booleans, `no-confusing-void-expression` ignores arrow shorthands, and
  test files turn off the rules that exist to catch test-idiom noise (non-null
  assertions, `unnecessary-*`). Nothing is off globally without one.
- **Coverage is a floor, not a grade.** The thresholds guard against silent
  regression. They say nothing about whether the assertions meant anything.

## API

### `ng-signal-request`

| Export                                                        | Description                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRequest(source, options?)`                             | Reactive `GET` query on top of `httpResource`                                                                                                                       |
| `createRequest.get` / `.post` / `.put` / `.patch` / `.delete` | Verb variants (`.get` is the bare call)                                                                                                                             |
| `createRequest.<verb>.text` / `.blob` / `.arrayBuffer`        | Non-JSON body variants                                                                                                                                              |
| `createMutation(builder, options?)`                           | Imperative `POST` write with its own lifecycle                                                                                                                      |
| `createMutation.post` / `.put` / `.patch` / `.delete`         | Verb variants (`.post` is the bare call)                                                                                                                            |
| `createInfiniteRequest(source, options?)`                     | Paginated query; one cache entry per page, with `createInfiniteRequest.<verb>` and `.<verb>.text` / `.blob` / `.arrayBuffer` variants                               |
| `createQuery(source, options)`                                | Cached query whose source is `(params, ctx) => Promise<T> \| Observable<T>` — for IndexedDB, storage, GraphQL, anything non-HTTP                                    |
| `combine(sources)`                                            | Aggregates handles: `response` · `loading` · `status` · `error` · `reload` · `cancel`                                                                               |
| `createRequests(items, build, options?)`                      | One handle per list item, reconciled by identity                                                                                                                    |
| `provideSignalRequest(config \| () => config)`                | Global `baseUrl`, `retry`, `retryTimeouts`, `networkMode`, `headers`, `onError`, `onSuccess`, and the cache defaults. The factory form runs in an injection context |
| `OnlineManager`                                               | The injectable connectivity source: `online` (signal) · `onReconnect(listener)` · `setOnline(value)` for tests                                                      |
| `ALWAYS_ONLINE`                                               | A `Connectivity` that is always online and has nobody to notify — the default when nothing is provided                                                              |
| `SIGNAL_REQUEST_CONFIG`                                       | The `InjectionToken` behind it                                                                                                                                      |
| `RequestCancelledError`                                       | Thrown by `run()` on cancel / disable / destroy                                                                                                                     |
| `toError(value)`                                              | Normalizes an `unknown` into an `Error` without wrapping an `HttpErrorResponse`                                                                                     |
| `toRequestError(cause, context?)`                             | Normalizes an `unknown` into a `RequestError`                                                                                                                       |
| `requestErrorOf(error, context)`                              | Builds a `requestError`-style accessor for your own `error` signal                                                                                                  |

### Types

| Export                                                              | Description                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `RequestError`                                                      | The discriminated failure union                                    |
| `RequestErrorView`                                                  | `RequestError` plus the per-kind predicates and `message`          |
| `RequestErrorKind` / `RequestErrorOf<K>`                            | The five kinds, and one union member by name                       |
| `RequestErrorContext`                                               | `{ timeout? }` used for timeout classification                     |
| `SignalRequest<T, R, TParams>`                                      | Query handle                                                       |
| `CachedRequest<T, R, TParams>`                                      | Query handle backed by a shared cache entry                        |
| `QueryRequest<T, R, TParams>`                                       | Handle returned by `createQuery` (no HTTP-only state)              |
| `QuerySource<T, TParams>` / `QueryContext<TParams>`                 | The function a query runs, and its `{ signal, params }` context    |
| `QueryOptions<T, TParams>`                                          | Options for `createQuery`                                          |
| `InfiniteRequest<TPage, TParam>`                                    | Paginated handle                                                   |
| `FlattenedPages<TPage>`                                             | What `response()` yields: items for an array page, pages otherwise |
| `Combinable<T>` / `Combined<T>` / `RequestSet<T>`                   | The shapes `combine` and `createRequests` accept and return        |
| `ResponsesOf<TSources>`                                             | Record→responses mapping used by `combine`                         |
| `SelectOptions<S>`                                                  | `{ equal }` for `select()`                                         |
| `SignalMutation<T, TArgs>`                                          | Mutation handle                                                    |
| `RequestOptions<T, TParams, TRaw>` / `MutationOptions<T, TArgs>`    | Option shapes                                                      |
| `CreateRequest` / `CreateRequestFn`                                 | The callable variants and their shapes                             |
| `CreateMutation`                                                    | The mutation variant shape                                         |
| `RequestSource` / `RequestValue` / `RequestConfig` / `ParamsOption` | Source and params description                                      |
| `QueryParams` / `QueryValue` / `PathParams`                         | Parameter helpers                                                  |
| `RetryConfig` / `RetryOptions`                                      | Retry policy                                                       |
| `RequestStatus` / `MutationStatus` / `RunResult<T>`                 | Status and result types                                            |
| `Reloadable` / `OptimisticTarget<T>` / `InvalidationTarget`         | Invalidation, optimistic-update and key shapes                     |
| `SignalRequestConfig`                                               | Global config shape                                                |
| `NetworkMode`                                                       | `'online'` · `'always'` · `'offlineFirst'`                         |
| `Connectivity`                                                      | `{ online: Signal<boolean>; onReconnect(listener): () => void }`   |

### Cache

| Export                                                                  | Description                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryClient`                                                           | Injectable: `invalidate` · `refetch` · `cancel` · `getData` · `setData` · `remove` · `evict` · `size` · `isFetching` · `isPaused` · `isAnythingPaused` · `count` · `clear` · `isMutating` · `mutatingCount`                                 |
| `MutationRegistry`                                                      | In-flight and paused mutation counts, globally and per `mutationKey`                                                                                                                                                                        |
| `QueryCache`                                                            | The store: `resolve` · `peek` · `matching` · `markInvalidated` · `remove` · `removeExact` · `evictIdle` · `size` · `maxEntries` · `tightenMaxEntries` · `all` · `subscribeChanges` · `clear`                                                |
| `CacheEntry`                                                            | One cached resource: `data` · `status` signals, `refetch()` · `subscribe()` · `setData()` · `evict()` · `isStale()`, `seeded` · `observerCount` · `hasPlan` · `planKind` diagnostics. History is read from `DevtoolsHistory`, not the entry |
| `QueryKey` / `QueryKeyFactory` / `QueryKeyFilter` / `QueryKeyPredicate` | Key shapes and the matching filter                                                                                                                                                                                                          |
| `normalizeKey` · `matchesFilter` · `startsWith` · `formatKey`           | Key helpers, exported for devtools and custom stores                                                                                                                                                                                        |
| `FetchAttempt` / `RetryEvent` / `FetchOutcome`                          | One settled fetch (start, duration, outcome) and one scheduled retry, as recorded on an entry                                                                                                                                               |
| `defaultStructuralSharing` · `StructuralSharingFn`                      | The default sharing walk, and its type                                                                                                                                                                                                      |
| `CachedRequest` / `CachedRequestOptions` / `CacheOptions`               | The cached handle and its options                                                                                                                                                                                                           |
| `RefetchOnMount`                                                        | `'stale'` · `'always'` · `false`                                                                                                                                                                                                            |
| `RESTORE_GATE` / `RestoreGate` / `IDLE_RESTORE_GATE`                    | How a cached request learns that a restore is in flight, without the core knowing about storage                                                                                                                                             |

### `ng-signal-request/testing`

`setup` · `settle` · `respond` · `fail` · `isHttpError` · `cache` · `advanceClock` · `TestSetup` · `ChildScope`

### `ng-signal-request/devtools`

`QueryDevtools` · `DevtoolsPanel` · `DevtoolsHistory` · `provideDevtoolsHistory` · `snapshotEntries` · `DevtoolsEntry` · `DevtoolsStatus` · `SnapshotOptions`

### `ng-signal-request/persist`

`providePersistedCache` · `createPersister` · `CACHE_PERSISTER` · `Persister` · `PersistOptions` · `CacheStorage` · `AsyncCacheStorage` · `RestoreOf` · `indexedDbStorage` · `IndexedDbStorageOptions` · `dehydrate` · `defaultDehydrateFilter` · `anyDataDehydrateFilter` · `DehydratePredicate` · `DehydrateOptions` · `hydrate` · `HydrateOptions` · `CacheSnapshot` · `CacheSnapshotEntry` · `SNAPSHOT_VERSION` · `SnapshotCodec` · `dateRevivingCodec` · `provideCacheTransfer` · `CACHE_TRANSFER_KEY` · `CacheTransferOptions` · `prefetch` · `Prefetchable` · `PrefetchReport`

## Devtools

A separate entry point, and that is the feature rather than packaging detail:

```ts
import { QueryDevtools, DevtoolsPanel } from 'ng-signal-request/devtools';

// in a dev-only shell component
@Component({ imports: [DevtoolsPanel], template: `<ngsr-devtools />` })
export class DevShell {}
```

History is opt-in, because keeping per-entry attempts, retries and observer
names is a cost every application would otherwise pay for a panel it may never
open. Add the provider at the application root, before the first keyed handle is
created:

```ts
import { provideDevtoolsHistory } from 'ng-signal-request/devtools';

bootstrapApplication(App, {
  providers: [provideHttpClient(), provideDevtoolsHistory()],
});
```

The panel itself works without it; the history columns are then empty. History
does not live on `CacheEntry`: `DevtoolsHistory` owns a
`WeakMap<CacheEntry, History>`, caps attempts and retries at ten each, and is
collected with the entry. The sink records from the moment the provider exists.
Opening the panel later is fine, but it cannot backfill entries that were
already created before the provider, because those entries never received the
sink. A free `snapshotEntries(cache)` call omits history unless you pass the
reader: `snapshotEntries(cache, { history: inject(DevtoolsHistory) })`.

`DevtoolsPanel` is a small, unstyled table of the cache, fixed to the bottom
right and collapsed to a `cache 3` button until clicked. Every row has a
`details` toggle that opens a second row with the current value preview (capped
at 200 characters, with the full JSON size next to it), the plan kind, whether
the value came from a seed, the observer `debugName`s, the last ten fetch
timings/outcomes and the last ten scheduled retries. `QueryDevtools` is the
headless part:

| Member                                         |                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `entries()`                                    | live snapshot: key, status, observers, fetch count, age, retry, error, paused, plan kind, seed origin, attempts and retry history |
| `online()` / `isRestoring()`                   | the library's own connectivity and restore-gate state, so the panel cannot disagree with it                                       |
| `count()` / `fetching()`                       | totals, without building the full snapshot                                                                                        |
| `isOpen()` · `open()` · `close()` · `toggle()` | panel state                                                                                                                       |
| `invalidate(entry)` / `refetch(entry)`         | by key, like `QueryClient`: the row's key and its children                                                                        |
| `cancel(entry)`                                | aborts the in-flight request for that key and its children                                                                        |
| `markStale(entry)` / `remove(entry)`           | **exactly** this row: mark it invalidated without a refetch, or remove it without taking sibling child keys                       |
| `log()`                                        | `console.table` of the current snapshot                                                                                           |
| `logChanges()`                                 | logs one line per change — `+ key`, `- key`, a fetch, a status move — until the returned function is called                       |

`snapshotEntries(cache, { filter?, now?, preview? })` builds a snapshot without
the service, for a test or a custom panel. `preview` is off by default: the
panel turns it on only while it is open, because serializing a large payload is
the one cost that scales with the value. A circular value or a symbol becomes
`[unserializable]`; the preview never throws.

`entries()` is a `computed` over the entries' own signals — no polling, no
interval to forget to clear. The header shows the entry count against
`maxEntries` when one is set, flags an overshoot, and marks `(offline)` and
`(restoring)` from the same managers the requests use.

**It costs nothing when unused.** The entry point is its own bundle and the
primary entry point never imports it, so an application that does not write the
import above ships none of it — there is no production flag to get wrong and no
branch that could be mis-trimmed. The production demo deliberately does not
render the panel; `check:dist` asserts that none of the devtools strings reach
its output. The positive control is `projects/probe/src/main-devtools.ts`, a
minimal app that does render `<ngsr-devtools />` and is built with the probes.

```ts
// what the check is, in one line
expect(demoBundle).not.toContain('no cached queries');
```

Two things the panel reports that deserve a word:

- **`observers` and `observerNames` can lag by one change-detection pass.**
  Subscription bookkeeping is not a signal, because a template should not be
  able to depend on it. Everything else in the table is exact.
- **`'ready'` is not the same as fresh.** Real staleness depends on the
  `staleTime` of whichever handle is asking, which is a per-handle decision the
  entry deliberately does not know, so a panel claiming to judge it would be
  guessing. `'invalidated'` is reported exactly, and `age` is the honest
  substitute.

The panel is a debugging aid, not an object inspector: it shows a JSON preview,
not a lazily expandable tree, and it has no timeline or persisted settings. Those
are deliberate omissions, not a claim that a bigger panel would be worse.

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
pnpm build         # build the library into dist/signal-request
pnpm test          # unit tests (vitest, headless, coverage thresholds)
pnpm typecheck     # tsc --noEmit over the lib, spec, devtools and demo projects
pnpm lint          # eslint, type-aware, over every file
pnpm format        # prettier --write
pnpm watch         # rebuild on change (development configuration)
pnpm verify        # typecheck + lint + format:check + test + build + check:types-compat + build:demo + check:dist
pnpm check:dist    # post-build assertions (see "Bundle" below)
pnpm check:api     # export diff against a git ref: `pnpm check:api v0.1.0`
pnpm check:types-compat  # compile the 0.1.0 compatibility fixture against the build
pnpm bench         # the resolve() benchmark at 200k iterations (see docs/perf.md)
pnpm test:e2e      # Playwright against the production demo (needs `pnpm exec playwright install chromium`)
```

`pnpm test:e2e` is deliberately outside `pnpm verify`: it downloads a browser and
takes longer than the rest of the gate together. CI runs it as a separate job. It
needs a built demo first, which the script does itself; the API is mocked at the
network layer, so it does not depend on jsonplaceholder being reachable. See
[Step B2 in the design notes](docs/design-0.2.md) for what it found that the fake
`OnlineManager` could not.

`pnpm lint` and `pnpm format:check` are part of `pnpm verify` and of CI, so a pull
request cannot land a lint error or a formatting difference. The config is
`eslint.config.mjs`: `typescript-eslint`'s `strictTypeChecked` with type-aware
linting, `angular-eslint` for templates, and `eslint-config-prettier` last so the
two never disagree. Every rule that is not on has a written reason next to it.

`pnpm check:api` fails only when a name that existed before is gone, so it is the
command behind every "no breaking change" claim in this repository. Its output is
recorded in [`docs/verification.md`](docs/verification.md).

`pnpm check:api` answers a narrower question than it sounds like it does, though. A
name can survive and still become unusable, because the shape behind it changed —
which is exactly what widening `Persister.hydrate()` did. So `pnpm check:types-compat`
compiles [`compat/v0.1.0/usage.ts`](compat/v0.1.0/usage.ts): code written against the
**0.1.0 public API only**, across all four entry points, in strict mode, against the
**built** declarations. It is the same kind of claim, made one level down, and it is
part of `pnpm verify`. Where a 0.1.0 spelling could not be kept, it is written behind
a load-bearing `// @ts-expect-error` that names the accepted break, so a later change
that quietly restores it fails the check and the exception gets removed with it.

> On Windows, `packageManager` pins a pnpm version newer than the one on
> `PATH`. If `pnpm install` fails with _"is not recognized as an internal or
> external command"_, that pnpm self-management shim is broken - run the
> command through Corepack instead: `corepack pnpm install`.

## Bundle

The library ships as four entry points, and the split is load-bearing rather
than cosmetic. Sizes are the gzipped ESM bundles from a production build:

| Entry point                  | Size        | When it is in an application |
| ---------------------------- | ----------- | ---------------------------- |
| `ng-signal-request`          | **20.9 KB** | always                       |
| `ng-signal-request/devtools` | 4.0 KB      | only if imported             |
| `ng-signal-request/persist`  | 3.7 KB      | only if imported             |
| `ng-signal-request/testing`  | 0.8 KB      | only in tests                |

The primary entry point has no imports from the other three and `sideEffects` is
`false`, so an application that never writes those imports never links the code.
`pnpm check:dist` asserts this against a real production build: the demo is
compiled, and the output is required to contain core strings and none of the
`/devtools` or `/persist` ones. It also scans each entry point's own bundle for the
other three's strings, so a cross-entry `import` is caught even when nothing in the
demo exercises the pair. The reason to test it rather than trust it is that
"separate entry point" is an intention and a bundle scan is a fact.

Those numbers are what ships. What an application **retains** is a different
measurement, and until 0.2.0 it was never taken. `projects/probe` contains five
minimal production apps that differ only in their imports; `check:dist` builds them
and compares gzip sizes against the one without the library:

| Probe      | What it imports                                               | Over the control |
| ---------- | ------------------------------------------------------------- | ---------------- |
| `request`  | one uncached `createRequest`                                  | **+17.9 KB**     |
| `keyed`    | a keyed `createRequest` and `QueryClient`                     | **+18.6 KB**     |
| `full`     | every core factory and the `/persist` + `/devtools` entries   | **+23.8 KB**     |
| `devtools` | a keyed request with history opted in and `<ngsr-devtools />` | **+28.2 KB**     |

The unkeyed request probe fell from +21.4 KB to +17.9 KB after the module-level
factory tables were marked `/*#__PURE__*/`. The unused `createInfiniteRequest`
and `createMutation` tables - and the injectables only they reached - are now
dropped. What remains is the cached engine itself: `createRequest` has keyed
overloads, and its runtime branch imports that engine statically, so an app that
only uses the uncached path still links it. Removing that last gap would mean a
module per factory or a separate cached entry point, both public-API decisions
reserved for a later release. The `devtools` row is a positive control for the
secondary entry point, not part of that core comparison: it pays for the panel on
purpose.

Budgets, so growth is a decision rather than a surprise: the primary entry point
is not allowed past **21.5 KB gzip** (raised from 20 KB by 0.2.0's `createQuery`;
the measured 20.9 and the reasoning are in `docs/design-0.2.md`), and any
secondary entry point past **15 KB gzip**. The probe release budgets are unchanged
(`request` and `keyed` 22.5 KB over the control, `full` 24 KB, `devtools` 32.5 KB);
`check:dist` now also enforces tighter regression limits of **18.4 / 19.2 / 24 /
28.8 KB**. `pnpm attribution` prints the per-module retained bytes behind the
request probe, and `pnpm check:dist` prints every number on each run.

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
- [Changelog](https://github.com/theunal/ng-signal-request/blob/main/CHANGELOG.md)
- [License (MIT)](./LICENSE)
