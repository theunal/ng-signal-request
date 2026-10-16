# Design — server state for `ng-signal-request`

Status: proposal for v0.1.0. Written before any of the cache code exists.

## 1. Where we are today

`createRequest` builds an Angular `httpResource` per handle. `createMutation` already
talks to `HttpClient` directly. So the library has two transports, chosen by what
each primitive needs — the library is not uniformly `httpResource`-based, and that
matters for everything below.

What exists and is shared between the two paths, in `utils.ts`:

| Function | Role |
| --- | --- |
| `resolveRequest(value, method, baseUrl, params)` | source → `HttpResourceRequest`; fills `path`, splits `params`, applies the verb |
| `withGlobalHeaders(request, global)` | merges global defaults; reads a reactive `headers()` **inside the reactive chain** |
| `normalizeRetry` / `nextRetryDelay` | retry policy, shared by queries and mutations |
| `splitParams` | `body` / `path` / `headers` vs query string |

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
  precisely what we are trying to *avoid* unless the last subscriber left.

And the decisive point: the features Phase 1 asks for — refcount, dedup,
stale-while-revalidate, gcTime, abort-on-last-unsubscribe — are **properties of a
fetch coordinator**, not of a reactive request primitive. Adopting `httpResource`
per entry would mean reimplementing all of them *on top of* it, plus paying for a
primitive whose reactive semantics fight the job. Bending `HttpClient` into that
shape is about the same amount of code and is legible.

### Why not "return `undefined` from the params chain while a fresh entry exists"

This was the original sketch and it is wrong in a specific way: it dedups the
*response* but not the *network call*. Two components mounting at the same time
would each get their own `httpResource`, each of which would decide independently
to return `undefined`, and the moment the entry went stale both would fetch. To
actually coalesce, you need a shared in-flight promise — at which point you have
built the coordinator anyway, and now you have *also* kept the resource, with its
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
stated reason: *"`httpResource` is meant for reads (it is eager and cancels the
previous request, which is not what you want for writes)."* The same argument
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
  steady state: the entry's state *is* the signal graph, and the handle just
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

| Entry | `status()` |
| --- | --- |
| disabled (source returned `undefined`) | `idle` |
| no data, fetching | `loading` |
| has data, fetching | `reloading` |
| has data, not fetching, no error | `resolved` |
| terminal error | `error` |
| a `set()` / `setData()` wrote locally | `local` |

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

If the result is the *old* reference, the entry's data signal is not written and
**no consumer re-runs**. This is what keeps a 200-response with one changed field
from re-rendering an unchanged table, and it composes with `equal` rather than
replacing it: `equal` is the degenerate "is this the same value?" case of the
same idea.

## 5. Public API draft (Phase 1)

```ts
createRequest(source, {
  key: () => ['users', { page: page() }],   // opt-in; absent = today's behaviour
  staleTime: 5_000,                          // 0 = always stale
  gcTime: 300_000,                           // default 5 min
  refetchOnMount: 'stale',                   // 'stale' | 'always' | false
  structuralSharing: (old, next) => next,    // default: identity
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

| Risk | Mitigation |
| --- | --- |
| Two code paths drift | The shared primitives (`resolveRequest`, `withGlobalHeaders`, retry, `toRequestError`) are already factored out and are used by both. Only the fetch/status orchestration is duplicated, and it is deliberately small. |
| `key` read outside a reactive context → stale entry | The key is read in a `computed`; a signal it reads becomes a dependency, exactly like the existing source. |
| Entry leaks | Refcount + gcTime, plus a leak test that asserts subscriber count and timer count return to zero. |
| Memory: `Map` grows forever with many distinct keys | `gcTime` bounds it. A `maxEntries` cap is a follow-up, not in v0.1.0. |
| SSR: entry state leaking between requests | `QueryCache` is a root singleton. A server rendering two different users would share entries. **This is a real problem** — see below. |
| Structural sharing makes the response mutable-looking | It only ever returns a *previous* reference, never mutates. Callers must still treat cached data as immutable; documented. |

### SSR is a genuine correctness problem

A root-scoped `QueryCache` on the server is shared across all requests in the
process. Two users rendering `/users` at the same moment would share one entry
and potentially see each other's data.

Options, and why the first:

1. **Per-application-instance cache.** `provideSignalRequest` already returns
   `EnvironmentProviders`; the cache is created per `ApplicationRef`. Phase 7
   hydrates it from `TransferState` at bootstrap, so per-instance is also what
   hydration needs. Requires handing the cache to `bootstrapApplication`'s
   environment injector — which is exactly what an `EnvironmentProviders`
   factory already does.
2. Request-scoped cache via `REQUEST` injection token — correct, but Angular
   only provides `REQUEST` inside a route handler, and a root service cannot see
   it.
3. Document that SSR users must provide a fresh cache per request — a footgun.

Going with 1, in Phase 1, so the SSR story is not retrofitted in Phase 7.

## 8. Rejected alternatives

- **Keep `httpResource` for keyed requests** (entry-per-resource). §2.
- **Cache in front of `httpResource` via the params chain.** §2.
- **Per-request `QueryCache` via `new QueryCache()` passed to every call.** Makes
  `invalidate` a global side channel to find them. Rejected.
- **Signals instead of `computed` for entry state.** Entry state *is* reactive —
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
  addition; it is not in v0.1.0 scope. Recommended as v0.1.1.
- **CI does not build the demo app**, so template type errors in demo sections are
  not caught. A `pnpm build:demo` step should be added to the workflow; cheap and
  clearly right.
- **Two READMEs are kept byte-identical by hand.** This has already caused one
  committed drift. A `cmp` check belongs in CI.

## 10. Phase plan

| Phase | Contents | Depends on |
| --- | --- | --- |
| 1 | `QueryCache`, `CacheEntry`, key normalization, `key` option, dedup, `staleTime`, `gcTime`, `refetchOnMount`, structural sharing, abort, per-instance cache | — |
| 2 | Injectable `QueryClient`: `invalidate` / `refetch` / `cancel` / `getData` / `setData` / `remove` / `isFetching`, prefix matching, batched invalidation; `invalidates` key overload | 1 |
| 3 | `mutationKey`, `onMutate` context, `isMutating()`, `target` accepts a key | 2 |
| 4 | `createInfiniteRequest` | 1 |
| 5 | `select` that does not break inference; `createRequests` + `combine` | 1 |
| 6 | `/devtools` entry point | 1, 2 |
| 7 | `/persist` entry point; `TransferState` dehydrate/hydrate, `prefetch` | 1, 2 |
| 8 | Fix the documented sharp edges | 1–7 |

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

**`response()` flattens only when a page *is* an array.** `TPage` is opaque — a page may be
`Item[]` or `{ items, cursor }`, and there is no way to know which field of an envelope is the
list. Guessing produces a plausible-looking list that is wrong for some API. So the runtime flattens
arrays and passes anything else through, and the *type* follows the same condition via
`FlattenedPages<TPage>`: `InfiniteRequest<Item[], P>` has `Signal<readonly Item[]>`,
`InfiniteRequest<Envelope, P>` has `Signal<readonly Envelope[]>`. The type and the runtime agree
because they are guarded by the same predicate.

**`reload()` is sequential, not parallel.** Pages are independent entries and could be refetched
concurrently, which would be faster. Offset pagination is only coherent when the pages are requested
in sequence, though, and a page that comes back with a different set of rows is far easier to reason
about when the pages are not racing each other. Sequential is slower on purpose.

One bug worth naming, because it is the class of bug the `untracked` helper invites: `pages()` was
first written with `untracked(page.entry.data)` inside the `computed`. That reads correctly and
passes on one page — the accumulated list only breaks on the *second* page, because a page arriving
does not change `loadedParams()`, so nothing re-invalidates the computed. The reads must be tracked.
`isFetchingNextPage()` had the same shape. Both are tracked now, and the tests that caught them are
in `infinite-request.spec.ts`.