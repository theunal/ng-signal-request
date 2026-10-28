# The idempotency contract

> **Scope.** This is the contract between `ng-signal-request/persist/queue` and the server an
> application writes to. The queue is an **at-least-once** outbox: a call can be sent more than
> once - after a retry, after a reload, from another tab, or from the application's service worker.
> Exactly-once is only reachable when the server deduplicates. This document states what each side
> has to do, what the library can prove, and what it cannot.
>
> **Audited revision.** Repository `226787c` plus the non-owner work described in
> `docs/design-offline-mutation-queue.md` §14.3; npm release `0.2.0` does not contain the queue.
>
> **Sources.** `projects/signal-request/src/lib/create-mutation.ts` (key minting, retry policy),
> `projects/signal-request/persist/queue/queue.ts` (entry storage, replay),
> `projects/signal-request/persist/queue/sw/sw.ts` (worker replay),
> `projects/signal-request/persist/queue/idempotency.spec.ts` and `e2e/queue.spec.ts` (the proofs).

## 1. What the library guarantees

A persisted call has **one** idempotency key for its whole life. It is minted before the first
request is built, stored in the queue entry, and reused verbatim:

| Path                                    | What it sends                                                              |
| --------------------------------------- | -------------------------------------------------------------------------- |
| First attempt                           | `Idempotency-Key: <minted>` (or the application's key, or a caller header) |
| Same-page retry after a 503/timeout     | the same key - the retry re-subscribes to the same prepared request        |
| Replay after a reload                   | `entry.idempotencyKey` from storage                                        |
| Replay from another tab                 | `entry.idempotencyKey` from storage                                        |
| Replay from the service worker          | `context.idempotencyKey`, which is `entry.idempotencyKey`                  |
| Replay after a `retry()` / `retryAll()` | the same key; a manual retry is not a new write                            |

The key is a UUID (`crypto.randomUUID`), so two independent calls never collide by accident. An
application that wants _two different calls_ to be the same write - a double-tapped "save", or a
retry the application starts itself - supplies `persistence.idempotencyKey(args)` and returns the
same string for the same logical payload.

`persistence.idempotencyHeader` renames the header. `false` disables it, and that is a real
trade-off, not a preference: without a key the queue refuses to retry an **ambiguous** failure,
because a retry could apply the write twice (§4).

## 2. What the server has to do

1. **Read the header.** Default `Idempotency-Key`; the application may rename it. Missing header
   means "no dedupe requested" - treat the request as a normal write.
2. **Scope the key.** Deduplicate per `(account or tenant, endpoint)` or globally; either is fine,
   as long as one key never means two different writes. Do not scope by connection or session.
3. **Persist the key and its outcome in the same transaction as the effect.** A key written after
   the effect leaves a window where a crash applies the write twice; a key written before it but
   not rolled back on failure turns a failed write into a permanent `409`.
4. **A repeat returns the stored outcome**, not a second effect: same status, same body where the
   body matters to the client. A repeat that arrives while the first is still in flight must either
   wait for it or answer `409`/`425` - both are handled by the client (§4).
5. **Keep the key long enough.** The queue keeps an entry until it is delivered, and an entry can
   survive a laptop that is offline for days. A TTL shorter than that window silently turns a
   replay into a second write. One week is a safe default; a day is the minimum worth documenting.
6. **Reject a reused key with a different payload** (`409` or `422`) instead of applying it. That
   is the only signal that catches an application-minted key colliding with itself.
7. **Never deduplicate on the body.** Two genuine writes can be identical - "add 1 to the counter"
   twice is not a duplicate.

### The one thing to get right

The effect and the key must commit together. Everything else in this document is a consequence of
that sentence.

## 3. What the library cannot do

- It cannot verify that the server honours the header. There is no handshake for it, and a server
  that ignores `Idempotency-Key` looks exactly like one that does not.
- It cannot make a non-idempotent endpoint safe. `POST /orders` with a generated id is idempotent
  by construction; `POST /orders` with a server-generated id is not, and no header fixes that
  unless the server stores the key.
- It cannot undo a duplicate. The queue's own replay path is single-writer (Web Locks, §14 of the
  design document), but a duplicate is still possible when a tab that does not own replay is
  mid-flight and the owner adopts the same entry. The key is what makes that harmless.

## 4. Failure classification, as implemented

The queue only retries what the contract makes safe. `idempotencyHeader` here means "the request
carries a key".

| Failure                            | Key present         | Key absent (`false`) |
| ---------------------------------- | ------------------- | -------------------- |
| Offline (`navigator.onLine` false) | retry               | retry                |
| Network error while online         | permanent           | permanent            |
| Timeout                            | retry               | permanent            |
| Aborted                            | retry               | permanent            |
| `408`, `425`, `429`                | retry               | retry                |
| `5xx`                              | retry               | permanent            |
| `401`, `403`                       | pause, ask for auth | pause, ask for auth  |
| anything else (`4xx`)              | permanent           | permanent            |

A permanent failure keeps the entry (`state: 'failed'`) and never drops it: the application decides
whether to `retry(id)`, `remove(id)` or `clear()`.

`persistence.isAlreadyApplied(error)` is the replay-only `409` policy. A first attempt that answers
`409` is a failure; a replay that answers `409` is a success when the application says so, because
the first attempt was applied and its response was lost. This is the one place where the client has
to be told what the server's dedupe response looks like.

## 5. Verifying your server

The proof has two halves, and the client half is already in the repository.

**Client half (automated).** `projects/signal-request/persist/queue/idempotency.spec.ts` asserts
that the same key is used for the first attempt, every retry, a reload replay and a worker replay,
and that `idempotencyHeader: false` turns an ambiguous failure permanent. `e2e/queue.spec.ts`
asserts the same against a real browser and a dedupe-aware mock endpoint.

**Server half (manual, once per endpoint).** Send the same request twice with one key:

```bash
curl -sS -X POST https://api.example.com/todos \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7b1f0f9e-2b4b-4f0e-9c62-0f3a1d5a1f11' \
  -d '{"title":"only once"}'

curl -sS -X POST https://api.example.com/todos \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 7b1f0f9e-2b4b-4f0e-9c62-0f3a1d5a1f11' \
  -d '{"title":"only once"}'
```

Pass when: the second response is the first response (or a documented `409`), and the database has
one row. Then send a _different_ body with the same key and expect a rejection - that is the check
that catches a dedupe layer which only compares keys.

## 6. What this buys, and what it does not

With the contract honoured, a write made offline in a tab that was closed, replayed by another tab,
retried three times and finally delivered by a service worker lands exactly once. Without it, the
same sequence lands as many times as it was sent - the queue's durability is not the problem, the
endpoint is.

The queue stays labelled **experimental** until an application has run this contract against a real
backend and recorded the outcome; the library's own tests can only prove the client half.
