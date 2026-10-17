# Design — server state for `ng-signal-request`

Status: **shipped in v0.1.0.** Written before any of the cache code existed, so it
is a plan; each phase's notes at the end of this document record what changed while
building it and why. Where the plan and the code disagree, the code is right and the
disagreement is a bug — two of them are written down as such.

## 1. Where we are today

`createRequest` builds an Angular `httpResource` per handle. `createMutation` already
talks to `HttpClient` directly. So the library has two transports, chosen by what
each primitive needs — the library is not uniformly `httpResource`-based, and that
matters for everything below.

What exists and is shared between the two paths, in `utils.ts`:

| Function                                         | Role                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `resolveRequest(value, method, baseUrl, params)` | source → `HttpResourceRequest`; fills `path`, splits `params`, applies the verb    |
| `withGlobalHeaders(request, global)`             | merges global defaults; reads a reactive `headers()` **inside the reactive chain** |
| `normalizeRetry` / `nextRetryDelay`              | retry policy, shared by queries and mutations                                      |
| `splitParams`                                    | `body` / `path` / `headers` vs query string                                        |

And in `errors.ts`: `toRequestError`, which classifies a failure into the
discriminated union, and `RequestErrorView` (per-kind predicates + `message`).

The status vocabulary is Angular's: `idle | loading | reloading | resolved | error | local`.

## 2. The decision everything else hangs on

> **Keyed requests are driven by `HttpClient` directly, coordinated by a root-owned
> `QueryCache`. Keyless requests keep `httpResource` and change nothing.**

This is the question the brief asks us to decide and justify. The answer is
"neither `httpResource`-per-entry nor the param-chain trick — a third path".

### Why not one `httpResource` per cache entry

A cache entry is the opposite of what `httpResource` is built for:

- An entry **outlives every single consumer**. `httpResource` is created in an
  injection context and dies with that injector's `DestroyRef`. Giving entries
  their own long-lived injectors means an `EnvironmentInjector` per entry plus a
  manual `destroy()` on GC — a lot of machinery to keep a primitive we don't
  want.
- An entry must **serve stale data while refetching** (stale-while-revalidate).
  `httpResource` moves to `loading` on a params change and its value handling is
  built around "this consumer wants exactly one request".
- `httpResource` **cancels the previous request** when its params function
  produces a different request. For an entry, "the request changed" is not a
  thing — there is one request in flight per entry, and cancelling it is
  precisely what we are trying to _avoid_ unless the last subscriber left.

And the decisive point: the features Phase 1 asks for — refcount, dedup,
stale-while-revalidate, gcTime, abort-on-last-unsubscribe — are **properties of a
fetch coordinator**, not of a reactive request primitive. Adopting `httpResource`
per entry would mean reimplementing all of them _on top of_ it, plus paying for a
primitive whose reactive semantics fight the job. Bending `HttpClient` into that
shape is about the same amount of code and is legible.

### Why not "return `undefined` from the params chain while a fresh entry exists"

This was the original sketch and it is wrong in a specific way: it dedups the
_response_ but not the _network call_. Two components mounting at the same time
would each get their own `httpResource`, each of which would decide independently
to return `undefined`, and the moment the entry went stale both would fetch. To
actually coalesce, you need a shared in-flight promise — at which point you have
built the coordinator anyway, and now you have _also_ kept the resource, with its
status model collapsed (`idle`/`local` standing in for "this is a cache hit") and
retry-timer ownership ambiguous (whose back-off timer is running?).

### What we give up

`httpResource` gives us, for free:

- **`transferCache` hydration.** Not actually lost: `transferCache` is an
  `HttpClient` request option, not a resource one, and Phase 7's SSR work needs it
  on the `HttpClient` path anyway. Carried over explicitly.
- **`progress()` on queries.** Carried over — `observe: 'events'` on `HttpClient`
  is what `createMutation` already does.
- **Angular's own status semantics.** Replaced by our own five-state entry, mapped
  back onto the public `RequestStatus` vocabulary so templates do not change.

### Precedent

`createMutation` already made this exact call (`create-mutation.ts:180`) with the
stated reason: _"`httpResource` is meant for reads (it is eager and cancels the
previous request, which is not what you want for writes)."_ The same argument
extends to reads that are coordinated across consumers.

## 3. Architecture

```
createRequest(source, { key })  ──opt-in──►  QueryCache (root singleton)
      │                                           │
      │                                     ┌─────┴──────────────┐
      │  no key (today's behaviour)           │  Map<hash, Entry>  │
      └──► httpResource (unchanged)           └─────┬──────────────┘
                                                     │ one fetch per entry
                                                 HttpClient
```

- **`QueryCache`** — root singleton, injectable, owns a `Map<string, CacheEntry>`.
  Nothing else holds it; handles are thin views that subscribe to one entry.
- **`CacheEntry`** — the coordinator. Owns the data, the status, the refcount, the
  in-flight request and its `AbortController`, the gc timer, and the retry timer.
- **Handle** — `computed`s reading the entry's signals. No `effect()` in the
  steady state: the entry's state _is_ the signal graph, and the handle just
  projects it.

### Key normalization

A key is a function returning an array of segments. Segments are normalized to
strings via a stable stringify (object keys sorted recursively) so that
`['users', { a: 1, b: 2 }]` and `['users', { b: 2, a: 1 }]` are the same key and
object segments compare by value, not identity.

- `entryHash = segments.map(stableSegment).join('\u0000')` — for `Map` lookup.
- The normalized segment array is kept **on the entry** as well, because prefix
  matching (`invalidate(['users'])`) needs the segments, not just the hash.

`key: () => ['users', filters()]` must be **read inside the handle's reactive
context**, so a filter signal change re-points the handle at a different entry —
that is the whole ergonomic story, and it mirrors how the source already works.

## 4. Entry state machine

```
                 subscribe (refcount 0→1)
        ┌────────────────────────────────────┐
        │  refetchOnMount decides             │
        │  'always' → fetch                   │
        │  'stale'   → fetch if stale or empty│
        │  false     → no fetch               │
        └────────────────────────────────────┘
                         │
        idle ────────────┴──────────► fetching ──────┬──► success
         ▲                                           │
         │                                           └──► error ──┐
         └───────────── refcount 0 ────────────────────────────────┘
                  (start gcTime timer; abort if in flight)
```

Mapped onto the public `RequestStatus`, so templates and existing code are
unchanged:

| Entry                                  | `status()`  |
| -------------------------------------- | ----------- |
| disabled (source returned `undefined`) | `idle`      |
| no data, fetching                      | `loading`   |
| has data, fetching                     | `reloading` |
| has data, not fetching, no error       | `resolved`  |
| terminal error                         | `error`     |
| a `set()` / `setData()` wrote locally  | `local`     |

`error` is **masked while a retry is in flight**, matching today's behaviour
(`create-request.ts:214-216`).

### Added handle members (keyed path only)

`isStale()`, `isFetching()`, `dataUpdatedAt()`. Keyless handles keep today's
member list exactly — a handle that never asked for a cache does not learn what
staleness means.

### Abort

The entry owns an `AbortController`. **When the refcount reaches 0 the in-flight
request is aborted**, whether or not there is cached data, and the entry keeps
whatever it already had. This matches the brief ("an in-flight request with no
subscribers must actually be cancelled") and TanStack's rule.

Losing a fetch because a user navigated away mid-request is only acceptable
because the entry is still in the map: the next subscriber refetches, and any
data already delivered is kept. The gc timer runs from the same moment.

### gcTime

On `refcount → 0`, start `setTimeout(gcTime)`. If a subscriber returns first, the
timer is cleared. On fire, the entry is deleted and its timers destroyed.
Browser-only; on the server gc timers are skipped entirely so they cannot hold
stability (same rule as `pollInterval` / `debounce`).

### Structural sharing

On every successful fetch the incoming value is passed through, in order:

1. the request's `structuralSharing(oldData, newData)` if given, else
2. the existing `equal(oldData, newData)` — which today goes to `httpResource` as
   value equality.

If the result is the _old_ reference, the entry's data signal is not written and
**no consumer re-runs**. This is what keeps a 200-response with one changed field
from re-rendering an unchanged table, and it composes with `equal` rather than
replacing it: `equal` is the degenerate "is this the same value?" case of the
same idea.

## 5. Public API draft (Phase 1)

```ts
createRequest(source, {
  key: () => ['users', { page: page() }], // opt-in; absent = today's behaviour
  staleTime: 5_000, // 0 = always stale
  gcTime: 300_000, // default 5 min
  refetchOnMount: 'stale', // 'stale' | 'always' | false
  structuralSharing: (old, next) => next, // default: identity
});
```

Global defaults in `provideSignalRequest`: `staleTime`, `gcTime`,
`refetchOnMount`, `refetchOnWindowFocus`, `refetchOnReconnect`. Per-request
options win.

## 6. Backwards compatibility plan

Hard rule: **a handle with no `key` runs today's code path, unchanged.**

- `buildInContext` gains a keyed branch; the unkeyed branch is the existing body
  verbatim, not a refactor of it. That is the only way to guarantee the promise.
- No existing option changes meaning. `staleTime` / `gcTime` /
  `refetchOnMount` / `structuralSharing` are inert without `key`.
- `key` is not required, has no default, and cannot be inferred.
- Acceptance: the existing 169 tests pass **without modification**. If one needs
  editing, the design is wrong.
- `createMutation.invalidates` gains an overload for key arrays
  (`invalidates: [['users']]`) alongside the existing `Reloadable[]`.

## 7. Risks

| Risk                                                  | Mitigation                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two code paths drift                                  | The shared primitives (`resolveRequest`, `withGlobalHeaders`, retry, `toRequestError`) are already factored out and are used by both. Only the fetch/status orchestration is duplicated, and it is deliberately small. |
| `key` read outside a reactive context → stale entry   | The key is read in a `computed`; a signal it reads becomes a dependency, exactly like the existing source.                                                                                                             |
| Entry leaks                                           | Refcount + gcTime, plus a leak test that asserts subscriber count and timer count return to zero.                                                                                                                      |
| Memory: `Map` grows forever with many distinct keys   | `gcTime` bounds it. A `maxEntries` cap is a follow-up, not in v0.1.0.                                                                                                                                                  |
| SSR: entry state leaking between requests             | `QueryCache` is a root singleton. A server rendering two different users would share entries. **This is a real problem** — see below.                                                                                  |
| Structural sharing makes the response mutable-looking | It only ever returns a _previous_ reference, never mutates. Callers must still treat cached data as immutable; documented.                                                                                             |

### SSR is a genuine correctness problem

The risk: a cache that lives for the process rather than for one render would let
two users rendering `/users` at the same moment share an entry and see each
other's data.

The Phase 1 answer, which Phase 7 then leaned on, is that **`providedIn: 'root'`
already means "per application instance"**: `root` resolves to the root
environment injector of _one_ `bootstrapApplication` / `renderApplication` call,
and Angular's SSR calls `renderApplication` per request. So the cache is isolated
per server request by construction, with no factory, no `REQUEST` token and
nothing for the user to remember to provide. Phase 7 hydration is therefore
per-instance too, which is exactly what `TransferState` gives: a per-request
bucket of state.

Options considered:

1. **`providedIn: 'root'`.** Chosen — the framework's own per-application scope.
2. **Per-instance cache via an `EnvironmentProviders` factory.** Would also work,
   and was the original plan. Rejected only because it is strictly more code for
   the same scope: a factory that builds a `QueryCache` still has to register it
   under the same token in the same injector.
3. **Request-scoped cache via the `REQUEST` token.** Correct, but Angular only
   provides `REQUEST` inside a route handler, and a root service cannot see it.
4. **Documenting "provide a fresh cache per request".** A footgun, and unnecessary
   given (1).

The residual sharp edge is the one that cannot be designed away: this holds
because the server renders per request. A server that reused one
`bootstrapApplication` instance across requests (some caching proxies, a custom
`express` handler that hoists the injector) would share the cache, and the fix
there is in the host, not in this library. Documented rather than hidden.

## 8. Rejected alternatives

- **Keep `httpResource` for keyed requests** (entry-per-resource). §2.
- **Cache in front of `httpResource` via the params chain.** §2.
- **Per-request `QueryCache` via `new QueryCache()` passed to every call.** Makes
  `invalidate` a global side channel to find them. Rejected.
- **Signals instead of `computed` for entry state.** Entry state _is_ reactive —
  data, status, refcount all change — so `signal`/`computed` are the right tools
  here. (Contrast with the `requestError` predicates, which are deliberately
  plain prototype methods because a failure is not a time-varying value.)
- **Make staleness a `computed` over a clock signal.** Needs a timer signal, which
  means waking everyone on an interval forever. Staleness is evaluated on read and
  on `invalidate` instead; `isStale()` is a plain function reading
  `dataUpdatedAt` plus the current time.
- **`vitest bench` for the performance numbers.** `@angular/build:unit-test` has no
  `bench` option, and plain `vitest` cannot compile these Angular sources without
  a new dev dependency. Using perf **assertions as ordinary tests** under
  `pnpm test` instead: no new dependency, the numbers are enforced in CI, and they
  fail loudly on regression. `docs/perf.md` records the measurements.

## 9. Gaps in the brief, called out now rather than at the end

- **No linter or formatter exists.** The repo has only `.editorconfig`;
  `pnpm typecheck` (strict TS + `strictTemplates`) is the entire quality gate.
  Adding ESLint + Prettier is a real change to the toolchain and a supply-chain
  addition; it is not in v0.1.0 scope. Recommended as v0.1.1. **Still open.**
- ~~**CI does not build the demo app**~~ — closed in Phase 6:
  `.github/workflows/ci.yml` runs `build:demo` and `check:dist` on every push and
  PR, so template type errors in the demo sections are caught.
- ~~**Two READMEs are kept byte-identical by hand**~~ — closed in Phase 6:
  `scripts/check-dist.mjs` compares them and fails the build on drift.
- ~~**The published secondary entry points were never typechecked**~~
  (`tsconfig.lib.json` only listed `src/**`) — closed in Phase 6 by widening
  `include` and moving `rootDir` to `"."`.
- ~~**No coverage threshold**, so "≥90% on new code" was a claim rather than a
  gate~~ — closed in Phase 8; see below.
- **`maxEntries` is still not implemented.** `gcTime` bounds the cache in _time_,
  and a workload with a very large number of distinct keys within one `gcTime`
  window is unbounded in _space_. Documented as a limit; a follow-up.

## 10. Phase plan

| Phase | Contents                                                                                                                                                                           | Depends on |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | `QueryCache`, `CacheEntry`, key normalization, `key` option, dedup, `staleTime`, `gcTime`, `refetchOnMount`, structural sharing, abort, per-instance cache                         | —          |
| 2     | Injectable `QueryClient`: `invalidate` / `refetch` / `cancel` / `getData` / `setData` / `remove` / `isFetching`, prefix matching, batched invalidation; `invalidates` key overload | 1          |
| 3     | `mutationKey`, `onMutate` context, `isMutating()`, `target` accepts a key                                                                                                          | 2          |
| 4     | `createInfiniteRequest`                                                                                                                                                            | 1          |
| 5     | `select` that does not break inference; `createRequests` + `combine`                                                                                                               | 1          |
| 6     | `/devtools` entry point                                                                                                                                                            | 1, 2       |
| 7     | `/persist` entry point; `TransferState` dehydrate/hydrate, `prefetch`                                                                                                              | 1, 2       |
| 8     | Fix the documented sharp edges                                                                                                                                                     | 1–7        |

### Phase 4 notes — `createInfiniteRequest`

The plan said "`createInfiniteRequest`". Three decisions were not in the plan and are worth
recording, because each one is a place where the obvious implementation lies.

**No page cache of its own.** The tempting design is an accumulator signal inside the handle that
collects pages. It would work, and it would be isolated — `client.invalidate(['items'])` would not
reach it, `staleTime` would not apply per page, and page 1 would be fetched twice if anything else
wanted it. Instead each page is an ordinary `QueryCache` entry keyed `base key + page param`, and
`pages()` / `response()` are derived from those entries. Everything else in the library then applies
to a paginated list without the paginated code knowing: prefix invalidation, per-page `staleTime`
and `gcTime`, and dedup against a plain `createRequest` on the same key.

**`response()` flattens only when a page _is_ an array.** `TPage` is opaque — a page may be
`Item[]` or `{ items, cursor }`, and there is no way to know which field of an envelope is the
list. Guessing produces a plausible-looking list that is wrong for some API. So the runtime flattens
arrays and passes anything else through, and the _type_ follows the same condition via
`FlattenedPages<TPage>`: `InfiniteRequest<Item[], P>` has `Signal<readonly Item[]>`,
`InfiniteRequest<Envelope, P>` has `Signal<readonly Envelope[]>`. The type and the runtime agree
because they are guarded by the same predicate.

**`reload()` is sequential, not parallel.** Pages are independent entries and could be refetched
concurrently, which would be faster. Offset pagination is only coherent when the pages are requested
in sequence, though, and a page that comes back with a different set of rows is far easier to reason
about when the pages are not racing each other. Sequential is slower on purpose.

One bug worth naming, because it is the class of bug the `untracked` helper invites: `pages()` was
first written with `untracked(page.entry.data)` inside the `computed`. That reads correctly and
passes on one page — the accumulated list only breaks on the _second_ page, because a page arriving
does not change `loadedParams()`, so nothing re-invalidates the computed. The reads must be tracked.
`isFetchingNextPage()` had the same shape. Both are tracked now, and the tests that caught them are
in `infinite-request.spec.ts`.

### Phase 5 notes — `select`, `combine`, `createRequests`

**`select` is a method, and the reason is measurable.** The brief listed this phase as "`select`
that does not break inference", and the v0.0.x code already claimed a `select` _option_ was
impossible without saying what actually broke. So the claim was tested rather than repeated. Two
probes:

```ts
// Probe 1: a selector type parameter WITH a default.
declare function f<T, S = T>(src: () => T, opts: { select?: (data: T) => S }): { response: S };

f<{ name: string; age: number }>(() => ({ name: 'x', age: 1 }), { select: (u) => u.name });
//                    ^ error TS2322: Type 'string' is not assignable to type '{ name: string; age: number }'
```

```ts
// Probe 2: the same, with NO default, to see whether inference is merely overridden by one.
declare function g<T, U, V>(src: () => T, opts: { other?: U; select: (d: T) => V }): { r: V };

g<{ n: string }>(() => ({ n: 'x' }), { select: (d) => d.n });
//                    ^ error TS2558: Expected 3 type arguments, but got 1
```

Both fail for one reason, and it is worth naming because it is a TypeScript limitation rather than
a quirk of this library: **TypeScript has no partial type-argument inference.** Naming even one type
argument turns inference off for every other type parameter — those fall back to their defaults, and
a type parameter with no default is not a fallback, it is an error. Since `createRequest<T>(…)` is
the whole idiom of this library, a `select` option can never be typed well. The probe files were
temporary; the two snippets above are the record.

`handle.select(…)` has none of that: `S` is the only type parameter in play at the call site,
nothing is named ahead of it, and `expectTypeOf` pins the inference in `select.spec.ts`.

It also earns its place beyond ergonomics. `computed(() => handle.response()?.map(…))` already
memoizes and already stops propagation when the result is `Object.is`-equal, so the _only_ thing a
method can add is a different equality — which is exactly what a selector that rebuilds an object
needs. `select.spec.ts` tests both halves: with `equal` a response that changed an unrelated field
does not wake the consumer, and without it, it does.

**`combine` returns an aggregate, not a `computed`.** The trivial case is one line either way. What
a hand-written aggregate tends to get wrong, and what the tests therefore pin:

- `reload()` over `Array.prototype.some()` reports success while leaving every source after the
  first `true` stale. The aggregate asks all of them, deliberately not short-circuiting.
- `error()` is the **first** failure in source order, and it clears when that failure does — an
  aggregate that keeps reporting an arbitrary member's last error is worse than no aggregate.
- `status()` is `'reloading'` only when **nothing is missing**. A half-loaded screen is `'loading'`
  however much of it is filled in; `'reloading'` would tell a template it is ready to show.

`Combinable` is structural, so `SignalRequest` and `CachedRequest` both satisfy it without a union,
and a stub in a test satisfies it too — which is how the aggregate's own logic is tested without an
HTTP backend.

**`createRequests` reconciles by identity, not by rebuilding.** The obvious implementation is
`combine(items().map(build))`, and it is wrong for the same reason a `key` is needed at all: every
list change would destroy and rebuild every handle, so every keyed entry would drop to zero
observers and immediately rejoin. One handle is built per item identity and reused, so adding one id
to a list of twenty touches one handle. Identity defaults to `Object.is` on the item — right for a
list of ids — with a `key` escape hatch for objects, since two structurally equal objects are two
identities. Reordering is the case that makes this visible: the handles come back in the new order
_as the same objects_, and nothing is refetched to achieve it.

### Phase 6 notes — `/devtools`

The plan said "`/devtools` entry point", and the acceptance criterion was that it be _absent_ from
a production bundle that does not use it. The packaging is therefore the feature: a secondary
ng-packagr entry point, `sideEffects: false`, and — the part that actually matters — nothing in
`src/` importing it. There is no `isDevMode()` branch inside the library, and therefore no branch
that can be mis-trimmed or that a bundler has to be clever about. An application that never writes
`import … from 'ng-signal-request/devtools'` links none of it, which was checked rather than
assumed: the demo builds clean, `dist/demo/browser/main-*.js` contains `RequestCancelled` and
`httpResource` (so it does include the library) and contains none of `ngsr-devtools`,
`no cached queries`, `[ngsr] +`, `snapshotEntries` or `QueryDevtools`.

**A real bug came out of this phase, and it is worth recording because it would have shipped.** The
first implementation of `QueryDevtools` kept a `version` signal and bumped it from a
`cache.subscribeChanges` listener, so that adding or collecting an entry would invalidate the
`entries` computed. It throws immediately:

```
NG0600: Writing to signals is not allowed in a `computed`. Signal: 'version'.
  at QueryCache.notify (query-cache.ts:141)
  at QueryCache.resolve (query-cache.ts:55)
  at create-cached-request.ts:173
  at producerRecomputeValue (computed.ts:147)
```

`QueryCache.resolve` calls `notify()` **synchronously**, and `resolve` is called from a handle's key
`computed` — that is how a keyed handle builds its entry. So the listener ran inside a computed
evaluation. This is not a corner case: it is the first keyed request of any application that has
injected `QueryDevtools`. The fix is to coalesce the write into a microtask, which moves it outside
any evaluation; the cost is that `entries()` can be one microtask behind, which is what every other
signal in an application already is.

The general lesson is worth keeping in mind for the rest of the cache work: **`subscribeChanges`
listeners run synchronously inside `resolve`, which can be inside a computed, so a listener may
read the world but may not write a signal.**

Two deliberate omissions in what the panel reports, both because the alternative would be a lie:

- It does not judge freshness. Real staleness is a function of the `staleTime` of whichever handle
  is asking, which is a per-handle decision the entry does not know, so `'ready'` means "has data
  and nothing invalidated it" and the exact fact reported is `invalidated`.
- `observers` is a plain getter rather than a signal, because subscription bookkeeping is not
  something a template should be able to depend on. The consequence is a column that can lag one
  change-detection pass, which is stated in the README rather than hidden.

`tsconfig.lib.json` was also widened from `src/**/*.ts` to include `testing/**/*.ts` and
`devtools/**/*.ts` (with `rootDir` moved to `"."`). Both are published entry points that nothing in
`src/` reaches, so until now `pnpm typecheck` never compiled them — a gap that predates this phase
and that the `/devtools` entry point would have doubled.

### Phase 7 notes — `/persist` and SSR

The reload boundary and the SSR boundary are the same problem — take the cache out, put the cache
back — so they share one `dehydrate`/`hydrate` pair rather than two dialects of the same snapshot.
`providePersistedCache` covers `localStorage`; `provideCacheTransfer` covers `TransferState`; both
are the pair plus a provider that puts the call at the right moment.

**The design decision that mattered most was not to create entries when hydrating.** The obvious
implementation of `hydrate` is to walk the snapshot, `cache.resolve(key)` each entry and write the
value in. It leaks, and quietly. `QueryCache` arms an entry's `gcTime` timer in `release()` — the
moment the **last observer leaves** — so an entry that is never subscribed to has no observers, no
timer, and nothing that will ever remove it. Every persisted key would become an entry at startup
and stay for the life of the injector. Hydrating a hundred keys would pin a hundred entries,
including the ninety-five the application never asks for. `TtlCache`-style timers do not help; the
timer is armed by refcount, not by creation.

So `hydrate` **seeds** instead: `QueryCache.seed(key, value, dataUpdatedAt)` stages a value, and
`resolve` applies it at the moment an entry for that key is created. A payload nobody asks for is
dropped by the next hydrate and costs a `Map` entry until then. The cost is that seeded values are
invisible until consumed, which does make one assertion awkward — `cache().pendingSeeds` exists
partly so a test can see the staging at all.

**Seeding has to happen in the constructor, and this was a real bug, not a nicety.** `resolve` runs
inside the handle's key `computed` (see the Phase 6 note for the same stack), and Angular 22 forbids
writing a signal from inside a `computed`. Writing the restored value after construction —
`entry.restore(...)` — throws `NG0600` on the first keyed request of every application that
uses hydration. It typechecks, it reads perfectly, and it fails at runtime the first time a
persisted key is used. The fix is `SeedValue<T>` as a **constructor parameter**: the signals are
initialised with the value, which is creation rather than writing, so nothing is written at all, and
a seeded entry is never even briefly empty — which also removes the race where a handle reads an
empty entry and starts a fetch the seed was meant to prevent.

`restore()` still exists for the other half — a `seed` for a key that already has an entry — where
there is no constructor to hand anything to. That path is safe because `seed` is only called from
hydration, which happens at injector creation or in `main.ts`, never inside a computed.

**The other real bug was the destroy order.** `createPersister` registers its own `onDestroy(stop)`
when the persister is built, and `providePersistedCache` registers one afterwards to flush. Angular
runs `DestroyRef` callbacks in registration order, so `stop()` ran first, set `destroyed = true`,
and then the flush was a no-op — the one write that matters, because the debounce window is open and
the page is going away. The fix was to make the flush part of `destroy()` rather than something a
caller has to remember to do first: `stop()` flushes and _then_ stops. `Persister.destroy()` is now
documented as flushing, which is what its only real call site needs.

Notifications: persistence needs to hear about **data**, and `subscribeChanges` only reports the set
of entries. Reusing it would have produced a persister that writes an empty snapshot when an entry
appears and never writes again — the entry is created before it fetches, so the one interesting
event never fires that listener. Rather than build an `effect` that reads every entry (an O(n)
dependency graph, and one that would run a tick late), `QueryCache` gained a second, narrower
notification: `subscribeActivity`, which fires on the set changing _and_ on every settle. It is a
listener rather than a `Signal<number>` for the reason the devtools found the hard way, and its
listener must obey the same rule — which is why a failed write defers `enabled.set(false)` into a
microtask instead of writing it inline.

Smaller calls, each with a reason:

- **A snapshot is versioned and an unknown version is ignored**, not best-effort parsed. The storage
  key is global: the payload may have been written by an older build of the application, or by a
  different application that picked the same key. Reading a stale shape as if it were current is
  silent corruption with no way to notice afterwards.
- **`dataUpdatedAt` is restored with the value, and does not go through `setData`.** `setData`
  stamps `Date.now()` and sets `local`. Both are wrong here in ways that are invisible until they
  matter: the first makes persisted data permanently fresh, the second makes it report as a user
  edit.
- **`prefetch` returns a report instead of throwing.** A server render must render whatever it
  managed to fetch; `Promise.all` turns one failed endpoint into a 500 for a page that would have
  been fine.
- **`dateRevivingCodec` requires a full ISO instant with a zone.** `"2024-01-01"` is far more likely
  to be a slug, an order number or a version than a date, and a resolver eager enough to guess there
  corrupts data that never was a date. The codec also passes an existing `Date` through, because
  `provideCacheTransfer` can hand a snapshot over in memory rather than through JSON, and
  `Object.entries(new Date())` is `[]` — the first version of that function turned every `Date` into
  `{}`.
- **Storage failures disable the persister rather than throwing.** The worst outcome of a failed
  write is a slower first paint; the worst outcome of an unhandled `QuotaExceededError` inside a
  fetch's settle path is a broken application.
- **`localStorage` is probed in a `try`.** It is not enough to check `typeof` — in a sandboxed
  iframe or with cookies blocked, the global exists and _throws on access_.

Rejected: putting `dehydrate`/`hydrate` on `QueryCache` itself. They are serialisation policy —
what a codec is, what a version means, how old is too old — and the cache is the one class in the
library that deliberately has no options. Keeping them in `/persist` also keeps the snapshot code,
the codec and the storage probing in the bundle that only persistence users download.

### Phase 8 notes - the documented sharp edges, and a coverage gate

This phase had two halves: make the claims in the docs true again, and make the
quality bar enforceable instead of aspirational.

**Two README claims had become false, and stale documentation is worse than
missing documentation** because it is trusted. "Requests are not deduplicated -
two components asking for the same url each fire their own request" was only ever
true of a _keyless_ request, and stopped being the headline truth the moment keys
shipped. And "there is no `select` option and no infinite-query primitive" had been
sitting there since v0.0.4 while Phases 4 and 5 added exactly those two things. The
general lesson, recorded here because it will happen again: a feature phase is not
finished until the limits list has been re-read, since that list is where the
previous phase's absences were written down.

**One sharp edge was in the design doc rather than the README.** The section
headed "SSR is a genuine correctness problem" still described an
`EnvironmentProviders` factory as the chosen remedy, because that was the plan
before Phase 1 established that `providedIn: 'root'` already _is_ per-application
instance. The section now says what the code does, and names the residual risk that
no design can remove - it holds because the server renders per request, so a host
that reuses one injector across requests would share the cache. That is a fact
about the host, and it is written down rather than papered over.

**The one behavioural sharp edge in this phase needed no new code**, because it had
already been found and fixed while writing the Phase 7 tests: `Persister.destroy()`
now flushes an open debounce window _before_ it stops listening, so the destroy
order between `createPersister` and `providePersistedCache` no longer matters. See
the Phase 7 notes. The rest of this phase is tests, honest thresholds and honest
prose, which is the correct outcome for a phase whose job was to reconcile the
documentation with the library rather than to add to it.

Coverage went from 88.7% statements to 95.8% by testing what was _unexercised_
rather than what was convenient, and every gap that turned up was real API surface:
`ctx.chain()`'s explanatory failure on a cached handle, the params-cleared
"disabled" state (`run()` rejects, `tryRun()` reports, `reload()` returns `false`),
`timeout`/`headers` reaching the shared request, a throwing hook going to Angular's
`ErrorHandler` instead of failing the fetch, `set`/`update` writing through,
`refetchOnWindowFocus`, the poll timer re-arming, a cached retry, a throwing
`parse`, seeding into an entry that already exists, `QueryCache.clear()`, key
normalization for `bigint`/`Date`/`NaN`/`-0` and the function-segment error, and
the whole of `createInfiniteRequest`'s remaining surface (`select`, `cancel`,
`reload` guards, `entryFor`, `isFetchingPreviousPage`, `reload`, an envelope page
passing through unflattened, `onSuccess`/`onError`).

Two testing facts were learned the hard way and are now in the README:

- **A cached retry needs `setInterval` faked as well as `setTimeout`.** RxJS'
  async scheduler drives a delayed retry through an interval, so faking only
  `setTimeout` leaves the retry on a real timer - the test then fails with "found
  no matching request" rather than with anything that mentions timers.
- **The Angular testing backend does not forget an aborted request.** `verify()`
  still reports it, so cancellation is asserted with `request.cancelled`, exactly
  as the Phase 1 abort tests already did.

Thresholds are now wired into `angular.json` (`90` statements, `85` branches, `90`
functions, `90` lines) and `pnpm test` runs v8 coverage, so the gate is active
locally and in CI without a second script. The numbers are deliberately _below_
the current ones (95.8 / 90.0 / 96.3 / 97.8): a threshold set at the current
figure would fail on any harmless refactor that touched one branch, which trains
people to move the number rather than to test. The gate was also verified by
raising `lines` to 99 and confirming the run fails with
`ERROR: Coverage for lines (97.84%) does not meet global threshold (99%)` - a
threshold that has never been seen to fire is a threshold nobody should trust.

Deliberately not done: a `maxEntries` cap on the cache (still deferred, still
honestly documented as a gap), and ESLint + Prettier (proposed for v0.1.1, since
adding a linter is a toolchain and supply-chain change rather than a fix).
