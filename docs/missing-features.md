# Missing and Partially Implemented Features

> **Scope.** This document inventories what `ng-signal-request@0.2.0` does not do, or
> does only with a stated constraint. It is based on the shipped public surface and
> the repository's own design and verification records. It is **not a roadmap**:
> an item appearing here is not a promise that it will be implemented.
>
> **Audited revision.** Repository `d2e6128`; npm release `0.2.0`.
>
> **Sources.** `README.md` (especially "Known limitations", "Behavior notes and
> limits", "Devtools" and "Bundle"), `docs/design-0.2.md`,
> `docs/verification.md`, `CHANGELOG.md`, `projects/signal-request/src/lib/types.ts`,
> `projects/signal-request/persist/persist.ts`, `e2e/offline.spec.ts` and
> `e2e/playwright.config.ts`.

## Status vocabulary

| Status                 | Meaning                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Missing**            | There is no public API or behaviour for it.                                                                            |
| **Partial**            | A feature exists, but an important case, input, platform or guarantee is not covered.                                  |
| **By design**          | The absence is deliberate and documented. It is a product boundary, not a defect.                                      |
| **Documentation debt** | The behaviour exists, but a document or source comment describes an older or contradictory state.                      |
| **Not provided**       | No API is offered, but the repository does not claim it should be. Use an application-level or Angular-level solution. |

Impact is an assessment of the cost when the gap is hit:

- **High** — can lose user writes, duplicate a write, or produce a surprising request.
- **Medium** — a workaround exists, or the gap affects a common but not universal case.
- **Low** — API ergonomics, diagnostics, or an edge case.

## Summary

| #   | Area        | Gap                                                                             | Status              | Impact |
| --- | ----------- | ------------------------------------------------------------------------------- | ------------------- | ------ |
| 1   | Offline     | Mutation queue does not survive a reload                                        | Missing — by design | High   |
| 2   | Offline     | No cross-tab queue coordination or background replay                            | Missing             | High   |
| 3   | Offline     | Queue cannot be listed, inspected or manually resumed                           | Missing             | Medium |
| 4   | Offline     | `offlineFirst` is not available for mutations                                   | By design           | Low    |
| 5   | Offline     | Connectivity means "an interface is up", not "the API is reachable"             | Partial             | Medium |
| 6   | Cache       | One primary entry point; importing one factory retains the whole core           | Partial             | Medium |
| 7   | Cache       | Per-request `maxEntries` can only tighten the global cap                        | Partial             | Low    |
| 8   | Cache       | Eviction is LRU over idle entries only; a live cache can overshoot              | Partial             | Low    |
| 9   | Cache       | No normalized/entity cache or automatic cross-query update                      | By design           | Low    |
| 10  | Cache       | No cross-tab cache synchronisation                                              | Missing             | Medium |
| 11  | Cache       | Persistence is one snapshot blob; no per-key or partial hydration               | Partial             | Medium |
| 12  | Cache       | No `placeholderData` callback; only `initialValue` and `keepPreviousValue`      | Missing             | Low    |
| 13  | Cache       | `QueryClient` has no key-based `ensure`/`prefetch`/state/defaults helpers       | Partial             | Low    |
| 14  | Infinite    | Envelope pages are not flattened; one entry per page, not one list entry        | By design           | Low    |
| 15  | Infinite    | `remove()` is a view reset; `maxPages` releases subscriptions but keeps entries | By design           | Low    |
| 16  | Query       | Query context is only `{ signal, params }`; no client/key/meta context          | Partial             | Low    |
| 17  | Query       | Observable sources are first-emission-only; no streaming/live cache             | Missing — by design | Medium |
| 18  | Query       | Cancellation depends on the source honouring `ctx.signal`                       | Partial             | Low    |
| 19  | Mutations   | No mutation cache, history, global mutation state, or mutation `scope`          | Missing             | Medium |
| 20  | HTTP        | Non-GET `createRequest` is reactive and can fire on unrelated signal changes    | Partial             | High   |
| 21  | HTTP        | `progress()` only works with the XHR backend                                    | Partial             | Medium |
| 22  | HTTP        | `ctx.chain()` is unavailable on cached, lazy and debounced paths                | By design           | Low    |
| 23  | HTTP        | A timeout is retried by default until 0.3.0                                     | Partial             | Medium |
| 24  | HTTP        | `status: 0` cannot distinguish CORS, offline, extension and transport failure   | Partial             | Medium |
| 25  | HTTP        | Token refresh is interceptor-only; mutations do not retry by default            | By design           | Low    |
| 26  | HTTP        | Requests without a `key` are not deduplicated                                   | By design           | Low    |
| 27  | Persistence | Async restore delays the first fetch of every key, not only restored keys       | Partial             | Medium |
| 28  | Persistence | An async write is not awaited on teardown                                       | Partial             | Low    |
| 29  | Persistence | Two storage writes can interleave if the storage resolves out of order          | Partial             | Low    |
| 30  | Persistence | IndexedDB connection stays open for the life of the page                        | Partial             | Low    |
| 31  | SSR         | Transfer cache covers `GET` only; non-GET responses refetch on the client       | Partial             | Medium |
| 32  | SSR         | Polling, debounce and `networkMode` are ignored on the server                   | By design           | Low    |
| 33  | SSR         | Root cache is safe only when one bootstrap instance is used per render          | Partial             | Low    |
| 34  | Devtools    | No browser e2e test for the panel                                               | Partial             | Medium |
| 35  | Devtools    | No timeline, routing, persisted settings or plugin ecosystem                    | By design           | Low    |
| 36  | Devtools    | The value view is a JSON preview, not a lazy object inspector                   | By design           | Low    |
| 37  | Devtools    | A late history provider cannot backfill entries created earlier                 | Partial             | Low    |
| 38  | Devtools    | Observer counts/names can lag one change-detection pass                         | Partial             | Low    |
| 39  | Devtools    | History is capped at ten attempts and ten retries                               | By design           | Low    |
| 40  | Testing     | E2E covers only the offline path; query and devtools demos are not e2e-tested   | Partial             | Medium |
| 41  | Testing     | E2E runs Chromium only                                                          | Partial             | Low    |
| 42  | Testing     | No streaming test because there is no streaming feature                         | By design           | Low    |
| 43  | Types       | `onMutate` context needs an explicit type argument once `T`/`TArgs` are named   | Partial             | Low    |
| 44  | Types       | An explicit `SignalRequest<T>` annotation drops `initialValue` narrowing        | Partial             | Low    |
| 45  | Types       | Naming `TParams` disables inference for the other type arguments                | By design           | Low    |
| 46  | Types       | `retryAttempt()` keeps its value after retries are exhausted                    | By design           | Low    |
| 47  | Types       | `select` is a method, not an option                                             | By design           | Low    |
| 48  | Types       | `QueryRequest` intentionally has no HTTP-only state                             | By design           | Low    |
| 49  | Platform    | Angular 22 is the only supported Angular line                                   | By design           | Medium |
| 50  | Platform    | No React/Vue/Svelte/Solid adapters or migration codemod                         | By design           | Low    |
| 51  | Docs        | README still says a `queryFn`-style source is not a query                       | Documentation debt  | Medium |
| 52  | Docs        | `docs/design.md` still says `maxEntries` is not implemented                     | Documentation debt  | Low    |
| 53  | Docs        | `docs/plan.md` still describes phases 2/3/4/6 as not implemented                | Documentation debt  | Low    |
| 54  | Docs        | A source comment shows `isMutating()` as a boolean, while it returns a signal   | Documentation debt  | Low    |
| 55  | Docs        | Devtools size is stated as both 4.0 KB and 4.5 KB                               | Documentation debt  | Low    |

> **Update, 2026-10-25 — working tree only, not in `0.2.0`.** Item 1 is
> implemented behind an opt-in provider (`ng-signal-request/persist/queue` plus the
> `persistence` mutation option) and is covered by a real-browser e2e: IndexedDB,
> Web Locks, a write that survives the page and replays exactly once, and a
> permanent failure that stays durable. Item 2 is half closed by the same provider:
> ownership is handed to a waiting tab when the owner goes away (§1.2), so delivery
> outlives the owning tab; background replay with no tab open is still missing.
> Item 3 follows from the same provider: the
> queue exposes `entries`, `pendingCount`, `failedCount`, `retry`, `retryAll`,
> `resume`, `remove` and `clear`. Neither is in the published release, and the
> feature stays labelled experimental until the server-side idempotency contract is
> proven, so the table above still describes `0.2.0` - this note is the only place
> the inventory is updated ahead of a release. Measurements and limits:
> `docs/verification.md` §20; design: `docs/design-offline-mutation-queue.md`.

## 1. Offline and mutation delivery

### 1.1 The mutation queue is in memory only

**Status: Missing — by design. Impact: High.**

With `networkMode: 'online'`, a mutation made while offline is queued, its
optimistic write is applied, `paused()` is `true`, and `run()` stays pending until
the connection returns. The queue lives in the handle's memory. A reload or a tab
close loses both the queued call and the optimistic value the user saw.

This is a documented non-goal rather than an oversight: replaying a write after a
reload needs a stable mutation identity (`mutationKey` is optional and not unique),
a snapshot format with migrations, and an answer to whether a write that may already
have reached the server should be replayed. A library cannot invent an
at-least-once guarantee on behalf of the application.

**Workaround.** Disable the form while offline, keep an application-owned outbox in
IndexedDB, or use a service worker with Background Sync. The library deliberately
does not provide any of those.

**Evidence:** `README.md` "Known limitations" (offline queue); `docs/design-0.2.md`
§Phase 2 (`Persisting the mutation queue across a reload is a non-goal`).

### 1.2 No cross-tab queue coordination or background replay

**Status: Missing. Impact: High.**

Each tab has its own in-memory queue. There is no BroadcastChannel, no storage-event
listener, and no service-worker handoff. Two tabs can therefore replay the same
logical work independently, and closing the tab that owns the queue cancels the
delivery with no other owner taking over.

**Workaround.** Use one tab as the writer, a SharedWorker, or an application-level
service-worker queue. The library has no queue identity to coordinate on, so this
cannot be added by the consumer without its own outbox.

**Evidence:** queue ownership is per handle (`create-mutation.ts`); the persistence
module listens only to `pagehide` and `visibilitychange`, not to `storage` or a
BroadcastChannel (`persist/persist.ts`).

> **Update, 2026-10-25 — working tree only, not in `0.2.0`.** The cross-tab half is
> implemented for the durable queue. Web Locks elects a single owner, and a
> non-owner now **queues a request behind the lock** instead of only being refused,
> so when the owner tab closes or crashes the waiting tab becomes the owner,
> hydrates the stored queue and replays it. Delivery therefore outlives the tab
> that accepted the write, which was the high-impact half of this item; it is
> asserted with two real tabs in `e2e/queue.spec.ts`. The background half is still
> missing and stays a non-goal: with no tab open nothing replays, and a non-owner's
> own calls stay in memory. Both need an application-level service worker (or a
> per-entry claim), which the library does not provide. See
> `docs/design-offline-mutation-queue.md` §14 and `docs/verification.md` §20.3.

### 1.3 The queue cannot be listed or manually resumed

**Status: Missing. Impact: Medium.**

`MutationRegistry` exposes counts (`isMutating`, `mutatingCount`, `isPaused`) and
per-key counts, but not the queued calls themselves. There is no public
`resumePausedMutations()`, no list of pending mutation arguments, and no per-entry
callback for "this one is about to replay". A UI that wants to show _which_ writes
are pending has to keep references to every mutation handle itself.

**Workaround.** Hold the mutation handles, or maintain an application-level outbox
that mirrors each `run()`. `isMutating()` is enough for a global "saving…" badge,
not for a pending-writes list.

**Evidence:** `projects/signal-request/src/lib/cache/mutation-registry.ts`;
`QueryClient.isMutating()` / `mutatingCount()` in `query-client.ts`.

### 1.4 `offlineFirst` is not a mutation mode

**Status: By design. Impact: Low.**

`networkMode: 'offlineFirst'` is a query strategy: the first attempt is always sent,
because a service worker, HTTP cache or proxy may answer it; retries wait for a
connection. A mutation has no cached value to serve first, so `MutationOptions`
types the option as `Exclude<NetworkMode, 'offlineFirst'>`. A global `'offlineFirst'`
falls back to `'always'` for mutations.

There is no separate "send once and let the service worker decide" mutation mode.

**Evidence:** `types.ts` `MutationOptions.networkMode`; `README.md` "Offline"
table and mutation notes.

### 1.5 Connectivity is interface-level

**Status: Partial. Impact: Medium.**

`OnlineManager.online()` follows `navigator.onLine` and the window's `online` /
`offline` events. That reports that an interface exists, not that the API is
routable. Captive portals, VPN failures, DNS failures and an unreachable host all
look online. `networkMode: 'online'` is permission to stop holding, not a guarantee
that the request will succeed.

**Workaround.** Treat the first request after reconnect as fallible and surface
`RequestError`. There is no active health check, heartbeat, or configurable
connectivity probe in the library. A custom `OnlineManager` provider can replace the
source, but it must implement the same `Connectivity` contract.

**Evidence:** `README.md` "Known limitations" (`online means an interface appeared`);
`connectivity.ts` comments.

### 1.6 The replay heuristic uses the manager's state to break a `status: 0` tie

**Status: Partial. Impact: Low.**

A replayed mutation that fails with a `network` error is requeued only when
`onlineManager.online()` is `false`; if the manager says online, the failure is
reported as final. This is the only way to distinguish "the connection dropped
again" from "the browser is online but the request was blocked" because both arrive
as `status: 0`. A CORS failure, a DNS failure or an extension block can therefore be
classified as a final failure even though a later retry might have succeeded.

**Workaround.** Use an application-level retry policy for known-flaky endpoints, or
perform an explicit health check before replay.

**Evidence:** `docs/design-0.2.md` Phase 2, "A replay that fails because the
connection dropped again goes back to the queue"; `README.md` `status: 0` limitation.

### 1.7 No service-worker or background-sync integration

**Status: Missing — by design. Impact: Medium.**

The README recommends a service worker's Background Sync as one alternative to the
in-memory queue, but the library does not register one, provide a plugin, or expose
a queue format for one. Background delivery is entirely the application's
responsibility.

**Evidence:** `README.md` offline queue limitation; no service-worker entry point in
`projects/signal-request/package.json`.

## 2. Cache, queries and package shape

### 2.1 Importing one factory retains the whole core entry point

**Status: Partial. Impact: Medium.**

The factories live in one module with module-level tables. Importing only
`createRequest` still retains the cached engine, the infinite path and the mutation
queue. The measured cost is about **+17.6 KB gzip** for an uncached request over an
app without the library, against about **+18.3 KB** for a keyed request and
**+23.5 KB** for the full surface.

Pure annotations removed the unused factory tables, but the cached engine remains
because `createRequest` has keyed overloads and its runtime branch reaches it
statically. A real fix needs a module per factory or a separate cached entry point,
which is a public-API decision reserved for a later release. The offline code also
lives in core because `createRequest` injects `OnlineManager`, so a per-entry budget
cannot prove that a request which never opts into `networkMode` avoids it.

**Workaround.** None at the application level; the library is still small enough for
many apps. The probe measurements are the honest cost.

**Evidence:** `README.md` "Known limitations" and "Bundle"; `docs/design-0.2.md`
"Step B1".

### 2.2 Per-request `maxEntries` can only tighten the global cap

**Status: Partial. Impact: Low.**

There is one cache per application and nothing owns a subset of it. A per-request
`maxEntries` is therefore a budget for the whole cache, and the effective cap is
`min(global, every declared per-request value)`. A screen cannot ask for _more_ room
than the application configured; it has to raise the global value.

This is order-independent by construction, which last-writer-wins would not be, but
it means per-screen budgets are only useful as stricter limits.

**Workaround.** Raise the global cap and use tighter caps on the screens that should
not grow it.

**Evidence:** `types.ts` `CacheOptions.maxEntries`; `docs/design-0.2.md` "Why `min()`
and not a per-request allowance".

### 2.3 LRU only evicts idle entries and can overshoot

**Status: Partial. Impact: Low.**

`maxEntries` is least-recently-used over entries with no subscriber and no request
in flight. It never evicts data a mounted component is reading or a `run()` promise
is waiting on. If every entry is live, the cache overshoots and warns in dev mode
rather than turning a rendered value into a spinner.

This is a correctness-first trade, but it means `maxEntries` is not a hard memory
bound under a workload that keeps more entries live than the cap.

**Workaround.** Keep `maxEntries` above the realistic number of live entries, or
evict explicitly with `QueryClient.evict()`.

**Evidence:** `types.ts` `SignalRequestConfig.maxEntries`; `CHANGELOG.md` 0.2.0
`maxEntries` entry.

### 2.4 No normalized/entity cache

**Status: By design. Impact: Low.**

The cache is a document cache keyed by `QueryKey`; it does not decompose responses
into entities, merge an entity update into every query that contains it, or provide
a schema layer. A mutation that changes one user does not automatically update a
list query that embeds that user; `invalidates` or `setData` is the explicit tool.

TanStack Query is also not a normalized cache, so this is not a parity gap; it is a
boundary against Apollo/Relay-style stores.

**Evidence:** `README.md` "Cache" and "Compared with TanStack Query"; no entity or
normalization API in `public-api.ts`.

### 2.5 No cross-tab cache synchronisation

**Status: Missing. Impact: Medium.**

Two tabs share only what the storage medium shares. There is no `storage` event
listener, BroadcastChannel, or leader election to invalidate a query in tab B when
tab A refetches it. A persisted snapshot is read at startup; later writes in another
tab do not update a running cache.

**Workaround.** Invalidate on focus (`refetchOnWindowFocus`), or add an
application-level BroadcastChannel that calls `QueryClient.invalidate()`.

**Evidence:** `persist/persist.ts` listens to `pagehide` / `visibilitychange` only;
no `storage` event in the repository.

### 2.6 Persistence is one snapshot, not per-key storage

**Status: Partial. Impact: Medium.**

`providePersistedCache` writes one versioned snapshot under one storage key. A
hydrate stages values and creates entries only when a handle asks for the key, which
avoids creating an entry per persisted key, but the snapshot itself is read, parsed
and migrated as one blob. There is no per-key `getItem`/`setItem`, no partial
hydration, and no way to update one persisted entry without rewriting the snapshot.

`include`/`exclude` and `dehydrateFilter` choose what goes into the snapshot; they
do not make it incremental.

**Workaround.** Use a custom `CacheStorage` if the application needs per-key
storage, or accept the full-snapshot cost. The library's `Persister` contract is the
place to implement that.

**Evidence:** `README.md` "Persistence across reloads"; `persist/persist.ts`;
`docs/design-0.2.md` Phase 3.

### 2.7 No `placeholderData` callback

**Status: Missing. Impact: Low.**

`initialValue` is a static value, and `keepPreviousValue` keeps the previous
response across a params change. There is no TanStack-style `placeholderData`
function that derives a temporary value from the previous data, the params and the
query key, with its own "is placeholder" state.

**Workaround.** Use `keepPreviousValue`, hold the previous data in a signal and read
it in the template, or seed the cache explicitly.

**Evidence:** `types.ts` `RequestOptions` / `QueryOptions`; no placeholder field in
the public option types.

### 2.8 `QueryClient` has no key-based ensure/prefetch/state/defaults helpers

**Status: Partial. Impact: Low.**

`QueryClient` exposes `invalidate`, `refetch`, `cancel`, `getData`, `setData`,
`remove`, `evict`, `size`, `isFetching`, `isPaused`, `isAnythingPaused`, `count`,
`clear`, `isMutating` and `mutatingCount`. It does not expose:

- `ensureQueryData` / `fetchQuery` (run a request by key and return data);
- `prefetchQuery` by key (a handle-based `prefetch()` exists, but only in
  `ng-signal-request/persist`);
- `getQueryState` (the cache entry is reachable via `QueryCache.peek`);
- per-key defaults;
- `resetQueries` (use `remove` or `clear`);
- a query observer API.

`prefetch(handles)` is deliberately handle-based and lives in `/persist` because it
was added for SSR route resolvers.

**Workaround.** Hold a handle and call `run()`, or use `cache.peek()` and the
entry's methods for diagnostics. For SSR, import `prefetch` from `/persist`.

**Evidence:** `cache/query-client.ts`; `persist/persist.ts` `prefetch`.

### 2.9 Infinite queries use one entry per page

**Status: By design. Impact: Low.**

`createInfiniteRequest` does not create one list-level cache entry. Each page is an
ordinary cache entry keyed `base key + page param`. This is the property that makes
prefix invalidation work and lets a `createRequest` on `['items', 0]` share the
first page. The trade is that there is no single list entry to inspect, hydrate or
persist as a unit; the page entries are the unit.

**Evidence:** `README.md` "Infinite scroll"; `types.ts`
`InfiniteRequestOptions`.

### 2.10 Envelope pages are not flattened

**Status: By design. Impact: Low.**

`response()` flattens only when a page **is** an array. An envelope such as
`{ items, cursor }` is returned as pages, because the library cannot know which field
is the list. The return type follows the runtime, so an envelope type gives
`readonly Envelope[]`, not `readonly Item[]`.

**Workaround.** Map the envelope in the template or a `select()`, or use an
array-shaped page.

**Evidence:** `types.ts` `FlattenedPages`; `README.md` "Infinite scroll".

### 2.11 `remove()` and `maxPages` are not cache deletion

**Status: By design. Impact: Low.**

`feed.remove()` drops the infinite accumulation but does not delete the page
entries; the page entries stay cached and `gcTime` decides when they go. `maxPages`
releases the oldest page's subscription, which lets it be collected later, but does
not delete it immediately. Changing a signal in `key` restarts the accumulation and
leaves old pages cached.

**Workaround.** Call `QueryClient.remove()` on the page keys if immediate deletion is
required, or set `gcTime` appropriately.

**Evidence:** `README.md` "Infinite scroll"; `types.ts` `maxPages` comment.

### 2.12 Query context is minimal

**Status: Partial. Impact: Low.**

`createQuery` gives its source `(params, ctx)` where `ctx` is
`{ signal: AbortSignal, params: TParams }`. It does not pass a query client, a
canonical key, a metadata object or a fetch-status function. TanStack's
`QueryFunctionContext` is richer.

**Workaround.** Capture the surrounding service/client in a closure. The key is
already available to the caller; duplicate it if the source needs it.

**Evidence:** `types.ts` `QueryContext` / `QuerySource`.

### 2.13 Observable sources are first-emission-only

**Status: Missing — by design. Impact: Medium.**

If a `QuerySource` returns an Observable, the first `next` is the value, the entry
stores it and the subscription is torn down. Later emissions are ignored. Completion
without an emission is an error (`"The query completed without emitting a value"`).
There is no way to append to a cached value from a live source.

Streaming would need a different cache shape and an answer to what `response()`
means while the value grows. It is explicitly out of scope for 0.2.0.

**Workaround.** Use `pollInterval` for periodic refetches, or maintain a live stream
outside the cache and write into it with `setData`/`set` when a full snapshot
arrives.

**Evidence:** `README.md` "Known limitations"; `types.ts` `QuerySource`;
`docs/design-0.2.md` "Abort lifecycle".

### 2.14 Cancellation is cooperative

**Status: Partial. Impact: Low.**

The library aborts `ctx.signal` when the last subscriber leaves, `cancel()` is
called, or the handle is destroyed. A Promise source that ignores the signal keeps
running; its late result is dropped by the entry's settle guard, but the underlying
work is not stopped. For `httpResource`/`HttpClient`, Angular owns the abort; for
`createQuery`, the source must pass the signal to `fetch`, IndexedDB, a worker, etc.

**Workaround.** Always pass `ctx.signal` to the underlying API. A source that cannot
be aborted will still burn resources after cancellation.

**Evidence:** `types.ts` `QueryContext.signal`; `docs/design-0.2.md` "Abort
lifecycle".

### 2.15 No mutation cache, history, global mutation state or `scope`

**Status: Missing. Impact: Medium.**

`MutationRegistry` keeps counts, not mutations. There is no public mutation cache,
no list of past or in-flight mutations, no `useMutationState` equivalent, and no
`setMutationDefaults`. `mutationKey` only groups counts for `isMutating`, it does
not identify, deduplicate or persist a mutation.

The per-handle `concurrency` option (`parallel` / `exhaust` / `switch`) controls
calls of **one** mutation. TanStack's mutation `scope` serialises mutations that
share an id across different handles; there is no equivalent here.

**Workaround.** Keep handles or an application-level registry. Use `mutationKey`
plus `isMutating` for a global indicator, not for storing state.

**Evidence:** `cache/mutation-registry.ts`; `types.ts` `MutationOptions` /
`SignalMutation`.

## 3. HTTP behaviour

### 3.1 Non-GET `createRequest` is reactive

**Status: Partial. Impact: High.**

`createRequest.post(...)`, `.put(...)`, `.patch(...)` and `.delete(...)` are still
queries: a non-lazy one re-evaluates its source reactively and re-fires when a
signal read in that source changes. That is a write that can run more than once
without an explicit `run()`. The library prints a dev-mode warning once per page
load, pointing at `createMutation` and `lazy: true`, but it cannot make this a type
error without splitting the API.

**Workaround.** Use `createMutation` for writes, or `lazy: true` and call `run()`
explicitly. Do not read a changing signal in the source of a non-lazy POST.

**Evidence:** `README.md` "Behavior notes and limits"; `CHANGELOG.md` 0.2.0
dev-warning entry.

### 3.2 Progress is only available with the XHR backend

**Status: Partial. Impact: Medium.**

Angular 22's `HttpClient` defaults to the fetch backend, which cannot report upload
or download progress. `progress()` is populated only with
`provideHttpClient(withXhr())` and `reportProgress: true` (on the request source or
the mutation builder). With the fetch backend, the signal is never populated.

**Workaround.** Use `withXhr()` when progress matters, or show an indeterminate
indicator with the fetch backend.

**Evidence:** `README.md` "Behavior notes and limits"; `types.ts`
`SignalMutation.progress`.

### 3.3 `ctx.chain()` is unavailable on some paths

**Status: By design. Impact: Low.**

`ctx.chain()` comes from Angular's resource params context and therefore only exists
where an `httpResource` is driving the source. It is unavailable:

- on the cached path (a shared entry has no single `httpResource`);
- in `lazy` mode (the source runs in `run()`, not in the resource);
- with `debounce` (the debounce wrapper evaluates the params function).

Each case throws an explanatory error rather than chaining against a stale context.
The replacement is to put the upstream value in the key and return `undefined` from
the source while there is nothing to ask for.

**Evidence:** `README.md` "Behavior notes and limits"; `CHANGELOG.md` dependent
queries entry; `docs/design-0.2.md` §5.4.

### 3.4 A timeout is retried by default until 0.3.0

**Status: Partial. Impact: Medium.**

A timeout arrives as `status: 0`, so the default retry predicate cannot distinguish
it from a dropped connection. `timeout: 5_000` with `retry: 2` can take about 15
seconds before reporting `{ kind: 'timeout' }`. 0.2.0 keeps the 0.1.x default for
compatibility, warns in dev mode, and offers `retryTimeouts: false` globally or per
request. The default is scheduled to flip in 0.3.0.

**Workaround.** Set `retryTimeouts: false` today. An explicit `retry.when` also wins
over the global default.

**Evidence:** `README.md` "Known limitations" / timeout caveat;
`CHANGELOG.md` "Deprecated"; `docs/design-0.2.md` §5.1.

### 3.5 `status: 0` stays ambiguous

**Status: Partial. Impact: Medium.**

A CORS block, an extension, offline mode and a transport failure the browser will
not name all arrive as `status: 0`. The classifier can distinguish `aborted`,
`timeout` and (when the browser is certain) `offline`, but it deliberately does not
invent a `cors` kind. A `network` error with `offline: true` is a report, not a
promise that routing would have worked.

**Workaround.** Treat `status: 0` as "transport failure", not as a user-facing
diagnosis. Log the browser and network context separately.

**Evidence:** `README.md` "Known limitations"; `docs/design-0.2.md` §5.3.

### 3.6 No built-in token refresh

**Status: By design. Impact: Low.**

Reactive headers can make live requests refetch when a token signal changes, but
token refresh belongs in an `HttpInterceptor`. A refresh inside `HttpClient` is
invisible to the library: `status()` stays `loading`, `retryAttempt()` stays `0`,
and `onError` does not fire for the intermediate 401. The README shows the
interceptor shape and the `SKIP_AUTH` / single-flight requirements.

**Workaround.** Implement the refresh in an interceptor, with a shared in-flight
refresh promise and a loop guard.

**Evidence:** `README.md` "Auth: reactive headers + a refresh interceptor".

### 3.7 No retry for mutations by default

**Status: By design. Impact: Low.**

The global `retry` applies to query handles (`createRequest` and `createQuery`).
A mutation must opt in with its own `retry`, because writes are rarely idempotent.
`createInfiniteRequest` pages also do not retry unless their own `retry` is set;
they do not inherit the global query policy. This is not a missing feature; it is a
safety default.

**Evidence:** `types.ts` `SignalRequestConfig.retry` / `InfiniteRequestOptions.retry`;
`README.md` mutation options; `create-infinite-request.ts` `normalizeRetry`.

### 3.8 Keyless requests are not deduplicated

**Status: By design. Impact: Low.**

A request without a `key` is not shared and has no cache entry. Two components
asking for the same URL fire two requests. Giving the request a key is the opt-in
to sharing. This is what makes the uncached path follow the component's lifetime.

**Workaround.** Add a key when sharing is intended, or lift the request into a
service.

**Evidence:** `README.md` "Behavior notes and limits".

## 4. Persistence and SSR

### 4.1 Async restore delays every first fetch

**Status: Partial. Impact: Medium.**

A snapshot is one blob; the set of keys inside it is unknown until it has been read
and parsed. While an async restore is in flight, the first fetch of **every** key
waits for the restore, not only the keys the snapshot turns out to contain. The wait
is bounded by `restoreTimeout` (default 2000 ms), does not apply to
`waitForRestore: false`, and does not apply to synchronous storage. For a key with
nothing stored, the outcome is unchanged except for the delay of one storage read.

**Workaround.** Set `waitForRestore: false` on screens where paint matters more than
avoiding a possible double fetch. A synchronous storage has no gate at all.

**Evidence:** `README.md` "Known limitations"; `docs/design-0.2.md` §Phase 3;
`persist/persist.ts`.

### 4.2 An async write is not awaited on teardown

**Status: Partial. Impact: Low.**

A promise-returning `setItem` is fired on `pagehide`, visibility change and injector
teardown, but nothing blocks on it. A page teardown gives no second chance either
way, and blocking it would be worse than racing it. `localStorage` writes
synchronously there; this concerns async storages such as IndexedDB.

**Workaround.** Accept the race for async storage, or flush earlier (for example on
an explicit save) when the write must be durable.

**Evidence:** `README.md` "Known limitations"; `persist/persist.ts` `stop()`.

### 4.3 Storage writes can interleave

**Status: Partial. Impact: Low.**

The persister serialises its own `setItem` calls, so two writes from the library are
not outstanding together. If the storage itself resolves out of order, two writes can
still interleave at the storage layer; the library cannot serialize the storage's
own scheduling.

**Workaround.** Use a storage adapter that serialises writes, or a synchronous
storage.

**Evidence:** `README.md` "Known limitations"; `docs/design-0.2.md` Phase 3 risks.

### 4.4 The IndexedDB connection stays open

**Status: Partial. Impact: Low.**

`indexedDbStorage()` lazily opens one connection and reuses it. There is no owner to
hang a `close()` on, and another tab's upgrade closes it anyway; the library notices,
forgets it and reopens on the next call. A long-lived page therefore keeps one
connection open.

**Workaround.** Use the provided storage as intended; do not create a new
`indexedDbStorage()` per component. For strict connection control, write a custom
`CacheStorage`.

**Evidence:** `README.md` "Known limitations"; `persist/persist.ts`
`indexedDbStorage`.

### 4.5 SSR transfer cache is `GET`-only

**Status: Partial. Impact: Medium.**

Angular's transfer cache replays `GET` only. A non-`GET` `createRequest` response
does not cross from the server render to the client; the client re-fetches. The
README suggests `createMutation` for the write, or
`includePostRequests: true` in `provideClientHydration()` and accepting that every
payload crosses the wire.

**Workaround.** Keep server-rendered reads as `GET`, or opt into `includePostRequests`
and measure the payload.

**Evidence:** `README.md` "Behavior notes and limits" (SSR + transfer cache);
Angular's `provideClientHydration` behavior.

### 4.6 Server renders ignore timers and connectivity

**Status: By design. Impact: Low.**

On the server, `pollInterval`, `debounce` and `networkMode` are ignored so timers do
not hold stability and a render is never paused. Retry delays and `timeout` do apply.
`OnlineManager` is always online on the server and registers no listeners; a
`networkMode` option is inert there for the same reason.

**Evidence:** `README.md` "Behavior notes and limits"; `connectivity.ts`;
`docs/design-0.2.md` Phase 2 "As built".

### 4.7 The root cache is safe only with one bootstrap per render

**Status: Partial. Impact: Low.**

The cache is a root singleton. In a normal Angular SSR setup it is created per
request, which is what makes SSR safe. A server that reuses one
`bootstrapApplication` instance across requests (for example a custom caching proxy)
would share entries between users; that residual sharp edge is documented in the
0.1 design record and cannot be designed away by the library alone.

**Workaround.** Use the standard per-request bootstrap, or provide a request-scoped
cache in your own server integration.

**Evidence:** `docs/design.md` SSR section.

## 5. Devtools

### 5.1 The panel has no browser e2e test

**Status: Partial. Impact: Medium.**

`DevtoolsPanel` has unit and template coverage, but no Playwright test. The e2e
suite covers only the offline path. A regression in the panel's rendering, its
collapse behavior or its action wiring in a real browser would not be caught by the
current gate.

**Workaround.** Treat the panel as a debugging aid rather than production-critical,
and add an application-level smoke test if it is used in a developer shell.

**Evidence:** `docs/verification.md` Phase 6 record, "What this does not establish";
`e2e/`.

### 5.2 No timeline, routing, persisted settings or plugins

**Status: By design. Impact: Low.**

The panel is a compact table with details, not a full query explorer. It has no
timeline, no route-aware filter, no persisted open/closed or column settings, no
polling, and no plugin system. These are deliberate omissions, not a claim that a
larger panel would be worse.

**Evidence:** `README.md` "Devtools" final paragraph.

### 5.3 The value view is a JSON preview, not an object inspector

**Status: By design. Impact: Low.**

The details row shows a JSON preview capped at 200 characters and the full JSON
length. It does not lazily expand objects, follow references, or offer an editable
tree. Circular values and symbols become `[unserializable]` rather than throwing.

**Evidence:** `README.md` "Devtools"; `docs/verification.md` Phase 6 record.

### 5.4 A late history provider cannot backfill

**Status: Partial. Impact: Low.**

`DevtoolsHistory` records from the moment `provideDevtoolsHistory()` exists. An
entry created before the provider never received the sink, so opening the panel
later cannot backfill its attempts, retries or observer names. The panel still works
without the provider; the history columns are simply empty.

**Workaround.** Provide the history provider at application root, before the first
keyed handle, as documented.

**Evidence:** `README.md` "Devtools"; `docs/design-0.2.md` Phase 6.

### 5.5 Observer counts and names can lag one change-detection pass

**Status: Partial. Impact: Low.**

Subscription bookkeeping is deliberately not a signal, because a template should not
be able to depend on it. `observerCount` / `observerNames` are plain getters, so the
panel can show the previous value until the next change-detection pass. Everything
else in the table is exact.

**Evidence:** `README.md` "Devtools"; `docs/verification.md` Phase 6 record.

### 5.6 History is capped at ten entries per kind

**Status: By design. Impact: Low.**

`DevtoolsHistory` keeps at most ten fetch attempts and ten scheduled retries per
entry, dropping the oldest. A long session loses older diagnostics. The cap is there
to keep the opt-in history small and collectable with the entry.

**Evidence:** `README.md` "Devtools"; `docs/design-0.2.md` Phase 6.

### 5.7 `'ready'` is not the same as fresh

**Status: By design. Impact: Low.**

The panel reports `'ready'` when an entry has data, but real staleness depends on the
`staleTime` of whichever handle is asking, which is a per-handle decision the entry
does not know. `'invalidated'` is exact; `age` is the honest substitute for
freshness. A panel that claimed to judge freshness would be guessing.

**Evidence:** `README.md` "Devtools".

## 6. Testing and verification

### 6.1 E2E covers only the offline path

**Status: Partial. Impact: Medium.**

`e2e/offline.spec.ts` has three tests: an online-only request waits for reconnect,
queued mutations replay in order, and flapping after the queue settles does not
replay anything. The query demo section is not e2e-tested, the cache/infinite/mutation
sections are not e2e-tested, and persistence/SSR have no browser test.

**Workaround.** The unit suite covers these paths with Angular's `HttpTestingController`
and fake managers; that is strong evidence, but it is not a real-browser check.

**Evidence:** `e2e/offline.spec.ts`; `docs/verification.md` "What this does not
establish".

### 6.2 Devtools has no e2e test

**Status: Partial. Impact: Medium.**

See §5.1. The panel's unit/template coverage is not a browser integration test.

**Evidence:** `docs/verification.md` Phase 6 record.

### 6.3 E2E runs Chromium only

**Status: Partial. Impact: Low.**

The Playwright config has a single project: `chromium`. `navigator.onLine`, the
`online`/`offline` event ordering and IndexedDB behavior are not exercised in
Firefox or WebKit. The library's browser-facing code is small, but the test matrix
does not prove cross-browser behavior.

**Evidence:** `e2e/playwright.config.ts`.

### 6.4 No streaming test, because there is no streaming feature

**Status: By design. Impact: Low.**

Observable sources are first-emission-only, so there is no "append a later emission"
test to write. The absence is deliberate and listed under known limitations.

**Evidence:** `docs/verification.md`; `README.md` Observable limitation.

### 6.5 Performance numbers are a ceiling, not a portable guarantee

**Status: Partial. Impact: Low.**

The benchmark is a single-machine run compared against an in-run control. It is
strong enough to catch a large regression, but it is not a cross-machine or
cross-browser performance guarantee. Coverage thresholds are a floor against silent
regression, not a grade of assertion quality.

**Evidence:** `docs/verification.md`; `README.md` "Coverage is a floor, not a
grade".

## 7. Types and API ergonomics

### 7.1 `onMutate` context needs an explicit type argument after `T`/`TArgs`

**Status: Partial. Impact: Low.**

`createMutation` can infer `TContext` from `onMutate`, but TypeScript fills any type
argument you skip with its default. Once you write `createMutation<Todo, Draft>(…)`,
`TContext` is already `undefined` before `onMutate` is considered, so a returning
`onMutate` is a compile error. Write `createMutation<Todo, Draft, Snapshot>(…)` or
write no type arguments and let everything infer.

This is a TypeScript limitation, not a library choice; the alternative (capturing the
whole options object in a type parameter) would silently produce `unknown` instead of
an error.

**Evidence:** `types.ts` `MutationOptions.onMutate`; `README.md` "Known limitations".

### 7.2 An explicit `SignalRequest<T>` annotation drops `initialValue` narrowing

**Status: Partial. Impact: Low.**

The handle's `response` type is `R`, derived from whether `initialValue` is present.
Writing an explicit `SignalRequest<T>` annotation fixes `R` to `T | undefined`, so
the compiler forgets that `initialValue` made the response non-nullable. Let the
handle infer, or annotate the precise `SignalRequest<T, T>` if you need to.

**Evidence:** `types.ts` `SignalRequest`; `README.md` "Behavior notes and limits".

### 7.3 Naming `TParams` disables inference for the other type parameters

**Status: By design. Impact: Low.**

`createRequest<User>(url)` means "no params". `createRequest<Item[], ListQuery>(…)`
means "params are required"; `params` must appear in the options. This is how the
library distinguishes the two cases at runtime. There is no partial type-argument
inference, so the same rule is why `select` is a method rather than an option and why
`onMutate` needs an explicit `TContext`.

**Evidence:** `types.ts` `RequestOptions` / `QueryOptions`; `docs/design.md` the
partial-inference probes.

### 7.4 `retryAttempt()` keeps its value after exhaustion

**Status: By design. Impact: Low.**

The signal is reset by a success, a new params key or `idle`, not by running out of
retries. That lets a UI say "we tried N times". A consumer that wants a zero after
exhaustion must derive that from `status()` / `error()`.

**Evidence:** `README.md` "Behavior notes and limits"; `types.ts`
`RequestBase.retryAttempt`.

### 7.5 `select` is a method, not an option

**Status: By design. Impact: Low.**

`handle.select(fn, { equal })` returns a memoized `Signal`. It is not a `select`
option on `createRequest` / `createQuery`, because naming one type argument turns off
inference for the others and a selector type parameter cannot be inferred at the
call site. The method also keeps the shared value untouched, so each consumer can
have its own projection and equality.

**Evidence:** `types.ts` `RequestBase.select`; `docs/design.md` partial-inference
section.

### 7.6 `QueryRequest` intentionally omits HTTP-only state

**Status: By design. Impact: Low.**

`createQuery` returns a `QueryRequest` without `headers`, `statusCode` or `progress`,
because a function source may not have made an HTTP call at all. If you need those,
use `createRequest` (HTTP) or report your own metadata outside the handle.

**Evidence:** `types.ts` `QueryRequest`.

## 8. Platform and project scope

### 8.1 Angular 22 only

**Status: By design. Impact: Medium.**

The peer range is `>=22.0.0 <23.0.0`. The library uses Angular 22's `httpResource`,
resource params context, signal APIs and build tooling. Angular 16–21 applications
cannot install it without ignoring peer dependencies, and there is no compatibility
layer. This is a deliberate scope choice, not a missing adapter.

**Evidence:** `projects/signal-request/package.json` peer dependencies;
`README.md` "Compared with TanStack Query" framework scope.

### 8.2 No multi-framework adapters

**Status: By design. Impact: Low.**

The package is Angular-specific. There is no React, Vue, Svelte or Solid adapter.
TanStack Query's framework-agnostic core is a different product shape; this library
trades that breadth for Angular's `httpResource`, DI and signal integration.

**Evidence:** `README.md` comparison table; package entry points.

### 8.3 Zero runtime dependencies is a constraint, not a feature toggle

**Status: By design. Impact: Low.**

The package ships `tslib` plus Angular peers only. That is why IndexedDB is
hand-written, why there is no migration library, and why the persistence adapters are
small. Adding a dependency is a conscious product decision, not a missing import.

**Evidence:** `projects/signal-request/package.json`; `docs/design-0.2.md` "Global
constraints".

### 8.4 No migration codemod from TanStack Query

**Status: By design. Impact: Low.**

The README maps the vocabularies (`queryKey` → `key`, `queryFn` → source, etc.) and
says the translation is mechanical, but there is no codemod. A migration is manual.

**Evidence:** `README.md` "Upgrading from 0.0.x" and comparison section.

## 9. TanStack Query parity appendix

This table is a reference, not a backlog. Several items are deliberate differences;
several are genuinely absent. TanStack Query is the mature reference implementation
in this category, and the README says so.

| TanStack Query feature                                       | Here                                                      | Classification         |
| ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------- |
| Persisted offline mutation queue                             | In-memory queue only                                      | Missing — by design    |
| Mutation `scope` across handles                              | Per-handle `concurrency` only                             | Missing                |
| Mutation cache / `useMutationState` / global mutation state  | Counts only (`isMutating`, `mutatingCount`)               | Missing                |
| Devtools timeline, route filter, persisted settings, plugins | Compact panel with history and actions                    | Missing — by design    |
| Typed `queryOptions` helper                                  | `QueryKeyFactory` + plain options                         | Missing                |
| `placeholderData` callback                                   | `initialValue` / `keepPreviousValue` only                 | Missing                |
| `initialData` as a function                                  | Static `initialValue`; `seed()` is imperative             | Partial                |
| `select` option                                              | `handle.select()` method                                  | By design              |
| `enabled: false`                                             | `params` set to `undefined`                               | By design              |
| `queryClient.ensureQueryData` / `fetchQuery`                 | Hold a handle and call `run()`                            | Missing                |
| `queryClient.prefetchQuery` by key                           | `prefetch(handles)` in `/persist`                         | Partial                |
| `queryClient.getQueryState` / observers                      | `QueryCache.peek()` / `CacheEntry` diagnostics            | Partial                |
| `queryClient.setQueryDefaults` / `resetQueries`              | Global `provideSignalRequest` / `remove` / `clear`        | Missing                |
| `resumePausedMutations`                                      | No public queue control                                   | Missing                |
| `onlineManager.setEventListener`                             | Replace the `OnlineManager` provider; no helper           | Missing                |
| `injectQueries` / dynamic query arrays                       | `combine` and `createRequests`                            | Partial                |
| Infinite query with one list-level cache entry               | One cache entry per page                                  | Intentional difference |
| `persistQueryClient` storage/plugin breadth                  | `/persist` with `localStorage`-shape + `indexedDbStorage` | Partial                |
| Streaming SSR / live query values                            | Not supported; first emission only                        | Missing — by design    |
| Normalized/entity cache                                      | Neither library provides one                              | Not a parity gap       |
| Multi-framework adapters                                     | Angular only                                              | By design              |

## 10. Documentation debt

These are not runtime gaps, but they make the current surface harder to assess. They
are listed because a reader can otherwise conclude that a shipped feature is missing
or that a limitation no longer exists.

### 10.1 README says a `queryFn`-style source is not a query

`README.md` still contains, under "Known limitations":

> **Errors are HTTP-shaped.** A `queryFn`-style source — GraphQL, IndexedDB, a WASM
> call — is not a query here. Everything goes through `HttpClient`.

That is false for 0.2.0. `createQuery` accepts
`(params, ctx) => Promise<T> | Observable<T>` and shares the same cache and handle
as the HTTP path. The same README's comparison table and `createQuery` section
describe the feature correctly. The stale sentence should be removed or rewritten to
say that only **errors** from `createQuery` are normalized as `unknown` rather than
HTTP-shaped.

**Evidence:** `README.md` "Known limitations"; `README.md` comparison table;
`types.ts` `QuerySource`.

### 10.2 `docs/design.md` still says `maxEntries` is not implemented

The older design record says "`maxEntries` is still not implemented" and calls it a
gap. `maxEntries` shipped in 0.2.0 with global and per-request forms, LRU eviction,
staged-seed accounting and devtools reporting. `docs/design.md` is a historical 0.1
record; it needs a status banner or a correction so it is not read as current.

**Evidence:** `docs/design.md` (0.1 limits / "deliberately not done");
`CHANGELOG.md` 0.2.0 `maxEntries` entry.

### 10.3 `docs/plan.md` still describes phases as not implemented

`docs/plan.md` opens by saying phases 2 (offline), 3 (async persistence), 4
(`queryFn`) and 6 (devtools depth) are "designed ... but not implemented". All four
shipped in 0.2.0. The file is a task plan from before the work, not a status page;
it needs a historical banner or an update to avoid contradicting
`docs/design-0.2.md`.

**Evidence:** `docs/plan.md` line 11; `docs/design-0.2.md` phase status table.

### 10.4 `isMutating` is shown as a boolean in a source comment

`MutationOptions.mutationKey` says:

```ts
client.isMutating(['todos']); // true while any todo mutation is running
```

The actual method returns `Signal<boolean>`, so the example needs `client.isMutating(['todos'])()`
or a template read such as `client.isMutating(['todos'])()`. This is a small but
sharp documentation error in a public type comment.

**Evidence:** `types.ts` `MutationOptions.mutationKey`; `cache/query-client.ts`
`isMutating`.

### 10.5 Devtools size is stated twice with different values

The comparison table says the devtools entry is **4.0 KB gzip**; the Bundle section
says **4.5 KB gzip**. The measured value in the current record is 4.5 KB, so the
comparison table is stale. This is cosmetic, but it undermines the "measured, not
claimed" tone of the surrounding section.

**Evidence:** `README.md` comparison table; `README.md` "Bundle".

## 11. What this means in practice

- **The only intentional data-loss path is the offline queue on reload.** The cache
  itself is not silently dropping live entries; `maxEntries` refuses to evict
  subscribed or in-flight entries.
- **The highest-risk HTTP footgun is a non-lazy non-GET `createRequest`.** It is a
  query by construction, so it can re-fire reactively. Use `createMutation` or
  `lazy: true`.
- **The largest missing product feature is a durable offline outbox.** It is a
  deliberate non-goal, not a half-finished queue.
- **The largest packaging gap is per-factory tree-shaking.** The primary entry
  retains the cached engine even for an uncached request.
- **The most visible quality gap is e2e breadth.** The offline path is tested in a
  real browser; query, devtools, persistence and SSR are not.
- **Several "missing" items are simply not TanStack features.** A normalized cache,
  multi-framework adapters, a plugin ecosystem and a service-worker runtime are
  different products; their absence is not a defect in this one.

## 12. If these gaps are ever prioritised

This is not a release commitment and does not change the current release state. A
sensible order, based only on the impact above:

1. **Persisted mutation queue / outbox** — only if the product needs offline writes
   to survive a reload; it requires an idempotency and migration design.
2. **Per-factory tree-shaking or a cached subpath** — a public-API decision; it
   improves every application that uses only one factory.
3. **E2E breadth** — query, devtools and persistence; the offline path already has
   the hard-won real-browser coverage.
4. **Documentation corrections** — the README `queryFn` sentence first, because it
   contradicts a shipped feature.
5. **Ergonomics** — `placeholderData`, key-based client helpers and richer query
   context are useful but do not block the current surface.

## Evidence index

- `README.md` — "Known limitations", "Behavior notes and limits", "Offline",
  "Persistence across reloads", "SSR", "Devtools", "Bundle", "Compared with
  TanStack Query's Angular adapter".
- `docs/design-0.2.md` — phases 1–6, "Global constraints", Phase 2 non-goal, Phase 3
  risks, Phase 4 query context, Phase 6 devtools.
- `docs/verification.md` — §11 "What this does not establish"; §12 Phase 6 record;
  e2e and coverage records.
- `CHANGELOG.md` — 0.2.0 Added/Changed/Deprecated; historical 0.1.0 limits.
- `projects/signal-request/src/lib/types.ts` — public option types, query context,
  infinite-query types, mutation types, type-inference notes.
- `projects/signal-request/src/lib/cache/query-client.ts` — imperative client
  surface.
- `projects/signal-request/src/lib/cache/mutation-registry.ts` — counts, not a
  mutation cache.
- `projects/signal-request/persist/persist.ts` — snapshot storage, restore gate,
  IndexedDB, prefetch.
- `e2e/offline.spec.ts` and `e2e/playwright.config.ts` — the current browser test
  boundary.
- `projects/signal-request/package.json` — peer range, runtime dependencies and
  entry points.
