# Design — 0.2.0

Written 2026-10-16, before the code, continuing `docs/design.md`. The same rule
applies as there: the plan is a plan, and where the code and this document
disagree the code is right; disagreements get written down.

## Scope of this document

The 0.2.0 brief has six phases. They are not equally hard, and the brief says so:
two of them are small and mostly additive, and two change the request lifecycle
itself.

| Phase | Subject                                 | Status                                     |
| ----- | --------------------------------------- | ------------------------------------------ |
| 0     | Verify the 0.1.0 claims                 | **Done** — see `docs/verification.md`      |
| 1     | Bound the cache in space (`maxEntries`) | **Done** in this session                   |
| 5     | Remove the known traps                  | **Done** in this session                   |
| A     | Type-compatibility audit against 0.1.0  | **Done** in this session, below            |
| 2     | Offline / `networkMode`                 | **Done** in this session, below            |
| 3     | Async persistence and migrations        | Designed here, deferred to its own session |
| 4     | Non-HTTP sources (`queryFn`)            | Designed here, deferred to its own session |
| 6     | Devtools depth                          | Designed here, deferred to its own session |

Phases 2 and 4 change how a request is _driven_: an offline query does not fetch
until the network returns, and a `queryFn` query has no `HttpClient` behind it at
all. Both reach into `CacheEntry.execute`, which is the one method every keyed
request goes through. Doing them in the same session as two safe phases would put
the risky change and the safe change in one diff, and a bisect would not be able
to tell them apart. Phases 1 and 5 are shape-preserving: new options, new
signals, better messages, no change to how a fetch is executed.

## Global constraints, restated as decisions

- **Zero new runtime dependencies.** `tslib` plus Angular peers only. Anything
  that looks like it needs a library (a migration library, an IndexedDB wrapper)
  is written by hand or is not done.
- **No breaking change.** `pnpm check:api v0.1.0` must keep reporting
  `removed 0`. That means every new option is optional, every new signal is
  additive, and the `RequestErrorKind` union may gain optional _fields_ but never
  new or renamed members.
- **A handle without a `key` behaves exactly as it does today.** Nothing in
  Phase 1 or 5 touches the `httpResource` path except a dev-mode warning.
- **Tree-shakeable.** Phase 1 and 5 add code to the core entry point, which is
  under a 20 KB gzip budget and was at 15.9 KB. Phase 2 and 3 add code to
  secondary entry points. `pnpm check:dist` must keep proving that an unused
  entry point never reaches a production bundle.
- **Strict TypeScript, inference intact.** `createRequest<User[]>(url, { key })`
  must stay callable with one type argument.

---

## Step A — the 0.1.0 type-compatibility audit

Phase 0 asked "which export names went away?", and the answer is measured by
`pnpm check:api`. It never asked the harder question: **does code written against
0.1.0 still compile?** A name can survive and still become unusable, because the
shape behind it changed — which is exactly what 0.2.0's `/persist` work did to
`Persister.hydrate()`.

So the check is an executable one. `compat/v0.1.0/` holds a fixture written
against the **0.1.0 public API only** — the four entry points, the usage the 0.1.0
README shows, and the shapes a 0.1.0 caller would have annotated by hand — and
`pnpm check:types-compat` compiles it, in strict mode, against the **built
`dist/signal-request` declarations**. `pnpm verify` runs it after `build`.

The fixture is not documentation. It is the claim "this still works", and it fails
the build when the claim stops being true.

### The rule for a failure

For each name that stops compiling, there are two outcomes, and the default is the
first:

1. **Restore it.** If there is a way to keep the 0.1.0 meaning _and_ have the new
   one, the new one is expressed in terms that do not cost the old one anything.
   `Persister.hydrate()` is the worked case below.
2. **Accept it.** Only when the two meanings are genuinely incompatible, and only
   with a written justification and a `// @ts-expect-error` line in the fixture
   that carries the reasoning. The directive is load-bearing: if a later change
   accidentally restores the old spelling, the `@ts-expect-error` becomes an
   _unused_ directive and the check fails, which is the prompt to delete it and
   the accepted break with it.

### `Persister.hydrate()` — restored, not accepted

0.1.0's `hydrate(): number` became `hydrate(): number | Promise<number>`, because an
IndexedDB read cannot answer synchronously. `await persister.hydrate()` is
unaffected; `const n: number = persister.hydrate()` broke.

The fix is a conditional return type, not a cast and not an overload pair. The
storage is the thing that knows the answer, so the storage's type is what selects
it:

```ts
export type RestoreOf<S> = S extends { getItem(key: string): infer R }
  ? R extends string | null
    ? number // a synchronous storage: `hydrate()` answers on this stack
    : R extends Promise<unknown>
      ? Promise<number> // an asynchronous one: it cannot, and says so
      : number | Promise<number> // mixed or unknown: the honest union
  : number;
```

and `createPersister` infers it from the option:

```ts
export function createPersister<S extends CacheStorage | null | undefined = undefined>(
  options?: PersistOptions<S>,
): Persister<RestoreOf<S>>;
```

So `createPersister({ storage: localStorage }).hydrate()` is `number` again,
`createPersister({ storage: indexedDbStorage() }).hydrate()` is `Promise<number>`,
and `createPersister().hydrate()` is `number`. The distribution over the union is
what makes the middle case work: `CacheStorage`'s `string | null | Promise<string |
null>` distributes to `number | Promise<number>`, which is why a caller who widened
their own storage to the interface keeps the union rather than a lie.

`indexedDbStorage()` also gained a narrower return type (`AsyncCacheStorage`, a new
export) so the inference has something to bite on. It is a subtype of
`CacheStorage`, so nothing that took the old return type breaks.

**The residual, accepted.** The `Persister` _type_ — and therefore the
`CACHE_PERSISTER` token — keeps the union when it is written without a type
argument. A non-generic interface cannot mean two things, and a token cannot carry
a type parameter, so `inject(CACHE_PERSISTER).hydrate()` is `number | Promise<number>`
where 0.1.0 said `number`. That case is in the fixture behind a
`// @ts-expect-error`. Justification: the union is _true_ through the token — the
persister a token resolves may have been built over any storage — and refusing to
say so would be the silent-wrong-answer failure the widening exists to avoid.

### The `dehydrateFilter` default — accepted, with an opt-out

`dehydrate`'s default filter narrowed from "anything with data" to "has data, is
not fetching, is not in an error state" (Phase 3, `defaultDehydrateFilter`). It
changes no type, so the fixture cannot see it; it is a behaviour change and it is
in the CHANGELOG's `Changed` with a migration note.

The brief asked for an opt-out that restores the 0.1.0 filter if none existed, and
none did. `anyDataDehydrateFilter` is that value:

```ts
providePersistedCache({ dehydrateFilter: anyDataDehydrateFilter });
```

It is `(entry) => entry.hasData()`, which is 0.1.0's `data !== undefined` clause
and nothing more.

### The rest of the audit

Everything else 0.2.0 added is optional and therefore additive: new options on
`SignalRequestConfig`, `CacheOptions`, `MutationOptions`, `PersistOptions`,
`DehydrateOptions`, `HydrateOptions`; new signals and methods on the handles and
`QueryCache` / `QueryClient`; new members on the `RequestError` union. The fixture
compiles all of it against the built declarations, so "no type-level break" is a
measurement rather than a reading of the diff. `Persister extends RestoreGate` —
two added members — is the one place where a _consumer who implements_ the
interface breaks; nobody can, since `createPersister` is the only producer, and the
fixture pins the intended direction (assigning a `Persister` to a `RestoreGate`
compiles).

### Behaviour changes a 0.1.0 consumer could notice without a compile error

Listed here so the CHANGELOG can point at a single source:

| Change                          | Default now         | 0.1.0                 | Opt-out                                          |
| ------------------------------- | ------------------- | --------------------- | ------------------------------------------------ |
| `dehydrateFilter`               | narrowed            | anything with data    | `anyDataDehydrateFilter`                         |
| `waitForRestore`                | `true`              | n/a (no gate existed) | `waitForRestore: false`, or `restoreTimeout: 0`  |
| `retryTimeouts`                 | `true`              | retried timeouts too  | `retryTimeouts: false` (default flips in 0.3.0)  |
| seeds count toward `maxEntries` | yes                 | no seeds existed      | none needed (no seeds unless `/persist` is used) |
| `Persister.hydrate()`           | `number \| Promise` | `number`              | none (restored for `createPersister`)            |

---

## Phase 1 — `maxEntries`

### The problem, precisely

`gcTime` bounds the cache in time. Every entry that loses its last observer arms
a timer and is dropped when it fires, so a cache with 10 keys touched once a
minute stays small. What `gcTime` does not bound is the number of _distinct_ keys
touched inside one window. A typeahead that keys on the query string, a
virtualised list that keys on the row id, or a `createRequests` over a large
array all produce a new key per interaction. With a 5 minute `gcTime`, a minute
of typing can hold hundreds of entries that nothing will ever read again, and the
memory cost of each is a `CacheEntry` plus five or six signals.

### API

```ts
// Global. Default: unlimited, so 0.1.0 applications are unaffected.
provideSignalRequest({ maxEntries: 500 });

// Per request. Optional; the effect on the shared cache is described below.
createRequest('/users', { key: () => ['users'], maxEntries: 100 });

// Reading it back.
inject(QueryClient).size(); // Signal<number> — the whole cache
inject(QueryClient).evict(['users']); // number — matching *and idle* entries only
inject(QueryCache).maxEntries; // number — the effective cap, Infinity when none
```

Signatures:

```ts
interface SignalRequestConfig {
  /** Upper bound on unobserved entries. Default unlimited. 500 is a sane value. */
  maxEntries?: number;
}

interface CacheOptions<T> {
  /** Can only tighten the global cap, never loosen it. See "why min()" below. */
  readonly maxEntries?: number;
}

class QueryClient {
  /** Number of entries in the cache, as a signal. Coalesced to a microtask. */
  size(): Signal<number>;
  /** Removes matching entries that nothing is watching. Returns how many went. */
  evict(filter?: QueryKeyFilter): number;
}

class QueryCache {
  /** The effective cap. `Infinity` when nothing configured one. */
  get maxEntries(): number;
  /** Narrows the cap. A cap is a budget: this can only lower it. */
  tightenMaxEntries(cap: number): void;
}
```

### Eviction policy

Enforcement runs **on insert**, synchronously, inside `QueryCache.resolve`.

A candidate is an entry with `observerCount === 0` **and** no request in flight.
Among candidates the least recently used goes first. That is the whole policy;
the two guards are the load-bearing part:

- An entry with a subscriber is someone's data. Evicting it would make a mounted
  component's `response()` go to `undefined` and turn a cache hit into a spinner,
  which is the opposite of the feature.
- An entry with a request in flight has a caller waiting on a promise. Evicting
  it would leave that promise unresolved until its timeout, or reject it with a
  `RequestCancelledError` the caller never asked for.

If there is no candidate — everything is live — the cap is _not_ met, the cache
overshoots, and a dev-mode warning explains why:

```
[ngsr] maxEntries: 120 entries with nothing watching, cap is 100; every other
entry has a subscriber or a request in flight, so the cache is over its cap
until something goes idle.
```

The warning is guarded by a flag that resets the moment the cache comes back
under the cap, so a permanently undersized cap does not log on every insert.

Recency is a monotonic counter held by the cache, stamped onto the hash on
`resolve` and on every settle. It is deliberately **not** a signal and
deliberately not in `CacheEntry`: nothing renders it, and `CacheEntry`'s
surface is exported.

### Why `min()` and not a per-request allowance

The brief asks for the option globally _and_ per request. There is one cache for
the application, so a per-request cap has to mean something about that shared
store. Three readings are possible:

1. **Per key-prefix budget.** `maxEntries: 100` on `['users', id]` caps the
   `'users'` domain at 100 entries, independently of other domains. This is the
   most useful reading and was rejected as too much machinery for a small phase:
   it needs a prefix→cap registry with its own lifecycle, a rule for two requests
   declaring caps for overlapping prefixes, and a way for the devtools to show
   every domain.
2. **Last writer wins.** A request declaring `maxEntries` replaces the cache's
   cap. Order-dependent (whichever request was constructed last decides, which is
   a constructor-order accident), and a request could _raise_ the cap above what
   the application owner configured. Rejected.
3. **The tightest budget wins: `min(global, every declared per-request)`.**

Chosen. It is order-independent, it means the global value is a hard ceiling that
no leaf request can exceed, and it is trivially explainable: _a per-request
`maxEntries` can only make the cache smaller._ The cost is real and is documented
rather than hidden — a request cannot ask for a larger budget than the global
one, so a screen that genuinely needs 1000 entries while the rest of the app
needs 50 has to raise the global value.

### Why eviction cannot use `destroy()`

`resolve` runs inside the handle's key `computed`. That is a constraint the
codebase has already been bitten by twice, and it is why `SeedValue` is a
constructor parameter and why the devtools listener defers to a microtask.

`destroy()` writes signals (`cancel()` sets `isFetching`, `retryAttempt` and
`progress`), so calling it from `resolve` is `NG0600`. The fix is to split the
method:

```ts
destroy(): void {                 // unchanged behaviour, signal writes included
  if (this.destroyed) return;
  this.destroyed = true;
  this.cancel();
  this.teardown();
}

/** `destroy()` for an entry with nothing in flight: identical, minus the signal writes. */
evict(): void {
  if (this.destroyed) return;
  this.destroyed = true;
  this.teardown();
}

private teardown(): void {        // plan, settle listeners, gc timer, onDestroy
  ...
}
```

Skipping `cancel()` is safe _by construction_, not by optimism: eviction only
ever selects entries with no observers, and an entry loses its observers only
through `release()`, which cancels the request on its way out. So for a candidate,
`cancel()` was a no-op apart from its signal writes. The guard in the selector
(`!isFetching()`) is what keeps that argument true, and there is a test that
fails if it is removed.

### A parallel recency map, not a field on `CacheEntry`

`CacheEntry` is exported and is what the devtools panel reads. A `lastUsedAt`
field on it would be public API for a bookkeeping detail, and would survive into
`DevtoolsEntry` as a column nobody asked for. The cache keeps
`Map<hash, number>`, maintained alongside `settleDetachers` — the same pattern,
the same lifecycle points (`resolve` adds, `forget`/`remove`/`clear` delete).

### Cost

Enforcement is a scan of the entry map per insert, picking the minimum recency
among candidates: `O(entries)` per insert, and `entries` is bounded by the cap,
so a cache at its cap pays `O(cap)` per insert and never grows. At the
recommended 500 that is 500 comparisons on a cache miss, against a network
request that costs thousands of times more. A heap was rejected as unearned
complexity for a small phase — it is the obvious optimisation if a benchmark ever
shows this matters, and there is a benchmark in `docs/perf.md` to find out.

### What the cap covers — staged seeds count too (Step 0.1, added after this document)

The section that used to sit here said `QueryCache.seeds` was deliberately
**outside** `maxEntries`. That was wrong, and this is a correction rather than a
rewrite: a staged value is memory being held for a key somebody will ask for, so
leaving it outside the bound let one large persisted snapshot bypass the cap
entirely — the accumulation the feature exists to prevent, one reload away.

**Policy.** The cap bounds `entries + seeds`. When the total is over:

1. seeds are dropped first, oldest `dataUpdatedAt` first, a tie keeping whichever
   was staged first (`Map` insertion order);
2. then idle entries are evicted by the Phase 1 LRU rule.

Seeds first, because a seed is a value **no handle has asked for yet this
session**: losing one costs a refetch the next time its key is used, whereas
evicting an entry also throws away an object handles have already resolved and
could be about to re-attach to. Oldest-`dataUpdatedAt` first because that is the
clock `staleTime` already uses, so the seed dropped is the one least likely to
have been worth restoring.

Rejected: a separate `maxSeeds` (a second knob for the same resource, and the
snapshot has no natural size of its own); "drop whoever was staged last" (that is
the _freshest_ data, and it would make `hydrate` order-dependent in the worst
way).

**Enforcement points:** `seed()`, `resolve()` — with one place reserved for the
entry about to be inserted — and `tightenMaxEntries()`. Those are the only places
either collection grows, so the invariant holds between them without any
periodic pass.

**A seed a resolve is consuming can never be the one evicted**, and that is
structural rather than optimistic: `resolve` deletes the seed and hands it to the
`CacheEntry` constructor _before_ it enforces the cap, and the new entry joins the
map _after_. At no point in between is the value being consumed still staged.

**What deliberately did not change.** The eviction guards, the overshoot warning,
and `QueryCache.size` (still entries; the capped total is
`size + pendingSeeds`). Overshoot is still only possible when live entries alone
exceed the cap, because seeds are always droppable. Two things were adjusted for
honesty: the devtools label shows the staged part (`cache 3 + 12 staged / 100`) so
the readout cannot quietly under-report, and `clear()` now drops staged values
too, because "empty" has to mean empty.

**Cost.** Every `seed()` that lands over budget scans the staged map — at most
the cap — for its oldest member, so `hydrate`ing `n` values costs `O(n · cap)`
once, at startup. There is a benchmark for it in `docs/perf.md`. `hydrate()`'s
return value keeps counting what the snapshot _contributed_, not what survived:
the cap is the cache's policy, and a snapshot is a hint rather than a
reservation.

---

## Phase 5 — the known traps

Five items. Each is either fixed, or fixed where a fix exists and documented
where it does not.

### 5.1 A timeout is retried by default

Today: `timeout` produces a `status: 0` failure, the default retry predicate
treats `status: 0` as transient, so `timeout: 5000` with `retry: 2` takes ~15
seconds to fail. That is documented in `types.ts` as a caveat rather than fixed,
which is exactly the kind of documentation that becomes a bug report.

The brief asks for a behaviour change gated behind an option so 0.2.0 stays
compatible, with a dev-mode warning and a migration path. Design:

```ts
interface SignalRequestConfig {
  /**
   * Whether a timeout counts as retryable. Default `true` in 0.2.0 — the 0.1.0
   * behaviour. **Set this to `false`**; the default flips in 0.3.0.
   */
  retryTimeouts?: boolean;
}

interface RequestOptionsBase<T, TParams, TRaw> {
  /** Per-request override of the global `retryTimeouts`. */
  retryTimeouts?: boolean;
}
```

When it is `false`, a timeout is not retried by the **default** predicate. An
explicit `retry.when` is a user decision and is left alone entirely — the option
only governs what the library decides on its own.

Detecting "this failure was a timeout" needs no new plumbing: `errors.ts`
already classifies a `TimeoutError` abort, and `RequestErrorContext.timeout`
already exists for it. The retry predicate can route through the same
classification instead of re-deriving it from `status === 0`.

Dev-mode warning, when a request declares both a `timeout` and a retry and says
nothing about `retryTimeouts`:

```
[ngsr] `timeout: 5000` with `retry: 2` can take ~15000 ms to give up, because a
timeout is retried by default. Pass `retryTimeouts: false` to stop at the first
timeout, or set `retry: { when: … }` to decide for yourself.
```

Migration path, as the brief requires: 0.2.0 default `true` + warning; 0.3.0
default `false` and the warning becomes an error path in the changelog. The
README's `timeout` row gains the option rather than the warning it has today.

### 5.2 A non-GET `createRequest` fires writes

`createRequest.post('/x')` builds a reactive resource. Change a signal its source
reads and it POSTs again. Nobody means that; they mean a mutation.

A dev-mode-only warning when a non-GET variant is created without `lazy: true`:

```
[ngsr] `createRequest.put(...)` is reactive: it will re-send whenever a signal
its source reads changes. For a write, use `createMutation.put(...)`, or pass
`lazy: true` and call `run()` yourself.
```

"Dev-mode only" is `isDevMode()` guarding a `console.warn`. There is no
production behaviour, and the check is a string comparison on the method plus a
boolean read, behind a branch that minifiers keep but that costs nothing on the
happy path. This is the one place the library deliberately reports something the
user did not ask it to.

### 5.3 `status: 0` ambiguity

What `status: 0` can mean: the network is down, the request was blocked (CORS,
an extension, mixed content), the request was aborted, or the fetch failed for a
reason the browser will not name. What can be distinguished:

| Situation                        | Signal available                                | Verdict                                      |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Aborted on purpose               | `AbortError` / `TimeoutError` name on the cause | Already classified as `aborted` / `timeout`  |
| Off by the browser's own account | `navigator.onLine === false`                    | New: `offline: true` on the `network` member |
| Blocked, CORS, opaque            | nothing — the browser hides it                  | Stays `network`, honestly unclassified       |
| Everything else                  | nothing                                         | `unknown`                                    |

The change is one optional field:

```ts
| { readonly kind: 'network'; readonly cause: unknown; readonly offline?: boolean };
```

`kind` gains no members and no member is renamed, per the brief. It is optional
so a consumer's `if (error.kind === 'network')` narrowing keeps compiling.

`navigator.onLine` is read defensively (`typeof navigator` guard) so the server
reports `offline: undefined` rather than throwing. Phase 2 replaces the source
with `OnlineManager.online()`, which is the same value with an override seam;
`offline` stays the field either way, so this is not throwaway work.

What is deliberately **not** done: inventing a `cors` kind. There is no reliable
signal, and a guess that is sometimes wrong is worse than an honest `network`.

### 5.4 Cached handles have no `.resource` and no `ctx.chain()`

The question the brief asks is whether dependent queries can be supported on a
cached handle — a `dependsOn` / `enabled` option, or a chain helper built on
handles.

Investigation first, because the answer decides which of three things to do. A
cached handle's key is a `computed` that reads the caller's key factory. If that
factory reads another handle's signal, the dependency is already reactive _and_
already correct: the argument — the upstream value — is part of the cache
identity, so two consumers of the same derived key share one entry. That is
strictly better than `ctx.chain()`, which transports an argument without making
it part of the identity.

What is genuinely absent on the cached path is `enabled`: "do not fetch until X".
On the uncached path that is a source returning `undefined`. On the cached path
the equivalent is a key that declines to resolve. The decision is made in the
"code" section below, after the implementation, per the disagreement rule at the
top of this document.

Whichever way it goes, the runtime message already points at the recommended
alternative, and the type error is checked: `.resource` must be a compile error
on `CachedRequest`, not a `undefined` that fails at runtime.

### 5.5 `onMutate`'s `TContext` is only inferred when no type arguments are written

Today, `createMutation<T, TArgs>(...)` forces `TContext` to its default because
TypeScript has no partial type-argument inference — the same wall Phase 5 of the
0.1.0 plan hit with `select`, which is why `select` is a method rather than an
option.

The brief asks for overloads or a builder. Both are tried as probes against the
real declaration, and the outcome is recorded verbatim either way: if it cannot
be done, the current behaviour stays and an `expectTypeOf` test pins it so nobody
"fixes" it into something worse.

### 5.6 As built — where the code disagrees with the above

The document is a plan, so the differences are listed rather than edited away.
None of them changes a public name; each is either a narrowing or a measurement.

**5.1, the predicate routes through `errors.ts` rather than re-deriving it.**
As designed, with one rename: `isAbortLike` is exported from `errors.ts` and
`isTransient` gained a `retryTimeouts` argument. The flag governs the abort-like
branch only, so a `TypeError` or a bare `status: 0` that is _not_ an abort stays
transient. `public-api.ts` lists its exports by name, so exporting the helper did
not widen the API — `pnpm check:api` still reports 0 added for it.

**5.1, the warning is deduplicated.** As designed, plus `warnDevOnce`: one line
per combination per page load. The design put the warning at the call site
("a request declares both"), which is once per handle — and a handle is once per
component instance, so a revisited route would warn on every navigation. A
repeating warning is a filtered warning. The cost is module state, which is why
`dev-warnings.spec.ts` uses a distinct message per assertion.

**5.1, the migration is a warning, not a scheduled default flip.** The design
promised "0.2.0 default `true` + warning; 0.3.0 default `false`". That second half
is a policy for a release this document cannot commit, and a default that flips
is a breaking change that deserves its own deprecation decision — in 0.3.0, with
the escape hatch already in place. 0.2.0 ships the option, the warning and the
migration note; the flip is left open.

**5.2, the warning reads the caller's name.** `caller.name` is the same dotted
label Angular's `NG0203` message uses (`createRequest.post.text`), so the warning
names the exact call instead of the method, and dedupes per call shape rather than
per verb.

**5.3, `offline` is `?: true`, not `?: boolean`, and is only ever set when the
browser is certain.** The design's field would have been present with `false` in
any browser, which (a) breaks the 0.1.0 assertion
`toEqual({ kind: 'network', cause })` — an additive field with a concrete value is
not additive to `toEqual` — and (b) claims something the library cannot know:
"the browser believes it is online" is not "the request reached a server", and a
CORS rejection lands in the same member. Absent-means-nobody-said is the honest
encoding, and `offline?: true` is what makes that visible in the type rather than
only in the docs. If Phase 2's `OnlineManager` ever produces an authoritative
`false`, widening `true` to `boolean` is additive for every reader.

**5.4, the answer is "the alternative is the feature", with tests instead of an
`enabled` option.** The investigation confirmed the design's reading and went one
step further: `resolveRequest` returning `undefined` short-circuits
`rawPlan` _before_ `cache.resolve`, so a gated dependent request creates no entry
for its not-yet-meaningful key. That makes "source returns `undefined`" a complete
`enabled` on the cached path, with no new option — so no option was added, and
`dependent-queries.spec.ts` pins both halves (no request _and_ no entry; the
upstream value inside the downstream key). The runtime and compile-time pointers
(`ctx.chain()`'s message, `.resource` as a type error) already existed and were
only asserted.

**5.5, infeasible, and the near-miss is worse than the limitation.** The probe
(kept out of the tree; reproduced here) tested four forms against a declaration
shaped like the real one:

```ts
// works — `TContext` is inferred from `onMutate`
const a = factory((title: string) => ({ url: '/x' }), { onMutate: (t) => ({ title: t }) });

// error TS2322: Type '(title: string) => { title: string; at: number; }' is not
// assignable to type '(args: string) => Promise<undefined> | undefined'.
const b = factory<number, string>((title) => ({ url: '/x' }), { onMutate: (t) => ({ title: t }) });
```

The overload that captures the options object — `O extends Options<T, A, unknown> =
Options<T, A, unknown>`, with the context recovered by a conditional on `O` —
**compiles** and reports `context()` as `unknown` (probe: `error TS2322: Type
'unknown' is not assignable to type '{ title: string; at: number; } |
undefined'`). So the choice is between a loud compile error and a silently
degraded type, and the loud one wins: it is fixable in one word
(`createMutation<T, TArgs, TContext>`) and the silent one removes the only reason
`context` is generic at all. The limitation is documented on `onMutate`, in the
README's "Known limitations", and pinned by a `@ts-expect-error` test in
`mutation-key.spec.ts`.

---

## Phase 2 — offline / `networkMode` (as built)

### The correction this phase starts from

The sketch this section replaces wrote:

```ts
interface SignalRequestConfig {
  networkMode?: NetworkMode; // 'online' (default) | 'always' | 'offlineFirst'
}
```

**That comment is wrong.** 0.1.0 sent every request regardless of what the browser
said about connectivity. `refetchOnReconnect` only decided whether a _reconnect
event_ started a refetch; the `offline: true` field on a `network` error was a
classifier read at failure time, not a gate; and nothing anywhere consulted
`navigator.onLine` before opening a connection. No code path was ever paused.

So the behaviour that exists today is `'always'`, and `'online'` has to be opt-in.
Making `'online'` the default would be a silent change for every existing
application: a request that used to fire and fail loudly while offline would
instead sit paused with a pending `run()` promise, and the failure a caller was
already handling would stop arriving. The brief's own rule — "the effective default
must equal today's behaviour; if requests today fire while `navigator.onLine === false`, the effective default stays `'always'`" — settles it in one line.

**Decided: `'always'` is the default. `'online'` is opt-in.** Recorded rather than
edited away, per the rule at the top of this document.

### API

```ts
export type NetworkMode = 'online' | 'always' | 'offlineFirst';

/** The seam the core reads connectivity through. `OnlineManager` is its implementation. */
export interface Connectivity {
  readonly online: Signal<boolean>;
  onReconnect(listener: () => void): () => void;
}

@Injectable({ providedIn: 'root' })
export class OnlineManager implements Connectivity {
  readonly online: Signal<boolean>;
  onReconnect(listener: () => void): () => void;
  /** The test seam: a test drives connectivity without a browser. */
  setOnline(value: boolean): void;
}

interface SignalRequestConfig { networkMode?: NetworkMode }   // global default
interface RequestOptionsBase { networkMode?: NetworkMode }    // per request, cached and uncached
interface MutationOptions<…> { networkMode?: NetworkMode }    // per mutation
interface FetchPlan<T> { networkMode?: NetworkMode }          // what the entry reads
interface RequestBase { paused: Signal<boolean> }             // new signal, every handle

QueryClient.isPaused(filter?: QueryKeyFilter): boolean
```

### `online` is state, `reconnect` is an event

`OnlineManager` owns the only `window` listener pair in the library and one
`WritableSignal`, and it is the only place connectivity is read. It has **two**
outputs because the library needs two different things:

- `online()`, the **state**, read before deciding whether to start something. It
  comes from `navigator.onLine`, updated by the `online` / `offline` events. This
  is what `networkMode` and the `offline: true` classifier read.
- `onReconnect(listener)`, the **event**, for "the browser says a connection just
  appeared". This is what `refetchOnReconnect` — and a paused fetch's resume —
  hang off. A state cannot express it: `online` is already `true` at
  start-up on a connected machine, so "it is true" is not a reconnect.

That split is what keeps 0.1.0's `refetchOnReconnect` test passing untouched. The
test dispatches `window.dispatchEvent(new Event('online'))`; jsdom's
`navigator.onLine` is `true` throughout, so the _state_ does not change and a
state-based subscriber would see nothing. The event subscriber sees the event,
which is exactly what 0.1.0's `fromEvent(window, 'online')` did.

Bursts are coalesced: the listener set is notified from one microtask, so three
`online` events in a turn call each listener once. State writes are synchronous,
because a paused fetch has to be released in the same turn the connection is
reported back.

On the **server** `OnlineManager` reads `true` and registers nothing — no
`navigator`, no `window`, no timer — so `networkMode` is inert there and
`vi.getTimerCount() === 0` is assertable on the `server` platform. The platform
check is `isPlatformBrowser`, the same one the rest of the library uses.

Read defensively: a missing `navigator`, or an `onLine` that is not exactly
`false`, means "no report", i.e. online. That is 0.1.0's own reading in
`errors.ts:isOffline`, kept.

### Where the pause lives, and why in the entry

The sketch said the pause check belongs around the retry scheduling in
`CacheEntry.execute`. Half right. It is around retry scheduling **and** around the
decision to open a connection at all, and for keyed requests both belong to the
**entry**, not the handle:

- The pause state is shared. Two components on one key are one request; if one of
  them could be "paused" and the other not, the same fetch would be described two
  ways.
- The resume is shared. One reconnect must release one fetch, not one per
  subscriber.
- `QueryClient.isPaused()` asks about keys, and a key is an entry.

So `CacheEntry` gained a `paused` signal, and `fetch()` gained one branch in front
of the existing dedup:

```ts
fetch(plan) {
  if (this.destroyed) return rejected(…);
  if (this.inFlight) return this.inFlight;         // unchanged: join the in-flight one
  if (this.shouldPause(plan)) return this.hold(plan);   // new
  return this.start(plan);                          // the old body, renamed
}
```

`shouldPause` is `plan.networkMode === 'online' && !online()`. `hold` sets
`paused`, stores the plan, registers one `onReconnect` listener, and returns a
promise that is kept as `inFlight` — so a second handle still _joins_ rather than
starting a second request, and a paused entry is indistinguishable from a
fetching one to the dedup. `resume` clears the hold, unregisters the listener,
calls `start`, and hands the outcome to the held promise.

`cancel()` releases the hold too, rejecting the held promise with
`RequestCancelledError` — which is how "a paused request that loses its last
observer is cancelled like any other" falls out of the existing `release()`
without a second mechanism.

**`networkMode` travels in the `FetchPlan`, not the constructor.** The entry
already keeps the last registered plan and rebuilds requests from it; the mode is
one more thing the plan describes, so the entry needs no new plumbing and a
cache-driven refetch (`invalidate`) obeys the mode the last subscriber registered.
The rule for two handles on one key with different modes is therefore the rule the
plan already has, and it is documented rather than new: **the newest registered
plan wins, and two handles on one key should agree on `networkMode` for the same
reason they should agree on the request.** A constructor parameter was rejected: it
would have added a positional argument to a public constructor for something the
plan already carries.

`Connectivity` reaches the entry through the constructor's trailing optional
parameter, defaulting to a shared `ALWAYS_ONLINE` — so an entry built without one
is online forever, which is 0.1.0's behaviour and what the entry's own unit tests
get by default. `QueryCache` injects `OnlineManager` and passes it in.

### Semantics, mode by mode

| Mode             | First attempt                | Retry while offline    | `offline` ignored                  |
| ---------------- | ---------------------------- | ---------------------- | ---------------------------------- |
| `'always'`       | runs                         | runs (the timer fires) | yes                                |
| `'online'`       | **held** until online        | held until online      | `network.offline` still reports it |
| `'offlineFirst'` | runs (a cache/SW may answer) | held until online      | yes                                |

- **`'online'` — do not start while offline; start or resume once on reconnect.**
  One fetch per reconnect, guaranteed by the entry's own dedup: the resume runs
  synchronously inside the notification and puts a promise in `inFlight`, so
  anything else that reacts to the same reconnect joins it instead of opening a
  second connection. This is also why `refetchOnReconnect: true` plus
  `networkMode: 'online'` does not double-fire — the reconnect refetch joins the
  resumed fetch.
- **`'offlineFirst'` — the first attempt always runs**, because the point of the
  mode is that a service worker, a cache or a proxy may answer it. Retries pause,
  which is where the mode differs from `'always'` under a flapping connection.
- **`'always'` — connectivity is never consulted.** Every 0.2.0 handle defaults
  to this, so the default path changes not at all.

### Paused retries do not burn an attempt

The retry is scheduled by rxjs's `retry({ delay })` in `CacheEntry.execute`, and
the `delay` callback is the seam: it is asked for a notifier, and the notifier is
where the timer lives. So:

```ts
delay: (err, attemptNo) => {
  const delay = nextRetryDelay(policy, attemptNo, toError(err));
  if (delay === undefined) return throwError(() => err);
  if (mode !== 'always' && !connectivity.online()) {
    // No timer is armed and `attemptNo` is not spent on a clock that is not running.
    return waitForReconnect(connectivity).pipe(finalize(() => paused.set(false)));
  }
  this.retryAttempt.set(attemptNo);
  return timer(delay);
};
```

The attempt counter is set **only** on the branch that actually arms a timer, so
the retry budget is untouched while offline and the retry happens once the
connection is back — with no additional back-off, because the offline wait _is_
the spacing. `waitForReconnect` is one observable, built per pause; it emits on the
next reconnect and unsubscribes its listener on teardown, so cancelling while a
retry is paused leaves nothing behind. **It must emit, not complete**: rxjs's
`retry` treats a notifier `next` as "resubscribe" and a notifier `complete` as "end
the stream", and an earlier draft's `subscriber.complete()` made the retried request
vanish instead of retry — the test for this is the reason the distinction is written
down.

`retryAttempt()` is deliberately left at `0` while held: it means "a retry is
scheduled", and nothing is. `paused` is what says the entry is waiting.

### `paused` next to `loading`

`paused()` is a new signal on every request handle and on every mutation handle. A
paused handle reports `status: 'loading'` (or `'reloading'` when it already has
data) **and** `paused() === true`. `loading` alone cannot tell a spinner that will
finish from one that cannot start, which is the reason the signal exists; the
documented advice is to read `paused()` before showing the indefinite state. This
matches TanStack's `status: 'pending'` alongside `fetchStatus: 'paused'`, and it
keeps `RequestStatus` a closed union of four states with no new member.

### Mutations offline

With `networkMode: 'online'`, `run()` while offline **queues** the call:

- `onMutate` still runs at `run()` time, and the optimistic write still lands
  immediately, because the call _was_ made from the caller's point of view — it has
  simply not been sent. The rollback happens on final failure or cancellation,
  never merely because the connection is missing.
- The call counts as in-flight: `inFlight` is incremented and
  `MutationRegistry.begin()` is called at enqueue, so `isMutating()` is true and a
  toolbar spinner is honest.
- `run()`'s promise stays **pending** until the call is replayed or cancelled.
- On reconnect the queue is drained **in call order**, with `concurrency` honoured:
  `parallel` replays every queued call, in order; `exhaust` has at most one queued
  call because the second `run()` returned the first's promise; `switch` cancelled
  the previous queued call when the newer `run()` arrived.
- `cancel()` (and `destroy()`) rejects a queued call with `RequestCancelledError`
  and rolls its optimistic write back — the same `undo` compare-and-swap the
  in-flight path uses, so a sibling call's value is never wiped.
- `onSuccess` and `invalidates` run after the **replayed** call succeeds, in the
  same settle order as an online one (invalidate → `onSuccess` → `onSettled`).

**A replay that fails because the connection dropped again goes back to the
queue**, not to a final error. The heuristic, stated as a heuristic because that is
what it is: if the failure classifies as `kind: 'network'` **and**
`onlineManager.online()` is `false`, the call is re-queued and stays pending; if
the manager says online, it is a real failure (a CORS rejection, a blocked
request, DNS) and is reported normally. `status: 0` cannot distinguish those two
cases — that is Phase 5.3's documented ambiguity — so the manager's own state is
what breaks the tie, and the README says so where a reader will find it.

**Persisting the mutation queue across a reload is a non-goal**, and it is in the
README's "Known limitations". Replay semantics need the application's own
idempotency story — a replayed POST that already reached the server before the
reload is a duplicate write — and a library that replays one because it was in
`localStorage` would be inventing an at-least-once guarantee the application never
agreed to. The queue lives in memory and dies with the page, like the in-flight
requests it is made of.

### Ordering against the restore gate

A request that is both waiting for a restore and offline resolves **restore
first, then connectivity**, and it does so without a special case: `run()` already
waits for `restoreGate.restored()` before reading the plan, and the plan it then
reads goes into `entry.fetch()`, which is where the connectivity hold is. The
composed order is the order the code already had, with one more wait inside the
inner call. `waitForRestore: false` skips the first wait only.

### Devtools: the minimum

Phase 6 is the depth pass. This phase adds only what it must: `online` on the
`QueryDevtools` service, `paused` on `DevtoolsEntry`, an offline marker and a
per-row paused marker in the panel. `DevtoolsStatus` gains no member; a paused
entry shows its real status with the marker beside it.

### Tests

`OnlineManager` is the seam the specs drive, and `setOnline` is why it exists: no
test depends on a browser's `navigator`, and `src/lib/connectivity.spec.ts` is the
only file that touches the global at all (to prove the initial state and the
server's no-op).

Covered: offline at mount; going offline mid-request; ordered replay for all three
`concurrency` modes; flapping producing no duplicate; the retry interaction (no
attempt burnt, no timer armed); `cancel()` while paused; losing the last observer
while paused; the restore-gate + offline order; SSR no-op (`vi.getTimerCount() ===
0`, no listeners); one keyed entry shared by two handles while paused; and the
races — reconnect during an invalidation, reconnect during `destroy()`, a replay
while a new `run()` arrives, `switch` superseding a queued call. Every new public
signature has an `expectTypeOf` test. The 10,000-paused-handle destruction test is
in `offline.spec.ts`, and the two new benchmark cases are in `cache/perf.spec.ts`.

### As built — results and deviations

Everything below is a difference between this document and the code, recorded
because the code won.

1. **`networkMode` defaults to `'always'`, not `'online'`.** The preamble at the top
   of this phase is the correction; it is repeated here so a reader who lands on the
   semantics table sees it. No existing handle reads connectivity.
2. **`waitForReconnect` is a private method on `CacheEntry`, not a free helper in
   `connectivity.ts`.** It needs `this.connectivity` and `this.paused`, and a free
   function would have taken both as arguments to do the same thing. The uncached
   path needs no notifier at all: it calls `resource.reload()` from its own
   `onReconnect` listener.
3. **The notifier emits.** See above — `complete` ends the retry instead of firing it.
4. **`setOnline` is a no-op on the server.** The manager is always online there, and
   the test seam must not be able to create a state the environment cannot reach. A
   half-life of this decision: on the server, `networkMode: 'online'` is inert because
   the manager never reports `false`, not because the handles check the platform.
5. **The mutation queue drains before a new call is accepted.** `online` flips
   synchronously, but the announcement is a microtask; a `run()` in that window would
   otherwise be sent before an older queued call. `prepare()` drains the queue first,
   and `offline.spec.ts` pins the order (`a` then `b`).
6. **The mutation queue's `replay()` has no empty-batch guard.** A `splice(0)` of an
   empty queue is a no-op, and the guard was an unreachable branch.
7. **A paused entry that never fetched is `'empty'` in the devtools snapshot, not
   `'loading'`.** `paused` is a separate column; `DevtoolsEntry.status` stays the
   entry's real status. The devtools test asserts the marker, not a claimed fetch.
8. **`QueryClient.isPaused()` reads only queries.** Mutations are not owned by the
   cache, and `isMutating()` is a different question; a queued mutation reports its
   own `paused()`.
9. **`RequestErrorContext` gained `offline?: boolean`,** so `networkFailure` can be
   told about the manager's state by the handle that has it, with the `navigator`
   fallback kept for failures observed elsewhere.
10. **Coverage.** 541 tests, 23 files; statements 97.16%, branches 92.73%, functions
    98.02%, lines 98.52% — above the previous report on all four. The 12 uncovered
    functions are the same 12 as before this phase (defensive paths and the two
    probe-only helpers), and no new function is covered only by accident. The
    statements this phase added and still does not reach are the unreachable entry
    guards listed in `docs/verification.md` §9.

### Rejected alternatives

- **`'online'` as the default.** Rejected above; it is a silent behaviour change.
- **A connectivity parameter on `CacheEntry`'s constructor — accepted, as a trailing
  optional one.** The first draft rejected it as positional and redundant with the
  plan; the code needs it there because `QueryCache` is the only thing that can
  inject the manager, and the entry is built in a `computed` where a call to
  `inject()` is not available. It is optional and defaults to `ALWAYS_ONLINE`, so
  existing construction sites (and tests) are unchanged.
- **A global pause gate in `QueryClient`.** The cache would then own per-entry
  fetch policy, which it deliberately does not: `QueryClient` knows _what a user
  means by a key_, `CacheEntry` knows _whether to fetch_.
- **`fromEvent(window, 'online')` per handle, as today.** It was the source of two
  truths about connectivity and could not be faked in a test without a global stub.
- **Persisting the mutation queue.** Above.
- **A `paused` member on `RequestStatus`.** A status is what the data is; being
  paused is why nothing is happening. Two questions, two signals.
- **Pausing the _first_ attempt in `'offlineFirst'`.** That is `'online'`. The mode
  exists precisely so an offline-capable source still gets its chance.

### Risks

- **A pause that never releases.** If `onReconnect` is never called (a browser that
  never fires the event, or a test that forgets to), the held promise is pending for
  ever. The bound is the same one every pending `run()` has: `cancel()`, `destroy()`
  and losing the last observer all reject it. There is deliberately **no timeout** —
  offline is not an error, and a timer that gave up would fabricate a failure the
  user did not have.
- **Two handles, two modes, one key.** Resolved as "newest plan wins", documented.
  The failure mode is a request that fires when one subscriber expected it held.
- **The `status: 0` heuristic for replay.** Stated as a heuristic; a mutation
  replayed into a server that has already applied it is the application's problem,
  not something this library can detect.
- **Bundle size.** The offline code lives in the core, so it is not separable and
  `check:dist` cannot prove it absent. Its gzip cost is in the report.

---

## Phase 3 — async persistence (`/persist`)

## Phase 3 — async persistence (`/persist`)

Written before the code. The paragraph that used to sit here is replaced by the
decisions, because two of them fight the code that exists and one of them cannot
be what the sketch implied.

### What the phase is for

`localStorage` is synchronous, so 0.1.0 could hydrate during injector creation and
_know_ the first render saw restored data. IndexedDB cannot answer synchronously,
so a snapshot read through it lands some time after the first mount — after the
first fetch, if nothing holds the fetch back. Everything below is either an
adapter or a consequence of that one sentence.

### 1. `CacheStorage` becomes maybe-async

```ts
export interface CacheStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
```

A union rather than a second `AsyncCacheStorage` type: a storage written against
the old interface still satisfies this one, so `localStorage`, `sessionStorage`,
the in-memory doubles in the spec suite and every `CacheStorage` an application
already has keep working with no edit and no cast. `await` on a non-promise is
free, so one code path serves both.

**`Persister.hydrate()` therefore returns `number | Promise<number>`.** This is a
widening of an existing signature, and it is the one place this phase touches one.
It is deliberate rather than accidental: the number keeps its meaning (how many
values the snapshot contributed), `await persister.hydrate()` keeps compiling and
behaving, and a caller that compared the result synchronously now gets a _compile
error_ rather than a wrong answer — the loud failure. The alternative,
`restore(): Promise<number>` alongside a sync `hydrate(): number`, would make
`hydrate` return `0` for async storage, which is a lie about the data rather than
about the timing. Rejected, and recorded in the CHANGELOG under Changed.

### 2. `indexedDbStorage(options)`

```ts
export interface IndexedDbStorageOptions {
  readonly database?: string; // 'ng-signal-request'
  readonly store?: string; // 'cache'
  readonly version?: number; // 1
  /** The `IDBFactory` to open from. Defaults to the global `indexedDB`. */
  readonly factory?: IDBFactory;
}
export function indexedDbStorage(options?: IndexedDbStorageOptions): CacheStorage;
```

Hand-written, one lazily-opened connection cached per storage instance, the object
store created on `upgradeneeded`.

`factory` is an option rather than a module-level `globalThis.indexedDB` read for
two reasons. jsdom has no IndexedDB, so the suite needs a seam that is _not_
`vi.stubGlobal` — a global stub leaks into every other test in the file and into
any test that runs concurrently — and a worker application may legitimately want a
different factory. It is also the only way to reach `upgradeneeded` and `blocked`
without adding a fake IndexedDB library, which the zero-dependency rule forbids.

Every failure becomes the existing disabled signal instead of an exception:

- **no factory, or `open()` throws** (private mode, storage blocked): every method
  rejects; `hydrate` catches, disables, and `persist` becomes a no-op;
- **`onblocked`** (a stale tab holds the old version): rejects the open;
- **`setItem` rejection** (quota, closed connection): caught on the write path →
  disable, the same as a throwing `localStorage`;
- **junk in the store**: already handled — `JSON.parse` throws → remove → `0`.

### 3. The restore race, and the gate

The hard part, and the reason this is not just an adapter. `QueryCache.resolve`
runs inside a handle's key `computed`, so nothing there can await. Two mechanisms,
and the second is what makes the acceptance criterion true.

**(a) A late seed reconciles; it never clobbers.** `QueryCache.seed` on a key whose
entry already exists calls `CacheEntry.restore(value, dataUpdatedAt)`, which today
writes unconditionally. With an async read, "restore" can arrive _after_ the
network answered, and the stored value is by definition older — writing it would
mean the cache regressing in time. Rule: a late seed is applied only when the
entry has no data yet, or when the seed's `dataUpdatedAt` is **newer** than the
entry's. Equal timestamps keep the entry's value, because by then it is the one
handles are reading.

**(b) `RESTORE_GATE`, a core seam that hold the first fetch.**

```ts
export interface RestoreGate {
  /** `true` while a restore is in flight. Read reactively: it releases held fetches. */
  readonly isRestoring: Signal<boolean>;
  /** Settles when the restore does, or when its bound elapses. Never rejects. */
  restored(): Promise<void>;
}
export const RESTORE_GATE = new InjectionToken<RestoreGate>('ng-signal-request: restore gate', {
  providedIn: 'root',
  factory: () => IDLE_RESTORE_GATE,
});
```

**`restorable(key)`, which this document sketched, is not in the interface as built.** The
sketch assumed the gate could answer "does the snapshot carry this key?" before the fetch is
held. It cannot, for a reason that is structural rather than an implementation limit: a snapshot
is **one blob**. `getItem(key)` returns the whole thing, so the set of keys it carries is
unknown until it has been read and parsed — and by the time that has happened, the persister is
seeding, which is the same instant `isRestoring` flips. A per-key predicate would therefore
change the outcome only in the window between "read resolved" and "parse finished", which is
microseconds, while costing a public way to hash a query key (the equality the predicate needs is
`hashKey`'s, and that is internal to the cache — a second, structural implementation of the same
rule would be a place for the two to disagree).

What is left is honest and easy to state: **while a restore is in flight, the first fetch of
every key waits, not only the keys the snapshot turns out to carry.** The keys that are not
restorable still do not fetch against the restored value — `maybeFetchOnMount` runs after the
hold and finds no data — so the outcome is the one the sketch wanted; what differs is that their
first fetch is _delayed_ by one storage read, which is the price of not being able to ask the
question earlier. It is bounded by `restoreTimeout`, it does not apply to `waitForRestore: false`
or to a synchronous storage, and it is written down in the README's known limitations rather
than left for someone to discover. Recorded here because `docs/plan.md` says the code wins and
the disagreement gets recorded.

This lives in the **core** entry point, not in `/persist`, because the party that
has to wait is the cached request. The alternative — teaching core about
`CACHE_PERSISTER` — would make every application that never persists pay for the
persistence code, which is exactly what the separate entry point exists to avoid.
The core cost is the token, the interface and one `inject`, and the default gate
is an idle constant so a non-persisting application allocates nothing and the
effect's read of `isRestoring()` is a `false`.

The option is `waitForRestore`, on `SignalRequestConfig` and on
`CachedRequestOptions`, defaulting to **`true`**. Defaulting to `true` is safe for
existing users because the gate is only busy when a restore is _actually_ async: a
sync storage finishes during injector creation, so `isRestoring()` is `false`
before any handle exists and nothing changes. It is the right default because
"restored before the first fetch" is the entire promise of persisting.

The bound is `PersistOptions.restoreTimeout`, default `2000` ms — a hung storage
must not hold the first render forever. Reaching the bound sets `isRestoring` to
`false` and applies nothing; the snapshot's late seeds still reconcile under rule
(a) if the read ever completes.

**What is held:** the mount-time fetch (the subscription effect) and `run()`, which
resolves after the restore instead of racing it. **What is not:** `reload()`,
`invalidate()`, polling and refocus refetches. They are explicit instructions that
happen after mount, the restore is bounded anyway, and `reload()` returns
synchronously — it cannot wait even if it wanted to.

**On the server:** `indexedDbStorage` has no factory, so it rejects and the
persister disables itself; `defaultStorage()` was already `null` there. The gate
never becomes busy, nothing awaits, and no stability is held. `provideCacheTransfer`
remains the SSR path and is untouched: `TransferState` is synchronous.

### 4. Versioning: `buster` and `migrate`

`CacheSnapshot` gains an optional `buster?: string`. A snapshot whose `buster` is
not the configured one is dropped, exactly like a version mismatch. Optional and
compared by value, so an application that never sets one sees no change.

`SNAPSHOT_VERSION` **stays `1`**, deliberately. The new field is optional, so a
snapshot written by 0.1.0 is still a valid `CacheSnapshot` and reading it is
correct — bumping the number would throw away every existing snapshot on upgrade
for no gain, which is an anti-feature. `migrate(snapshot, fromVersion)` is the
mechanism for the bump that _does_ change the shape, and it is exercised in the
suite against synthetic `version: 0` and `version: 2` payloads:

```ts
readonly migrate?: (snapshot: CacheSnapshot, fromVersion: number) => CacheSnapshot | null;
```

A `migrate` that throws, or returns `null`, discards the snapshot and leaves the
cache empty. A throw is caught, so it can never take down bootstrap — a bad
migration is a cold first paint, not a broken application. `migrate` is _not_
called for a version that matches `SNAPSHOT_VERSION`.

### 5. `dehydrateFilter`, and one changed default

```ts
export type DehydratePredicate = (entry: CacheEntry<unknown>) => boolean;
interface DehydrateOptions {
  readonly dehydrateFilter?: DehydratePredicate;
}
```

The default becomes: **has data, is not fetching, and is not in an error state.**
Today an entry that failed a refetch but still holds yesterday's value _is_
persisted, and an entry that is mid-refetch is persisted in whatever half-state
its signals are in. Neither is worth restoring, and both are cheap to exclude. Sub
`(entry) => boolean` rather than a filter-descriptor object, because the entry API
is already the honest unit here — `include`/`exclude` select by key, this selects
by state.

This is a behaviour change on the persist path and goes in the CHANGELOG under
Changed. It cannot lose data: the previous value of the same key was written by the
previous write, and excluding a failing entry means the older _good_ value stays.

### 6. Writes, coalescing, and the `hydrate` return value

Writes go through one in-flight chain so that a `setItem` that returns a promise
cannot overlap with the next one; the debounce stays a trailing debounce, and a
rejected write disables the persister through the same path as a throwing one. The
flush points (`pagehide`, visibility, injector teardown) are unchanged, and a
promise-returning `setItem` is fired but not awaited there — a page teardown gives
no second chance either way, and blocking it on an async write is worse.

`hydrate`'s return keeps counting what the snapshot **contributed**, not what
survived: the `maxEntries` policy from Step 0 may drop staged values immediately,
and that is the cache's policy rather than the snapshot's. Documented on the
method.

### 7. Tests, and the risks

The suite covers: async round trip through a promise-returning storage; restore
racing the first render (a key whose snapshot is in the gate is not fetched
before the seed lands, and _is_ fetched when its key is not in the snapshot);
a late seed that loses to newer network data; corrupted payload; quota exceeded;
blocked upgrade; `version` mismatch with and without `migrate`; a throwing
`migrate`; a `buster` change; SSR no-op; and a hand-written in-memory `IDBFactory`
double for `indexedDbStorage` itself.

Known risks, stated rather than mitigated away:

- **The gate can delay a first paint** by up to `restoreTimeout` for a slow
  storage, and it delays the first fetch of _every_ key rather than only of
  restorable ones — see the note in §3 for why the key set cannot be known
  earlier. That is the trade the feature is: a bound, an option to turn it off,
  and a default that only engages when a read is genuinely outstanding.
- **Two writes can interleave at the storage layer** if an application hands over a
  storage whose `setItem` resolves out of order. This library serializes its own
  calls; it cannot serialize the storage's.
- **A `migrate` that silently returns a wrong-shaped snapshot** is not detectable
  here — the snapshot is untrusted input, which is why the version check exists and
  is why `migrate` is optional.

## Phase 4 — `queryFn` (deferred, sketch)

```ts
createQuery<T>({
  key: () => ['user', id()],
  queryFn: ({ signal, params }) => fetch(...),
});
```

A second _plan_ for the same `CacheEntry`, not a second cache. `FetchPlan` is
already the seam: today it carries an `HttpClient` request, and a query would
carry a function plus an `AbortSignal` built from the subscription the entry
already owns. The acceptance criterion — a keyed `createRequest` and a
`createQuery` on one key share one entry and one in-flight call — is a decoder
requirement: the plan must be re-buildable when _either_ kind of handle built it,
which is why `FetchPlan` already stores the request rather than a closure.

## Phase 6 — devtools depth (deferred, sketch)

Per-entry detail (data preview, timings, observers, retry history) and actions
(invalidate, refetch, cancel, remove, set stale). The entry point must stay under
15 KB gzip and stay absent from a bundle that does not import it, both already
asserted by `check:dist`. The one invariant to preserve is the reason the panel
works at all: nothing under `/devtools` may write a signal from a
`subscribeChanges` listener, because those fire inside a `computed`.
