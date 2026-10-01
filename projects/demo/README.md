# Demo — runnable example app

An Angular application that exercises every feature of the library against a real
API.

```bash
pnpm start          # ng serve demo  ->  http://localhost:4200
pnpm build:demo     # production build -> dist/demo
```

The app imports the library **by its package name** and resolves to the
**source** via `paths` in the root `tsconfig.json`
(`projects/signal-request/src/public-api.ts`). So `pnpm start`, the editor and
`pnpm typecheck` all work without `dist/`.

> The demo's tsconfig is named `tsconfig.json`, not `tsconfig.app.json`. The
> editor's TypeScript service walks up from a file looking for exactly that
> name; with the `.app` suffix it skipped this folder and fell back to the root
> config, which made `import ... from 'ng-signal-request'` show up unresolved
> even though `ng serve` built fine.

## Data source

`https://jsonplaceholder.typicode.com` — a fake API, but CORS-enabled. The
warning banner in the app states two of its limits outright:

- `?q=` does **not** really filter server-side (so the search filters locally).
- Writes (POST / PUT / DELETE) are accepted but **not persisted**; records
  disappear after a `reload()`. That is also how you can watch `invalidates`
  firing.

`retry` and `cancel` need real HTTP behaviour that this API cannot provide, so
`demo-api.interceptor.ts` only intercepts `/api/*` paths:

| Path | Behaviour |
| --- | --- |
| `/api/flaky` | `503` on the first two hits, success on the third → `retry` is observable |
| `/api/slow` | 3s delay → `cancel()` has something real to abort |

Every other request goes to the real API.

## Tabs

**1 · List & params** — `createRequest`

- The `params` bag: `page` / `perPage` → query, `path` → the `:id` placeholder, `headers` → request
- Re-firing with `params.set()`; disabling the request with `params.set(undefined)`
- `initialValue` + `keepPreviousValue` (no flicker when the page changes)
- `reload()` / `cancel()` / `set()` / `update()` (optimistic) / `destroy()`
- `lazy: true` + `run()` / `tryRun()`
- `ctx.chain`: the comments request waits for the post, so no redundant round-trip
- `success()`, `status()`, `initialLoading()`, `retryAttempt()`, `statusCode()`
- `requestError()` for discriminated failures (`http` / `network` / `timeout` / `aborted`)

**2 · Form & mutation** — `createMutation`

- The same endpoint under two concurrency policies: `exhaust` (double-click
  protection, returns the in-flight promise) and `parallel` (every call goes out)
- `args` doubles as a params bag: the builder stays a bare url while `body` /
  `path` get placed for you
- The verb comes from the variant, never the builder: `createMutation.delete` for
  the remove button, `createMutation.put` for the edit form
- `invalidates` → the list refreshes automatically after a successful write
- `onSuccess` / `onError`, and reading the outcome with `tryRun()` without catches
- The `responseType` and `timeout` options

**3 · Retry, debounce, polling**

- `debounce: 300` + a request counter (the first request is never delayed, only source changes)
- `retry: 3` with a custom `delay` / `when` — `/api/flaky` passes on the third attempt
- `pollInterval` switched on and off reactively: `() => (running() ? 2000 : false)`
- `parse` to validate / map the body (`{ count }`)
- `cancel()` really aborting a 3-second request
- `createRequest.text()` — the body read as text
- The `equal`, `debugName` and `injector` options pass straight through

## Not covered

The demo tries to show everything, but these are deliberately left out:

- **The token refresh flow** needs a real interceptor. The demo covers the same
  observable behaviour (intermittent failure → successful retry) with
  `/api/flaky` + `retry`. For reactive `headers` and refresh, see the "Auth"
  section of the main README.
- **The `!` on `ctx.chain`**: `detail.resource` is `Post | undefined` because it
  has no `initialValue`, so the chain narrowing is invisible to the compiler.
  There is no runtime problem — the chain does not resolve until the value is
  really there — but the `!` is needed.
