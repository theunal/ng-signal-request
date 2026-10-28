# 0.4.0 release review (2026-10-28)

This is the release record for the durable mutation queue. It states what ships, what deliberately
does not change, why the version is `0.4.0` and not `0.3.0`, and the checks that have to pass before
the tag. The npm outcome is recorded at the end, when there is one.

> **Status: ready to cut, not cut.** Every code and documentation change is in the working tree and
> the gate below passes. The two steps that are left are a decision and an action: tag `v0.3.0`
> first (see "Why 0.4.0"), then tag `v0.4.0` and let `npm-publish.yml` do the publish.

## What ships

- `ng-signal-request/persist/queue` - the durable outbox, its provider, its signals and its
  administrative methods, **experimental**.
- `ng-signal-request/persist/queue/sw` - the dependency-free worker half: `drainMutationQueue`,
  `indexedDbQueueStorage`, `registerMutationQueueSync`.
- `docs/idempotency-contract.md` - the server-side contract the queue depends on.
- The `persistence` option on `createMutation` and the `MutationQueueAdapter` seam it uses.

## What does **not** change

This is the part the release is judged on, because the queue is additive and everything else is not
allowed to move.

| Area                                     | 0.2.0                | 0.4.0                                    |
| ---------------------------------------- | -------------------- | ---------------------------------------- |
| Default mutation queue                   | in memory            | in memory, unchanged                     |
| `networkMode` default                    | `'always'`           | `'always'`                               |
| A mutation without `persistence`         | 0.2.0 path           | 0.2.0 path                               |
| An application without the provider      | 0.2.0 path           | 0.2.0 path                               |
| `retryTimeouts` default                  | `true`               | `true` (the flip is `0.3.0`, not this)   |
| `maxEntries` default                     | `Infinity`           | `Infinity`                               |
| Cache persistence default                | `localStorage`, sync | unchanged                                |
| Angular peer range, runtime dependencies | unchanged            | unchanged                                |
| Public API names removed                 | -                    | none (`pnpm check:api v0.2.0` reports 0) |

A 0.2.0 application that upgrades and changes nothing observes nothing: no request is built
differently, no default flips, and the new entry points are only reachable through an import it does
not make.

One addition is visible to a type-only reader, and it is additive:

- `MutationQueueAdapter.attachSettled?(id, settled)` - optional, so the existing adapter contract and
  any third-party implementation keep compiling. It is how a call a non-owner stored settles when
  another tab delivers it.

## Why `0.4.0` and not `0.3.0`

`0.3.0` is reserved, and it was reserved in public: `CHANGELOG.md` (0.2.0), `README.md`
("this default changes in 0.3.0") and `docs/design-0.2.md` all promise that `retryTimeouts` flips to
`false` in `0.3.0`. `docs/design-offline-mutation-queue.md` §19.1 and §22 record the same split.

Two consequences, both deliberate:

1. **This branch does not flip `retryTimeouts`.** Bundling a breaking default change into the queue
   release would make the release notes lie about what "no defaults change" means.
2. **`v0.3.0` has to be tagged before `v0.4.0`.** That tag is a one-line default change plus the
   documentation that already describes it. If it is never tagged, the queue ships as `0.4.0`
   anyway - but then the changelog owes an explanation for the missing `0.3.0`, and this record is
   where it would go.

The queue is experimental, so an application can use it today from a branch or a workspace path
without any tag at all.

## Behaviour changes against 0.2.0

There are none for an application that does not opt in. For an application that does, the surface is
new, so "changed" is not the right word - the differences worth stating are:

| #   | Area                                              | Before (0.2.0 + queue branch)                   | Now                                                                                             |
| --- | ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | A non-owner tab's own call                        | memory-only hold under `'online'` while offline | stored durably; the owner adopts and delivers it                                                |
| 2   | `queue.enabled()`                                 | `false` in a tab that does not own replay       | `true` - durability and replay are separate questions now; `owner()` answers the second         |
| 3   | A non-owner's `run()`                             | rejected/resolved locally, entry lost on reload | settles when that tab becomes the owner, or on the owner's `removed` announcement (`onSettled`) |
| 4   | Snapshot writes                                   | the owner overwrote the whole snapshot          | every writer read-merge-writes under a short-lived write lock                                   |
| 5   | `queue.clear()` in a tab that does not own replay | deleted the owner's snapshot                    | deletes only the entries that tab stored                                                        |

Rows 1, 3 and 5 are the point of the release; rows 2 and 4 are the price.

## Pre-release checklist

Run in this order. Everything below the line is manual because it depends on an account, a registry
or a decision rather than on the repository.

### Automated

- [x] `pnpm run typecheck` - library, specs, demo, `queue-e2e`, `e2e`.
- [x] `pnpm run build` - `ng-packagr`, five entry points.
- [x] `pnpm run lint` and `pnpm run format:check`.
- [x] `pnpm run test` - unit suite, including `persist/queue/idempotency.spec.ts` and the
      non-owner handover test.
- [x] `pnpm run check:types-compat` and `pnpm run check:types-queue`.
- [x] `pnpm run build:demo` and `pnpm run check:dist` - the demo must still contain none of the
      `/devtools`, `/persist` or `/persist/queue` markers, and the two README copies must be
      byte-identical.
- [x] `pnpm check:api v0.2.0` - 0 removed, and `/persist/queue` is skipped for a ref that predates
      it.
- [x] `pnpm run test:e2e` - the queue suite against Chromium, including the dedupe test.

### Manual

- [ ] Tag `v0.3.0` (the `retryTimeouts` flip) if that release is still owed.
- [ ] Confirm the npm version is free: `curl -fsSL https://registry.npmjs.org/ng-signal-request/0.4.0`.
- [ ] Check the tarball, not the workspace: `pnpm pack` in `projects/signal-request` and confirm
      `persist/queue` and `persist/queue/sw` are present with their `.d.ts` files, and that
      `package.json` `exports` lists both.
- [ ] Confirm `projects/signal-request/package.json` `version` is `0.1.0` in the repository - the
      workflow derives the published version from the tag, and a hand-edited version there is a
      merge conflict waiting to happen.
- [ ] Read the release notes as a 0.2.0 user: nothing they use changed.
- [ ] Tag and push: `git tag v0.4.0 && git push origin v0.4.0`. The workflow builds, tests,
      typechecks the demo, runs `check:dist` and publishes with provenance through Trusted
      Publishing. It skips the publish if the version is already on the registry.

## Rollback

An application removes `providePersistedMutationQueue` and its `persistence` options; the 0.2.0 path
returns and stored entries are ignored. `queue.clear()` before removing the provider if the entries
are not wanted later. No cache schema is involved, and `/persist/queue` can be deleted from a build
without touching `/persist`.

The package itself cannot be unpublished after 72 hours; a bad release is superseded, which is why
the checklist above is longer than the change.

## npm outcome

Not published yet. When it is, record the version, the workflow run URL and the SLSA statement here,
the way `docs/release-0.2.md` does.
