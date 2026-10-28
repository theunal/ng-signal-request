# Plan - item 2, background replay for the durable mutation queue

> **Status: implemented in the working tree, unreleased and experimental.** This
> plan closes the second half of `docs/missing-features.md` item 2 ("No cross-tab
> queue coordination or background replay"). The cross-tab half was already
> delivered by the Web Locks owner and its handoff
> (`docs/design-offline-mutation-queue.md` §14). This plan adds the background
> half without changing the queue's storage format or the behaviour of an
> application that does not install it.
>
> **Audited revision.** Repository `05a7bee`; npm release `0.2.0`.
>
> **Candidate release.** `0.4.0`, with the rest of the durable queue. Still
> experimental until the server-side idempotency contract is proven.

## 1. What is missing

The durable queue can already outlive the page that accepted a write: the entry
is in IndexedDB, and a waiting tab takes the Web Lock over when the owner closes.
It cannot outlive **every** tab. With no tab open, nothing runs the replay loop,
so a write stays on disk until the user opens the application again.

A non-owner tab's own calls are also in memory only. That is a separate gap and
is **not** part of this plan (see §8).

## 2. Decision

Background replay is delivered through an **application-owned service worker**,
not by the library registering one.

The library cannot rebuild an application's request without the application's
builder. Persisting a raw URL and headers would bypass the builder, `parse`,
`invalidates` and the handle signals, and would store an auth token that must be
refreshed - the same boundary the design already chose in §9.1 and §21.2. A
service worker is therefore given a map of plain replay functions by the
application, and the library owns everything around them: the snapshot format,
validation, FIFO order, the lock, retry/backoff bookkeeping and removal.

Two pieces ship:

1. **Page side.** `providePersistedMutationQueue({ backgroundSync: true })`
   registers the sync tag whenever a durable entry exists. It never registers a
   service worker and never imports worker code.
2. **Worker side.** A new dependency-free entry point,
   `ng-signal-request/persist/queue/sw`, with:
   - `MUTATION_QUEUE_SYNC_TAG`;
   - `registerMutationQueueSync(registration, options?)`;
   - `drainMutationQueue(options)`;
   - `indexedDbQueueStorage(options?)`;
   - the handler and result types.

The application still owns the service worker file and its lifecycle. That is
the only honest split: the worker needs application code to send the request,
and the application needs the library to read, order and update the queue.

## 3. Page-side API

```ts
providePersistedMutationQueue({
  eager: [TodoStore],
  // Opt-in. Requires an application service worker that handles the tag.
  backgroundSync: true,
});
```

`backgroundSync` accepts `boolean | { tag?: string }`. The default tag is
`ng-signal-request:mutation-queue`.

Rules:

- Registration is attempted during queue initialization, after hydration, and
  again after an enqueue or a retryable failure. `registration.sync.register` is
  idempotent for the same tag, so calling it repeatedly is cheap.
- `navigator.serviceWorker.ready` is used, so a page that starts before the
  worker is active still registers once it is.
- If `serviceWorker` or `SyncManager` is unavailable, a dev warning is emitted
  once and the option is a no-op. It never changes the queue's `enabled` state:
  background delivery is an extra, not a durability requirement.
- A rejected `register()` is reported to `ErrorHandler`, never thrown from
  `enqueue()`.

## 4. Worker-side API

```ts
// sw.ts - the application's own service worker
import {
  MUTATION_QUEUE_SYNC_TAG,
  drainMutationQueue,
  indexedDbQueueStorage,
} from 'ng-signal-request/persist/queue/sw';

self.addEventListener('sync', (event) => {
  if (event.tag !== MUTATION_QUEUE_SYNC_TAG) return;
  event.waitUntil(
    drainMutationQueue({
      storage: indexedDbQueueStorage(),
      handlers: {
        'todos.add': async (args, ctx) => {
          const response = await fetch('/todos', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ctx.idempotencyHeader === false
                ? {}
                : { [ctx.idempotencyHeader]: ctx.idempotencyKey }),
            },
            body: JSON.stringify(args),
          });
          if (!response.ok) throw new SyncHttpError(response.status, await response.text());
        },
      },
    }),
  );
});
```

`drainMutationQueue`:

- reads the same envelope the page writes (`version`, `timestamp`, `buster`,
  `entries`);
- validates it without trusting it; a corrupt or unsupported snapshot is left
  untouched and reported as `blocked`;
- takes the same Web Lock name as the page (`ifAvailable: true`). If a page owns
  the queue, the worker returns `blocked: 'locked'` and lets the page replay -
  two writers are exactly what the lock exists to prevent. If no page is open,
  the lock is free and the worker drains;
- replays entries in `seq` order;
- removes an entry and persists the removal after each success;
- updates `attempts`, `lastAttemptAt`, `nextAttemptAt` and `lastError` after a
  failure, using the same classification and backoff as the page;
- stops on a failed or quarantined entry when `stopOnFailure` is `true` (the
  default), on a missing handler, on a future `nextAttemptAt`, and on `401`/`403`;
- returns a `MutationQueueSyncResult` summary instead of throwing for an expected
  stop.

`indexedDbQueueStorage()` is a dependency-free adapter with the page queue's
defaults (`database: 'ng-signal-request'`, `store: 'mutations'`, `version: 1`).
An application that already has a storage adapter can pass any object with
`getItem` / `setItem` / `removeItem`.

## 5. Handler contract

```ts
interface MutationQueueSyncHandler {
  readonly key: string;
  readonly version?: number;
  readonly idempotencyHeader?: string | false;
  readonly deserialize?: (raw: unknown) => unknown;
  readonly migrate?: (
    entry: PersistedMutationEntry,
    fromVersion: number,
  ) => PersistedMutationEntry | null;
  replay(args: unknown, context: MutationQueueSyncContext): Promise<void>;
}
```

- `key` is `persistence.key`. Two handlers with the same key are a developer
  error; the first wins and a dev warning is printed.
- `version` is the args version the handler understands. An entry with a
  different version needs `migrate`; otherwise it is left untouched and reported
  as `blocked: 'version'`.
- `deserialize` defaults to identity, because the default codec stores JSON-safe
  args. A custom codec needs its deserializer here as well.
- `replay` must send `context.idempotencyKey` in
  `context.idempotencyHeader` (default `Idempotency-Key`). The helper cannot add
  the header itself: it does not know the request shape. `idempotencyHeader:
false` is the explicit "my server deduplicates another way" opt-out.
- Throwing is the failure signal. The helper reads `status` (HTTP), `kind`
  (`network`, `timeout`, `aborted`) and `name` from the error, so a plain
  `Error` is a permanent failure unless it carries one of those fields.

## 6. Failure and retry table

| Failure                                         | Worker action                                            |
| ----------------------------------------------- | -------------------------------------------------------- |
| `navigator.onLine === false` before an attempt  | Stop, leave `pending`, report `offline`.                 |
| `kind: 'network'`                               | Retry with backoff; stop this drain.                     |
| `kind: 'timeout'` with an idempotency header    | Retry with backoff; stop this drain.                     |
| `kind: 'timeout'` without an idempotency header | Mark `failed`; do not send again.                        |
| `408`, `425`, `429`                             | Retry with backoff; `Retry-After` is honoured when read. |
| `5xx` with an idempotency header                | Retry with backoff up to `maxAttempts`.                  |
| `5xx` without an idempotency header             | Mark `failed`.                                           |
| `401`, `403`                                    | Stop, leave `pending`, report `auth`.                    |
| Other `4xx`                                     | Mark `failed`.                                           |
| Missing handler / version mismatch              | Stop, leave untouched, report the reason.                |
| Corrupt snapshot / entry                        | Stop, leave the raw snapshot untouched.                  |
| Storage read/write failure                      | Stop, report `storage`; never overwrite the snapshot.    |

Backoff matches the page: 1s, 2s, 4s, 8s, 16s, capped at 30s, 80-120% jitter,
`maxAttempts` default 5. A future `nextAttemptAt` is not slept on in the worker:
Background Sync is best-effort and has no reliable timer. The entry stays
pending and the next sync event (or the next page) continues it.

## 7. Ordering, idempotency and races

- Global FIFO by `seq`, exactly like the page. `stopOnFailure: true` by default.
- The worker and the page share one Web Lock. `ifAvailable: true` means the
  worker never waits for a live page: the page is already the better replay
  owner because it can run `invalidates`, `onSuccess` and the handle signals.
- The worker is the owner only when no page holds the lock. It then reads the
  snapshot fresh; its view cannot be stale because it has no long-lived state.
- The idempotency key is the entry's stored key, passed verbatim. A worker
  replay and a page replay of the same entry therefore carry the same key, which
  is the whole duplicate-safety story.
- The worker never calls `onRestore`, `onMutate`, optimistic writes or
  `invalidates`. Those are page concerns; the page will reconcile when it opens.

## 8. Non-goals

- **The library registering a service worker.** It cannot own the worker's URL,
  scope, build or update lifecycle. `backgroundSync` only registers a tag on a
  worker the application already has.
- **Background replay without an application service worker.** Nothing replays
  with no tab and no worker. This is now a documented integration, not a missing
  library primitive.
- **Non-owner durability.** A non-owner tab's own calls still stay in memory.
  A BroadcastChannel handoff or a per-entry IndexedDB claim is the follow-up;
  neither is in this plan.
- **A raw request store.** The worker gets application replay functions, not a
  serialized `fetch`.
- **`invalidates`, `onSuccess` or optimistic restore in the worker.** The worker
  has no cache or component tree; the page owns those.
- **Guaranteed delivery.** Background Sync is best-effort and browser-controlled.
  The library guarantees at-least-once storage, not a wake-up.

## 9. Tests

Unit (`persist/queue/sw/sw.spec.ts`):

- empty snapshot, success, FIFO, removal persisted after each entry;
- idempotency context passed to the handler, custom header, `false`;
- retry/backoff update, `maxAttempts`, `Retry-After`;
- permanent `4xx`, `5xx` with and without a header, timeout with and without;
- `401`/`403` stop; `offline` stop;
- missing handler, version mismatch with and without `migrate`;
- corrupt JSON, wrong envelope, wrong buster, unsupported version;
- duplicate handler key, `deserialize` throw;
- lock busy and lock granted; storage read/write failure;
- `stopOnFailure: false`; `now` injection for deterministic backoff.

Page (`queue-config.spec.ts`):

- `backgroundSync: true` registers the tag after initialization and after an
  enqueue;
- a missing `serviceWorker` / `SyncManager` warns once and does not disable the
  queue;
- a rejected `register()` goes to `ErrorHandler`.

Browser e2e is **not** added in this change. A real Background Sync test needs a
custom service worker build and browser permission; the unit suite proves the
state machine and the page registration, and `docs/verification.md` records the
boundary honestly.

## 10. Documentation and gates

- `README.md` (and the byte-identical library copy): a "Background replay"
  subsection with the worker example, the handler contract, the lock behaviour,
  the best-effort limit and the non-owner gap.
- `docs/design-offline-mutation-queue.md`: update §4, §14.3, §17.3, §19.2 and
  §22 to point at this plan instead of calling background replay an absolute
  non-goal.
- `docs/missing-features.md` item 2: record the new integration surface and keep
  the honest limit (the application must install a worker; non-owner writes are
  still in memory).
- `CHANGELOG.md`: an Unreleased entry.
- `docs/verification.md`: a §21 record with the unit boundary and the absent
  browser test.
- `scripts/check-dist.mjs`: a marker set and budget for
  `ng-signal-request-persist-queue-sw.mjs`, and a check that the demo bundle does
  not contain it.
- `compat/queue/usage.ts`: a type fixture for the new entry point.

## 11. Acceptance criteria

1. The page option registers the sync tag after a durable enqueue, and does
   nothing when the browser or the worker is unavailable.
2. `drainMutationQueue` replays FIFO, reuses the stored idempotency key and
   removes only entries it actually sent.
3. A live page owner makes the worker return `blocked: 'locked'` without
   touching the queue.
4. A corrupt snapshot is never overwritten.
5. A permanent failure stays `failed`; a retryable one stays `pending` with
   updated `attempts` / `nextAttemptAt`.
6. The new entry point has no Angular runtime import and stays under its own
   bundle budget.
7. An application that does not set `backgroundSync` and does not import the new
   entry point behaves exactly as before.
8. Unit tests, type checks, lint, format, build and `check:dist` are green.
