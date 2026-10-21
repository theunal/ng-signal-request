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
  - **Staged persisted values count toward the cap too.** `seed` / `hydrate` park a
    value until a handle asks for its key, and that area used to sit outside the
    bound, so one large snapshot could bypass it entirely. A staged value is now
    dropped before any entry is, oldest fetch first — a value nothing has asked for
    is the cheaper thing to lose — and the devtools label shows the staged part
    (`cache 3 + 12 staged / 100`). `QueryCache.clear()` drops staged values as well,
    so a cleared cache cannot be repopulated from one.
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
- **Asynchronous persistence, and the ordering rule that makes it safe.** A
  `localStorage` read finishes during injector creation, so restored data is in place
  before anything can look. A read that cannot answer synchronously — IndexedDB, a
  `fetch` from a service worker, anything promise-shaped — finishes _after_ the first
  mount, and the mount has already started a request of its own by then: two answers
  for one key, with nothing deciding which is the truth. Phase 3 is the fix, in two
  halves.
  - **`indexedDbStorage({ database, store, version, factory })`** — a `CacheStorage`
    over IndexedDB, for the case `localStorage` cannot serve: it is capped at a few
    megabytes, it blocks the main thread on every write, and it has no notion of size.
    One connection is opened lazily and reused, the object store is created on
    `upgradeneeded`, another tab's upgrade closes and forgets the connection, and
    every failure — no `indexedDB` at all, a blocked upgrade, a quota refusal —
    **rejects**, which the persister turns into a disabled persister rather than an
    exception inside a settle path.
  - **`CacheStorage`'s three methods may return promises.** Additive in the strict
    sense: a storage written against 0.1.0 satisfies the widened interface with no
    edit and no cast, and a sync storage is still called on the same stack, so its
    timing is unchanged.
  - **`waitForRestore` (default `true`), on `SignalRequestConfig` and on the cached
    request options.** While a restore is in flight, the **first** fetch of a key
    waits for it and then decides again — a seed that arrived fresh means no fetch at
    all, a seed that arrived stale means the fetch happens as usual. `run()` waits
    too, and re-reads its plan afterwards, so it fetches the params as they are when
    the restore lands rather than the ones it was called with. Nothing else is held:
    `reload()`, `invalidate()`, polling and refocus refetches are explicit
    instructions that happen after mount, and `reload()` returns synchronously.
  - **`PersistOptions.restoreTimeout` (default 2000 ms)** bounds the wait, because a
    storage that never answers must not hold a first paint, and `restoreTimeout: 0`
    turns the hold off globally. Reaching the bound opens the gate and applies
    nothing; a read that lands afterwards still seeds, under the reconciliation rule
    below.
  - **A late seed never clobbers newer data.** `QueryCache.seed` on a key whose entry
    already exists now applies the value only when the entry has no data yet, or when
    the value is **strictly newer** than the entry's `dataUpdatedAt`. A snapshot is
    what the _last_ session fetched; it is older than an answer already on the wire
    by construction, and writing it would be the cache going back in time. See the
    migration note.
  - **`RESTORE_GATE` / `RestoreGate` / `IDLE_RESTORE_GATE` in the core**, and
    `Persister.isRestoring` / `Persister.restored()`. The gate is a token the core
    reads and `/persist` implements, which is why an application that never persists
    pays nothing: the token's default is an idle constant, and an application that
    does not call `providePersistedCache` neither provides nor allocates anything.
    `providePersistedCache` now also registers itself as the gate, so the two cannot
    disagree about whether a restore is in flight.
  - **`CacheSnapshot.buster` and `HydrateOptions.migrate`** — two version bumps of
    different weight. `SNAPSHOT_VERSION` stays `1`: the new field is optional, so a
    snapshot written by 0.1.0 is still a valid one to read, and bumping the number
    would throw away every stored snapshot on upgrade for nothing. `buster` is the
    cheap one — change the string, and every payload from before it is dropped —
    while `migrate(snapshot, fromVersion)` turns an older _shape_ into a current one.
    A `migrate` that throws or returns `null` discards the snapshot and leaves a cold
    first paint, never a bootstrapping failure: the application that would report the
    error has not started yet. Neither runs when the version already matches, and the
    `buster` check runs **after** `migrate`, because a shape migration knows nothing
    about what the application put in the responses.
  - **`dehydrateFilter`**, a `(entry) => boolean` predicate over entry _state_ —
    `include` / `exclude` select by key, and the two questions are unrelated. See
    Changed for the new default.
  - Writes go through **one in-flight chain**, so two writes are never outstanding
    together; the debounce stays trailing, the flush points (`pagehide`, visibility,
    injector teardown) are unchanged, and a rejected write disables the persister
    through the same path as a throwing one.
  - `pnpm check:dist` now also asserts that each entry point's own bundle contains no
    string belonging to another one — the same boundary the demo-bundle check
    measures, one level up, so a cross-entry import is caught even when nothing in
    the demo exercises the pair.
- **`AsyncCacheStorage`, and `RestoreOf<S>` — the persistence types that say what the
  storage can do.** `AsyncCacheStorage` is a `CacheStorage` whose three methods return
  promises, and `indexedDbStorage()` now returns it, so "this read cannot answer on
  the current stack" is visible in the type rather than only in the implementation.
  `RestoreOf<S>` is the conditional type that turns a storage type into the return
  type of `hydrate()`; it exists so that widening the persister did not cost 0.1.0
  callers their `number` — see Changed.
- **`anyDataDehydrateFilter` — the 0.1.0 dehydrate predicate, as a named value.** The
  documented opt-out from the narrowed default: `(entry) => entry.hasData()`, which is
  exactly the old clause. See Changed.
- **`pnpm check:types-compat`, and `compat/v0.1.0/`.** `pnpm check:api` answers "which
  export names went away"; this answers the harder question — **does code written
  against 0.1.0 still compile?** `compat/v0.1.0/usage.ts` is written against the 0.1.0
  public API across all four entry points, in strict mode, and it is compiled against
  the **built** declarations (`pnpm verify` runs it right after `build`). It is not
  documentation: it is the claim "0.1.0 code still type-checks", and it fails the build
  when that stops being true. Where a spelling cannot be kept, it is written behind a
  load-bearing `// @ts-expect-error` that names the accepted break — so if a later
  change quietly restores it, the unused directive fails the check and the exception
  gets deleted with it.
- **Offline mode — `networkMode`, and one `OnlineManager` behind it.** `'online'`
  pauses a request instead of failing it while the browser reports no connection, and
  releases it once on reconnect. `'offlineFirst'` lets the first attempt run — a
  service worker, an HTTP cache or a proxy may answer it — and pauses only the
  retries. `'always'` is the **default**, and it is exactly what 0.1.x did on every
  path: connectivity is never read, so an application that does not opt in pays one
  boolean on the cache entry and registers no listener.
  - Per request (`createRequest`), per infinite request, per mutation
    (`createMutation`), and globally through `provideSignalRequest({ networkMode })`.
    The request wins over the global value.
  - **`OnlineManager`** is the single source of truth, and it separates two things:
    `online` is a **signal** (the state), `onReconnect(listener)` is an **event** (the
    edge). A reconnect must refetch once; an offline mount must not refetch on every
    read of the state — one primitive cannot do both. The state starts from
    `navigator.onLine`, follows the window's `online`/`offline` events, coalesces a
    burst within one tick into a single announcement, and removes its listeners on
    injector destruction. On the server it is always online and registers neither a
    listener nor a timer, so a render cannot be held. `setOnline(value)` is the test
    seam; `setOnline(true)` announces the same way an `online` event does.
  - The state means **an interface appeared**, not that a request will be routed. A
    captive portal, a VPN that is down and an unreachable API all look online;
    `'online'` is permission to stop holding, and the request that starts can still
    fail.
  - **`paused` on every handle** (`SignalRequest`, `CachedRequest`,
    `InfiniteRequest`, `SignalMutation`) and **`QueryClient.isPaused(filter?)`** — the
    counterpart of `isFetching`, for a "waiting for a connection" banner. Queries
    only: a queued mutation reports its own `paused()`. A paused request is not an
    error and does not settle; its `run()` promise stays pending, `status()` is
    `'loading'` before it has ever loaded and `'reloading'` when there is a value to
    keep showing.
  - **A paused retry burns no attempt and arms no back-off timer.** The retry waits
    for a reconnect through one listener, so a `retry: { count: 3 }` policy cannot be
    spent while offline and a request that reconnects starts with its budget intact.
  - **The pause belongs to the entry, not to the handle.** Two handles on one key
    share one hold and one resumed request; a paused entry that loses its last
    observer is cancelled like any other in-flight request, so `cancel()`,
    `destroy()` and eviction leave no timer or listener behind. With an asynchronous
    restore the order is fixed: the first fetch waits for the snapshot **first**, and
    then for connectivity.
  - **`RequestError.offline`** is now read from the same manager, so the error and
    the pause cannot disagree. `networkFailure()` keeps the `navigator` fallback for a
    failure observed outside an injection context.
  - Devtools show the state on the button and mark a paused row. The panel's own
    reads are unchanged.
- **An offline mutation queue.** A `createMutation` with `networkMode: 'online'`
  accepts a call while offline, reports `paused: true`, keeps the promise pending and
  replays the call **in call order** on the next reconnect. The mode you already
  chose still decides what happens: `parallel` replays every queued call, `exhaust`
  returns the promise of the one already queued, and `switch` cancels the previous
  queued call with `RequestCancelledError` — the same rules as an online call, just
  deferred.
  - `onMutate` and the optimistic write run at `run()`; `onSuccess` and `invalidates`
    run after the replayed call actually succeeds. A queued call counts as in flight,
    so `isMutating()` is `true` while it waits.
  - `cancel()` (or `destroy()`) rejects a queued call with `RequestCancelledError` and
    rolls its optimistic write back. A replay that fails because the connection
    dropped again goes **back to the queue** rather than reporting a failure: the
    user cannot act on it, and the next reconnect is the retry.
  - **The queue is in memory and does not survive a reload** — stated under Known
    limitations in the README, with the reasons.
- **The bundle's real cost is measured.** `projects/probe` holds four minimal
  production applications that differ only in their imports; `pnpm check:dist` builds
  all four and enforces the gzip delta over a no-library control (`request` and
  `keyed` 21.5 KB, `full` 23 KB). The measurement confirms what a per-entry budget
  could not: an app that imports one factory retains almost the whole core
  (+20.4 KB), because the module-level `Object.assign(...)` factory tables and the
  `@Injectable` static declarations are calls esbuild cannot prove pure. The README's
  Bundle section now reports the retained number next to the published one, and
  `docs/design-0.2.md` records the method and the two methods that were rejected.
- **`OnlineManager` is constructed only when connectivity will actually be read.**
  With the default `networkMode: 'always'` and no `refetchOnReconnect`, no manager,
  `window` listeners or `navigator.onLine` read are created; `RequestError.offline`
  keeps 0.1.0's navigator fallback in that case. This is a runtime change only — it
  was measured and removes 0 bytes from the bundle (see `docs/design-0.2.md`).
- **A real-browser check of the offline path.** `e2e/offline.spec.ts` runs Playwright
  Chromium against the **production** demo, takes the browser offline with
  `context.setOffline`, and counts network requests at the route layer: the banner,
  a paused `networkMode: 'online'` request resuming, a queued mutation replaying once
  and in order, and no duplicate on a second offline/online flap. Playwright is a
  devDependency, `pnpm test:e2e` is the entry point, and CI runs it as a separate
  `e2e` job — it is not part of `pnpm verify`.
- **`createQuery(source, options)` — a cached query whose source is a function.**
  `createRequest` assumes `HttpClient`; a query is for IndexedDB, storage, GraphQL, a
  WASM call, or an Observable you already have:
  ```ts
  const draft = createQuery<string>(async () => localStorage.getItem('draft') ?? '', {
    key: () => ['draft'],
    initialValue: '',
  });
  ```
  The source is `(params, ctx) => Promise<T> | Observable<T>`, `ctx` carries
  `AbortSignal` and the current params, and `key` is required. It is the same cache
  and the same handle as a keyed `createRequest`: `staleTime`, `gcTime`, dedup,
  structural sharing, `maxEntries`, `networkMode` / `paused()`, retry, invalidation,
  `select`, `run` / `reload` / `cancel` / `set` / `update`, `/persist`, SSR and
  devtools all apply. A keyed `createRequest` and a `createQuery` on one key share
  one entry and one in-flight call; the most recently registered plan decides how a
  cache-driven refetch runs, and a dev-mode warning fires once when two kinds
  disagree (they do not share a data type).
  - **Aborts are real.** The signal is aborted when `cancel()` is called, the last
    subscriber leaves, or the handle is destroyed, and a late promise/emission can
    never write to the entry. A cancelled entry keeps no timer or listener.
  - **An Observable's first emission is the value.** The entry unsubscribes after
    it; later emissions are ignored, and completion without a value is an error.
    Streaming is listed under Known limitations, not silently half-supported.
  - **Errors are classified as `unknown`, not as HTTP.** An abort-like rejection is
    `{ kind: 'aborted' }`; everything else — including a `TypeError` — is
    `{ kind: 'unknown', cause }`, because a function source has no HTTP status to
    interpret.
  - **The shared engine is one engine.** `createRequest`'s cached path and
    `createQuery` now call the extracted `cached-handle.ts`; the HTTP half is the
    thin wrapper that resolves a source to an `HttpResourceRequest`. `createRequest`
    itself is unchanged.
  - **The core budget moves from 20 KB to 21.5 KB gzip**, measured at 20.5 KB after
    the feature; the probes measured +21.2 / +21.2 / +23.0 KB. This is a deliberate,
    recorded budget change, not a silent one (see `docs/design-0.2.md`, Phase 4).
- **Devtools depth - what is in the entry, where it came from, and what happened.**
  The panel can now answer a cache bug rather than only list keys.
  - **Per-entry details.** A `details` toggle expands a row with the current value
    preview, the full JSON size, the plan kind, whether the value came from a seed or
    transfer, the observer `debugName`s, the last ten fetch attempts
    (`startedAt` / `durationMs` / `success` | `error` | `aborted`) and the last ten
    scheduled retries.
  - **Previews are opt-in and bounded.** `snapshotEntries(..., { preview: true })`
    serializes the value; the panel asks for that only while it is open, caps the
    preview at 200 characters with an ellipsis, reports the full size, and renders a
    circular or unserializable value as `[unserializable]` instead of throwing.
  - **Actions.** `QueryDevtools.invalidate`, `refetch`, `cancel`, `markStale` and
    `remove`. Invalidate/refetch/cancel follow `QueryClient`'s by-key semantics (the
    key and its children); stale and remove affect exactly the clicked row. Removal
    uses the new exact `QueryCache.removeExact(key)`; the existing prefix `remove`
    still means what it did.
  - **`isRestoring`**, read from `RESTORE_GATE`, and a `(restoring)` header marker
    beside `(offline)`, so the panel cannot disagree with the gate that holds the
    first fetch.
  - **History is opt-in and lives outside the core.** The core exposes only the
    `DevtoolsSink` interface and the `DEVTOOLS_SINK` token. `CacheEntry` keeps an
    optional sink reference, `seeded`, `observerCount`, and the same
    `fetchHistory` / `retryHistory` / `observerNames` getters, but no arrays or
    observer `Set`; without a sink those getters return empty arrays.
    `provideDevtoolsHistory()` installs the `/devtools` implementation, which owns
    a `WeakMap<CacheEntry, History>`, caps attempts and retries at ten each, and is
    collected with the entry. The provider must exist before the first keyed
    handle; opening the panel later shows history from that point, not before.
    The public types `FetchAttempt`, `FetchOutcome` and `RetryEvent` still describe
    the rows.
  - **No polling, no new dependency, and no per-entry history when unused.** The
    production demo still does not import `/devtools`; a dedicated `devtools` probe
    renders the panel with history opted in as the positive control, measured at
    **+28.2 KB** over the no-library control with a **32.5 KB** probe budget. The core (20.9 KB) and
    `/devtools` (4.4 KB) ceilings are unchanged at 21.5 / 15 KB. See
    `docs/design-0.2.md`, Phase 6 and `docs/verification.md` §15.

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
- **The default dehydrate filter is narrower: has data, is not fetching, is not in an
  error state.** An entry that is mid-refetch is a half-state whose stored shape
  depends on whether the response or the snapshot ran first, and an entry that
  **failed** its refetch while still holding yesterday's value is stale truth: the
  server just declined to confirm it, and restoring it on the next load would show
  data this session already knows to be suspect with no error to go with it, while
  overwriting the previous _good_ write. Excluding both cannot lose data — the
  previous value of the same key was written by the previous write — and it applies
  to `provideCacheTransfer` too, since the SSR snapshot goes through the same
  `dehydrate`. `dehydrateFilter` replaces the whole predicate when you want the old
  behaviour (`(entry) => entry.hasData()`), and 0.2.0 names that predicate for you:
  **`anyDataDehydrateFilter`**, which is what to pass when you want 0.1.0's rule back
  rather than the default. This is the one change in this release that reaches an
  unmodified 0.1.0 application.
- **`Persister.hydrate()` returns whatever the storage's own type says it can.**
  Deriving it from the storage instead of declaring it once is what keeps 0.1.0
  compiling: an application that wrote `const n: number = persister.hydrate()` — with
  `localStorage`, `sessionStorage`, or any hand-written storage returning a value —
  still compiles, because a storage that returns a value is a storage the read can
  answer on the current stack. `createPersister({ storage: indexedDbStorage() })`
  gives `Promise<number>`, and `await` works on both. Two spellings keep the honest
  union `number | Promise<number>` and are the **accepted residual**: annotating the
  interface itself (`const p: Persister = …`) and going through the `CACHE_PERSISTER`
  token, because neither can carry the storage's type. A token cannot carry a type
  parameter, and the persister it resolves may have been built over any storage, so
  saying `number` there would be a silent wrong answer. Both are pinned by
  `@ts-expect-error` in the compatibility fixture and listed under Migration.
  The free `hydrate(cache, snapshot, options)` function is unchanged — it is handed an
  already-parsed snapshot and stays synchronous.
- **A first fetch now waits for an asynchronous restore (`waitForRestore`, default
  `true`).** New in 0.2.0 and inert for every 0.1.0 application, because 0.1.0 had no
  way to configure a storage whose read is not synchronous: with `localStorage` the
  read finishes during injector creation, so nothing is ever held. The opt-outs are
  `waitForRestore: false` on the request, `restoreTimeout: 0` globally, or simply not
  using an asynchronous storage.
- **Connectivity is opt-in: `networkMode` defaults to `'always'`.** No request or
  mutation starts reading connectivity on upgrade, so one that used to fire and fail
  loudly still fires and fails loudly. `'online'` is a choice you make per request,
  per mutation, or globally.
- **`QueryCache.seed` no longer overwrites an entry whose data is newer than the
  value being staged** (see Added for the rule and why). A seed is a _restore_, and a
  restore means "this is what the last session had"; use `CacheEntry.setData` to
  force a value in, which is the method that says so. The one visible consequence: an
  application that called `seed` a second time expecting an older payload to win over
  a fetch that happened in between will see the fetch's value kept instead.
- No export was removed: `pnpm check:api v0.1.0` reports 0 removed.

### Migration from 0.1.x

Nothing here needs a code change to keep working, and the two entries that can change
behaviour need a storage that cannot answer synchronously — which 0.1.0 had no way to
configure, so no existing application is in that position.

- **Nothing about connectivity changes on upgrade.** `networkMode` defaults to
  `'always'`, which never reads `navigator.onLine`, so every existing request and
  mutation fires exactly when it did. Adopting `'online'` is a separate decision, and
  one you make per request, per mutation, or globally.
- **Persistence is synchronous only if you make it so.** `providePersistedCache()`
  with no `storage` still uses `localStorage`, and a `localStorage` read still
  finishes during injector creation: `isRestoring()` is `false` before any handle
  exists, nothing is held, and the first fetch happens exactly when it used to. The
  gate only engages when you hand over something promise-shaped.
- **If you wire up an asynchronous storage**, the first fetch of every key waits for
  the restore (up to `restoreTimeout`, 2000 ms by default, off with `restoreTimeout:
0` or `waitForRestore: false`). That is the point of the feature. Its known cost:
  keys the snapshot does not even carry are delayed by one storage read, because the
  set of keys inside the blob is unknown until it has been read — see the README's
  known limitations.
- **If you called `seed()` expecting it to win over newer data**, that is the one
  behaviour that changed. `CacheEntry.setData` is the method for a forced write.
- **If you want the old dehydrate default**, pass `anyDataDehydrateFilter` as
  `dehydrateFilter` — to `providePersistedCache`, `provideCacheTransfer`, or a direct
  `dehydrate()` call. It is `(entry) => entry.hasData()`, the 0.1.0 rule, and it is the
  only thing to write.
- **Two spellings of `Persister` keep the union `number | Promise<number>` from
  `hydrate()`** — they are the accepted part of the widening, not an oversight:
  `const p: Persister = createPersister({ storage: localStorage })` (annotating the
  interface) and `inject(CACHE_PERSISTER).hydrate()`. Both cannot know what the
  storage is, so neither is told `number`. Write `const p = createPersister({ storage:
localStorage })` and the storage's own type decides, which is `number` for every
  0.1.0 storage; or `await`, which compiles for both. `pnpm check:types-compat`
  compiles both cases and documents each behind an `@ts-expect-error`.

### Deprecated

- **`retryTimeouts`'s `true` default.** The option is not deprecated and will not be
  — what changes is the value you get when you do not set it. **In 0.3.0 the default
  flips to `false`**, so a `timeout` stops being retried unless you ask for it. It
  stays `true` in 0.2.0 because flipping it here would silently change how long a
  failing request takes for everyone upgrading from 0.1.x, and a retry policy is not
  something to change underneath a caller in a minor release.

  What to do now, if you combine a `timeout` with a `retry`:

  - want the 0.3.0 behaviour today → `retryTimeouts: false`, globally in
    `provideSignalRequest` or on the request;
  - want today's behaviour to survive the flip → `retryTimeouts: true`;
  - not sure whether you are affected → the dev-mode warning says so, once per
    combination, the first time it is built.

  Set it explicitly and the flip is a non-event.

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

| Entry point                  | Raw     | Gzip    |
| ---------------------------- | ------- | ------- |
| `ng-signal-request`          | 74.3 KB | 15.9 KB |
| `ng-signal-request/devtools` | 8.5 KB  | 2.3 KB  |
| `ng-signal-request/persist`  | 7.0 KB  | 2.3 KB  |
| `ng-signal-request/testing`  | 1.8 KB  | 0.8 KB  |

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
