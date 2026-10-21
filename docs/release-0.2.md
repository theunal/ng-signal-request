# 0.2.0 release review (2026-10-21)

This is the release record for 0.2.0. It compares the published release with `v0.1.0`,
lists every behavior change and its opt-out, and keeps the manual release checks in one
place. The npm outcome is recorded at the end.

## Diff against 0.1.0

At the published release commit `47db330` (the tag target):

```text
$ git diff v0.1.0 --stat
 102 files changed, 19760 insertions(+), 2000 deletions(-)
```

The diff includes the library, all four entry points, the demo, the probes, the compatibility
fixture, the e2e suite, the workflows, the design/verification records and the README
copy checked by `check:dist`. It also includes `docs/plan.md`, which arrived with the
`origin/main` merge; that file is not part of the npm tarball.

## Behavior changes against 0.1.0

| #   | Area                                                | 0.1.0                                                 | 0.2.0                                                                                                                         | Opt-out / workaround                                                                                                                          |
| --- | --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Persistence / SSR dehydrate default                 | every entry with data was written                     | only entries with data, not fetching, and not in an error state                                                               | pass `anyDataDehydrateFilter` (the 0.1.0 rule) or any custom `dehydrateFilter`; applies to `providePersistedCache` and `provideCacheTransfer` |
| 2   | `QueryCache.seed` reconciliation                    | an existing entry was restored unconditionally        | an existing entry is restored only when it has no data, or the seed is **strictly newer**                                     | use `CacheEntry.setData` for a forced write, or pass a newer `dataUpdatedAt`                                                                  |
| 3   | `RequestError.network` while the browser is offline | `{ kind: 'network', cause }`, message `No connection` | adds `offline: true`, message `Offline`                                                                                       | none; `offline` is additive and the message is display text - branch on `kind` / `cause` if copy matters                                      |
| 4   | Dev warning: `timeout` combined with retry          | none                                                  | one warning per combination, in dev mode                                                                                      | `retryTimeouts: false` removes the warning and stops retrying timeouts; an explicit `retry.when` also takes precedence; production unaffected |
| 5   | Dev warning: non-`lazy`, non-`GET` `createRequest`  | none                                                  | one warning per verb, in dev mode                                                                                             | use `createMutation`, or `lazy: true`; production unaffected                                                                                  |
| 6   | `Persister.hydrate()` type                          | `number`                                              | `number` for inferred synchronous storages; `number \| Promise<number>` through an annotated `Persister` or `CACHE_PERSISTER` | `await` the call, or use `createPersister({ storage })` and let the storage type select the return type; compile-time only                    |
| 7   | `MutationOptions.networkMode` type                  | n/a (the option is new in 0.2)                        | excludes `'offlineFirst'`; a global `'offlineFirst'` falls back to `'always'` for mutations                                   | use `'online'` to queue while offline or `'always'` to send regardless; this is a 0.2-only spelling, not a 0.1.0 break                        |

Rows 1 and 2 are the only behavior changes that can reach an unmodified 0.1.0
application. Row 6 is the accepted compile-time break; it is also called out at the top
of `CHANGELOG.md`. Everything else in the release is either additive, gated behind a new
option, or a dev-mode warning.

Defaults that were deliberately **not** changed: `networkMode: 'always'`,
`retryTimeouts: true`, `maxEntries: Infinity`, and synchronous `localStorage`
persistence (no first-fetch hold). `createRequest`'s keyed path and `createQuery` share
one engine, but a 0.1.0 application has no `createQuery`, so its cache behavior is
unchanged.

## Manual pre-release checklist

These checks are intentionally manual: several depend on the npm account, GitHub
settings, or a legal decision rather than the repository.

### Package identity and version

- [x] The package is unscoped: `ng-signal-request`. Before the release, `latest` was
      `0.1.0` and `0.2.0` was free; `npm owner ls ng-signal-request` returns `theunal`.
      After the release, `latest` is `0.2.0`.
- [x] Keep the unscoped name. A scope (`@theunal/...`) would change every install
      command and is a breaking package-name change; do not do it in this release
      without a migration plan.
- [x] Create the tag **on the final commit**: `v0.2.0` points at `47db330`. The first
      attempt (`0b4192c`) failed in CI; see "CI retry" and "Published" below.
- [x] Do not `npm publish` the working `dist/` by hand. The manifests in the
      repository intentionally remain `0.1.0`; the workflow rewrites the version
      from the tag. The dry-run used a temporary copy with version `0.2.0` and
      succeeded.
- [x] Push the final commit to `main` and the tag (`git push origin main`,
      `git push origin v0.2.0`); the workflow triggers on the tag and derives `0.2.0`
      from `GITHUB_REF_NAME`. Post-publish documentation commits follow on `main` and
      are not part of the tag.

### Repository metadata

- [x] `repository.url`, `bugs.url` and `homepage` all point at
      `https://github.com/theunal/ng-signal-request`; `git remote -v` agrees. The
      repository is public and the issue tracker is enabled (`has_issues: true`).
- [x] Confirm the README copy in `projects/signal-request/README.md` matches the root
      README; `pnpm check:dist` checks this today.
- [x] Confirm the published tarball contains `LICENSE`, `README.md`, all four entry
      points (`/devtools`, `/persist`, `/testing`) and no probe/demo/e2e files. The
      dry-run listed 15 files.

### npm publishing and provenance

- [x] `projects/signal-request/package.json` has `"publishConfig": { "access":
"public", "provenance": true }`. The generated `dist/signal-request/package.json`
      keeps both.
- [x] npm Trusted Publishing is configured for this repository and the workflow file
      `.github/workflows/npm-publish.yml` (GitHub Actions provider). The npm account has
      the package's publisher permission; no long-lived `NPM_TOKEN` exists. The
      registry's `_npmUser.trustedPublisher` field and the successful OIDC publish prove
      the setting.
- [x] The workflow has `permissions: contents: read` and `id-token: write`, installs
      npm >= 11.5.1, deliberately omits `setup-node`'s `registry-url`, and publishes with
      `npm publish --provenance --access public`. Those are the conditions for OIDC and a
      signed provenance statement.
- [x] After the workflow, the npm metadata matches the tag: `gitHead` is `47db330`, the
      SLSA statement names `refs/tags/v0.2.0` and the same `gitCommit`, and a clean
      `npm audit signatures` reports 5 verified registry signatures and 1 verified
      attestation. See "Published" below.

### License and attribution

- [x] `LICENSE` names the copyright holder: `Copyright (c) 2026 Yusuf Unal` in both
      the root copy and `projects/signal-request/LICENSE` (the one that is packaged).
- [x] `projects/signal-request/package.json` has `"author": "Yusuf Unal"`; the private
      root manifest has the same field for consistency.
- [x] Third-party attribution reviewed by the maintainer. The runtime dependency is
      only `tslib` (0BSD, which requires no attribution notice), and the only other
      linked third-party code is the Angular peer packages (MIT, provided by the
      application rather than bundled here). No copied code requires an additional
      notice, so no `THIRD_PARTY_NOTICES.md` is added. This is a maintainer review,
      not a legal opinion.

### CI retry

The first tag push (run #10, commit `0b4192c`) failed in `pnpm test`. Two
`dev-warnings` assertions saw no `console.warn`: `warnedOnce` is module state shared by
specs in a worker, and `create-request.spec.ts` had already printed the same message
before the spy was installed. The publish step was skipped and npm stayed at 0.1.0.
`add5e61` clears the ledger before each warning test; five consecutive CI-mode runs
passed. `origin/main` also carried an Angular 22.2.3 bump and the tracked
`docs/plan.md`, merged in `327f071`; the full gate was rerun on the merge. Run #11 on
`47db330` then passed and published 0.2.0. The version document was briefly 404 for
about four minutes after the job; that was npm CDN propagation, not a skipped publish.

### Verification gate

- [x] `pnpm verify` passes on the final candidate. Last run: 24 files, **599 tests**,
      coverage 97.86 / 93.61 / 99.25 / 99.03; `check:dist` passed.
- [x] `pnpm check:api v0.1.0` reports **0 removed** in all four entry points; core is
      76 -> 90 exports (14 added), `/devtools` 6 -> 8, `/persist` 21 -> 28,
      `/testing` 6 -> 6.
- [x] `pnpm check:types-compat` passes; the only expected failures are the annotated
      `Persister` and `CACHE_PERSISTER` spellings behind `@ts-expect-error`.
- [x] `pnpm test:e2e` passes in a real browser. Rerun on the candidate after Step 5,
      again after the warning-copy trim, and again after the Angular 22.2.3 merge:
      **3/3 passed** on the candidate commit that contains this document (see
      `docs/verification.md` §18 and §19).
- [x] `pnpm check:dist` has headroom: three consecutive runs on the merged candidate
      gave **identical** sizes — `full` +23.52 KB against a 24 KB limit (0.48 KB),
      `devtools` +27.89 against 28.8 KB (0.91 KB), `request` +17.57, `keyed` +18.33.
      Do not raise a budget to make a release pass.
- [x] `git status` is clean on the final commit. `docs/plan.md` is tracked because
      `origin/main` contained it; it is not in the npm tarball.
- [x] The tag points at the release commit `47db330`; the registry's `gitHead` and the
      SLSA `gitCommit` both name it. The `0.2.0` CHANGELOG heading and these publish
      notes are post-release commits on `main`; they are not in the npm tarball.

## Published

- Version: `ng-signal-request@0.2.0`, also `latest`; npm recorded it at
  2026-10-21 16:53:33 UTC.
- Release commit / `gitHead`: `47db3304102835b3abf2f58d3497ac49555d5524`; tag `v0.2.0`
  points at it. Workflow run #11:
  <https://github.com/theunal/ng-signal-request/actions/runs/39638051821>.
- Tarball: 15 files, 896482 bytes unpacked, integrity
  `sha512-f8tw11i5eCPeCyINvJJigSRmU4/uDXdM/ZiTvNP0tIr0f/wHES5lEfRiIxIsosK89koNTnzXm/jkKVeZ3yivGg==`.
- Provenance: SLSA v1, `refs/tags/v0.2.0`, repository
  `https://github.com/theunal/ng-signal-request`, resolved dependency `gitCommit`
  `47db330...`; `npm audit signatures` in a clean install reports 5 verified registry
  signatures and 1 verified attestation.
- The first run (#10, `0b4192c`) failed in tests and published nothing. The tag was
  moved to `47db330` after the test fix and the `origin/main` merge.

## Post-release CI

The separate `CI` workflow failed at lint on `47db330` and `7f19821`: the probe tsconfig
maps `ng-signal-request` to `dist/signal-request`, but CI ran lint before the library
build, so on a clean runner the probe imports were unresolved. The fix builds the library
before lint in `.github/workflows/ci.yml` and `pnpm verify`; with `dist` removed,
`pnpm verify` passes. The follow-up `CI` run #5 on `474d166` passed:
<https://github.com/theunal/ng-signal-request/actions/runs/39640775656>. The npm
tarball, provenance and tag still point at `47db330`.
