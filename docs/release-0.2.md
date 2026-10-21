# 0.2.0 release review (2026-10-21)

This is the pre-release record for the 0.2.0 candidate. It compares the candidate with
`v0.1.0`, lists every behavior change and its opt-out, and keeps the manual release
checks in one place. It does not publish anything.

## Diff against 0.1.0

At the final candidate (including this document):

```text
$ git diff v0.1.0 --stat
 101 files changed, 19433 insertions(+), 1872 deletions(-)
```

The diff includes the library, all four entry points, the demo, the probes, the compatibility
fixture, the e2e suite, the workflows, the design/verification records and the README
copy checked by `check:dist`. It does **not** include `docs/plan.md`, which is untracked
and must stay untracked.

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

- [ ] The package is unscoped: `ng-signal-request`. `npm view ng-signal-request name
version dist-tags` returns `0.1.0` as `latest`; `ng-signal-request@0.2.0` returns
      `E404`, so the version is free. Confirm the publishing account still owns the
      package (`npm owner ls ng-signal-request`).
- [ ] Decide whether an unscoped name is still wanted. A scope (`@theunal/...`) would
      change every install command and is a breaking package-name change; do not do it
      in this release without a migration plan.
- [ ] Create the tag **on the final commit**: `git tag v0.2.0`. No `v0.2.0` tag exists
      locally or on `origin` yet.
- [ ] Do not `npm publish` the working `dist/` by hand. The manifests still say
      `0.1.0`; the workflow rewrites the version from the tag. A manual publish without
      that step would target the already-published 0.1.0.
- [ ] Push only the tag (`git push origin v0.2.0`); the workflow derives `0.2.0` from
      `GITHUB_REF_NAME` and skips the publish if that version already exists.

### Repository metadata

- [ ] `repository.url`, `bugs.url` and `homepage` all point at
      `https://github.com/theunal/ng-signal-request`; `git remote -v` agrees. Open each
      URL and confirm the repository is public and the issue tracker is enabled.
- [ ] Confirm the README copy in `projects/signal-request/README.md` matches the root
      README; `pnpm check:dist` checks this today.
- [ ] Confirm the published tarball contains `LICENSE`, `README.md`, all four entry
      points (`/devtools`, `/persist`, `/testing`) and no probe/demo/e2e files.

### npm publishing and provenance

- [ ] `projects/signal-request/package.json` has `"publishConfig": { "access":
"public", "provenance": true }`. The generated `dist/signal-request/package.json`
      keeps both.
- [ ] npm Trusted Publishing is configured for this repository and the workflow file
      `.github/workflows/npm-publish.yml` (GitHub Actions provider). The npm account must
      have the package's publisher permission; no long-lived `NPM_TOKEN` should exist.
- [ ] The workflow has `permissions: contents: read` and `id-token: write`, installs
      npm >= 11.5.1, deliberately omits `setup-node`'s `registry-url`, and publishes with
      `npm publish --provenance --access public`. Those are the conditions for OIDC and a
      signed provenance statement.
- [ ] After the workflow, open the npm version page and confirm the provenance badge and
      the expected git tag/commit. If the job fails, the "Diagnose Trusted Publishing"
      step prints the OIDC request state without secrets.

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

### Verification gate

- [ ] `pnpm verify` passes on the final commit. Last run: 24 files, **599 tests**,
      coverage 97.86 / 93.61 / 99.25 / 99.03; `check:dist` passed.
- [ ] `pnpm check:api v0.1.0` reports **0 removed** in all four entry points; core is
      76 -> 90 exports (14 added), `/devtools` 6 -> 8, `/persist` 21 -> 28,
      `/testing` 6 -> 6.
- [ ] `pnpm check:types-compat` passes; the only expected failures are the annotated
      `Persister` and `CACHE_PERSISTER` spellings behind `@ts-expect-error`.
- [x] `pnpm test:e2e` passes in a real browser. Rerun on the candidate after Step 5 and
      again after the warning-copy trim: **3/3 passed** on the candidate commit that
      contains this document (see `docs/verification.md` §18).
- [x] `pnpm check:dist` has headroom: three consecutive runs on the same candidate gave
      **identical** sizes — `full` +23.49 KB against a 24 KB limit (0.51 KB),
      `devtools` +27.91 against 28.8 KB (0.89 KB), `request` +17.54, `keyed` +18.30.
      Do not raise a budget to make a release pass.
- [x] `git status` is clean except for the intentionally untracked `docs/plan.md`.
- [ ] The tag points at the commit that contains this file and the final CHANGELOG
      entry.
