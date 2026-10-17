# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Entries for the `0.0.x` line are not retrofitted. It was a pre-release series
> that existed to settle the shape of `createRequest` and `createMutation`; the
> tags are in the git history if you need them.
>
> **The public API of `v0.0.4` is a strict subset of 0.1.0**: diffing the export
> list of `public-api.ts` between the two tags gives 0 removed, 40 added.

## [Unreleased]

### Added

- **`maxEntries` — the cache is now bounded in space as well as in time.** `gcTime`
  collected entries nobody was watching, but only after the fact: a workload that
  touched many distinct keys inside one window — a typeahead keyed on the query
  string, a virtualised list keyed on the row id — had no bound at all.
  - Global through `provideSignalRequest({ maxEntries })`, and per request through
    the `maxEntries` cache option. A per-request value can only **tighten** the
    global one, never raise it: there is one cache and nothing owns a subset of it,
    so the smallest declared budget wins and the global value is a ceiling. That is
    order-independent, which last-writer-wins would not be.
  - The policy is LRU over **idle** entries only — no subscriber, no request in
    flight. If nothing qualifies, the cache overshoots rather than taking data out
    from under a mounted component, and warns once per episode in dev mode.
  - Eviction runs synchronously as entries arrive, so the cap is a memory bound
    rather than a report.
  - `QueryClient.size` (`Signal<number>`) and `QueryClient.evict(filter)`; on the
    store, `QueryCache.maxEntries`, `tightenMaxEntries` and `evictIdle`, and
    `CacheEntry.evict()` for a teardown that writes no signals.
  - The devtools panel shows the entry count against the cap and flags an
    overshoot.
  - `docs/design-0.2.md` records the per-key-prefix reading that was rejected, and
    why eviction cannot go through `destroy()`.
- **`retryTimeouts` — the timeout + retry caveat, now controllable.** A timeout
  arrives as a `status: 0` abort, so the default retry predicate cannot tell it
  apart from a dropped connection and retries it: `timeout: 5_000` with `retry: 2`
  could spend about 15s before reporting `{ kind: 'timeout' }`.
  - `retryTimeouts: false` takes the timeout out of what the **default** predicate
    considers transient — per request, or globally through
    `provideSignalRequest({ retryTimeouts: false })`. A genuine network failure
    still retries, because that is the case retries exist for, and an explicit
    `retry: { when }` still wins over both.
  - **The default is `true`, unchanged from 0.1.x.** Setting `retryTimeouts` is
    opt-in; nobody's timing changes on upgrade. In dev mode the library now warns,
    once per combination, when a `timeout` is combined with retry and neither
    escape hatch is used — see the migration note below.
- **`RequestError`'s `network` kind carries `offline: true` when the browser says
  there is no connection.** `navigator.onLine` is consulted only where it exists,
  so the field is absent on the server and absent when the browser believes it is
  online. It is typed `offline?: true` rather than `offline?: boolean` because an
  absence is not a claim — a CORS block and a dropped socket land in the same
  member. `message` becomes `Offline` in that case.
- **A dev-mode warning for a non-`lazy`, non-`GET` `createRequest`.** These verbs
  are reactive exactly like the `GET` form, so `createRequest.post(...)` re-fires
  whenever a signal its source reads changes — invisible at the call site, and a
  second write nobody asked for. The warning points at `createMutation` and at
  `lazy: true`. It cannot be a type error without splitting the verbs in two, which
  would break every existing call.
- **Dependent queries on the cached path are documented and tested.** `ctx.chain()`
  stays unavailable there (a shared entry has no single `httpResource` to chain
  against), and the error message points at the replacement: read the upstream
  handle and put its value in the key, and return `undefined` from the source while
  there is nothing to ask for. `projects/signal-request/src/lib/cache/dependent-queries.spec.ts`
  pins both halves.

### Fixed

- The 0.1.0 changelog claimed every new `QueryCache` member was a signal. Only
  `CacheEntry.data` and `CacheEntry.status` are.
- README corrections, found by auditing every claim against the code: the error
  predicates are methods (`http()`, `timeout()`, `network()`, …) with a `message`
  getter, not `isHttp` / `isTimeout`; the `/testing` export list was missing
  `cache`, `advanceClock`, `TestSetup` and `ChildScope`; and the library ships four
  entry points, not three. `docs/verification.md` has the full audit.

### Changed

- **`timeout` + retry now warns, and has a way out.** The behaviour is unchanged —
  a timeout is still retried by default — so nothing you have today needs a change.
  If that is not what you want, add `retryTimeouts: false`: globally in
  `provideSignalRequest`, or on the request. The old workaround
  (`retry: { when: (e) => (e as HttpErrorResponse).status !== 0 }`) still works and
  still takes precedence. In dev mode you will now see one console warning the first
  time the combination is built, which is what this entry is for.
- A non-`lazy`, non-`GET` `createRequest` also warns in dev mode, once per verb.
  Behaviour is unchanged; use `createMutation` or `lazy: true`.
- No export was removed: `pnpm check:api v0.1.0` reports 0 removed.

## [0.1.0] - 2026-10-16

Server state: a shared cache, key invalidation, infinite queries and persistence,
without a new runtime dependency and without changing how an uncached request
behaves.

Every addition below is **opt-in per handle**. A request with no `key` is still a
plain `httpResource` with its own lifetime, and there is no cache, no dedup and no
garbage collection involved in that path.

### Added

- **A shared cache, opted into with `key`.** Two components that pass the same key
  resolve the same entry and cost **one** request; both see the data. Entries
  outlive their consumers (stale-while-revalidate, `gcTime`, structural sharing),
  which is precisely why the keyed path is driven by `HttpClient` rather than by
  `httpResource`.
  - `QueryCache` — `peek`, `size`, `seed`, `remove`, `clear`, `markInvalidated`,
    `subscribeChanges`, `subscribeActivity`.
  - `CacheEntry` — the unit of fetching, with `fetchCount`, `dataUpdatedAt`,
    `observerCount`, `isStale`, `local`, and the retry/cancel/settle plumbing. Its
    `data` and `status` are signals; the rest are plain reads, because subscription
    bookkeeping is not something a template should key off.
- **Key invalidation and `QueryClient`** — `invalidate`, `refetch`, `getData`,
  `setData`, `remove`, `isMutating`, `mutatingCount`. `invalidate` marks, batches
  by microtask and refetches what is on screen. Keys compare **by value**,
  recursively, so `['users', { page: 2 }]` from two call sites is one key;
  function and symbol segments throw with an explanation instead of never hitting.
- **Key filters** — prefix matching by segment (`['users']` reaches `['users', 1]`
  but not `['users-draft']`), an empty key matching everything, or a predicate over
  the raw segments.
- **Mutation integration** — `invalidates` accepts handles **or** keys;
  `mutationKey` groups mutations for `client.isMutating(filter)`; `target` performs
  an optimistic write addressed by key, into an existing entry.
- **`optimistic` with automatic rollback**, addressed by handle or by key, with the
  settle order pinned: `onMutate` → optimistic write → send; on success
  `invalidates` → `onSuccess` → `onSettled`; on failure rollback → `onError` →
  `onSettled`. Hooks receive a trailing `context` unconditionally.
- **`createInfiniteRequest`** — an infinite query where **each page is an ordinary
  cache entry** keyed `base key + page param`. That single decision is what makes
  prefix invalidation, cross-component sharing and `['items', 0]` deduplicating
  against a `createRequest` work on a feed. `pages`, `response` (flattened only
  when a page is an array), `pageParams`, `fetchNextPage`, `fetchPreviousPage`,
  `hasNextPage`, `hasPreviousPage`, `isFetchingNextPage`, `isFetchingPreviousPage`,
  `reload` (in order), `remove`, `maxPages`, `initialPageParam`,
  `getNextPageParam`, `getPreviousPageParam`.
- **`select()`** on all three handle types, with an optional custom `equal`. A
  **method** rather than an option, because a partial type-argument list cannot be
  inferred — an option would have forced `createRequest<Item[], Query>(…)` at every
  call site. The shared value is untouched and each consumer keeps its own
  projection.
- **`combine(sources)`** — aggregate several handles, positionally (array) or by
  name (record), with `response` / `loading` / `status` / `error` / `reload` /
  `cancel`. `error()` reports the first failure in source order.
- **`createRequests(items, build)`** — one request per item, reconciled by item
  identity (`Object.is`, with a `key` escape hatch).
- **`ng-signal-request/devtools`** — `QueryDevtools`: a snapshot of the entries,
  their state and a few actions, polled through a microtask so it can be used from
  a `computed` without `NG0600`. Nothing in the main entry point imports it, and
  `check-dist` asserts it is absent from a production build that does not use it.
- **`ng-signal-request/persist`** — `dehydrate` / `hydrate` shared by both
  boundaries in `providePersistedCache` (storage) and `provideCacheTransfer`
  (`TransferState`, no new peer dependency). A versioned snapshot, key filters,
  `dateRevivingCodec`, and storage failures that disable the persister instead of
  throwing. `prefetch(handles)` warms a route and reports failures without
  rejecting.
- **`cache().seed(key, value, dataUpdatedAt)`** — hydration that does not stamp
  `Date.now()` and does not report as a local write. Seeds are staged and applied
  when the entry is created, so a large persisted snapshot does not create entries
  that nothing observes and nothing collects.

### Changed

- **`invalidates` widened**: it accepted `Reloadable` handles only and now also
  accepts query keys, told apart by shape, so existing arrays-of-handles are
  unaffected. (This is the only signature change in 0.1.0.)
- **`retryAttempt()` is visible on the keyed path too**, and masked failures
  (`status() === 'loading'` while a retry is pending) are consistent between
  cached and uncached requests.
- **`Persister.destroy()` flushes before it stops**, so an open debounce window is
  written on teardown rather than dropped.
- **Documentation corrections**, in both directions:
  - "Requests are not deduplicated" is now stated as true **without a `key`**.
  - "There is no `select` option and no infinite-query primitive" is removed —
    both exist.
  - `docs/design.md` no longer describes an `EnvironmentProviders` factory as the
    SSR remedy: `providedIn: 'root'` already means one cache per render, and the
    residual risk (a host that reuses one injector across requests) is stated.

### Testing

- 360 tests across 15 files.
- `pnpm test` now runs v8 coverage and **fails below the thresholds** in
  `angular.json` (90 statements, 85 branches, 90 functions, 90 lines). Actual:
  95.8 / 90.0 / 96.3 / 97.8. The gate was verified by raising a threshold above
  the current number and watching the run fail.
- New tests cover the args of the API that were previously unexercised, not
  convenient lines: `ctx.chain()`'s explanatory failure on a cached handle, the
  params-cleared "disabled" state, `timeout`/`headers` on the shared request, a
  throwing hook, a throwing `parse`, a cached retry, seeding into an existing
  entry, and the rest of `createInfiniteRequest`'s surface.
- `.github/workflows/ci.yml` runs typecheck, tests (with coverage), the library
  build, the demo build and `check:dist` on every push and pull request.

### Bundle

| Entry point | Raw | Gzip |
| --- | --- | --- |
| `ng-signal-request` | 74.3 KB | 15.9 KB |
| `ng-signal-request/devtools` | 8.5 KB | 2.3 KB |
| `ng-signal-request/persist` | 7.0 KB | 2.3 KB |
| `ng-signal-request/testing` | 1.8 KB | 0.8 KB |

`/devtools` and `/persist` are separate entry points and are **not** in the core
bundle; `pnpm check:dist` builds the demo app and asserts that their markers are
absent from it.

### Limits

- **`maxEntries` is not implemented.** `gcTime` bounds the cache in time; a
  workload with very many distinct keys inside one `gcTime` window is unbounded in
  space. Documented rather than hidden.
- **`remove()` on an infinite query is a view reset, not a reload.** Nothing
  re-subscribes to page one afterwards; change the key to start over.
- **Persistence is synchronous** (`localStorage`-shaped). Async storage is not
  supported.
- No offline support (`onlineManager`-style) and no `networkMode`.

[0.1.0]: https://github.com/theunal/ng-signal-request/releases/tag/v0.1.0
