# Performance

Recorded 2026-10-17 on this development machine (Windows, Node 22). Numbers are
for **`QueryCache.resolve`**, the one path 0.2.0 changed, because it sits inside
every keyed handle's key `computed` and is therefore on the critical path of
every render that reads a cached request.

Reproduce with:

```bash
pnpm bench
```

`pnpm bench` runs the benchmark bodies in the ordinary spec suite at 200,000
iterations instead of the 20,000 `pnpm test` uses, and prints four lines:

```
[bench] resolve, warm key: 93.1 ms over 200000 → 0.47 µs/op
[bench] resolve + subscribe + release, no cap: 2997.0 ms over 200000 → 14.99 µs/op
[bench] resolve + subscribe + release, cap 100: 2342.7 ms over 200000 → 11.71 µs/op
[bench] at-cap inserts, cap 100 pre-warmed: 1343.1 ms over 200000 → 6.72 µs/op
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
in-suite assertions are ceilings (50 µs/op, roughly 25× the real cost) rather than
a 10% tolerance: a 10% assertion here would fail on a busy machine and be deleted
within a week.

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

## The regression flag

A change is flagged when a case in this file moves by more than 10% **and** the
move survives a re-run. Anything smaller than that, or that does not reproduce, is
noise — as the table above demonstrates by producing an 11% "regression" in a
build that does less work.
