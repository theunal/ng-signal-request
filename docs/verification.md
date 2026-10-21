# Verification of the 0.1.0 claims

Written 2026-10-16, against `ff70a58` (tag `v0.1.0`), a clean working tree.

This file exists because the README makes four kinds of claim that are easy to
state and easy to get wrong: coverage totals, bundle sizes, the tree-shaking
boundary, and the export diff. Each one below was measured, not trusted. Where a
claim was false, it was fixed and the fix is recorded.

Reproduce everything here with:

```bash
pnpm verify                 # typecheck + test + build + build:demo + check:dist
pnpm check:api v0.1.0       # export diff, working tree against a tag
```

## 1. Coverage

`pnpm test` runs `@angular/build:unit-test` with v8 coverage enabled in
`angular.json`, so the totals are printed on every run and the thresholds are
enforced by the builder rather than by a reviewer.

| Metric     | Measured           | Threshold in `angular.json` | Margin |
| ---------- | ------------------ | --------------------------- | ------ |
| Statements | 95.8% (2012/2100)  | 90                          | 5.8    |
| Branches   | 89.96% (986/1096)  | 85                          | 4.96   |
| Functions  | 96.27% (465/483)   | 90                          | 6.27   |
| Lines      | 97.84% (1682/1719) | 90                          | 7.84   |

360 tests in 15 files, all passing.

### The threshold really fails the build

A threshold nobody has seen fire is a threshold that may be wired to nothing.
`lines: 90` was raised to `lines: 99.9`, `pnpm test` was run, and the run exited
**1** with:

```
ERROR: Coverage for lines (97.84%) does not meet global threshold (99.9%)
```

The tests themselves still reported `15 passed (15)` and `360 passed (360)` — the
failing step is the coverage gate, which is the point. `angular.json` was then
restored; `check:dist` later confirmed the working tree was clean.

## 2. Bundle sizes

Measured from a production build of the library (`pnpm build`), reporting the
gzip size of each FESM bundle. These are the numbers `pnpm check:dist` prints.

| Entry point                  | Raw     | Gzip        | Budget | Headroom |
| ---------------------------- | ------- | ----------- | ------ | -------- |
| `ng-signal-request`          | 74.3 KB | **15.9 KB** | 20 KB  | 4.1 KB   |
| `ng-signal-request/devtools` | 8.5 KB  | 2.3 KB      | 15 KB  | 12.7 KB  |
| `ng-signal-request/persist`  | 7.0 KB  | 2.3 KB      | 15 KB  | 12.7 KB  |
| `ng-signal-request/testing`  | 1.8 KB  | 0.8 KB      | 15 KB  | 14.2 KB  |

The demo application's initial bundle after `pnpm build:demo` is 230.91 KB raw /
66.78 KB over the wire. It is not a budget — it is the number the tree-shaking
check is run against, and having it recorded makes a leak visible as a delta.

## 3. The tree-shaking boundary really is measured

`pnpm check:dist` searches the demo's production bundle for strings that only
exist inside `projects/signal-request/devtools/` and
`projects/signal-request/persist/`, while asserting that core strings _are_
present. The second half matters: "no devtools strings found" would also be the
result of an audit that searched nothing, or an app that does not use the library
at all.

On a clean tree:

```
ok  core markers present: RequestCancelled, httpResource, createInfiniteRequest
ok  devtools markers absent: ngsr-devtools, no cached queries, [ngsr] +, snapshotEntries
ok  persist markers absent: providePersistedCache, provideCacheTransfer, dateRevivingCodec
```

### The check really catches a leak

`src/lib/cache/query-cache.ts` was temporarily given the exact mistake the check
describes — an import of the `/devtools` entry point from core code, referenced
so it could not be dropped:

```ts
import { QueryDevtools } from '../../../devtools/devtools';
// ...
clear(): void {
  void QueryDevtools; // probe
```

`npx ng build demo` then `pnpm check:dist` exited **1**:

```
FAIL  the /devtools entry point leaked into the demo production bundle ([ngsr] +)
      — something under src/ must be importing it
```

and the demo bundle grew from 230.91 KB to **232.80 KB** raw (66.78 → 67.30 KB
transfer) — a leak is measurable, not just detectable. The probe was reverted with
`git checkout` and the bundle returned to 230.91 KB.

## 4. Export diff

`scripts/api-diff.mjs` (new, `pnpm check:api`) parses `public-api.ts` textually at
a git ref and compares it to another ref or the working tree. It exits non-zero
only when a name that existed before is gone, since that is the one breaking
outcome.

```
$ pnpm check:api v0.0.4 v0.1.0
comparing v0.0.4 (36 exports) -> v0.1.0 (76 exports)
added   40: CacheChangeListener, CacheEntry, CacheOptions, CachedRequest, ...
removed 0: (none)

$ pnpm check:api v0.1.0          # worktree
comparing v0.1.0 (76 exports) -> working tree (76 exports)
added   0: (none)
removed 0: (none)
```

So the README's and CHANGELOG's "0 removed, 40 added" claim for the 0.0.x → 0.1.0
step is exactly right, and the working tree has not drifted from the tag. The 40
additions are new names; no 0.0.4 name was renamed, removed or reshaped.

The parser guards against the failure mode that would make this check worthless:
if it matches fewer than one export on either side it fails loudly rather than
reporting a clean empty diff. Passing a ref that does not exist exits 1 with an
instruction to `git fetch --tags`, instead of a raw git stack trace.

The output above is the 0.1.0-era shape, from when the script read one file. It now
walks all four entry points (`src/public-api.ts`, `devtools/devtools.ts`,
`persist/persist.ts`, `testing/testing.ts`) and prints one added/removed pair per
entry, because Phase 3 changed signatures inside `/persist` and "0 removed" is a
claim about the published package rather than about its core. The 0.2.0 run, and the
bug that motivated the change, are in section 8.

## 5. Claims that were false, and were fixed

The README was audited against the code, not skimmed. Three statements did not
match reality:

| Location                          | Claim                                           | Reality                                                                                                                         | Fix                                    |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| TanStack comparison, "Errors" row | predicates named `isHttp`, `isTimeout`          | The predicates are methods: `http()`, `timeout()`, `network()`, `aborted()`, `unknown()`, plus a `message` getter (`errors.ts`) | Row rewritten to name the real methods |
| `/testing` entry point list       | `setup · settle · respond · fail · isHttpError` | Also exports `cache`, `advanceClock`, and the `TestSetup` / `ChildScope` types                                                  | List completed                         |
| Bundle section prose              | "ships as three entry points"                   | Four: core, `/devtools`, `/persist`, `/testing` (the table below it already listed four)                                        | Corrected to "four"                    |

A fourth claim — "Requests are not deduplicated" and the absence of `select` /
infinite queries — had already been corrected during the 0.1.0 work; the current
text states the opposite, correctly.

### Audit of the API tables

Every export name in the README's `### ng-signal-request`, `### Types`,
`### Cache`, `### ng-signal-request/testing`, `### ng-signal-request/devtools`
and `### ng-signal-request/persist` tables was extracted and checked against the
export list of the corresponding entry point: **65 of 65 names exist**. The only
rows excluded are the table headers and rows whose first cell is a member chain
(`QueryClient.invalidate`, `createRequest.get`), which name methods rather than
exports.

### Claims checked and confirmed true

- `RequestErrorKind` really is five kinds (`aborted | timeout | http | network |
unknown`) — `errors.ts`. `RequestErrorView` really carries per-kind predicates
  and a `message` getter, not a `switch` target.
- `debounce` + `ctx.chain()` really throws: `ctx.chain() is only available in
auto mode without \`debounce\`` (`create-request.ts:72`).
- The global `retry` really applies to queries only: `create-mutation.ts` resolves
  `normalizeRetry(options.retry)` with no `config.retry` fallback.
- `retryAttempt()` really survives retry exhaustion (asserted in `errors.spec.ts`)
  and is reset by success, a new params key, and `idle`.
- Bundle budgets in the README (20 KB core, 15 KB secondary) match `BUDGETS` in
  `scripts/check-dist.mjs`, so the prose and the gate cannot drift apart quietly.

## 6. What this verification does _not_ establish

- The export diff is textual. It proves no name disappeared; it does not prove a
  surviving name kept its shape. Behavioural compatibility rests on the 0.1.0
  test suite, which was never modified while 0.1.0 was built.
- `check:dist` proves the _demo_ does not link `/devtools`. A different
  application could import them and get exactly what it asked for; that is the
  intended contract, not a gap.
- Coverage says which lines ran, not whether the assertions were meaningful. The
  number is a floor against silent regression, not a quality score.
- The bundle budgets are gzip sizes with no transfer-encoding applied. A real
  server with Brotli would report smaller numbers; the comparison between entry
  points is unaffected.

## 7. Reality check, re-run during the 0.2.0 work (2026-10-17)

The plan for 0.2.0 asks for the 0.1.0 numbers to be re-measured rather than
inherited, and they were — on the Phase 5 tree, before Step 0.1 touched anything.
The figures in sections 1–4 held. Two _other_ things did not, and both are recorded
where they belong rather than quietly fixed:

| Check                        | Previous report               | This machine, this run                                                             |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| Test suite on the clean tree | 413 passing                   | 413 collected, **2 failed** — the two perf ceilings                                |
| Coverage on the clean tree   | 96.06 / 90.39 / 96.65 / 97.95 | the failing run printed no summary; after the fixes, 96.49 / 91.02 / 96.88 / 98.19 |
| `pnpm verify`                | exit 0                        | **exit 1**                                                                         |
| `pnpm bench`                 | exit 0, four lines            | exit 0 on the first run, **5 s timeout** on a later one                            |

The `check:api` figure (76 exports, 0 removed) and the core bundle size were
re-measured after Step 0.1 and are recorded in the 0.2.0 report; they did not move.

1. **The 50 µs/op ceiling was calibrated for a run without coverage and enforced
   in a run with it.** Under `pnpm test`, v8 coverage inflates the capped loop to
   67–71 µs/op, so `pnpm verify` — which is the command the acceptance criteria name
   — was red. Fixed by scoping the tight ceiling to `pnpm bench` and adding a
   machine-independent _shape_ assertion; the full account is in `docs/perf.md`
   under "Two ceilings, not one".
2. **The default 5-second test timeout is too short for a 200,000-iteration loop**
   on a loaded machine, so `pnpm bench` could report a timeout instead of a number.
   Fixed with an explicit 120-second timeout on the perf tests. The same audit
   caught a docstring in `perf.spec.ts` claiming "the ceiling scales with `N`",
   which was never true.

The audit also produced `scripts/uncovered-branches.mjs` (throwaway tooling, kept
because it is how the next reader can repeat it):

```bash
pnpm exec ng test --coverage --coverage-reporters=json
node scripts/uncovered-branches.mjs            # everything
node scripts/uncovered-branches.mjs error      # one file
```

It listed the branch paths no test had taken. The ones reachable through the public
API became tests — `summarize`'s empty status text, `CacheEntry.fetch()` on a
destroyed entry, `subscribe()` on a destroyed entry, `clear()` and the staged
values, `refetch()` with no subscriber, `destroy()`/`evict()` idempotence, the
devtools label counting staged values — which is what moved branches from 90.27 to
91.02. The rest are defensive paths (a callback reassigned twice, a plan that was
never built) and are listed here rather than tested so that nobody mistakes them
for coverage.

## 8. Phase 3 record (2026-10-19)

Measured on the Phase 3 tree, after the asynchronous-persistence work, by the same
commands the acceptance criteria name. Nothing here is inherited from a previous
run.

| Check                                                | Result                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm verify`                                        | **exit 0** — typecheck, lint, format:check, 485 tests, build, check:dist |
| Coverage (statements / branches / functions / lines) | 96.95 / 92.19 / 97.86 / 98.48                                            |
| `pnpm check:api v0.1.0`                              | **0 removed**, 7 added names (core 3, `/persist` 4)                      |
| Core bundle                                          | 80.8 KB raw, **17.6 KB gzip** (was 17.4 before this phase)               |
| `/persist` bundle                                    | 12.5 KB raw, **3.7 KB gzip** (was 2.3)                                   |
| `pnpm bench`                                         | exit 0, seven lines; no case moved against a control that moved          |

Two things are worth recording rather than leaving in the diff:

1. **`check:api` now compares all four entry points.** It read only
   `src/public-api.ts` before, so "0 removed" was a claim about a quarter of the
   published surface — and Phase 3 changed signatures inside `/persist`. The added
   names are the ones the CHANGELOG lists; the removed set is empty in every entry.
2. **One bug was found while writing the tests for it.** `runRestore` released the
   gate from two places — the `restoreTimeout` timer and the settling read — and a
   restore that timed out and _then_ completed decremented the in-flight count
   twice. The count going negative is invisible (`isRestoring()` still reads
   `false`), and the effect is that every _later_ restore starts without opening the
   gate: a hold that quietly stops holding, in exactly the async-storage
   configuration the feature exists for. Fixed with a once-only release, and pinned
   by "still holds a later restore after one timed out" in
   `persist/persist.spec.ts`.
3. **A second coverage pass closed what the first left open.** The first Phase 3 run
   measured 96.49 / 91.56 / 96.61 / 98.02 — functions marginally _below_ the 96.65%
   the plan names as the floor — so the uncovered functions were listed instead of
   inherited, with `node scripts/uncovered-functions.mjs` (the sibling of the branch
   probe in section 7). Five were reachable and became tests: two of them Phase 3's
   own (the counter increment for a _second_ restore in flight, and the `.catch` that
   reports a throwing `deserialize` on the asynchronous path, where no caller is left to
   reject to) and three older ones (`dateRevivingCodec.serialize`, `defaultStorage`,
   and the `visibilitychange` flush, none of which any test had ever reached). The
   totals above are the result. The only function left uncovered is
   `createPersister`'s `caller`, which exists to carry a name for
   `assertInInjectionContext` and is never invoked.

## 9. Phase 2 record (2026-10-19)

Measured on the Phase 2 tree (the offline work), after `pnpm verify` exited 0 by
itself. Same commands as section 8.

| Check                                                | Result                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                        | **exit 0** — typecheck, lint, format:check, 541 tests, build, check:types-compat, build:demo, check:dist |
| Coverage (statements / branches / functions / lines) | 97.16 / 92.73 / 98.02 / 98.52                                                                            |
| `pnpm check:api v0.1.0`                              | **0 removed**, 14 added names (core 7, `/persist` 7)                                                     |
| Core bundle                                          | 89.5 KB raw, **19.2 KB gzip** (17.6 after Phase 3)                                                       |
| `/persist` bundle                                    | 12.6 KB raw, **3.7 KB gzip** (unchanged)                                                                 |
| Devtools bundle                                      | 10.3 KB raw, **2.7 KB gzip** (unchanged)                                                                 |
| `pnpm bench`                                         | exit 0, nine lines; no case moved against a control that moved                                           |

The four figures are above the previous report on every axis (96.95 / 92.19 /
97.86 / 98.48), with 541 tests in 23 files.

1. **The added surface on 0.1.0 is 14 names, not 10.** Four are this phase's
   (`ALWAYS_ONLINE`, `Connectivity`, `NetworkMode`, `OnlineManager`), three are
   Phase 3's (`RESTORE_GATE`, `IDLE_RESTORE_GATE`, `RestoreGate`) and seven are
   Step A's `Persister` work in `/persist`. Section 8 measured a tree that did not
   have this phase; that row is left as it was measured.
2. **The gzip delta is Step A + Phase 2 together: 17.6 → 19.2 KB.** Step A added
   one runtime value (`anyDataDehydrateFilter`); the rest is the manager, the
   paused-entry state and the mutation queue. The offline code lives in **core**,
   not a lazily loaded entry point, because `createRequest` itself injects the
   manager — so `check:dist` cannot prove it absent for consumers who never opt in,
   and the number above is the honest cost. It is inside the 20 KB ceiling, with
   about 0.8 KB of headroom.
3. **What is still uncovered in the files this phase touched** (found with the same
   probe as section 8): `CacheEntry.resume`'s `held === undefined`, `destroyed` and
   `plan === undefined` guards, the `inFlight` identity check in `hold`'s `clear`,
   and `createMutation`'s `if (settled) subscription.unsubscribe()` — the last one
   is only reachable with a custom **synchronous** `HttpBackend`, and the rest are
   guards the design makes unreachable (the reconnect listener is detached by both
   `resume` and `destroy`, and `hold` always stores a plan). They are kept as
   defensive code and reported rather than deleted to move a number; none is a
   function that is covered only by accident.
4. **The suite proves the two bugs the tests were written to catch.** The
   `waitForReconnect` notifier emitted `complete` instead of `next`, which silently
   ended the retried request, and `setOnline(false)` was writable on the server.
   Both are recorded in `docs/design-0.2.md` under "As built".

## 10. Step B record (2026-10-20)

Two measurements that the entry-point budgets could not make: what an application
actually retains, and whether the offline path works in a real browser.

| Check                                                | Result                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                        | **exit 0** — typecheck, lint, format:check, 541 tests, build, check:types-compat, build:demo, check:dist |
| Coverage (statements / branches / functions / lines) | 97.16 / 92.69 / 98.03 / 98.52                                                                            |
| `pnpm check:dist`                                    | core 19.3 KB gzip; `/devtools` 2.7; `/persist` 3.7; `/testing` 0.8                                       |
| Probe deltas over the no-library control             | `request` +20.41 KB, `keyed` +20.46 KB, `full` +21.92 KB                                                 |
| `pnpm test:e2e`                                      | **3/3 passed** in Playwright Chromium, 1 worker, against the production demo                             |

1. **The probe number is the number that matters, and it is larger than the entry
   point.** Importing any one factory retains almost the whole core: the three
   probes are within 1.5 KB of each other. The cause and the rejected measurement
   methods are in `docs/design-0.2.md` under Step B1; the README's Bundle section
   now leads with the retained figure rather than the published one.
2. **A runtime branch is not a bundle branch.** `OnlineManager` is now resolved
   only when `networkMode` or `refetchOnReconnect` needs it, which removes the
   construction and two `window` listeners for the default configuration - and
   changes the probe by 0 bytes, because the class and its static DI declaration
   are still in the imported module. This is reported as a runtime win, not a size
   win.
3. **The probe budgets are part of `verify`, and they cost about eight seconds.**
   `check:dist` now runs `build:probes` itself, which requires `pnpm build` first
   (the probes resolve `ng-signal-request` to `dist/signal-request` so that
   `sideEffects: false` is in play). The limits - 21.5 KB for `request` and
   `keyed`, 23 KB for `full` over the control - are the measured values plus about
   5%.
4. **The e2e job is real, and it is not in `verify`.** `e2e/offline.spec.ts`
   passes three checks against the production demo served by
   `scripts/serve-dist.mjs`, with the API mocked through `context.route` and the
   browser taken offline with `context.setOffline`. CI has a separate `e2e` job.
   What the browser revealed (a paused fetch reports `loading`; a cross-origin
   JSON `POST` also produces an `OPTIONS` preflight; one reconnect means one
   request and one replay; settled queues stay settled) is recorded in
   `docs/design-0.2.md` under Step B2.
5. **Nothing here claims coverage of the browser's own behaviour.** The unit
   suite still drives a fake `OnlineManager`; the e2e proves the wiring to
   `navigator.onLine` and the window events, not every browser's offline
   semantics. Section 6's limits apply unchanged.

## 11. Phase 4 record (2026-10-20)

`createQuery` added a second plan kind to the existing entry instead of a second
cache. The checks below are the ones that would notice if that claim were false.

| Check                                                | Result                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                        | **exit 0** — typecheck, lint, format:check, 576 tests, build, check:types-compat, build:demo, check:dist                                            |
| Coverage (statements / branches / functions / lines) | 97.56 / 93.39 / 98.58 / 98.74 — above the 0.2.0 floors of 97.16 / 92.73 / 98.02 / 98.52                                                             |
| New-code coverage                                    | `create-query.ts` 100 / 97.1 / 100 / 100; `cached-handle.ts` 97.9 / 90.9 / 100 / 99.5; `executeQuery` in `cache-entry.ts` 100% statements and lines |
| `pnpm check:dist`                                    | core **20.5 KB** gzip; `/devtools` 2.7; `/persist` 3.7; `/testing` 0.8                                                                              |
| Probe deltas over the no-library control             | `request` **+21.17 KB**, `keyed` **+21.21 KB**, `full` **+22.97 KB**                                                                                |
| `pnpm check:api v0.1.0`                              | **0 removed**; 14 added in core (7 query names) and 7 added in `/persist`                                                                           |
| `pnpm test:e2e`                                      | **3/3 passed** against the rebuilt production demo (the offline suite; no query e2e spec)                                                           |
| Bench, control compared in-run                       | query promise source **4.71–4.88 µs/entry**, dedup **0.04 µs/entry**; nothing >10% slower, so no flag                                               |

1. **One engine, measured by the diff.** `createRequest` is unchanged at the
   public surface (the 0.1.0 export check still passes, and the existing request
   suites did not need edits). `cached-handle.ts` now owns the entry, refcount,
   subscription effect, polling, focus/reconnect, state signals and settle hooks;
   `create-cached-request.ts` only builds the HTTP plan and `create-query.ts` only
   the function plan. The only engine branches the feature added are the
   `EntryPlan` dispatch and the kind-switch warning.
2. **The tests that matter are the shared-entry ones.** A keyed `createRequest`
   and a `createQuery` on one key see one entry and one in-flight call in both
   directions, a dev-mode warning fires once when the kinds disagree, and a late
   promise or Observable emission after `cancel()` / last-unsubscribe / `destroy()`
   does not write. The 30 query tests also cover Promise and Observable sources,
   error normalization (`unknown` with the original `cause`, aborted as
   `aborted`), retry with `defer`, `networkMode` pause/resume, invalidation during
   a flight, persist/SSR, and `expectTypeOf` for the generic, `select` and
   `initialValue`.
3. **The budget was raised on purpose, and it is still the tight number.** The
   design record proposed 24 KB before the code existed; the measured cost was
   20.5 KB, so the applied ceiling is **21.5 KB** (measured plus about 5%), not the
   proposal. Probe ceilings are 22.5 / 22.5 / 24 KB. Raising the core budget from
   20 KB is stated in the README and the CHANGELOG and is flagged in the release
   report; `check:dist` prints the measured value on every run.
4. **The benchmark is a ceiling, not a target.** Both new cases live in the
   ordinary perf spec and are compared against the in-run control as the rule
   requires. The join is a branch on the entry's existing in-flight promise, and
   the loop asserts the source ran exactly once, so a dedup regression fails
   rather than merely slowing down. Full numbers are in `docs/perf.md`.
5. **What this does not establish.** The e2e suite still covers only the offline
   path; the query demo section is not e2e-tested. Observable sources are
   first-emission-only, and there is no streaming test because there is no
   streaming feature. The shared key in the demo is a demonstration of the
   mechanism, not a recommendation to mix factories per key.

## 12. Phase 6 record (2026-10-20)

Phase 6 added per-entry history and observer metadata to the core, and a detail/action
layer to `/devtools`. The checks below are the ones that would notice if the panel were
reading something the entry did not actually record, or if the entry point stopped being
opt-in.

| Check                                                | Result                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                        | **exit 0** - typecheck, lint, format:check, 593 tests, build, check:types-compat, build:demo, check:dist                                           |
| Coverage (statements / branches / functions / lines) | 97.66 / 93.48 / 98.63 / 98.8 - above the 0.2.0 floors of 97.16 / 92.73 / 98.02 / 98.52                                                             |
| New-code coverage                                    | `devtools.ts` **99.22 / 94.68 / 100 / 98.86**; the added `cache-entry` history/seeded/observer paths are exercised by the eight new history tests  |
| `pnpm check:dist`                                    | core **20.85 KB** gzip; `/devtools` **4.01**; `/persist` 3.74; `/testing` 0.8                                                                      |
| Probe deltas over the no-library control             | `request` **+21.44 KB**, `keyed` **+21.50 KB**, `full` **+23.49 KB**, `devtools` **+30.85 KB**                                                     |
| `pnpm check:api v0.1.0`                              | **0 removed**; core 76 -> 93 (17 added, including `FetchAttempt` / `FetchOutcome` / `RetryEvent`); `/devtools` unchanged at 6; `/persist` 21 -> 28 |
| `pnpm test:e2e`                                      | **3/3 passed** against the rebuilt production demo (the offline suite; no devtools e2e spec)                                                       |
| Bench, control compared in-run                       | control 0.45 µs/op; subscribe/release 25.66 / 24.27; `createQuery` 4.93 µs/entry; nothing >10% slower                                              |

1. **Both fixed budgets were kept, and the new probe budget is labelled.** Core is
   20.85 KB against 21.5; `/devtools` is 4.01 against 15. Adding `<ngsr-devtools />`
   to the existing `full` probe was measured at **+32.00 KB** (from +23.49), so it
   was reverted rather than raising `full`'s 24 KB budget. A dedicated `devtools`
   probe was added with its own **32.5 KB** budget (measured +30.85 plus about 5%).
   It is a positive control, not one of the core tree-shaking comparisons.
2. **The metadata is history, not a second snapshot.** `fetchHistory` and
   `retryHistory` are capped at ten, oldest dropped first; `seeded` is cleared by a
   successful fetch or `setData` and set again by `restore`; `observerNames` is one
   entry per subscribed handle, with `'anonymous'` when no `debugName` was given.
   The histories are plain arrays, and the panel's `computed` re-runs because every
   append also moves `updatedAt`, `isFetching` or `retryAttempt`.
3. **The actions say which rule they use.** `invalidate`, `refetch` and `cancel` go
   through `QueryClient`, so they keep its by-key (prefix) semantics. `markStale` and
   `remove` are exact to the clicked row; `remove` uses the new
   `QueryCache.removeExact`, and the existing prefix `remove` is unchanged. The test
   removes a parent entry and asserts its child survives.
4. **Preview cost is gated, not merely small.** `snapshotEntries` serializes only
   when `preview: true`; the service passes that only while `isOpen()` is true. The
   preview is capped at 200 characters plus an ellipsis, `size` is the full JSON
   length, and a circular value or a symbol becomes `[unserializable]`. The panel is
   a JSON preview, not a lazy object inspector; that limitation is in the README.
5. **What this does not establish.** The devtools panel has unit/template coverage,
   not an e2e test in a real browser. `observerCount` / `observerNames` are plain
   getters and can lag by one change-detection pass; the test asserts the value after
   a settle, not the timing of Angular's render. There is no timeline, no persisted
   panel state, and no polling. The benchmark is one run on this machine: the
   control and the history code are both at the harness's noise floor, so it supports
   "nothing is flagged", not a claim of a precise constant.

## 13. Step 1 clean-room record (2026-10-21)

The tree was reinstalled from scratch (`node_modules` removed, `pnpm install --frozen-lockfile`,
pnpm 12.6.0) so the lockfile versions - Angular 22.2.2 and vitest 5.0.4 - were the ones measured.

| Check                                                | Result                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                        | **exit 0** - typecheck, lint, format:check, 24 files / 593 tests, build, check:types-compat, demo, dist |
| Coverage (statements / branches / functions / lines) | 97.66 / 93.48 / 98.63 / 98.8                                                                            |
| `pnpm test:e2e`                                      | **3/3 passed** in Playwright Chromium                                                                   |
| `pnpm check:api v0.1.0`                              | **0 removed**; core 76 -> 93 exports                                                                    |
| `pnpm check:types-compat`                            | **exit 0**                                                                                              |
| Probe deltas over the no-library control             | `request` +21.44 KB, `keyed` +21.50 KB, `full` +23.49 KB, `devtools` +30.85 KB                          |
| Core FESM                                            | 97.1 KB raw, 20.9 KB gzip                                                                               |

The clean install reproduced the previous Phase 6 numbers exactly at two decimals. No dependency
resolved to a different version, so the report's measurements are still tied to the lockfile.

`84190a2` (".") is still reachable through the reflog after the reset to `e96dea2`. Its tree contains
three files: `docs/plan.md` (97 added lines), `package.json` and `pnpm-lock.yaml`; the reflog shows
`commit: .` followed by `reset: moving to e96dea2`. Nothing from that commit was lost.

## 14. Step 2 record - tree-shaking the factory tables (2026-10-21)

The unkeyed `createRequest` probe was **+21.44 KB** over the control. It is now **+17.87 KB**, a
reduction of **3.57 KB (16.6%)**. `keyed` fell from +21.50 to **+18.57 KB**, and the `devtools`
positive control from +30.85 to **+27.91 KB**; `full` is unchanged at **+23.47 KB**, because it
already imported every factory.

| Probe      | Before    | After      | Change       |
| ---------- | --------- | ---------- | ------------ |
| `request`  | +21.44 KB | **+17.87** | **-3.57 KB** |
| `keyed`    | +21.50 KB | **+18.57** | **-2.93 KB** |
| `full`     | +23.49 KB | **+23.47** | -0.02 KB     |
| `devtools` | +30.85 KB | **+27.91** | **-2.94 KB** |

### Method: source-map byte attribution, outside the library

`pnpm attribution` builds the request probe with `--source-map` and runs
`scripts/bundle-attribution.mjs`. The script decodes the standard base64-VLQ mappings, walks the
generated positions and attributes the distance between two mapped positions to the source file of
the first one. The result is a raw-byte table for the modules actually retained; modules with no
generated bytes were shaken away. This needs no esbuild metafile, no new dependency and no library
code. The numbers are raw UTF-8, not gzip, because a module's gzip contribution depends on its
neighbours; `check:dist` remains the gzip budget.

The retained library modules in the request probe after the change:

| Module                        |  Raw bytes | KB        |
| ----------------------------- | ---------: | --------- |
| `cache/cache-entry.ts`        |      7,603 | 7.42      |
| `create-request.ts`           |      6,133 | 5.99      |
| `cached-handle.ts`            |      4,176 | 4.08      |
| `cache/query-cache.ts`        |      4,157 | 4.06      |
| `utils.ts`                    |      3,624 | 3.54      |
| `create-cached-request.ts`    |      2,122 | 2.07      |
| `errors.ts`                   |      1,685 | 1.65      |
| `cache/key.ts`                |      1,070 | 1.04      |
| `connectivity.ts`             |      1,011 | 0.99      |
| `cache/structural-sharing.ts` |        703 | 0.69      |
| four small modules            |        535 | 0.52      |
| **total**                     | **32,686** | **31.92** |

Before the change the same probe also retained `create-infinite-request.ts` (5,124 B),
`create-mutation.ts` (4,667 B), `cache/query-client.ts` (1,725 B) and
`cache/mutation-registry.ts` (914 B), even though it imported none of them.

### Cause and fix

The top-level factory tables were calls with side-effectful arguments:
`Object.assign(createVariant(...), { post: createVariant(...), ... })`. The outer `Object.assign`
could be dropped, but every argument call was still evaluated, so esbuild kept the table, its
module and every import it reached. `/*#__PURE__*/` on the outer call **and on each factory call
inside the object literal** lets esbuild drop the whole initializer when the export is unused. The
injectables (`QueryClient`, `MutationRegistry`) then disappear with the modules that referenced
them; they were never the root cause on their own. `createRequests` had already been shaken because
it is a plain function, which is the control that the method measures real retention.

Public API and behavior are unchanged: `pnpm check:api v0.1.0` still reports 0 removed and the same
17 additions, `check:types-compat` passes, and no test needed an edit.

### What is left, and why it was not removed

The remaining 17.87 KB is not another factory table. It is the cached engine, and it is reachable
from `createRequest` itself: the function has keyed overloads, and its runtime branch statically
imports `buildCachedRequest`. A bundler cannot prove that branch dead for a call site whose options
are only known at runtime. The alternatives were rejected rather than silently shipped:

- **A module per factory.** It removes the unused _standing_ tables (already done), but not the
  cached engine, because `createRequest` is the module that owns the keyed branch.
- **A separate `/cache` entry point.** That changes where keyed `createRequest` lives, which is a
  public-API break forbidden by this release.
- **A dynamic `import()` in the keyed branch.** The factory would become asynchronous or return a
  handle that is inert until a microtask; both change behavior.
- **Removing the keyed overload from `createRequest`.** Same break, and it removes a 0.1.0 feature.

`check:dist` keeps the release budgets unchanged (22.5 / 22.5 / 24 / 32.5 KB) and now also enforces
tighter regression limits of **18.4 / 19.2 / 24 / 28.8 KB**. The limits are the new measurements
plus about 3%; they exist so the request probe cannot drift back to the old table cost one import at
a time.

## 15. Step 3 record - opt-in devtools history sink (2026-10-21)

The history that Phase 6 put on every `CacheEntry` now lives behind a sink that only exists when a
developer asks for it. The core owns an interface and a token; `/devtools` owns the arrays.

### Shape

- **Core** (`cache/devtools-sink.ts`): a write-only `DevtoolsSink` with `recordAttempt` /
  `recordRetry` / `addObserver` / `removeObserver`, plus `DEVTOOLS_SINK`. `CacheEntry` keeps only
  the optional `sink`, the in-flight attempt start time, `seeded`, and the observer count. It calls
  the sink when an attempt settles, a retry is armed, or an observer subscribes/leaves. There are
  no history getters on the entry; reads live on `DevtoolsHistory`.
- **`/devtools`**: `DevtoolsHistory` implements the sink over a `WeakMap<CacheEntry, EntryHistory>`,
  caps attempts and retries at ten each, and is provided by `provideDevtoolsHistory()` through
  `useExisting`. The `WeakMap` is what makes "history dies with the entry" structural rather than a
  cleanup step.
- **Late panel.** The provider records from the moment it exists. A panel opened later reads what
  was recorded; it cannot backfill entries created before the provider. Without the provider the
  history columns are empty, and `observerCount` still works. `snapshotEntries(cache)` omits
  history unless the caller passes `{ history: TestBed.inject(DevtoolsHistory) }`; the panel always
  passes its injected service.

### Tests and sizes

| Check                                                | Result                              |
| ---------------------------------------------------- | ----------------------------------- |
| `pnpm test`                                          | **596 passed** (24 files)           |
| Coverage (statements / branches / functions / lines) | 97.68 / 93.33 / 98.65 / 98.82       |
| `request` probe                                      | **+17.89 KB** gzip over the control |
| `keyed` probe                                        | **+18.60 KB**                       |
| `full` probe                                         | **+23.48 KB**                       |
| `devtools` probe (history opted in)                  | **+28.16 KB**                       |
| Core FESM                                            | 97.5 KB raw, **20.9 KB** gzip       |
| `/devtools` FESM                                     | 21.2 KB raw, **4.4 KB** gzip        |

The sink added about 0.4 KB gzip to the `/devtools` entry and nothing measurable to the core probe;
the core FESM is still 20.9 KB.

### 10,000-entry heap

The same ad-hoc harness as the earlier measurement: create 10,000 `CacheEntry` objects, force a
major GC, and read `process.memoryUsage().heapUsed` against an empty baseline. The "before" column
is the previous run with the arrays on the entry; "after" is this tree.

| Scenario                                 | Before                                    | After                       | Change                             |
| ---------------------------------------- | ----------------------------------------- | --------------------------- | ---------------------------------- |
| No devtools history                      | 80,939.6 KiB / 8,288 B each               | 80,841.1 KiB / 8,278 B each | -98.5 KiB / -10 B each             |
| Sink installed, empty history            | 83,445.1 KiB / 8,544 B each               | 80,842.1 KiB / 8,278 B each | -2,603 KiB / -266 B each           |
| Sink installed, 10 attempts + 10 retries | 97,797-98,134 KiB / ~10,014-10,049 B each | 94,087.1 KiB / 9,635 B each | -3,710-4,047 KiB / -380-414 B each |

The empty-history row is the interesting one: the old entry paid for two empty arrays even when
nothing recorded. The new entry pays one optional reference; the sink's empty `WeakMap` entry is
amortised to noise. With full history the saving is about 4%, because the history rows themselves
still exist - now outside the entry, in the panel's own storage.

### Release test

`devtools.spec.ts` has a `WeakRef` test that records one attempt, drops the entry, forces a major GC
through the V8 `--expose-gc` flag and asserts `ref.deref()` is `undefined`. That is what proves the
`WeakMap` does not retain the entry; a test that only removed the entry from the cache would pass
even if the sink leaked it.

`docs/design-0.2.md` Phase 6 is updated to match this shape.

## 16. Step 4 record - public-surface narrowing (2026-10-21)

The 0.2 line had accumulated names that were either internal plumbing or a second way to read the
devtools sink. Each was checked against the 0.1.0 surface before removal.

| Name / member                                                | Decision | Why                                                                                                                                        |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALWAYS_ONLINE`                                              | removed  | 0.2-only; the default `Connectivity` for an entry. Applications construct their own or use `OnlineManager`.                                |
| `IDLE_RESTORE_GATE`                                          | removed  | 0.2-only; the internal gate used when no restore is running. `RESTORE_GATE` / `RestoreGate` remain public.                                 |
| `EntryPlan`                                                  | removed  | 0.2-only; a public name for the argument `CacheEntry.fetch` / `registerPlan` already accepts structurally.                                 |
| `QueryFetchPlan`                                             | removed  | 0.2-only; the non-HTTP half of `EntryPlan`, useful only to the query engine.                                                               |
| `FetchOutcome`                                               | removed  | 0.2-only; the `FetchAttempt['outcome']` union. Keeping it forced consumers to import a name that carried no extra information.             |
| `FetchAttempt` / `RetryEvent`                                | kept     | Used by the core `DevtoolsSink` contract and by `CacheEntry` diagnostics. Moving them to `/devtools` would make the core import the panel. |
| `CacheEntry.fetchHistory` / `retryHistory` / `observerNames` | removed  | Devtools-only reads. `DevtoolsHistory.attempts()` / `retries()` / `observers()` own them; `snapshotEntries` takes `{ history }`.           |

`CacheEntry` still exposes `seeded`, `observerCount`, `hasPlan` and `planKind`; the first two are
asserted by the cache tests and the latter two are what the panel uses to say whether a fetch can
start. No 0.1.0 export was removed.

### API count and sizes

| Check                                | Result                                            |
| ------------------------------------ | ------------------------------------------------- |
| `pnpm check:api v0.1.0`, core        | 76 -> **90** exports; **14 added**, **0 removed** |
| `pnpm check:api v0.1.0`, `/devtools` | 6 -> **8** exports; 2 added, 0 removed            |
| `pnpm check:api v0.1.0`, `/persist`  | 21 -> 28; 7 added, 0 removed                      |
| `pnpm check:api v0.1.0`, `/testing`  | 6 -> 6; 0 added, 0 removed                        |
| `request` probe                      | **+17.83 KB**                                     |
| `keyed` probe                        | **+18.54 KB**                                     |
| `full` probe                         | **+23.71 KB**                                     |
| `devtools` probe                     | **+28.14 KB**                                     |
| Core FESM                            | 97.2 KB raw, **20.8 KB** gzip                     |
| `/devtools` FESM                     | 21.4 KB raw, **4.5 KB** gzip                      |

At this commit the expected added count is **14 in the core** (was 19) and **2 in `/devtools`**
(was 0); the total over the four entry points is 23, and `pnpm test` was **596 passed**. Step 5.2
adds `QueryClient.isAnythingPaused()` as a **method**, not an export, so the final counts stay
90 / 14 (see §17). The probe
budgets were not raised: the largest is `full` at 23.71 against 24 KB, and `devtools` at 28.14
against 28.8 KB.

## 17. Step 5 record - the remaining 0.2 decisions (2026-10-21)

### 5.1 `MutationOptions.networkMode`

`MutationOptions.networkMode` is now `Exclude<NetworkMode, 'offlineFirst'>`. `offlineFirst`
is a query strategy: a write has no cached value to serve first, and the mutation engine
already treated the value as `'always'`. The narrowing makes the type say what the engine
did. A global `networkMode: 'offlineFirst'` still falls back to `'always'` for mutations.
`create-mutation.spec.ts` pins the rejection with `@ts-expect-error`.

### 5.2 `QueryClient.isAnythingPaused()`

Added because the query-only `isPaused()` and the per-mutation `paused()` left a global
banner with no single read. `MutationRegistry` now counts parked calls, `createMutation`
increments/decrements that count on `hold` / `release`, and `isAnythingPaused()` returns
`isPaused() || mutations.isPaused()`. It takes no filter, because a query key cannot
describe a mutation key.

Cost, measured on the same probe harness:

| Probe      | Before 5.2 | After 5.2 | Delta    |
| ---------- | ---------- | --------- | -------- |
| `request`  | +17.83 KB  | +17.83 KB | 0        |
| `keyed`    | +18.54 KB  | +18.59 KB | +0.05 KB |
| `full`     | +23.71 KB  | +23.79 KB | +0.08 KB |
| `devtools` | +28.14 KB  | +28.21 KB | +0.07 KB |

The core FESM moved from 20.8 to 20.9 KB gzip. That is under 100 bytes on every probe,
so it was kept; the `full` limit (24 KB) still has 0.2 KB headroom. `pnpm test` is now
**599 passed**.

### 5.3 Uncovered functions

`pnpm exec ng test --coverage --coverage-reporters=json` followed by
`node scripts/uncovered-functions.mjs` reports **5 uncovered functions**, one in each of
`persist/persist.ts`, `combine.ts`, `create-infinite-request.ts`, `create-mutation.ts` and
`create-request.ts`. All five are the same artifact: the empty inner function returned by
the local `named()` helper (`const fn = (): void => {}`). Its `name` property is what Angular
prints in an injection-context error; the function itself is never called by design, so no
test can reach it without invoking it for coverage's sake. That is the entire list; there
are no untested reachable functions. `MutationRegistry.reset()` was classified as a
test-only escape hatch and is now covered directly; `QueryClient.clear()` and the testing
helper's `isDestroyed` getter gained assertions during the audit.

### 5.4 `CACHE_PERSISTER` token typing

Preserving `const n: number = inject(CACHE_PERSISTER).hydrate()` is not possible without
lying. A non-generic token cannot carry the storage's type, and the persister behind it may
have been built over IndexedDB, whose read is a promise. Typing the token as
`Persister<number>` would make async applications compile a `number` that is a
`Promise<number>` at runtime. The honest union is kept; the break is foregrounded at the top
of the CHANGELOG with the two workarounds (`await` the call, or use `createPersister` and
let inference choose the return type). The compatibility fixture keeps the failing spelling
behind `@ts-expect-error`.

### Final API count

`pnpm check:api v0.1.0` after 5.2: core 76 -> **90** exports (**14 added**, 0 removed),
`/devtools` 6 -> 8, `/persist` 21 -> 28, `/testing` 6 -> 6. Total added over the four
entry points: **23**. `isAnythingPaused()` is a method on the already-exported `QueryClient`,
so it does not move the export count. No 0.1.0 export was removed.

## 18. Release-candidate verification and budget trim (2026-10-21)

Run on `56060ee` plus the warning-copy trim described below; no other source change.

### E2E

`pnpm exec playwright install chromium` was already satisfied, then `pnpm test:e2e`
built the production demo and ran the real-browser offline suite:

```text
Running 3 tests using 1 worker
  ✓ the banner follows the browser and an online-only request waits for a connection
  ✓ queued mutations replay once, in call order, on reconnect
  ✓ flapping after the queue settled does not replay anything
  3 passed (3.4s)
```

The previous record said this had not been rerun after Step 5; it now has, on the
candidate.

### Bundle measurement

`pnpm check:dist` was run three times, each rebuilding all five probes. All three
runs produced byte-identical gzip sizes, so the measurement variance is **0.00 KB**
and the only real risk was the 0.21 KB margin itself:

| Probe      | Run 1  | Run 2  | Run 3  | Limit | Budget |
| ---------- | ------ | ------ | ------ | ----- | ------ |
| `request`  | +17.83 | +17.83 | +17.83 | 18.4  | 22.5   |
| `keyed`    | +18.59 | +18.59 | +18.59 | 19.2  | 22.5   |
| `full`     | +23.79 | +23.79 | +23.79 | 24    | 24     |
| `devtools` | +28.21 | +28.21 | +28.21 | 28.8  | 32.5   |

### Trim: shorter dev-only warning copy

`pnpm attribution` on the `full` probe (source map build) showed the retained
library modules, but no module was dead: the full probe exercises all of them. The
bytes that were removable were the four **dev-only warning messages**, retained in
production because `isDevMode()` is a runtime call, so the minifier cannot fold the
branches around them:

- `timeout` + retry warning (`utils.ts`)
- non-`lazy`, non-`GET` `createRequest` warning (`utils.ts`)
- `maxEntries` overshoot warning (`query-cache.ts`)
- mixed `createRequest` / `createQuery` key warning (`cached-handle.ts`)

Each message keeps its actionable tokens (the option names and the factory names the
tests assert) and moves the explanation to the docs. A first attempt used the
`ngDevMode` global to make the branches constant-fold; the application build does
not define it for library code, the attempt **added** 0.01 KB, and it was reverted.

After the trim, on three consecutive rebuilds with no variance:

| Probe      | Before | After  | Delta    | Limit | Headroom |
| ---------- | ------ | ------ | -------- | ----- | -------- |
| `request`  | +17.83 | +17.54 | -0.29 KB | 18.4  | 0.86     |
| `keyed`    | +18.59 | +18.30 | -0.29 KB | 19.2  | 0.90     |
| `full`     | +23.79 | +23.49 | -0.30 KB | 24    | **0.51** |
| `devtools` | +28.21 | +27.91 | -0.30 KB | 28.8  | 0.89     |

The `full` target (median <= 23.6 KB, at least 0.4 KB headroom) is met without
raising a budget. The core FESM is now **20.6 KB** gzip (was 20.9), so the primary
entry point has 0.9 KB against its 21.5 KB ceiling; `/devtools` stays at 4.5 KB.
§16 and §17 keep their original numbers: they are the record of the commits they
describe, not of this trim.

`pnpm test` remains **599 passed**, coverage **97.86 / 93.61 / 99.25 / 99.03**
(statements / branches / functions / lines); `pnpm run typecheck` and
`pnpm run lint` are clean.

## 19. CI retry, test isolation and Angular 22.2.3 merge (2026-10-21)

The first tag push (`v0.2.0` on `0b4192c`) triggered workflow run #10 and failed at
`pnpm test`, before the publish step. Two assertions in `dev-warnings.spec.ts` expected
one `console.warn` and saw none:

- `write-shaped createRequest > warns about a non-lazy write, once`
- `write-shaped createRequest > warns just the same for a cached write`

`warnedOnce` is module state. `create-request.spec.ts` legitimately makes POST/PATCH
calls, so in CI the same `(caller, method)` message had already been printed before
`dev-warnings.spec.ts` installed its spy; the ledger then suppressed the warning. Local
file order did not expose it. This was a test-isolation defect, not a product defect,
and no package was published.

`add5e61` adds `resetDevWarningsForTests()` (internal, not re-exported from the public
API) and clears the ledger before each warning test. The function is absent from the
FESM and from the full probe, so the bundle numbers are unchanged. Five consecutive
`CI=true pnpm test` runs passed before the merge, and three more passed after it.

`origin/main` had one independent commit (`84190a2`) that bumped Angular from 22.2.2
to 22.2.3, updated `pnpm-lock.yaml`, and tracked the working plan file. It was merged
into the release candidate as `327f071`; `pnpm install --frozen-lockfile` moved
Angular, Vitest, jsdom and ESLint to their lockfile versions.

After the merge, three consecutive `check:dist` runs were identical:

| Probe      | Delta  | Limit | Headroom |
| ---------- | ------ | ----- | -------- |
| `request`  | +17.57 | 18.4  | 0.83     |
| `keyed`    | +18.33 | 19.2  | 0.87     |
| `full`     | +23.52 | 24    | **0.48** |
| `devtools` | +27.89 | 28.8  | 0.91     |

Control is 38.36 KB gzip; core FESM is 20.6 KB, `/devtools` 4.5 KB. `pnpm verify`
passes with 599 tests and coverage 97.86 / 93.61 / 99.25 / 99.03; `pnpm check:api
v0.1.0` still reports 0 removed; e2e is 3/3.

Workflow run #11 on `47db330` then passed and published 0.2.0. npm recorded it at
16:53:33 UTC; `npm view` reports `latest` 0.2.0 and `gitHead` 47db330. The tarball has
15 files (896482 bytes unpacked). In a clean install, `npm audit signatures` reports 5
verified registry signatures and 1 verified attestation; the SLSA v1 statement names
`refs/tags/v0.2.0`, the repository, and resolved dependency `gitCommit` 47db330. The
version document was briefly 404 after the run because of npm CDN propagation; a later
cache-busted read returned 200.

The separate `CI` workflow then failed at lint on `47db330` and `7f19821`. The probe
tsconfig maps `ng-signal-request` to `dist/signal-request` so the size probes measure the
built package; CI ran lint before the library build, so on a clean runner the probe imports
were unresolved and `@typescript-eslint/no-unsafe-*` reported 30 errors. A local `dist`
hid the problem. The CI workflow and `pnpm verify` now build the library before lint; with
`dist` removed, `pnpm verify` passes. This changes no shipped code and no bundle number.
