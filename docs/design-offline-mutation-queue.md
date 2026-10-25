# Persisted offline mutation queue - design proposal

> **Status: implemented in the working tree, unreleased and experimental.** This
> document stays the decision record: it answers item 1 of
> `docs/missing-features.md`, and every decision below is what the code does.
> `docs/verification.md` §20 records what was measured and what the test boundary
> does not reach. The feature is opt-in, so it does not change the shipped
> behaviour of an application that does not install it, and no tag, publish or
> release-state change is part of it.
>
> **Audited revision.** Repository `d2e6128`; npm release `0.2.0`.
>
> **Candidate release.** `0.4.0`, after the `0.3.0` `retryTimeouts` change, and
> labelled experimental until the server-side idempotency contract is proven.
> The decisions below are settled for the design; implementation details remain.

## 1. Decision summary

| Question                     | Proposed answer                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Is this opt-in?              | Yes. A new `/persist/queue` provider and a new `persistence` mutation option. Without both, 0.2.0 behaviour is unchanged. |
| What identifies a mutation?  | An explicit, string-only `persistence.key`; `mutationKey` is not reused because it is optional and not unique.            |
| What is persisted?           | Mutation key, args, args version, order, attempts, idempotency key and failure metadata. Not headers, not closures.       |
| Where is it persisted?       | A separate versioned queue snapshot in `/persist/queue`, not inside the cache snapshot.                                   |
| When is it durable?          | The queue write is awaited **before** the optimistic write and before the request is sent.                                |
| How is it replayed?          | A registered mutation handle rebuilds the request from args and replays it in global FIFO order.                          |
| What prevents duplicates?    | A stable `Idempotency-Key` generated before the first send and reused on every replay.                                    |
| What about optimistic state? | The queue does not restore it automatically; `persistence.onRestore` lets the app reapply its own state.                  |
| What about two tabs?         | One writer via Web Locks. Without Web Locks the durable queue is disabled unless `assumeSingleTab: true`.                 |
| What if replay cannot run?   | The entry stays `pending`/`blocked`; `eager` services register handlers at startup and a dev warning names a stuck head.  |
| What happens on a bad queue? | Quarantine and block, do not delete. Losing a queued write is worse than refusing to replay an unreadable one.            |

## 2. What exists today

The current implementation is a per-handle, in-memory queue:

- `createMutation` keeps `queue: AcceptedCall[]` and a `queuedCount` signal. The
  queue is drained by `replay()` on reconnect, in call order
  (`create-mutation.ts:193-224`).
- `hold()` keeps the optimistic write and leaves `run()` pending; `loading()` is
  `true` and `paused()` is `true` while the call waits
  (`create-mutation.ts:430-437`, `types.ts:1195-1202`).
- A replay calls `send()` only. `onMutate` and `applyOptimistic` already ran at
  the original `run()` time and are not repeated
  (`create-mutation.ts:302-320`, `336-339`, `439-462`).
- A network failure while the manager is offline goes back to the queue; a
  `status: 0` failure while the manager says online is a final failure
  (`create-mutation.ts:498-525`).
- `destroy()` cancels every call in the handle, and the queue dies with the
  injector (`create-mutation.ts:570-578`).
- `MutationRegistry` stores counts only. There is no public mutation cache, no
  queue list and no `resumePausedMutations` equivalent
  (`cache/mutation-registry.ts`).

The cache persistence layer is a separate snapshot:

- `SNAPSHOT_VERSION = 1`, one storage key, `CacheStorage` / `AsyncCacheStorage`,
  `localStorage` by default and `indexedDbStorage()` for async storage
  (`persist/persist.ts:54`, `396-400`, `414-418`, `585-896`).
- `providePersistedCache` hydrates during injector creation and reuses
  `RESTORE_GATE` to hold query fetches (`persist/persist.ts:922-961`).
- A snapshot carries cache entries only. It has no notion of a pending write, an
  idempotency key or a replay owner.

Reusing that snapshot for mutations would mix two lifecycles. A cache snapshot
is disposable and is dropped on a version or buster mismatch. A queue snapshot is
not disposable: dropping it loses accepted user writes. The design therefore
keeps them separate.

## 3. Goals

1. A mutation accepted while offline or in flight survives a reload, a tab close
   and a browser restart.
2. The write is replayed **at least once** and, with server support for the
   idempotency key, **effectively once**.
3. Replay order is deterministic and preserves the order the application made
   the calls in.
4. The application can see which writes are pending, failed or blocked without
   holding every mutation handle.
5. A failed replay is not silently discarded. The application can inspect,
   retry, remove or clear an entry.
6. The feature is genuinely opt-in. An application that does not install the
   provider pays only for the small core token and does not change behaviour.
7. The existing in-memory path remains the fallback when persistence is not
   available or is disabled.

## 4. Non-goals

- **Exactly-once delivery.** The library cannot provide it without a server
  contract. The idempotency key is the contract; the server must honour it.
- **Cross-tab live coordination.** Item 2 is separate. This design covers a
  single owner via Web Locks. Without Web Locks the durable queue is disabled
  unless the application explicitly opts into `assumeSingleTab: true`; there is
  no BroadcastChannel or SharedWorker.
- **Service-worker Background Sync.** The library does not register a service
  worker or a sync tag.
- **Persisting closures, headers or `onMutate` context.** Those are neither
  safely serializable nor stable across an auth refresh.
- **Automatic optimistic UI restore.** The queue will not reconstruct arbitrary
  targets. `persistence.onRestore` lets the application reapply its own state.
- **Non-JSON request bodies.** `FormData`, `File`, `Blob`, `ArrayBuffer` and
  streams are not queueable in v1. A separate upload outbox is a different
  feature.
- **A replay when the owning mutation handle is not present.** The queue waits;
  it does not store a raw HTTP request.
- **A mutation cache or history.** The queue is an outbox, not a TanStack-style
  mutation cache.
- **Independent lanes in v1.** Entries reserve an optional `lane` field, but v1
  still replays global FIFO. Lane isolation is a later additive change.

## 5. User-facing API

### 5.1 Enabling the queue

```ts
// app.config.ts
import { provideHttpClient } from '@angular/common/http';
import { indexedDbStorage } from 'ng-signal-request/persist';
import { providePersistedMutationQueue } from 'ng-signal-request/persist/queue';

providers: [
  provideHttpClient(),
  providePersistedMutationQueue({
    // Optional. IndexedDB is the default; localStorage is the fallback.
    storage: indexedDbStorage({ store: 'mutations' }),
    // Optional. This is the storage key, not a mutation identity.
    key: 'my-app:mutation-queue',
    maxEntries: 100,
    autoReplay: true,
    // Root services whose mutation handles must register before replay.
    eager: [TodosApi, DraftsApi],
  }),
];
```

`providePersistedMutationQueue` is a sibling of `providePersistedCache`, not an
option on it. An application may want one without the other, and the two have
different failure policies.

`eager` is the escape hatch for lazy services: each token is injected during an
environment initializer, so a root mutation service constructs and registers its
handler before auto-replay starts. Component-scoped services are not suitable:
they do not exist after a reload.

The proposed provider surface is:

```ts
interface PersistedMutationQueueOptions {
  storage?: CacheStorage | null; // default: IndexedDB, then localStorage
  key?: string; // storage key; default: 'ng-signal-request:mutation-queue'
  buster?: string;
  maxEntries?: number; // default: 100
  autoReplay?: boolean; // default: true
  stopOnFailure?: boolean; // default: true
  assumeSingleTab?: boolean; // default: false; opt-in fallback without Web Locks
  eager?: readonly ProviderToken<unknown>[]; // injected before autoReplay
  noHandlerWarnAfterMs?: number; // default: 5000
  onStorageError?: 'degrade' | 'fail'; // default: 'degrade'
  retry?: { maxAttempts?: number; baseDelay?: number; maxDelay?: number };
  migrate?: (snapshot: MutationQueueSnapshot, fromVersion: number) => MutationQueueSnapshot | null;
  migrateEntry?: (
    entry: PersistedMutationEntry,
    fromVersion: number,
  ) => PersistedMutationEntry | null;
}
```

### 5.2 Marking a mutation as durable

```ts
readonly addTodo = createMutation<Todo, Draft>(
  (draft) => ({ url: '/todos', body: draft }),
  {
    networkMode: 'online',
    mutationKey: ['todos'],
    persistence: {
      key: 'todos.add', // stable, application-unique
      version: 1,
      // Optional. The default is JSON-safe args.
      codec: {
        serialize: (draft) => draft,
        deserialize: (raw) => raw as Draft,
      },
      // Optional. The default is a generated UUID.
      // `Draft` carries an application-owned clientId in this example.
      idempotencyKey: (draft) => draft.clientId,
      // Optional. Reapply app-owned optimistic UI after hydration.
      onRestore: (draft) => todosStore.restorePending(draft),
      // Optional. Replay-only policy for a duplicate 409.
      isAlreadyApplied: (error) => isAlreadyAppliedError(error),
    },
  },
);
```

The effective `networkMode` must be `'online'`. With `'always'`, a call that
fails offline is a final failure by design; persisting it would change that
contract. If `persistence` is present and the effective mode is not `'online'`,
the library warns in dev mode and leaves the mutation on the existing path.

If `providePersistedMutationQueue` is not installed, `persistence` is a no-op
with a dev warning; the mutation keeps the 0.2.0 path. The option alone never
causes a storage write.

`persistence.key` is required, is a `string`, and must be unique per mutation
definition:

- two handles with the same key cannot both replay the same entry;
- `mutationKey` is a query-key filter for counts, not an identity;
- the key is stored in the entry and is the only thing the queue needs in order
  to find the handler after a reload;
- `persistence.version` defaults to `1`; bump it when the args shape changes so
  `migrateEntry` can decide what to do.

`onRestore` runs once per hydrated pending entry that has a registered handler
and successfully deserialized args, after the cache restore gate settles and
before that entry's replay. If the handler registers later, the hook runs at
registration. A throw or rejection is reported but does not block the durable
write. It is not called for current-page enqueues or for failed/quarantined
entries.

`isAlreadyApplied` is consulted only on replay. If a replay receives a `409` and
the hook returns `true`, the queue treats the write as applied, removes the entry
and runs invalidations. It does not fabricate an `onSuccess` value; `onSettled`
runs with `context: undefined` and `meta.replayed: true`. A first-attempt `409`
remains a normal failure.

`concurrency: 'switch'` is incompatible with `persistence`: cancelling a write
that may already have reached the server contradicts the outbox guarantee. The
type should exclude the combination where possible, dev mode throws, and
production disables persistence for that mutation and warns (§13.3).

### 5.3 The queue service

`PersistedMutationQueue` is injectable from `/persist/queue`:

```ts
readonly queue = inject(PersistedMutationQueue);

readonly pending = this.queue.pendingCount; // Signal<number>
readonly failed = this.queue.failedCount; // Signal<number>
readonly replaying = this.queue.isReplaying; // Signal<boolean>
readonly needsAuth = this.queue.needsAuth; // Signal<boolean>
readonly owner = this.queue.owner; // Signal<boolean>
readonly enabled = this.queue.enabled; // Signal<boolean>
readonly entries = this.queue.entries; // Signal<readonly PersistedMutationEntry[]>
```

Methods:

```ts
queue.resume(): Promise<void>;       // start or continue replay
queue.pause(): void;                 // stop after the current entry
queue.retry(id: string): Promise<void>; // reset attempts and requeue one entry
queue.remove(id: string): Promise<void>; // drop one entry
queue.clear(): Promise<void>;        // drop every entry and the stored snapshot
queue.export(): Promise<string | null>; // raw snapshot for support
queue.onEvent(listener): () => void; // enqueued / replayed / failed / blocked / queue-full
```

The queue service is intentionally not part of `QueryClient`. A query cache is
not a write outbox; adding the queue to `QueryClient` would force every cached
application to retain the persistence path and would blur the meaning of
`isMutating`, which currently means "in flight" and not "waiting in storage".

The `entries` / `resume` surface is the minimum needed to operate and test a
durable queue. It is not a claim that item 3's broader inspection UI is complete.

### 5.4 What stays on the handle

The existing per-handle surface is unchanged:

- `run()` returns a promise that resolves on success and rejects on a final
  failure or cancellation. A durable call detached by `destroy()` rejects with
  `MutationDetachedError`, which is not a network failure.
- `tryRun()`, `status()`, `error()`, `requestError()`, `paused()`, `args()`,
  `context()`, `progress()` keep their meaning.
- `cancel()` cancels current-page calls as before.
- `destroy()` cancels in-flight calls but **does not delete persisted entries**;
  a queued write belongs to the application, not to the component that created
  the handle.
- `concurrency: 'parallel'` and `'exhaust'` keep their per-handle meaning.
  `'switch'` is not allowed with `persistence`: the type should exclude it where
  possible, dev mode throws, and production disables persistence for that
  mutation and warns (§13.3).

The queue adds a global pending/failed view; it does not turn `isMutating` into
a pending-writes indicator. A future `QueryClient` addition, if any, should be a
separate signal.

## 6. Data model and storage format

### 6.1 Envelope

The queue has its own versioned envelope. It is not `CacheSnapshot`.

```ts
export const MUTATION_QUEUE_VERSION = 1;

export interface MutationQueueSnapshot {
  readonly version: number; // library envelope version
  readonly timestamp: number; // when this snapshot was written
  readonly buster?: string; // application content stamp
  readonly entries: readonly PersistedMutationEntry[];
}

export interface PersistedMutationEntry {
  readonly id: string; // UUID, stable for the life of the write
  readonly key: string; // persistence.key
  readonly version: number; // app args version
  readonly args?: unknown; // serialized by persistence.codec; absent for void
  readonly createdAt: number; // epoch ms
  readonly seq: number; // order inside the queue
  readonly lane?: string; // reserved; v1 still uses global FIFO
  readonly idempotencyKey: string; // sent on every attempt
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly nextAttemptAt?: number;
  readonly state: 'pending' | 'failed' | 'quarantined';
  readonly lastError?: PersistedMutationError;
}

export interface PersistedMutationError {
  readonly kind: string; // RequestErrorKind, or 'deserialize' / 'storage'
  readonly status?: number;
  readonly message: string;
  readonly at: number;
}
```

`args` is already serialized. The queue does not know what is inside it; the
registered handler deserializes it with the `codec` from the same
`persistence` option. This keeps the storage layer free of application types.

A `void` mutation has no args, and `JSON.stringify` omits an `undefined`
property. A missing `args` field is therefore read as `undefined`; it is not
corruption by itself. The registered codec decides whether `undefined` is valid
for that mutation.

`lane` is reserved and ignored by v1. It is optional, so adding it later does not
require an envelope migration. When lanes ship, a permanent failure blocks only
its own lane; until then, global FIFO and `stopOnFailure` are the ordering rules.

### 6.2 Storage key and defaults

- Default key: `'ng-signal-request:mutation-queue'`.
- Default storage: IndexedDB via `indexedDbStorage()`, falling back to
  `localStorage` when IndexedDB is unavailable. If neither is usable, the queue
  reports `enabled: false` and the mutation falls back to the 0.2.0 path.
- This differs from `createPersister`, whose default is `localStorage`. The queue
  prefers IndexedDB because one snapshot can be large and a synchronous full
  rewrite blocks the main thread. Persistence already makes `run()` async, so the
  queue does not give up the 0.2.0 synchronous send guarantee for a second time.
- One snapshot per queue. This is simpler than per-entry storage and matches
  the existing `/persist` model. The cost is a full rewrite per change; the
  queue is intentionally small and capped.
- Writes are serialized by the queue, like `createPersister`'s write chain, so
  two queue writes are never in flight at the same time.

### 6.3 Ordering fields

`createdAt` alone is not enough: two entries can share a millisecond. `seq` is a
monotonic counter stored in the snapshot. A new entry takes `max(seq) + 1`; the
counter is not reset by a reload. The queue sorts by `seq`; a damaged snapshot
with a duplicate uses `createdAt` and `id` for a deterministic display order, but
the duplicate is quarantined and never replayed (§15.4). This does not depend on
the wall clock moving backwards.

## 7. Mutation identity and args

### 7.1 Why not `mutationKey`

`mutationKey` is optional, prefix-matched and explicitly a **grouping** key
(`types.ts:1067-1079`). Two different writes can share `['todos']`; one write
can have no key at all. It cannot identify a queue entry or find a handler after
a reload.

`persistence.key` is a string chosen by the application. It is the identity of
the mutation definition, not of one call. The call identity is the entry `id`.

### 7.2 Codec

```ts
export interface MutationArgsCodec<TArgs> {
  serialize(args: TArgs): unknown;
  deserialize(value: unknown): TArgs;
}
```

The default codec is a JSON codec: it accepts plain JSON data (objects, arrays,
strings, finite numbers, booleans, `null` and a root `undefined` for a `void`
mutation) and rejects values JSON would silently lose (functions, symbols,
bigints, non-finite numbers, cycles and nested `undefined`). It does not attempt
to preserve `Date`, `Map`, `Set` or class identity; supply a codec for those.
The existing `SnapshotCodec` (`persist/persist.ts:105-108`) is structurally
compatible, so `dateRevivingCodec` can be reused for a whole queue if desired,
but per-mutation codecs are the recommended shape.

Serialization happens at enqueue time. If `serialize` throws or the default JSON
codec rejects a value, the call fails before the optimistic write and before the
network. The queue never silently turns an unsupported value into `{}`.

### 7.3 Unsupported args

`FormData`, `Blob`, `File`, `ArrayBuffer`, typed arrays and streams are not
supported by v1. A codec can encode an `ArrayBuffer` to base64, but the queue
does not provide an upload path, progress restoration or a chunk protocol.
Those belong in a dedicated upload outbox.

## 8. Enqueue, durability and send order

Without persistence, the current path is intentionally synchronous when there
is no `onMutate`: `run()` puts the request on the wire before it returns
(`create-mutation.ts:580-590`). Persistence changes that path only when the
provider and the option are both present.

When the durable queue accepts the call, `run()` is always asynchronous, even
without `onMutate`: the durable enqueue is awaited before the request is
dispatched. A test that expects `run(); expectOne(url)` must await a tick when
persistence is enabled. This is the deliberate cost of the durability guarantee.

The proposed order for a persisted mutation is:

1. `onMutate` runs. A rejection fails the call and nothing is persisted.
2. The request builder runs. A throwing builder fails the call and nothing is
   persisted.
3. The args are serialized and an entry is created with a stable `id` and
   `idempotencyKey`.
4. The entry is appended to the queue and the queue write is **awaited**.
5. The optimistic write is applied.
6. The queue dispatches the entry when it is its turn. If online and the queue
   is idle, that is immediately after step 5. If offline or behind older
   entries, the call stays pending.
7. On success, the entry is removed and the removal is persisted.
8. On a retryable failure, the entry stays `pending` with `attempts` and
   `nextAttemptAt` updated.
9. On a permanent failure, the entry becomes `failed`, remains for
   inspection/manual retry, and stops later entries by default
   (`stopOnFailure: true`).

The enqueue-before-send order is the important decision. If the send happened
first and the page closed before the queue write, the user could have a request
on the wire with no durable record. At least once is the honest guarantee; the
idempotency key makes the duplicate safe when the server cooperates.

If the removal write after a successful response fails, the network call has
already succeeded: `run()` resolves, the queue reports a storage error, and the
entry may replay until a later write removes it. `onStorageError: 'fail'` applies
to the enqueue before the send, not to this cleanup write; a successful response
must not become a rejection because storage failed afterwards.

The optimistic write is applied **after** the durable enqueue. If the storage
refuses the write and the policy is `fail`, the user never sees an optimistic
value for a write that was not recorded. If the policy is `degrade`, the call
continues with the 0.2.0 in-memory queue and the queue reports
`enabled: false`; the application can decide whether to block writes.

`onMutate` still runs at `run()` time and still sees the world before this call
changed it. This matches the 0.2.0 contract (`types.ts:1081-1103`).

### 8.1 What `run()` resolves

- If the entry is accepted, dispatched and succeeds, `run()` resolves with the
  parsed response, as today.
- If it is queued because the browser is offline, `run()` stays pending, as
  today. A reload destroys that promise; the durable entry remains.
- If it is behind an older persisted entry, `run()` stays pending until its turn.
- If it fails permanently, `run()` rejects with the normalized error, as today.
- If `destroy()` detaches a current-page queued call, `run()` rejects with
  `MutationDetachedError`; the durable entry remains and may still be replayed.
- If the queue cannot persist and the policy is `fail`, `run()` rejects with a
  dedicated persistence error before anything is sent.

The original `run()` promise cannot survive a reload. The queue service, not a
promise, is the API for a write that outlives the page.

## 9. Replay

### 9.1 Handler registration

`createMutation` registers a handler with the queue when `persistence.key` is
present:

```ts
interface PersistedMutationHandler {
  readonly key: string;
  readonly version: number;
  deserialize(raw: unknown, version: number): unknown;
  replay(entry: PersistedMutationEntry): Promise<unknown>;
}
```

The queue stores handlers by key. On startup, hydrated entries whose key has no
handler stay `pending` and are reported as `blocked: 'no-handler'`. They are not
failed: the application simply has not constructed the owning service yet.
Because replay is global FIFO, a missing head handler blocks later entries. That
is deliberate: the queue will not reorder around a write whose definition it
cannot execute. `eager` services avoid the common case; if the head stays
unregistered for `noHandlerWarnAfterMs`, dev mode warns instead of blocking
silently.

This is a deliberate boundary. The queue does not persist a raw URL, headers or
a closure, because:

- headers may contain a token that must be refreshed, not replayed;
- a builder may depend on current application state;
- closures are not serializable;
- replaying a raw request would bypass `invalidates`, `parse`, `onSuccess` and
  the handle's signals.

The application must make its mutation owners available before replay is
expected. Root services are the natural home, and `providePersistedMutationQueue`
takes an `eager` list specifically for them (§5.1, §9.2). A service that is only
lazily injected will block the head of the queue until it is constructed.

Duplicate `persistence.key` registration is a developer error. In dev mode the
second registration throws a clear `MutationQueueKeyConflict`; in production the
first handler wins and the queue warns once. A silent last-writer-wins would
make replay depend on construction order.

### 9.2 When replay runs

The queue hydrates during injector creation, then starts replay when all of the
following are true:

- the platform is a browser;
- hydration has completed (the snapshot has been read and validated);
- if a cache persister is present, `RESTORE_GATE.restored()` has settled, so a
  replay's invalidations cannot race a cache restore;
- the queue is enabled and this tab owns it;
- `autoReplay` is `true` (default) or `resume()` was called;
- the browser is online;
- a handler is registered for the head entry.

`eager` services are injected during environment initialization, so their
handles normally register before auto-replay. If the head still has no handler
after `noHandlerWarnAfterMs` (default 5 seconds), dev mode emits a warning and a
`blocked: 'no-handler'` event. The entry stays pending; the queue does not fail a
write whose owning service has not been constructed.

Replay also runs on the `OnlineManager` reconnect event and after
`queue.resume()`. It does not run on a timer while offline; offline is not an
error and a timer that gives up would fabricate a failure.

Replay is sequential and global FIFO by `seq`. This is deliberately narrower
than per-lane concurrency:

- a create followed by an update is sent in the order the application made it;
- a permanent failure stops the queue by default (`stopOnFailure: true`), so a
  later write cannot overtake a failed predecessor;
- the first version is easy to reason about and to test.

The cost is head-of-line blocking across unrelated writes. Entries reserve an
optional `lane` field, but lanes are not active in v1; when they ship, a failure
will block only its own lane.

A new `run()` while the queue is non-empty appends to the queue and waits for
its turn. This matches the existing 0.2.0 rule that a new call must not overtake
an older queued call (`create-mutation.ts:395-398`). When the queue is empty and
online, the new entry is at the head and dispatches immediately.

### 9.3 What a replay does

A replay runs through the existing mutation machinery with a `replay` flag:

- it does **not** run `onMutate`;
- it does **not** run `optimistic`;
- it does not apply an undo closure;
- it rebuilds the request from the stored args and the current builder;
- it adds the stored idempotency key;
- it uses the current global headers, so a refreshed token is picked up;
- it runs `invalidates` and the applicable settle hooks when the handle is
  registered: `onSuccess` or `onError`, then `onSettled`;
- it passes `context: undefined` to the settle hooks, because the original
  context was never persisted;
- it passes `meta: { replayed: true }` as the final hook argument;
- it updates `response`, `error`, `requestError`, `args`, `status` and the
  mutation counts as an ordinary call would.

`replayed: true` means the entry was hydrated from storage and executed in a new
page load. A same-session retry, or the first send of a call accepted while
offline, is not a replay and passes `replayed: false`.

The settle-hook signatures already accept `TContext | undefined`
(`types.ts:1161-1165`), so a replay passing `undefined` does not break the type
contract. No conditional narrowing is needed; narrowing it would be a breaking
change for no gain. The optional final `meta` argument is additive: an existing
callback with fewer parameters remains assignable. An opt-in
`persistence.context` codec is a possible later addition; it is not v1.

`invalidates` should return keys, not handles, for a durable mutation. A handle
captured from a previous page load does not exist after a reload. Keys survive
because they are data. The existing `safe(reloadInvalidated)` wrapper already
turns a throwing target into an `ErrorHandler` report; using keys keeps that
report rare.

### 9.4 What a replay does not do

- It does not restore the previous page's `onMutate` side effects.
- It does not restore an optimistic value. See §10.
- It does not re-run `parse` on a stored response; there is no stored response.
  The new response goes through the current `parse`.
- It does not retry a permanent 4xx automatically.
- It does not run in a second tab that does not own the queue.

## 10. Optimistic state

### 10.1 v1 decision: do not restore optimistic state

The optimistic write is a UI statement about a call that was accepted. It is not
a server fact, and after a reload the call has not necessarily reached the
server. Persisting the optimistic value would require also persisting its target
identity, its previous value, its equality rule and enough context to roll it
back. The current `OptimisticTarget` is structural (`response` + `set`) and a
hand-written handle target may have no serializable identity
(`types.ts:1021-1029`, `1135-1154`).

V1 therefore treats optimistic state as **transient**:

- in the same page, it works exactly as today;
- after a reload, it is not reapplied by the queue;
- a replay after a reload does not run `optimistic`, so it cannot double-apply
  a value that cache persistence might already have restored;
- on a permanent replay failure there is no automatic rollback, because there
  was no automatic optimistic write in this page load.

The application can recover its own pending UI through `persistence.onRestore`
(§10.2). The queue still does not reconstruct a target or an undo closure.

This is a deliberate reduction in UI continuity in exchange for a queue that
does not lie about a server state it cannot reconstruct.

### 10.2 Application-owned restore hook

`persistence.onRestore(args, entry)` is the cheap middle ground between "do
nothing" and serializing optimistic targets. It runs once per hydrated pending
entry after the cache restore gate settles and before replay. The args are
already deserialized through the same codec, so the application can reconstruct
its own draft or pending row.

Only entries with a registered handler and successfully deserialized args reach
the hook; a missing handler leaves the entry blocked, and the hook runs when that
handler registers. The hook is UI recovery, not durability. It is not called for
current-page enqueues, failed entries or quarantined entries. A throw or
rejection is reported to Angular's `ErrorHandler`, and replay continues: the
durable write must not be blocked by a UI restore failure.

This solves the common offline-first case - "the pending row disappeared after a
reload" - without persisting `OptimisticTarget` identity, previous values or
compare-and-swap tokens. It is application code that knows where its pending row
belongs.

### 10.3 Interaction with `providePersistedCache`

The cache default `defaultDehydrateFilter` keeps any entry with data that is not
fetching and not in error (`persist/persist.ts:159-160`). A local optimistic
write has data, so it can be persisted by the cache snapshot. That is not the
queue's optimistic state; it is just a cached value.

Two application choices are acceptable:

1. Keep the cache snapshot as-is. The optimistic value may be visible after a
   reload until a refetch or an invalidation corrects it. The queue does not
   promise to roll it back.
2. Exclude local writes from cache dehydration when durable mutations are in
   use, for example with a custom `dehydrateFilter` that also requires
   `!entry.local()`. This keeps speculative values out of the reload.

The library should document both. It should not silently change the cache
persistence default for every application, because a user edit written with
`setData` may be intentionally persisted.

### 10.4 Possible opt-in later

A future `persistence.optimistic: true` could store:

- the target key (not a handle);
- the serialized previous value;
- the serialized optimistic value;
- a compare-and-swap token.

That would allow a reload to reapply and later roll back the value. It is not in
v1 because it multiplies the serialization surface, the security surface and
the failure cases, and because a handle target cannot always be identified.

## 11. Idempotency

### 11.1 Key generation

Every persistent entry gets an idempotency key **before the first send**:

- if `persistence.idempotencyKey(args)` is provided, use it;
- otherwise, if the built request already sets the configured header, use that
  value;
- otherwise, generate a UUID with `crypto.randomUUID()` and a
  `crypto.getRandomValues`-based fallback.

The key is stored in the entry and reused verbatim on every replay. It is not
regenerated after a reload.

### 11.2 Header

The default header name is `Idempotency-Key`. It can be changed:

```ts
persistence: {
  key: 'todos.add',
  idempotencyHeader: 'X-Idempotency-Key',
}
```

`idempotencyHeader: false` disables the header. In that case the queue can still
deliver at least once, but it cannot protect against a duplicate. The dev build
warns; the README states that the application must deduplicate.

The header is added to the built request after the builder and global headers
have been resolved. If the application already set the header, the queue stores
that value instead of overwriting it. This keeps a server-generated key or an
application-provided `clientId` authoritative.

On a replay the stored key is authoritative: if the rebuilt request supplies a
different value for that header, the queued key replaces it. That is what keeps
the key stable across a page load.

A custom header can trigger a CORS preflight on a cross-origin API. That is a
real cost and belongs in the documentation, not in a hidden default.

### 11.3 Server contract

The library guarantees **at least once**. The server must provide the
effectively-once half:

- remember the key for a bounded time;
- return the original status and body for a duplicate;
- do not apply the write twice.

If the server returns `409 Conflict` for a duplicate, the queue treats it as a
permanent failure by default. An application that uses `409` as "already
applied" can provide `persistence.isAlreadyApplied(error)`, whose default is
`false`. It is consulted only on replay: a `true` result removes the entry and
runs invalidations as a success; a first-attempt `409` remains a normal failure.
The hook keeps the status-code interpretation explicit instead of guessing from
the response body.

A replay can happen in three situations:

1. the original request never left the browser;
2. the original request reached the server but the response was lost;
3. the original succeeded and the queue removal did not persist before a close.

All three use the same key, so a compliant server returns the same result. The
library cannot detect case 3 by itself.

## 12. Failure, retry and auth

### 12.1 Classification

| Failure                                       | Default action                                                     |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Browser offline / `RequestErrorKind: network` | Keep `pending`; retry on reconnect.                                |
| Timeout with an idempotency header            | Retry with backoff, because the write may have reached the server. |
| Timeout with `idempotencyHeader: false`       | Mark `failed`; a blind retry could duplicate an applied write.     |
| `408`, `425`, `429`                           | Retry with backoff; honour `Retry-After` for `429` when readable.  |
| `5xx` with an idempotency header              | Retry with backoff up to `maxAttempts`.                            |
| `5xx` without an idempotency header           | Mark `failed`; the server may have applied the write.              |
| `401`, `403`                                  | Pause the queue and set `needsAuth`; keep the entry.               |
| `409` on replay + `isAlreadyApplied` true     | Treat as applied; remove the entry and invalidate.                 |
| Other `4xx`                                   | Mark `failed`; do not auto-retry.                                  |
| Args deserialize or schema error              | Mark `quarantined`; never send.                                    |
| Response parse error                          | Mark `failed`; the server may have applied the write.              |
| Storage failure                               | Disable the queue or fail the call, per `onStorageError`.          |

`status: 0` while the browser says it is online stays a final failure, matching
the 0.2.0 heuristic (`create-mutation.ts:500-513`). It can mean CORS, DNS, an
extension or a proxy; the queue does not guess. The application can call
`queue.retry(id)` after a health check.

Timeout handling uses the same language as the `0.3.0` `retryTimeouts` default
change: with an idempotency header, retry; without one, fail and keep the entry.
The library cannot verify that the server actually honours the header. The README
must say so explicitly and point at the server contract in §11.3.

### 12.2 Backoff

Default: 1s, 2s, 4s, 8s, 16s, capped at 30s, with jitter. The delay is stored as
`nextAttemptAt`, so a reload does not reset the backoff. `attempts` is also
stored. A manual `retry(id)` resets both.

`maxAttempts` defaults to 5. After exhaustion the entry becomes `failed`; it is
not deleted. The application can show it, retry it, or remove it.

### 12.3 Auth and pause

A `401`/`403` is not a reason to drop a user's write. The queue:

- stops after the current entry;
- sets `needsAuth` to `true`;
- keeps the entry `pending`;
- exposes an event so the shell can open a login flow;
- resumes only on `queue.resume()` or a new successful auth signal supplied by
  the application.

The library does not know how an application logs in. It should not retry a 401
in a loop.

`queue.pause()` stops after the current entry and leaves the rest pending. This
is also the escape hatch for a maintenance window or a read-only account.

### 12.4 Permanent failure and ordering

A permanently failed entry stays in the queue. By default `stopOnFailure: true`
stops later entries: a create that got a `400` followed by an update that would
now get a `404` must not run ahead of the failed create. Correctness wins over
liveness, and the application can recover with `retry` or `remove`.

`stopOnFailure: false` continues with the next entry and skips the failed one on
later automatic passes. That is the liveness-first option; the application
accepts that dependent writes may fail.

The entry reserves an optional `lane` field, but v1 does not use it. When lanes
ship, a permanent failure will block only its own lane instead of the whole
queue. Until then this remains a per-queue option, not a per-entry one.

## 13. Cancellation, `destroy` and concurrency

### 13.1 `cancel()`

- A call that is still in the current page's queue is removed from storage as
  well as from memory.
- A call that is already on the wire is aborted as today; the entry is removed.
- The optimistic undo runs as today for a current-page call.

Removing an entry after a request may already have reached the server is not a
rollback. It is a local cancellation; the server may still have applied the
write. The idempotency key is what keeps a subsequent replay from duplicating
it.

### 13.2 `destroy()`

`destroy()` still cancels in-flight calls. For a current-page queued call whose
durable entry remains, it rejects the promise with `MutationDetachedError`, not a
network or server error:

```ts
export class MutationDetachedError extends Error {
  readonly mutationId: string;
}
```

The error says "this handle no longer owns the pending result", not "the write
failed"; a UI should not show a failure toast for it. It does **not** clear
persisted entries:

- the handle is a view over a mutation definition, not the owner of the user's
  accepted writes;
- a component can be destroyed by navigation while the write is still valid;
- the next session or next handle can replay the entry.

If the write must not happen, remove it explicitly before destroying the handle.
This is the sharp edge of treating the queue as the application's outbox. An
application that really wants to cancel pending writes uses `queue.remove(id)` or
`queue.clear()`. This is a documented semantic difference from 0.2.0, where
`destroy()` also drained the in-memory queue.

### 13.3 Concurrency modes

- `parallel`: multiple calls are accepted, each gets its own entry, global FIFO
  still serializes their replay. This is a deliberate change from in-memory
  parallel dispatch when the queue is non-empty.
- `exhaust`: a second `run()` returns the in-flight promise, so only one entry
  exists. Unchanged.
- `switch`: the previous call is cancelled and its entry removed. This is **not
  allowed with persistence**: the previous write may already have reached the
  server, so cancelling it contradicts the outbox guarantee. The public type
  should exclude `{ concurrency: 'switch'; persistence: ... }` where possible; dev
  mode throws, and production disables persistence for that mutation and warns.
  An application that needs switch-like behavior must use a non-persistent
  mutation.

## 14. Cross-tab ownership

Two tabs reading the same queue can replay the same entry. The idempotency key
is the last line of defence, but duplicate network traffic and duplicate
duplicate-detection work are still bad. V1 uses a single-writer model.

### 14.1 Web Locks

When `navigator.locks` is available, the queue acquires an exclusive lock named
after the storage key:

```ts
navigator.locks.request(`ng-signal-request:mutation-queue:${key}`, async () => {
  // must stay pending until this tab releases ownership; replay and write here
});
```

The callback must not resolve while the tab owns the queue. The browser releases
the lock when the tab closes or crashes. A second tab reports `owner: false`
while the lock is held and disables durable persistence. It may retry
acquisition on `queue.resume()`; if it acquires the lock later, it re-reads the
storage snapshot before replaying, because its in-memory view may be stale.

### 14.2 Fallback

If Web Locks are unavailable, the default is to **disable durable persistence**
(`enabled: false`) and fall back to the 0.2.0 in-memory path. An application that
knows it has a single tab can opt in with `assumeSingleTab: true`; dev mode still
warns loudly and the owner signal is required in the UI.

This is deliberately stricter than "assume one tab". Idempotency is the last line
of defence, not the first. A lease (`owner.id`, `heartbeatAt`, takeover after a
timeout) is rejected for v1: it cannot be made atomic with a plain storage
snapshot, and a lease without an atomic claim can still produce two owners.

### 14.3 Non-owner tabs

A non-owner tab, or a tab with no Web Locks and no `assumeSingleTab` opt-in:

- does not replay;
- does not write the queue snapshot;
- reports `owner: false` and `enabled: false` for durable persistence;
- falls back to the 0.2.0 in-memory queue for its own calls.

Calls this tab accepted while it was a non-owner are in memory only; they are
not retroactively written when ownership changes. A reload before it acquires
ownership loses them. This is the cost of keeping a single writer without item
2's handoff.

A dev warning explains why. Item 2 can add a BroadcastChannel handoff or a
per-entry IndexedDB claim. Neither is in this design.

## 15. Versioning, migration and corruption

The cache snapshot drops mismatched versions because cached data is disposable
(`persist/persist.ts:305-327`). A queue must not do that.

### 15.1 Envelope version mismatch

If `snapshot.version !== MUTATION_QUEUE_VERSION`:

1. call `migrate(snapshot, fromVersion)` if provided;
2. if it returns a valid current snapshot, continue;
3. if it returns `null`, throws or returns an invalid shape, **quarantine the
   whole queue**.

Quarantine means:

- `enabled` becomes `false`;
- no replay and no new queue writes; an online call falls back to the in-memory
  path, or the application can treat `enabled` as a hard gate;
- `entries` exposes the readable entries if possible;
- `queue.clear()` is the explicit way to discard;
- a dev error names the storage key and the version.

The raw payload can be exported by the application for support. The library
does not overwrite it with an empty snapshot.

### 15.2 Buster mismatch

`buster` is the application's statement that the args mean something different.
A mismatch is treated like a version mismatch: quarantine, do not replay, do not
silently drop. The application can call `queue.clear()` after deciding that the
old writes are obsolete.

This is stricter than cache persistence on purpose. A stale cache entry costs a
refetch; a dropped queue entry costs a user's work.

### 15.3 Per-entry version mismatch

Each entry has its own `version`. If it differs from the registered handler's
version:

- call `migrateEntry(entry, fromVersion)` if provided;
- otherwise mark the entry `quarantined` and stop later entries;
- the UI can show the quarantined entry and offer `remove` to unblock;
- a quarantined entry is never skipped automatically, because a later write may
  depend on it.

`migrateEntry` is deliberately separate from the envelope migration: the
envelope is the library's shape, the entry version is the application's args
shape.

### 15.4 Validation and corruption

The queue is untrusted input. On read:

- `JSON.parse` failure -> quarantine, no overwrite;
- missing `version`/`entries` -> quarantine;
- `entries` not an array -> quarantine;
- an entry with a missing `id`, `key`, `idempotencyKey` or a non-finite `seq` ->
  quarantine that entry; a missing `args` is read as `undefined` and validated by
  the registered codec, not by the storage layer;
- an unknown `state` -> `quarantined`;
- a non-string `lane`, when present -> `quarantined`;
- duplicate `id` or duplicate `seq` -> keep the first, quarantine the rest.

A quarantined entry blocks later entries; it is not skipped automatically.
Removing it is the explicit unblock, just as with a failed head under
`stopOnFailure: true`.

No persisted field is ever evaluated as code.

## 16. Security and storage limits

The queue can contain personal data. It is stored in the same origin and is
readable by any script on that origin.

Rules:

- **Never persist headers or auth tokens.** The builder and the global header
  function run again at replay time. This is why the request is rebuilt rather
  than stored.
- **Never persist `onMutate` context by default.** It can contain a snapshot of
  a list, a token, a file handle or anything else.
- **Do not persist the cache snapshot inside the queue.** The queue has its own
  key and its own buster.
- **Offer `clear()` on logout.** An application should call it next to
  `CACHE_PERSISTER.clear()` when cache persistence is also installed.
- **Document the XSS exposure.** Encryption at rest with a key in the same
  origin is not a meaningful defence against XSS; the library should not imply
  that it is.
- **Validate and cap.** `maxEntries` defaults to 100. A full queue rejects the
  new call before the optimistic write and emits a `queue-full` event; it never
  evicts a `pending` or `failed` entry silently, because a failed entry is still
  unconfirmed user data. The application may remove `failed` entries itself or
  call `clear()`. A full queue is a policy error, not a storage failure, so
  `degrade` does not turn it into an in-memory write.
- **`assumeSingleTab` is not a lock.** It is an explicit assertion by the
  application, useful only for a single-tab deployment or a test environment.
- **No secrets in `args`.** If a draft contains a token or a password, the queue
  stores it. The codec can redact it, but the application owns that decision.

Quota refusal is a storage failure. With `onStorageError: 'degrade'` (default)
the queue disables itself and the call falls back to the in-memory path; with
`'fail'` the call rejects before optimistic. A `QuotaExceededError` must not take
down the request settle path.

## 17. Integration map

### 17.1 `create-mutation.ts`

| Existing seam                       | Change                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `AcceptedCall` (`45-54`)            | Add an optional `persistedId` and a replay path that reuses `send()` without `onMutate`.      |
| `queue` / `queuedCount` (`193-199`) | Keep as the in-memory fallback; the persistent queue lives in `/persist/queue`.               |
| `replay()` (`211-224`)              | Keep for the no-provider path; the persistent queue owns ordered replay when enabled.         |
| `applyOptimistic` (`302-320`)       | Apply after the durable enqueue, still before dispatch.                                       |
| `prepare` (`341-564`)               | Split request building from dispatch; add `idempotencyKey`, `replay` and `meta` flags.        |
| `hold` (`430-437`)                  | Still the offline hold; also mark the entry's persisted state as waiting.                     |
| `fail` (`498-525`)                  | Classify retryable vs permanent and report to the queue adapter.                              |
| `start` (`588-607`)                 | Run `onMutate`, build, enqueue, then dispatch.                                                |
| `run` (`609-628`)                   | Preserve `parallel` / `exhaust`; reject `switch` with persistence in dev/runtime.             |
| `destroy` (`570-578`)               | Cancel in-flight calls, reject detached promises with `MutationDetachedError`, leave entries. |
| `inject(...)` at construction       | Inject the core queue token; the default is a no-op so the non-persistent path is unchanged.  |

The core should not import `/persist`. It should define a small token and
interface in the core, with a no-op default, the same way `RESTORE_GATE` is a
core token whose implementation lives in `/persist` (`restore-gate.ts:46-54`,
`persist.ts:955`).

### 17.2 `MutationRegistry`

`MutationRegistry` remains a counter registry. It does not become the queue:

- `begin` / `end` still count dispatched calls;
- `hold` / `release` still count offline holds;
- persisted entries that have no handler are not "in flight" and should not make
  `isMutating()` true;
- the queue has its own `pendingCount` / `failedCount` signals.

If a replay is dispatched through a registered handle, it does call
`begin`/`end`, so `isMutating` is true while it is actually on the wire. That is
consistent with the current meaning.

### 17.3 `/persist/queue`

Add a new module, for example `persist/mutation-queue.ts`, exported from a new
`ng-signal-request/persist/queue` entry point:

- `providePersistedMutationQueue(options)`;
- `PersistedMutationQueue` injectable;
- `MUTATION_QUEUE_VERSION`;
- `MutationQueueSnapshot`, `PersistedMutationEntry`,
  `PersistedMutationQueueOptions`, `MutationArgsCodec`;
- `MutationQueueStorage` reuse of `CacheStorage` / `AsyncCacheStorage`;
- `MutationQueueError` and `MutationDetachedError` types.

The queue reuses `indexedDbStorage()` and the `CacheStorage` contract. It should
not implement or replace `RESTORE_GATE`: query fetches must not wait for a
mutation-queue restore, and a queue restore must not be debounced like cache
writes. It may read the existing `RESTORE_GATE` before dispatch (§9.2).

The separate subpath is decided: it keeps `/persist`'s current 3.7 KB gzip
budget from growing for applications that only persist the cache. The provider
surface and storage code must stay out of `/persist`'s barrel export.

### 17.4 `QueryClient`

No new method in v1. The queue is not cache state. The application injects
`PersistedMutationQueue` from `/persist/queue` for a pending-writes UI.

A future `QueryClient` convenience such as `pendingMutations()` would need a
core token and would blur `isMutating`; it is deliberately out of scope.

### 17.5 `types.ts` and public API

Add:

```ts
export interface MutationPersistenceOptions<TArgs> {
  readonly key: string;
  readonly version?: number;
  readonly codec?: MutationArgsCodec<TArgs>;
  readonly idempotencyKey?: (args: TArgs) => string;
  readonly idempotencyHeader?: string | false;
  readonly onRestore?: (args: TArgs, entry: PersistedMutationEntry) => void | Promise<void>;
  readonly isAlreadyApplied?: (error: Error) => boolean;
}

export interface MutationHookMeta {
  readonly replayed: boolean;
}

export class MutationDetachedError extends Error {
  readonly mutationId: string;
}

export interface MutationOptions<T, TArgs, TContext> {
  // ...
  readonly persistence?: MutationPersistenceOptions<TArgs>;
  readonly onSuccess?: (
    response: T,
    args: TArgs,
    context: TContext | undefined,
    meta?: MutationHookMeta,
  ) => void;
  readonly onError?: (
    error: Error,
    args: TArgs,
    context: TContext | undefined,
    meta?: MutationHookMeta,
  ) => void;
  readonly onSettled?: (
    args: TArgs,
    context: TContext | undefined,
    meta?: MutationHookMeta,
  ) => void;
}
```

The existing settle-hook signatures already use `TContext | undefined`; that
must not be narrowed. `meta` is an optional final argument for existing callers,
so old callbacks remain assignable. A first call passes `{ replayed: false }`; a
replay passes `{ replayed: true }`.

The `switch` + persistence combination should be a compile-time error where
TypeScript can express it:

```ts
type MutationOptionsFor<T, TArgs, TContext> =
  | (BaseMutationOptions<T, TArgs, TContext> & {
      concurrency?: 'parallel' | 'exhaust';
      persistence?: MutationPersistenceOptions<TArgs>;
    })
  | (BaseMutationOptions<T, TArgs, TContext> & {
      concurrency: 'switch';
      persistence?: never;
    });
```

If the inference cost is unacceptable, the runtime dev throw and production
disable/warn remain mandatory. The core queue token, handler interface and
`MutationDetachedError` belong in `public-api.ts`; the queue implementation stays
in `/persist/queue`.

## 18. Test strategy

### 18.1 Unit tests

- Envelope serialization / parsing, version gate, `buster`, `migrate`,
  `migrateEntry`, quarantine.
- Corrupt JSON, wrong shape, duplicate ids, duplicate seq, unknown state.
- Codec success and failure, including a `Date` / `Map` case.
- Argument serialization rejects non-JSON values before optimistic/network.
- Stable id and idempotency key generation; `crypto.randomUUID` fallback.
- Header precedence: builder header, global header, option header, stored key.
- `maxEntries`, queue-full rejection, `queue-full` event, no eviction of
  `failed` entries, `onStorageError` policies.
- FIFO ordering, `seq` ties, new-call append, `resume`, `pause`, `retry`,
  `remove`, `clear`, reserved `lane` round-trip.
- Failure table: network/offline, timeout with and without a header, 401/403,
  409 with `isAlreadyApplied`, 408/425/429/5xx, other 4xx.
- Backoff, `nextAttemptAt` survives a reload, `maxAttempts` exhaustion.
- `stopOnFailure: true` (default) stops; `false` continues.
- `eager` constructs root services; a missing head handler warns after
  `noHandlerWarnAfterMs` and remains blocked.
- `cancel()` removes; `destroy()` preserves and rejects with
  `MutationDetachedError`; `switch` + persistence throws in dev and disables
  persistence in production.
- `onMutate` rejection persists nothing; builder rejection persists nothing.
- Optimistic applies after enqueue and is not reapplied on replay.
- `onRestore` runs once after hydration and restore, before replay, and its
  failure does not block replay.
- `context: undefined` and `meta.replayed: true` on replay hooks; first-call
  hooks receive `meta.replayed: false`.
- `invalidates` with keys; a handle target after reload fails safely.
- Ownership: Web Locks present, absent, second tab, takeover, non-owner
  fallback, `assumeSingleTab` opt-in.
- Storage: IndexedDB default, localStorage fallback, no-storage disable.
- SSR: no storage, no listeners, no timers, no replay.

### 18.2 Integration tests

Use a fake `OnlineManager`, `HttpTestingController` and both a synchronous
in-memory `CacheStorage` and a promise-based one:

1. Run offline with persistence. Assert the storage snapshot exists before the
   request is attempted, the optimistic value is visible, and `run()` is pending.
2. Create a second injector over the same storage. Assert it hydrates, registers
   a handler, replays in order, and removes the entry on success.
3. Assert the replayed request carries the same idempotency key as the first
   attempt.
4. A failed replay keeps the entry and updates `attempts` / `lastError`.
5. A 401 pauses and sets `needsAuth`; `resume()` after auth sends.
6. A permanent 4xx marks `failed` and stops by default; `stopOnFailure: false`
   continues.
7. A 409 on replay with `isAlreadyApplied` removes the entry and invalidates;
   without the hook it stays failed.
8. A reload before the queue removal replays once and the server deduplicates.
9. A corrupted snapshot blocks, does not overwrite, and `clear()` recovers.
10. Two queue instances over one storage with a fake lock: only one owner
    replays; without Web Locks, durable persistence is disabled by default.
11. `eager` services register before auto-replay; a missing handler blocks and
    warns.
12. `onRestore` reapplies the app-owned pending row after reload.
13. No provider: the full existing mutation suite is unchanged.

### 18.3 Browser e2e

Extend `e2e/offline.spec.ts` with a real-browser durable path:

1. Go offline.
2. Submit a todo.
3. Assert the optimistic row and the pending marker.
4. Reload the page.
5. Go online.
6. Assert exactly one `POST` (plus any CORS preflight), with a stable
   `Idempotency-Key`, and one row in the list.
7. Repeat with a server that returns the same response for a duplicate key; the
   UI still shows one row.
8. Corrupt the storage key, reload, assert the queue is blocked and the app
   remains usable.
9. Two tabs: assert only the owner replays; the non-owner shows the documented
   fallback.

The e2e mock must count the preflight separately, as the 0.2.0 offline work
already established (`docs/design-0.2.md:1316-1318`).

### 18.4 Static and compatibility checks

- `pnpm verify` (typecheck, lint, unit, coverage, API check, dist check).
- `pnpm check:types-compat` for the existing public surface.
- A new compile-time fixture for `persistence`, `onRestore`,
  `isAlreadyApplied`, the optional `meta` hook argument, and the queue service.
- A negative type fixture proving `{ concurrency: 'switch'; persistence: ... }`
  is rejected, or a documented fallback if the union harms inference.
- A dist check proving `/persist` does not import `/persist/queue`, and that the
  new subpath is tree-shakeable.
- Bundle budget update only after measurement; no budget is changed by this
  document.
- Prettier check on this document and all touched docs.

## 19. Rollout and compatibility

### 19.1 Release shape

- Additive and opt-in.
- **0.3.0 is reserved for the `retryTimeouts` default change.** The durable queue
  is a separate `0.4.0` candidate and should be labelled experimental until the
  server-side idempotency contract is proven.
- No change to the default `networkMode` (`'always'`).
- No change to `createMutation` without `persistence` and without the provider.
- No change to the Angular peer dependency range.
- No change to existing bundle budgets in this document; the new subpath is
  measured before it lands.
- No new runtime dependency. `crypto.randomUUID` and Web Locks are browser
  APIs, feature-detected.
- The repo manifest version stays `0.1.0`; the release workflow derives the
  published version from the tag. This document does not change that.
- No tag, publish or release-state change is part of this task.

### 19.2 Documentation changes required before shipping

- README: replace the "offline mutation queue does not survive a reload" known
  limitation with the opt-in durable queue and its boundaries.
- README: document the idempotency contract, that the library cannot verify the
  server honours the header, the single-owner limitation, `assumeSingleTab`, the
  non-JSON body limitation, `stopOnFailure: true`, and the optimistic-state and
  `onRestore` decisions.
- README: document that the queue defaults to IndexedDB, unlike the cache
  persister's localStorage default.
- README: document `isAlreadyApplied` and the replay-only `409` policy.
- README: document that settle hooks receive `context: TContext | undefined` and
  `meta.replayed`, and that `switch` is incompatible with `persistence`.
- `docs/design-0.2.md`: add a short pointer from the Phase 2 non-goal to this
  document; do not rewrite the historical record.
- `docs/missing-features.md`: update item 1 only after the feature ships; the
  document is an inventory, not a roadmap.
- `CHANGELOG.md`: add an entry only when the code lands.
- `docs/verification.md`: add the durable-queue test boundary and the
  cross-browser limits.

### 19.3 Rollback

An application can remove `providePersistedMutationQueue` and the `persistence`
options. The code falls back to the 0.2.0 path. Stored entries remain but are
ignored; the application can call `queue.clear()` before removing the provider.
No schema migration is required to roll back. The `/persist/queue` entry point
can be removed without touching `/persist`.

### 19.4 Compatibility with `providePersistedCache`

The two providers are independent to configure, with one ordering requirement:

- queue replay waits for `RESTORE_GATE.restored()` before dispatch, so a replay's
  `invalidates` cannot race a cache restore; the gate is idle when no cache
  persister is installed;
- `persistence.onRestore` runs after the same gate and before replay, so it can
  reapply application-owned pending UI on top of a restored snapshot;
- cache restore does not gate a mutation's initial enqueue: a write made while
  the cache is restoring is durably stored immediately;
- a replay's `invalidates` goes through the normal `QueryClient` coalescing;
- the queue and the cache can use the same `indexedDbStorage()` factory or
  different databases/stores.

### 19.5 Bundle impact

The core adds a token, the option type and the enqueue/replay branch. The queue
implementation and storage live in the new `/persist/queue` entry point, so
`/persist` itself keeps its current 3.7 KB gzip budget for cache-only users. The
measurement is an implementation gate, not a budget change made by this document.

## 20. Decisions

These are settled for the design. Implementation details follow.

1. **API name.** `persistence.key` stays, as a plain `string`. It is the identity
   of the mutation definition, not `mutationKey` and not a query key. The
   per-call identity is the entry `id`.
2. **Handler registration.** `providePersistedMutationQueue({ eager: [...] })`
   injects root services in an environment initializer so their handles register
   before auto-replay. After `noHandlerWarnAfterMs` (default 5 seconds), dev mode
   warns and emits `blocked: 'no-handler'`; the entry stays pending.
3. **FIFO and lanes.** V1 remains global FIFO. `stopOnFailure` defaults to `true`,
   so a permanent failure stops later entries. Entries carry an optional
   `lane?: string`; it is unused in v1 and does not need a migration. When lanes
   ship, a failure blocks only its own lane.
4. **Cross-tab.** Web Locks single owner is enough for v1. If Web Locks is
   unavailable, durable persistence is disabled (`enabled: false`) rather than
   assumed single-tab; `assumeSingleTab: true` is an explicit opt-in. Non-owner
   writes are in-memory and can be lost on reload. Idempotency is the last line
   of defence, and `owner` plus a dev warning are mandatory UI signals.
5. **Optimistic restore.** Automatic restore stays out of v1.
   `persistence.onRestore(args, entry)` runs after hydration and the cache
   restore gate, before replay, so the application can reapply its own pending
   UI. It does not serialize targets or undo closures.
6. **`409`.** `persistence.isAlreadyApplied(error)` is a per-mutation hook,
   default `false`, consulted only on replay. A true result removes the entry and
   invalidates; a first-attempt `409` stays a failure.
7. **Queue full.** Reject the new call before the optimistic write, never evict
   `pending` or `failed`, and emit `queue-full`. A full queue is a policy error,
   not a storage failure.
8. **Storage default.** IndexedDB first, `localStorage` fallback, disable if
   neither. This differs from `createPersister`; `run()` is already async with
   persistence, so the default does not add a new latency contract.
9. **Subpath.** `ng-signal-request/persist/queue`. Keep the provider and storage
   code out of `/persist`, whose 3.7 KB gzip budget is for cache-only users.
10. **Context.** Replay passes `context: undefined`; the existing settle-hook
    types already accept `TContext | undefined` (`types.ts:1161-1165`), so no
    conditional narrowing is needed. Add an optional final
    `meta: { replayed: boolean }` argument; existing callbacks stay assignable. A
    context codec is not v1.
11. **Timeout retry.** Keep the table: retry with an idempotency header, fail
    without one. Document it in the same language as the `0.3.0`
    `retryTimeouts` change. README must state that the library cannot verify
    server-side header support.
12. **`switch`.** Dev throws; the public type should exclude `switch` +
    `persistence` where possible; production disables persistence for that
    mutation and warns. A canceled write may already have reached the server.
13. **Release.** `0.3.0` is only the `retryTimeouts` change. The queue is a
    `0.4.0` candidate, experimental until the server contract is proven.
14. **Detach.** `destroy()` rejects a current-page queued promise with
    `MutationDetachedError`, not a network failure; the durable entry remains. A
    true cancel is `queue.remove(id)`.

### 20.1 Remaining implementation details

- Exact TypeScript shape of the `switch` exclusion if the `BaseMutationOptions`
  union causes inference costs.
- IndexedDB availability probe and fallback timing.
- Re-export location for `MutationDetachedError`: it is defined in core and
  re-exported by `/persist/queue` for consumers of the queue service.

## 21. Rejected alternatives

### 21.1 Put the queue in the cache snapshot

Rejected. The cache snapshot is disposable. Its version/buster mismatch policy
drops data, which is correct for cached responses and wrong for accepted writes.
The two also have different write triggers, sizes and recovery stories.

### 21.2 Persist the raw HTTP request

Rejected. It would store auth headers, include non-serializable bodies, ignore a
refreshed token, and bypass the builder, `parse`, `invalidates` and the handle
signals. A raw request is a second, worse mutation implementation.

### 21.3 Persist only `mutationKey`

Rejected. `mutationKey` is optional and not unique. It cannot identify a
handler or distinguish two calls of the same mutation.

### 21.4 Re-run `run()` after reload

Rejected as the default. It would run `onMutate` and `optimistic` again, possibly
double-applying a cache-persisted value, and it would need a context that was
never serialized. The replay path is explicit and skips both.

### 21.5 Replay without idempotency keys

Rejected. A POST that reached the server before the reload would be applied
twice. The queue cannot detect that from the browser. At-least-once without a
key is not a safe default for writes.

### 21.6 Service-worker Background Sync as the implementation

Rejected for this feature. It is an application-level delivery mechanism, not a
library queue. It does not solve the handler registration, optimistic state or
server idempotency contract, and it would add a service-worker lifecycle the
library does not own.

### 21.7 Put the queue in `MutationRegistry`

Rejected. `MutationRegistry` is a counter registry. Making it own entries,
storage, ownership and replay would turn a small core injectable into a second
cache with a different lifecycle.

### 21.8 Per-tab, per-handle persistence only

Rejected. It would preserve the existing per-handle order but give no global
pending-writes view and no cross-handle ordering. The durable outbox is a global
feature; per-handle storage is a smaller feature that would need to be replaced
later.

## 22. Acceptance criteria

This design is implementable when all of the following are true:

1. The `persistence` option and the `/persist/queue` provider are documented and
   opt-in.
2. A persisted entry survives a reload and replays in FIFO order through the
   registered handler.
3. The first send and every replay use the same idempotency key.
4. A successful replay removes the entry; a retryable failure keeps it; a
   permanent failure keeps it as `failed` and stops later entries by default.
5. A corrupt or version-mismatched queue quarantines instead of deleting.
6. A missing handler leaves the entry pending, not failed; `eager` registration
   works and a stuck head produces the dev warning.
7. A second tab does not replay the same queue when Web Locks are available;
   without Web Locks the durable queue is disabled unless `assumeSingleTab` is
   explicitly set.
8. No auth header, closure or `onMutate` context is written to storage.
9. The queue does not automatically reapply optimistic state after a reload;
   `onRestore` can reapply application-owned pending UI, and the documentation
   explains that a cache snapshot may still restore the value.
10. The no-provider path passes the existing mutation suite unchanged.
11. Unit, integration and browser e2e coverage covers success, transient
    failure, permanent failure, auth pause, queue-full, `409` /
    `isAlreadyApplied`, `onRestore`, cancellation, detach, corruption, ownership
    and the reload/replay duplicate case.
12. `switch` + persistence is rejected in dev and cannot silently cancel a
    durable write in production.
13. `/persist` keeps its existing budget; `/persist/queue` is measured before it
    lands.
14. `0.3.0` remains the `retryTimeouts` release; the queue lands in `0.4.0` or
    later, labelled experimental.

## 23. Evidence index

- `projects/signal-request/src/lib/create-mutation.ts` - the in-memory queue,
  `hold`, `replay`, optimistic undo, settle hooks, `run`, `destroy`.
- `projects/signal-request/src/lib/cache/mutation-registry.ts` - counts only.
- `projects/signal-request/src/lib/types.ts` - `MutationOptions`,
  `networkMode`, `mutationKey`, `onMutate`, `optimistic`, `SignalMutation`,
  `concurrency` and the settle-hook context signatures (`1031-1165`).
- `projects/signal-request/src/lib/cache/query-client.ts` - `isPaused`,
  `isAnythingPaused`, `isMutating`, `mutatingCount`.
- `projects/signal-request/src/lib/cache/query-cache.ts` - `seed`, entry
  creation, restore ordering.
- `projects/signal-request/src/lib/cache/cache-entry.ts` - `local`, `setData`,
  `restore` and entry timestamps.
- `projects/signal-request/persist/persist.ts` - `CacheSnapshot`,
  `CacheStorage`, `AsyncCacheStorage`, `createPersister`,
  `providePersistedCache`, IndexedDB storage.
- `README.md` - "Known limitations" (offline queue), "Offline", "Persistence
  across reloads", "Compared with TanStack Query", public exports.
- `docs/design-0.2.md` - Phase 2 offline semantics, the persisted-queue
  non-goal, Phase 3 persistence constraints, Step B2 browser findings.
- `docs/missing-features.md` - item 1 and the surrounding inventory.
- `e2e/offline.spec.ts` - the current real-browser offline coverage.
