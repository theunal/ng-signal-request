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
iterations instead of the 20,000 `pnpm test` uses, and prints six lines (the last
two were added in Step 0.1; the sample below is one real run, not a target):

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

| Case | 0.2.0 | Recency stamping removed | Δ |
| --- | --- | --- | --- |
| `resolve`, warm key — no entry is created | 0.47 µs/op | 0.50 µs/op | probe **slower** by 6% |
| `resolve` + `subscribe` + release, no cap | 14.99 µs/op | 16.71 µs/op | probe **slower** by 11% |
| `resolve` + `subscribe` + release, cap 100 | 11.71 µs/op | 11.61 µs/op | probe faster by 1% |
| At-cap inserts, cap 100 pre-warmed | 6.72 µs/op | 6.36 µs/op | probe faster by 5% |

Every delta is inside the spread between two runs of the same code, and two of
the four have the wrong sign — a version doing strictly *less* work measured
*slower*. The conclusion is the one the numbers support and no more: **the added
cost is below this harness's noise floor, about ±11%.** That ±11% is why the
in-suite assertions are ceilings rather than a 10% tolerance: a 10% assertion here
would fail on a busy machine and be deleted within a week.

(That ±11% was optimistic, and Step 0.3 measured the harness again with a control
loop in the same run: two consecutive runs of *unchanged* code moved by up to 22%
on this machine. See "The noise floor, measured" below — the rule needs the control
that section describes, not the number.)

The warm-key case is not really a measurement at all, it is a check that the
short-circuit is still taken: `resolve` returns the existing entry before it
reaches any 0.2.0 code, and 0.47 µs/op for a map lookup is what that looks like.

## What the cap costs

Two of the four cases explain the shape of the feature without needing a graph:

- The **uncapped** loop grows a map to 200,000 entries. The **capped** loop holds
  100. The capped run is *faster* despite doing strictly more bookkeeping per
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

Until this step the in-suite assertion was a single `50 µs/op` ceiling in *both*
ways the suite runs, and `pnpm verify` was **not green** because of it.

`pnpm test` — which `pnpm verify` runs — turns v8 coverage on. Coverage
instruments every basic block, and the capped loops execute the eviction scan
~100 times per insert, so what the number measures is mostly the instrument. The
same capped loop, on this machine:

| Run | capped loop |
| --- | --- |
| `pnpm bench` — no coverage, 200,000 iterations | ~12 µs/op |
| `pnpm test` — v8 coverage, 20,000 iterations | 67–71 µs/op |

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

| Case | Phase 5 (clean) | Run A | Run B | Run C |
| --- | --- | --- | --- | --- |
| `resolve`, warm key — **control**, code unchanged | 0.48 | 0.63 | 0.62 | 0.38 |
| `resolve` + `subscribe` + release, no cap | 16.19 | 19.26 | 22.48 | 18.44 |
| `resolve` + `subscribe` + release, cap 100 | 12.05 | 12.67 | 15.51 | 14.22 |
| At-cap inserts, cap 100 pre-warmed | 6.72 | 6.89 | 7.77 | 7.12 |
| `seed`, no cap | — | 0.68 | 0.91 | 0.69 |
| `seed`, cap 100 | — | 1.63 | 1.66 | 1.83 |

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

| Case | A → B | B → C | A → C |
| --- | --- | --- | --- |
| `resolve`, warm key (control) | −2% | −39% | −40% |
| `resolve` + `subscribe` + release, no cap | +17% | −18% | −4% |
| `resolve` + `subscribe` + release, cap 100 | +22% | −8% | +12% |
| At-cap inserts, cap 100 pre-warmed | +13% | −8% | +3% |

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
2. Read the *shape*, not the size: the in-suite assertions do this already, by
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
- `offline` is read when a `network` failure is *classified* — the same failure
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

| Case | Phase 1 | Phase 5 | Δ |
| --- | --- | --- | --- |
| `resolve`, warm key — no entry is created | 0.47 µs/op | 0.44 µs/op | faster by 6% |
| `resolve` + `subscribe` + release, no cap | 14.99 µs/op | 15.60 µs/op | slower by 4% |
| `resolve` + `subscribe` + release, cap 100 | 11.71 µs/op | 11.96 µs/op | slower by 2% |
| At-cap inserts, cap 100 pre-warmed | 6.72 µs/op | 6.67 µs/op | faster by 1% |

Nothing crosses the 10% flag, and the two cases that moved are the two whose loops
do the most work per insert — which is the same shape seen in the probe table
above, where a *smaller* change produced an 11% "regression". The ±11% floor this
paragraph used to cite was itself optimistic; Step 0.3 re-measured the harness with
a control loop in the same run and found ±20–40%, which is why the rule below now
asks for that control rather than a threshold alone.

## The regression flag

A case is flagged when it moves by more than 10% **against the control loop
measured in the same run**, and the move survives a re-run. Anything smaller than
that, or that does not reproduce, is noise — as the probe table above demonstrates
by producing an 11% "regression" in a build that does *less* work, and as the
Step 0.3 table demonstrates by moving the control itself by 40%.

The control is `resolve` on a warm key: it short-circuits before the code any of
these changes touches, so its movement in a run is the machine's movement. If a
case moves less than the control did, the change did not cause it. If the control
moves by more than the case does in the other direction, there is nothing to
report either — which is the honest answer for most of the numbers in this file.


