# Performance

Recorded 2026-10-17 on this development machine (Windows, Node 22). Numbers are
for **`QueryCache.resolve`** and **`QueryCache.seed`**, the two paths 0.2.0
changed: `resolve` sits inside every keyed handle's key `computed` and is therefore
on the critical path of every render that reads a cached request, and `seed` runs
once per value of a restored snapshot.

Reproduce with:

```bash
pnpm bench
```

`pnpm bench` runs the benchmark bodies in the ordinary spec suite at 200,000
iterations instead of the 20,000 `pnpm test` uses, and prints seven lines (the last
two were added in Step 0.1 and the seventh in Phase 3; the sample below is one real
run, not a target, and it predates the seventh):

```
[bench] resolve, warm key: 76.3 ms over 200000 → 0.38 µs/op
[bench] resolve + subscribe + release, no cap: 3687.8 ms over 200000 → 18.44 µs/op
[bench] resolve + subscribe + release, cap 100: 2844.2 ms over 200000 → 14.22 µs/op
[bench] at-cap inserts, cap 100 pre-warmed: 1423.5 ms over 200000 → 7.12 µs/op
[bench] seed, no cap: 138.3 ms over 200000 → 0.69 µs/op
[bench] seed, cap 100: 366.1 ms over 200000 → 1.83 µs/op
```

## Why there is no `vitest bench`

Vitest's bench mode is a separate command that `@angular/build:unit-test` does
not expose. Reaching for it would mean a second toolchain — a second build of the
library, a second way to construct an injection context — maintained alongside
the one that already works, for one file. The benchmark bodies therefore live as
specs (`src/lib/cache/perf.spec.ts`), where they get the Angular compiler, the DOM
and the TestBed plumbing for free, and `pnpm bench` only changes the scale.

The cost of that trade is stated rather than hidden: **there is no statistical
runner.** `pnpm bench` is one run, and one run of a loop that allocates 200,000
objects has a spread. Read the trend in this file, not a single line of output.

## Does 0.2.0 slow down the existing path?

Phase 1 added two things to `resolve`: a `Map` write stamping recency, and an
eviction pass on insert. The honest way to price them is to remove them and
measure again, so that was done — both recency writes were commented out, `pnpm
bench` was re-run, and the file was restored. Two tests fail in that configuration
(the white-box assertions that the recency map is pruned and sized), which is how
you know the probe was really in effect.

| Case                                       | 0.2.0       | Recency stamping removed | Δ                       |
| ------------------------------------------ | ----------- | ------------------------ | ----------------------- |
| `resolve`, warm key — no entry is created  | 0.47 µs/op  | 0.50 µs/op               | probe **slower** by 6%  |
| `resolve` + `subscribe` + release, no cap  | 14.99 µs/op | 16.71 µs/op              | probe **slower** by 11% |
| `resolve` + `subscribe` + release, cap 100 | 11.71 µs/op | 11.61 µs/op              | probe faster by 1%      |
| At-cap inserts, cap 100 pre-warmed         | 6.72 µs/op  | 6.36 µs/op               | probe faster by 5%      |

Every delta is inside the spread between two runs of the same code, and two of
the four have the wrong sign — a version doing strictly _less_ work measured
_slower_. The conclusion is the one the numbers support and no more: **the added
cost is below this harness's noise floor, about ±11%.** That ±11% is why the
in-suite assertions are ceilings rather than a 10% tolerance: a 10% assertion here
would fail on a busy machine and be deleted within a week.

(That ±11% was optimistic, and Step 0.3 measured the harness again with a control
loop in the same run: two consecutive runs of _unchanged_ code moved by up to 22%
on this machine. See "The noise floor, measured" below — the rule needs the control
that section describes, not the number.)

The warm-key case is not really a measurement at all, it is a check that the
short-circuit is still taken: `resolve` returns the existing entry before it
reaches any 0.2.0 code, and 0.47 µs/op for a map lookup is what that looks like.

## What the cap costs

Two of the four cases explain the shape of the feature without needing a graph:

- The **uncapped** loop grows a map to 200,000 entries. The **capped** loop holds 100. The capped run is _faster_ despite doing strictly more bookkeeping per
  insert, because the work it avoids — rehashing, retaining, and eventually
  collecting 199,900 entries — dwarfs the 100-entry scan it pays. Bounding the
  cache is not a cost, it is the thing that makes the loop's cost flat.
- The **at-cap** run is the purest read of the eviction scan: the cache is
  pre-warmed to `cap`, so every one of the 200,000 inserts pays a full scan of 100
  candidates and evicts one. It comes in at 6.72 µs/op, below the uncapped loop's
  14.99 µs/op.

The scan is `O(cap)` per insert while over the cap — 100 comparisons at the
recommended 500, against a network request that costs thousands of times more. If
a future workload makes that visible, a heap ordered by recency is the obvious
replacement, and this file is where it should be measured first.

## Two ceilings, not one (Step 0.3)

Until this step the in-suite assertion was a single `50 µs/op` ceiling in _both_
ways the suite runs, and `pnpm verify` was **not green** because of it.

`pnpm test` — which `pnpm verify` runs — turns v8 coverage on. Coverage
instruments every basic block, and the capped loops execute the eviction scan
~100 times per insert, so what the number measures is mostly the instrument. The
same capped loop, on this machine:

| Run                                            | capped loop |
| ---------------------------------------------- | ----------- |
| `pnpm bench` — no coverage, 200,000 iterations | ~12 µs/op   |
| `pnpm test` — v8 coverage, 20,000 iterations   | 67–71 µs/op |

A 50 µs ceiling under coverage is an assertion about v8, and it fired: two tests
failed while the previous report described `pnpm verify` as green. The fix is not
one bigger number everywhere — it is that the tight ceiling belongs to the run
whose numbers this file records:

- `pnpm bench` → **50 µs/op**, about 4× the measured cost, and the numbers print;
- `pnpm test` → **1000 µs/op**, a sanity bound against a hang or a change of kind.

The check that survives both is about **shape** rather than size: each capped loop
is timed in halves, and the second half may not cost more than 4× the first. A loop
whose per-op cost grows with the number of keys seen fails that on any machine,
with or without coverage — which is what the ceiling was ever for.

Two smaller harness bugs came out of the same audit. The file's own docstring
claimed "the ceiling scales with `N`, so a machine that is merely slow still
passes"; it never did, the ceiling is an absolute µs/op, and the sentence is gone.
And the default 5-second test timeout is too short for the uncapped loop at 200,000
iterations on a loaded machine, which made `pnpm bench` report a timeout instead of
a number: the perf tests now take an explicit 120-second timeout.

## Step 0.1 — what staging a persisted value costs

`QueryCache.seed` now enforces the cap, so restoring a snapshot of `n` values costs
`n` map inserts plus, whenever the total is over, a scan of the staged map (at most
`cap`) to find the oldest. Two cases were added to measure that rather than assert
it, and `docs/design-0.2.md` has the policy.

Every row below is this machine, 200,000 iterations, one **clean-tree Phase 5**
run and then three runs of the Step 0.1 tree. They are all shown because the
spread between them is the finding — see the next section.

| Case                                              | Phase 5 (clean) | Run A | Run B | Run C |
| ------------------------------------------------- | --------------- | ----- | ----- | ----- |
| `resolve`, warm key — **control**, code unchanged | 0.48            | 0.63  | 0.62  | 0.38  |
| `resolve` + `subscribe` + release, no cap         | 16.19           | 19.26 | 22.48 | 18.44 |
| `resolve` + `subscribe` + release, cap 100        | 12.05           | 12.67 | 15.51 | 14.22 |
| At-cap inserts, cap 100 pre-warmed                | 6.72            | 6.89  | 7.77  | 7.12  |
| `seed`, no cap                                    | —               | 0.68  | 0.91  | 0.69  |
| `seed`, cap 100                                   | —               | 1.63  | 1.66  | 1.83  |

Read the control first. It runs **identical code** before and after Step 0.1 — a
warm `resolve` returns the existing entry before it reaches any of the new code —
and across the four runs it moved between 0.38 and 0.63 µs/op, a factor of 1.66.
That is the resolution of this harness on this machine today, and it is larger than
everything it is being asked to detect.

So the table supports exactly two claims. One: nothing moved by a factor that
suggests a change of complexity, in either direction. Two, and this is the new
information: staging a value costs **0.68–0.91 µs/op** uncapped — a `Map.set`, about
the same as the control's map lookup — and **1.63–1.83 µs/op** under a cap of 100,
which is the oldest-scan. A 10,000-value snapshot therefore stages in the low tens
of milliseconds at `cap: 100`, once, at startup, and the `O(n · cap)` cost is real
but negligible next to the deserialize and the render that follow it.

## The noise floor, measured (Step 0.3)

The four runs above were taken within about fifteen minutes on one machine, and the
`pnpm bench` output for each is quoted in the table. Consecutive runs of the **same**
Step 0.1 code disagree by:

| Case                                       | A → B | B → C | A → C |
| ------------------------------------------ | ----- | ----- | ----- |
| `resolve`, warm key (control)              | −2%   | −39%  | −40%  |
| `resolve` + `subscribe` + release, no cap  | +17%  | −18%  | −4%   |
| `resolve` + `subscribe` + release, cap 100 | +22%  | −8%   | +12%  |
| At-cap inserts, cap 100 pre-warmed         | +13%  | −8%   | +3%   |

The ±11% floor recorded after Phase 1 was optimistic: on the cheapest loop the
harness is off by **40%** between two runs of unchanged code, and on the allocating
loops by about **20%**. That has a direct consequence for the rule below, and it is
the reason this section exists rather than a sentence in a commit message: a single
`pnpm bench` run **cannot** resolve a 10% change on this machine, in either
direction.

What to do about it, in the order of how much it costs:

1. Compare a case against the **control in the same run** rather than against the
   previous report, and only trust a move that survives a re-run. That is what the
   rule below now asks for, and it is what made Run C's numbers usable.
2. Read the _shape_, not the size: the in-suite assertions do this already, by
   timing each capped loop in halves and refusing a second half that costs more
   than 4× the first. Complexity changes show up there; a 10% constant does not.
3. If a real decision ever needs 10% resolution, the harness has to change — repeat
   each loop and take the minimum, since the noise here is one-sided (a loop is
   never faster than its own true cost) — and that change should be made when there
   is a decision to justify it, not speculatively. Nothing in 0.2.0 does.

## Phase 5 does not get a row here

The Phase 5 changes are: a flag on the retry predicate, one `navigator.onLine`
read on the failure path, and `warnDevOnce` behind a build-time branch. None of
them is on a hot path, and the reason is structural rather than a measurement:

- The retry predicate runs only after a request has **already failed**, and at
  most `count + 1` times per call. It cannot be reached on a success.
- `offline` is read when a `network` failure is _classified_ — the same failure
  path, once per failure, not once per render.
- Both dev warnings are evaluated when a handle is **built** (once per component
  instance, deduplicated to one line per session) and are behind `isDevMode()`.

The one number that would move is `resolve`, which does not call any of them; the
benchmark above covers it. Measuring the failure path would need a harness that
fails 200,000 requests, which is more machinery than the change justifies — so the
record is the reasoning above plus the re-run below, which is the review step the
flag rule asks for.

`pnpm bench` was re-run on the Phase 5 tree (200,000 iterations, same four cases,
recorded from `[bench]` output):

| Case                                       | Phase 1     | Phase 5     | Δ            |
| ------------------------------------------ | ----------- | ----------- | ------------ |
| `resolve`, warm key — no entry is created  | 0.47 µs/op  | 0.44 µs/op  | faster by 6% |
| `resolve` + `subscribe` + release, no cap  | 14.99 µs/op | 15.60 µs/op | slower by 4% |
| `resolve` + `subscribe` + release, cap 100 | 11.71 µs/op | 11.96 µs/op | slower by 2% |
| At-cap inserts, cap 100 pre-warmed         | 6.72 µs/op  | 6.67 µs/op  | faster by 1% |

Nothing crosses the 10% flag, and the two cases that moved are the two whose loops
do the most work per insert — which is the same shape seen in the probe table
above, where a _smaller_ change produced an 11% "regression". The ±11% floor this
paragraph used to cite was itself optimistic; Step 0.3 re-measured the harness with
a control loop in the same run and found ±20–40%, which is why the rule below now
asks for that control rather than a threshold alone.

## Phase 3 gets one row, and it is a new one

Phase 3 (asynchronous persistence) touches four paths, and three of them are
nowhere near a hot one:

- **`createRequest` on the cached path** gained one `inject(RESTORE_GATE)` when the
  handle is built, and one tracked signal read (`restoreGate.isRestoring()`) per
  **evaluation of the subscription effect** — not per render, and not per read.
  Handles are built once per component instance and the effect runs on mount plus
  on a key or params change. Nothing in the four `resolve` cases builds a handle, so
  none of them measures it; a case that did would be measuring DI, not this change.
- **`run()` / `tryRun()`** gained one condition. `run` is a user-initiated call, not
  a loop.
- **`QueryCache.seed` into an entry that already exists** gained one untracked
  `dataUpdatedAt` read, and this is the one path the change makes _more_ common: an
  asynchronous restore that outlived its bound, or a second `hydrate()` over the
  same keys, arrives at an entry that is already there. Hence the new row.
- **`dehydrate`** now asks the filter per entry, and the new default reads three
  signals per entry instead of one. It runs once per debounce window (1000 ms,
  over at most `maxEntries` entries) and at the flush points — off the render path
  and off the request path, at a scale where the whole pass is microseconds. It
  does not get a row either: measuring it would say more about the debounce than
  about the change.

The `resolve` cases and the two `seed` cases are unchanged by this phase, which is
exactly why they are the control for it. `pnpm bench` on the Phase 3 tree:

| Case                                       | Run C       | Phase 3     | Δ             |
| ------------------------------------------ | ----------- | ----------- | ------------- |
| `resolve`, warm key — **the control**      | 0.38 µs/op  | 0.46 µs/op  | +21%          |
| `resolve` + `subscribe` + release, no cap  | 18.44 µs/op | 17.35 µs/op | faster by 6%  |
| `resolve` + `subscribe` + release, cap 100 | 14.22 µs/op | 12.61 µs/op | faster by 11% |
| At-cap inserts, cap 100 pre-warmed         | 7.12 µs/op  | 7.04 µs/op  | faster by 1%  |
| `seed`, no cap                             | 0.69 µs/op  | 0.70 µs/op  | +1%           |
| `seed`, cap 100                            | 1.83 µs/op  | 1.54 µs/op  | faster by 16% |
| **`seed` into an existing entry** (new)    | —           | 0.30 µs/op  | —             |

Read that table the way the rule below says to: the **control moved +21%**, so the
"faster by 11%" and "faster by 16%" entries are the machine, not the change, and the
one number to trust is that no case moved _against_ a control that moved the other
way. Nothing is flagged. The new row is the fastest of the seven because a late seed
against an existing, unwatched entry is one map lookup, one signal read and three
signal writes — the same work as `seed, no cap`, minus the staging map.

A second run of the **same tree**, minutes later and with nothing changed, gave
`0.40 / 16.42 / 12.69 / 7.15 / 0.62 / 1.52 / 0.32` µs/op — the control down 13% and
the "faster by 16%" seed row down 15%. That is the whole argument for the rule below:
run-to-run spread on this machine is larger than the threshold, so a comparison
across two runs (or against the table above) proves nothing, and a regression is only
credible when it shows up against a control measured in the same run.

## The regression flag

A case is flagged when it moves by more than 10% **against the control loop
measured in the same run**, and the move survives a re-run. Anything smaller than
that, or that does not reproduce, is noise — as the probe table above demonstrates
by producing an 11% "regression" in a build that does _less_ work, and as the
Step 0.3 table demonstrates by moving the control itself by 40%.

The control is `resolve` on a warm key: it short-circuits before the code any of
these changes touches, so its movement in a run is the machine's movement. If a
case moves less than the control did, the change did not cause it. If the control
moves by more than the case does in the other direction, there is nothing to
report either — which is the honest answer for most of the numbers in this file.

## Phase 2 — two new cases, and the control again

Phase 2 (offline / `networkMode`) adds almost nothing to the loops above: one
boolean field on a `CacheEntry`, one `shouldHold` check inside `fetch()` (a branch
that is **false** for every mode but `'online'`, and shorter than the request it
guards), and, on `'always'` handles, no connectivity read at all. The four `resolve`
cases and the three `seed` cases are therefore the control for the phase, not
evidence about it.

What the phase does add is two **bulk** events, and they get their own cases:

- **The reconnect storm.** 1,000 keyed entries are held by `networkMode: 'online'`,
  then one reconnect releases all of them. This is the case where a per-entry
  listener, a per-entry timer or a re-render per wake would be felt as a frozen
  frame.
- **The paused mutation queue.** 1,000 calls are queued by a `'online'` mutation,
  then replayed in one announcement. The queue has to stay ordered while it drains,
  and this measures the drain rather than asserting its shape.

Both measurements stop after one microtask, because that is where the work is:
`setOnline` stamps the state and the announcement microtask runs every listener
synchronously. `settle()` would add Angular's effect flushing, which belongs to the
harness rather than to this code.

Two runs of the **same Phase 2 tree**, minutes apart, 200,000 iterations, all nine
cases from the `[bench]` output:

| Case                                          | Run 1          | Run 2          | Δ (run 1 → 2) |
| --------------------------------------------- | -------------- | -------------- | ------------- |
| `resolve`, warm key — **the control**         | 0.60 µs/op     | 0.50 µs/op     | −17%          |
| `resolve` + `subscribe` + release, no cap     | 24.81 µs/op    | 25.04 µs/op    | +1%           |
| `resolve` + `subscribe` + release, cap 100    | 23.62 µs/op    | 23.64 µs/op    | 0%            |
| At-cap inserts, cap 100 pre-warmed            | 20.55 µs/op    | 16.98 µs/op    | −17%          |
| **`reconnect`, 1,000 paused entries** (new)   | 17.86 µs/entry | 17.50 µs/entry | −2%           |
| **mutation replay, 1,000 queued calls** (new) | 32.61 µs/entry | 22.47 µs/entry | −31%          |
| `seed`, no cap                                | 0.63 µs/op     | 0.67 µs/op     | +6%           |
| `seed`, cap 100                               | 1.44 µs/op     | 1.40 µs/op     | −3%           |
| `seed` into an existing entry                 | 0.45 µs/op     | 0.48 µs/op     | +7%           |

Read it the way the rule above says to. The **control moved −17%**, and the
at-cap row moved by exactly the same factor in the same direction — that is the
machine, not the change. The mutation-replay row moved **−31% between two runs of
identical code**, which is a stronger version of the same lesson: a 1,000-item
bulk case is not a stable measurement on this machine either, so its absolute
number should be read as "tens of microseconds per queued call, an order of
magnitude below a network round-trip". The reconnect row moved 2%, which is the
only number in the table worth quoting with a straight face.

**Nothing is flagged.** No case moved against the control by more than the control
itself moved, and a re-run of the same code disagrees with the first run by more
than the 10% threshold — which is the demonstration, again, that a cross-run
comparison here proves nothing. The meaningful statement about Phase 2 is
structural: an `'always'` handle never reads connectivity, and a paused entry holds
one promise and one listener instead of a timer, so a 1,000-entry storm is one
microtask of bookkeeping rather than a thousand wake-ups.

The core bundle cost of the offline code is reported separately, in the release
report and the README's bundle note: it lives in the core entry point, so
`pnpm check:dist` cannot prove it absent.

## Phase 4 — two `createQuery` cases

Phase 4 adds a second transport (`QueryFetchPlan`) to the same entry, so the
existing cases are again the control rather than evidence: the cache, the key
resolution and the seed path did not change. What is new is the cost of turning a
function's `Promise`/`Observable` into a settled entry, and the dedup that makes a
second handle join an in-flight query instead of calling the function again.

Both new cases report per operation rather than per 200,000-iteration loop, because
one of them is inherently a promise chain and the other is a join:

- **`createQuery run, promise source`** — a lazy handle is run 5,000 times
  sequentially; every `run()` starts a fetch, constructs the `defer`/`from` chain,
  settles the entry signals and resolves. It measures the whole function-source
  path, not just a map lookup.
- **`createQuery dedup, joined fetch`** — one entry has a never-settling query plan
  in flight; 20,000 further `fetch(plan)` calls must return the same promise and
  must not call the source again. The assertion counts source calls, so a dedup
  regression fails rather than merely slows.

Two consecutive runs of the **same Phase 4 tree**, minutes apart:

| Case                                       | Run 1          | Run 2          | Δ (run 1 → 2) |
| ------------------------------------------ | -------------- | -------------- | ------------- |
| `resolve`, warm key — **the control**      | 0.56 µs/op     | 0.52 µs/op     | −7%           |
| `resolve` + `subscribe` + release, no cap  | 30.22 µs/op    | 25.30 µs/op    | −16%          |
| `resolve` + `subscribe` + release, cap 100 | 23.74 µs/op    | 22.90 µs/op    | −4%           |
| At-cap inserts, cap 100 pre-warmed         | 21.06 µs/op    | 20.37 µs/op    | −3%           |
| `reconnect`, 1,000 paused entries          | 17.87 µs/entry | 18.48 µs/entry | +3%           |
| mutation replay, 1,000 queued calls        | 22.47 µs/entry | 22.01 µs/entry | −2%           |
| `seed`, no cap                             | 0.72 µs/op     | 0.72 µs/op     | 0%            |
| `seed`, cap 100                            | 1.47 µs/op     | 1.47 µs/op     | 0%            |
| `seed` into an existing entry              | 0.47 µs/op     | 0.47 µs/op     | 0%            |
| **`createQuery run, promise source** (new) | 4.71 µs/entry  | 4.88 µs/entry  | +4%           |
| **`createQuery dedup, joined fetch** (new) | 0.04 µs/entry  | 0.04 µs/entry  | 0%            |

Read it against the control in the same run, as the rule above requires. The
control moved −7% between the two runs; the largest movement against it is the
uncapped subscribe/release row at −16%, in the **faster** direction and on a loop
the phase does not touch. Nothing moves in the slower direction by more than the
control, so **nothing is flagged**.

The two new numbers say what the design claims. A function source costs about
**4.7–4.9 µs** end to end — the `defer`, the `from`, one entry write and a promise
resume — which is in the same range as the cached subscribe/release loops and two
orders of magnitude below a network round-trip. A join costs **0.04 µs**: it is the
`if (this.inFlight) return this.inFlight` branch, and the 20,000-call loop asserts
that the source ran exactly once. The dedup is not a second cache or a listener
registry; it is the entry's existing in-flight promise.
