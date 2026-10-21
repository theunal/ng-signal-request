# Task: finish ng-signal-request v0.2.0 (continue from the previous session)

## Where we are

Previous session finished (local commits only, nothing pushed, working tree clean):

- Phase 0 (verify 0.1.0 claims) - 412fc45
- Phase 1 (`maxEntries`) - e4928d5
- Phase 5 (known traps: `retryTimeouts`, non-GET warning, `offline: true`, dependent queries, `TContext` limitation) - f842143

Phases 2 (offline / `networkMode`), 3 (async persistence), 4 (`queryFn` source) and 6 (devtools depth) are designed in `docs/design-0.2.md` but not implemented. This session finishes them, plus a few gaps the last report left open.

Write code, comments, README, CHANGELOG, commit messages and tests in English. Talk to me in Turkish.

## How to work

1. Start by reading: `git log --oneline -10`, `docs/design-0.2.md`, `docs/verification.md`, `docs/perf.md`, README "Known limitations", CHANGELOG, and the current cache entry lifecycle (`QueryCache`, `CacheEntry`, `QueryClient`). Summarize the current state and any place where the design doc and the code disagree. Fix the doc where the code is right (for example `offline?: true` vs the older `offline?: boolean`).
2. Update `docs/design-0.2.md` for every phase below BEFORE implementing it: API sketch, rejected alternatives, backward-compat notes, risks. Ask me a question only if truly blocked; otherwise state the assumption and continue.
3. Work in the phase order given below (it follows dependencies, not numbering). After each phase `pnpm verify` must be green. One commit (or a small series) per phase. Do not push; do not publish.
4. If a design fights TypeScript inference or the cache model, do not force it. Propose the alternative, write the reasoning in the design doc, and implement that. Measure before rejecting (as was done for `TContext`).

## Hard constraints (unchanged)

- Zero new runtime dependencies (only `tslib` and the Angular peers). Peer range stays `>=22.0.0 <23.0.0`.
- Additive and opt-in. A handle without `key` behaves exactly as today. Nothing exported in 0.1.0 may be removed or change meaning: `pnpm check:api v0.1.0` must report **0 removed**. New public exports are expected now, so update the expected "added" count in the check and list the additions in the CHANGELOG.
- Tree-shakeable. Core stays under the 20 KB gzip budget (currently 17.3 KB), any secondary entry under 15 KB gzip. `check:dist` must keep proving that code of unused entry points never reaches a production demo bundle. Extend it to cover any new entry point or lazy chunk.
- Signal-first, zoneless-compatible, SSR-safe (timers, DOM, `navigator`, IndexedDB access are no-ops on the server and must never hold stability).
- Strict TypeScript, no `any` in public API, inference must keep working (`createRequest<User[]>(...)` stays callable with one type argument). Prove it with `expectTypeOf` tests.

## Step 0: close the open gaps from the last report

Do these first, as small commits:

1. **`QueryCache.seeds` must count toward `maxEntries`.** Persisted values staged by `hydrate` currently sit outside the cap, so a large persisted snapshot can bypass Phase 1's guarantee. Decide and implement a policy (for example: staged seeds are evicted LRU-first, oldest `dataUpdatedAt` first, under the same cap, and a seed is never evicted while a handle is resolving that key). Document it in the design doc, test it (large snapshot + low cap, seed consumed mid-eviction, SSR transfer path).
2. **Linter and formatter.** There is none. Add ESLint (angular-eslint + typescript-eslint, strict-type-checked config) and Prettier as devDependencies only, wire `pnpm lint` and `pnpm format:check` into `pnpm verify` and the CI workflow. Fix findings without changing behavior. Do not mass-reformat in the same commit as logic changes: formatting-only commit first.
3. **Reality check of the previous phases.** Re-run `pnpm verify`, `pnpm check:api v0.1.0`, `pnpm bench`, and the coverage report. Confirm the numbers from the last report (413 tests, ~96% statements, core 17.3 KB gzip). Read `src/**/errors.ts` and `utils.ts` (retry predicate) and the `maxEntries` eviction code, and add tests for any branch that is only covered by accident. Report discrepancies honestly instead of adjusting the numbers.
4. **`retryTimeouts` default.** Keep the default `true` in 0.2.0 (backward compatible), but make the migration path explicit: CHANGELOG "Deprecations" entry stating that the default will change in 0.3.0, plus the dev-mode warning already added. Do not flip the default in this task.

## Phase 3: async persistence and migrations (`/persist`)

Do this before offline because paused mutations may want to persist.

- Generalize the storage interface so `getItem` / `setItem` / `removeItem` may return a value or a Promise. The current sync `localStorage` default and every existing `providePersistedCache` option keep working unchanged.
- Add `indexedDbStorage(options)`: dependency-free wrapper over the native API (database name, store name, version). Handle unavailable IndexedDB, blocked upgrades, quota errors and private-mode failures by disabling persistence gracefully through the existing `enabled` signal pattern.
- Async hydration: add `isRestoring()` signal and an option so the first fetch of restorable keys waits until restore settles (bounded by a timeout so a slow storage cannot block rendering forever). Define and document behavior on the server (restore is skipped; `provideCacheTransfer()` stays the SSR path) and for keys that are not restorable (they do not wait).
- Versioning: `buster` (string) and `migrate(snapshot, fromVersion)`. Handle `SNAPSHOT_VERSION` bumps explicitly. A failed or throwing `migrate` discards the snapshot instead of crashing the app.
- `dehydrateFilter` option; by default errored and pending entries are not persisted.
- Staged seeds from async restore must respect the `maxEntries` policy from Step 0.
- Tests: async round trip, restore racing the first render, corrupted payload, quota exceeded, blocked upgrade, version mismatch, `buster` change, throwing `migrate`, SSR no-op, fake IndexedDB via an in-memory implementation of the storage interface.

## Phase 2: offline and network mode

- Injectable `OnlineManager`: `online()` signal, SSR-safe (always "online" on the server), overridable in tests. It must become the single source of truth: refactor the `navigator.onLine` check that feeds `network.offline` (Phase 5.3) and `refetchOnReconnect` to use it, without changing their documented behavior.
- `networkMode` option (per request, per mutation, global via `provideSignalRequest`): `'online'` (default: pause while offline), `'always'`, `'offlineFirst'`. Careful: the current default behavior must not change for existing users. If making `'online'` the effective default would pause requests that fire today while the browser reports offline, keep the effective default equal to today's behavior (`'always'`) and document it; the choice goes in the design doc with the reasoning.
- Signals: `paused()` on request and mutation handles, `QueryClient.isPaused()`.
- Pause/resume rules: a paused request does not burn a retry attempt; resume on reconnect without duplicating requests; a reconnect storm (flapping connection) triggers at most one refetch per entry; paused requests that lose all observers are cancelled like any other.
- Mutations: with `'online'` mode, calls made while offline are queued and replayed in order on reconnect, honoring `concurrency` (`exhaust`/`switch`/`parallel`) and `invalidates`. Define what happens to `run()` promises (they stay pending until replay or `cancel()`), with `optimistic` writes (shown immediately, rolled back on final failure). Persisting the queue across reloads is a non-goal unless it falls out cleanly from Phase 3; if not, list it in "Known limitations".
- Tests with fake timers and a mocked `OnlineManager`: offline at mount, going offline mid-request, ordered replay, flapping connection, retry interaction, cancel while paused, SSR.

## Phase 4: non-HTTP sources (`createQuery`)

- New primitive `createQuery(source, options)` whose source is `(params, ctx) => Promise<T> | Observable<T>` with an `AbortSignal` in `ctx`. It uses the same `QueryCache`, `key`, `staleTime`, `gcTime`, dedup, invalidation, structural sharing, `maxEntries`, `networkMode`, persist and SSR transfer, and returns the same handle shape (including `requestError` normalization, `select`, `run`, `reload`, `cancel`).
- A keyed `createRequest` and a `createQuery` with the same key share one entry and one in-flight call. Define the rule when their types disagree (document it, dev-mode warning).
- Do not change `createRequest`. Extract the shared engine into internal modules rather than duplicating code.
- Abort: last unsubscribe aborts the `AbortSignal` / unsubscribes the Observable; `cancel()` too.
- Tests: Promise and Observable sources, abort propagation, shared entry with `createRequest`, error normalization (non-HTTP errors map to `unknown` with the original `cause`), persist/SSR round trip, `networkMode` pause, `expectTypeOf` for inference.

## Phase 6: devtools depth (`/devtools`)

- Per-entry detail: data preview (expand/collapse, size-capped), last N fetch timings (start, duration, outcome), observer list (by `debugName` where given), retry history, `paused` state, cap usage (`size / maxEntries`), and whether the entry came from a persisted seed.
- Actions: invalidate, refetch, cancel, remove, mark stale.
- Show `isRestoring()` and the online/offline state.
- No polling; stay signal-driven. Entry stays under budget; `check:dist` must keep proving zero cost when unused.

## Quality bar

- Unit tests for every behavior above, plus race-condition tests: rapid key changes, invalidation during unmount, restore racing the first render, offline flapping, concurrent mutations replayed in order, `createQuery` abort during invalidation.
- Type tests for every new public signature.
- Coverage on new code at least 90%; global totals must not drop below the previous report (statements 96.06%, branches 90.39%, functions 96.65%, lines 97.95%).
- Benchmarks (vitest bench): re-run the existing set and add: 10k-key cache with and without `maxEntries` (including seeds), persist write coalescing with async storage, offline reconnect storm. Record before/after in `docs/perf.md` and flag any regression above 10%.
- Every new export has TSDoc.
- README: a section per phase, corrected "Known limitations" list that stays honest (remove what is now implemented, keep what is not), updated TanStack comparison table (offline, async persistence and non-HTTP sources move from "TanStack is ahead" to the correct status). CHANGELOG 0.2.0 with Added / Changed / Deprecated and the `retryTimeouts` migration note.
- Demo: one working example per new feature (offline banner with a queued mutation, IndexedDB-backed persistence, a `createQuery` over a non-HTTP source, extended devtools).
- Bump the version to 0.2.0 in the manifest only if the release process derives it from files; the release is tag-driven, so do not tag or publish.

## Acceptance criteria

- All 0.1.0 tests pass unchanged; `check:api v0.1.0` reports 0 removed.
- With `maxEntries: 100`, persisted seeds plus live entries never exceed the policy in the design doc, and no timers are left behind after creating and destroying 10,000 keyed handles.
- A mutation fired while offline runs once, in order, after reconnect; flapping connectivity produces no duplicate requests.
- A snapshot stored through `indexedDbStorage` is restored before the first fetch of its keys, a `buster` change discards it, and a throwing `migrate` does not crash the app.
- A keyed `createQuery` and a keyed `createRequest` with the same key share one entry and one in-flight call.
- `pnpm verify` (typecheck + lint + format check + test + build + build:demo + check:dist) is green, and `check:dist` proves offline/devtools/persist code is absent from a demo build that does not import them.

## Final report (in Turkish)

When done, report briefly: completed phases and commits, decisions taken and why, what you deliberately did not do, measured coverage / bundle / benchmark numbers (and any difference from the previous report), and remaining risks. Do not push or publish; tell me the exact commands to review the diff (`git log --oneline`, `git diff v0.1.0 --stat`, `pnpm verify`).
