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

| Metric | Measured | Threshold in `angular.json` | Margin |
| --- | --- | --- | --- |
| Statements | 95.8% (2012/2100) | 90 | 5.8 |
| Branches | 89.96% (986/1096) | 85 | 4.96 |
| Functions | 96.27% (465/483) | 90 | 6.27 |
| Lines | 97.84% (1682/1719) | 90 | 7.84 |

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

| Entry point | Raw | Gzip | Budget | Headroom |
| --- | --- | --- | --- | --- |
| `ng-signal-request` | 74.3 KB | **15.9 KB** | 20 KB | 4.1 KB |
| `ng-signal-request/devtools` | 8.5 KB | 2.3 KB | 15 KB | 12.7 KB |
| `ng-signal-request/persist` | 7.0 KB | 2.3 KB | 15 KB | 12.7 KB |
| `ng-signal-request/testing` | 1.8 KB | 0.8 KB | 15 KB | 14.2 KB |

The demo application's initial bundle after `pnpm build:demo` is 230.91 KB raw /
66.78 KB over the wire. It is not a budget — it is the number the tree-shaking
check is run against, and having it recorded makes a leak visible as a delta.

## 3. The tree-shaking boundary really is measured

`pnpm check:dist` searches the demo's production bundle for strings that only
exist inside `projects/signal-request/devtools/` and
`projects/signal-request/persist/`, while asserting that core strings *are*
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

## 5. Claims that were false, and were fixed

The README was audited against the code, not skimmed. Three statements did not
match reality:

| Location | Claim | Reality | Fix |
| --- | --- | --- | --- |
| TanStack comparison, "Errors" row | predicates named `isHttp`, `isTimeout` | The predicates are methods: `http()`, `timeout()`, `network()`, `aborted()`, `unknown()`, plus a `message` getter (`errors.ts`) | Row rewritten to name the real methods |
| `/testing` entry point list | `setup · settle · respond · fail · isHttpError` | Also exports `cache`, `advanceClock`, and the `TestSetup` / `ChildScope` types | List completed |
| Bundle section prose | "ships as three entry points" | Four: core, `/devtools`, `/persist`, `/testing` (the table below it already listed four) | Corrected to "four" |

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

## 6. What this verification does *not* establish

- The export diff is textual. It proves no name disappeared; it does not prove a
  surviving name kept its shape. Behavioural compatibility rests on the 0.1.0
  test suite, which was never modified while 0.1.0 was built.
- `check:dist` proves the *demo* does not link `/devtools`. A different
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
The figures in sections 1–4 held. Two *other* things did not, and both are recorded
where they belong rather than quietly fixed:

| Check | Previous report | This machine, this run |
| --- | --- | --- |
| Test suite on the clean tree | 413 passing | 413 collected, **2 failed** — the two perf ceilings |
| Coverage on the clean tree | 96.06 / 90.39 / 96.65 / 97.95 | the failing run printed no summary; after the fixes, 96.49 / 91.02 / 96.88 / 98.19 |
| `pnpm verify` | exit 0 | **exit 1** |
| `pnpm bench` | exit 0, four lines | exit 0 on the first run, **5 s timeout** on a later one |

The `check:api` figure (76 exports, 0 removed) and the core bundle size were
re-measured after Step 0.1 and are recorded in the 0.2.0 report; they did not move.

1. **The 50 µs/op ceiling was calibrated for a run without coverage and enforced
   in a run with it.** Under `pnpm test`, v8 coverage inflates the capped loop to
   67–71 µs/op, so `pnpm verify` — which is the command the acceptance criteria name
   — was red. Fixed by scoping the tight ceiling to `pnpm bench` and adding a
   machine-independent *shape* assertion; the full account is in `docs/perf.md`
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

