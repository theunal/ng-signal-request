import {
  HttpClient,
  HttpEventType,
  HttpHeaders,
  type HttpEvent,
  type HttpProgressEvent,
  type HttpResourceRequest,
} from '@angular/common/http';
import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  ErrorHandler,
  inject,
  Injector,
  isDevMode,
  runInInjectionContext,
  signal,
  untracked,
} from '@angular/core';
import { retry, throwError, timer, type Observable, type Subscription } from 'rxjs';
import { SIGNAL_REQUEST_CONFIG } from './config';
import { reportedOffline, resolveConnectivity, type NetworkMode } from './connectivity';
import { QueryCache } from './cache/query-cache';
import { MutationRegistry } from './cache/mutation-registry';
import { QueryClient } from './cache/query-client';
import {
  MutationDetachedError,
  RequestCancelledError,
  toError,
  toRequestError,
  type RequestErrorView,
} from './errors';
import {
  MUTATION_QUEUE,
  MutationQueueQuarantineError,
  type MutationQueueHandler,
  type PersistedMutationEntry,
} from './mutation-queue';
import type { QueryKey } from './cache/key';
import {
  type MutationArgsCodec,
  type MutationHookMeta,
  type MutationOptions,
  type MutationStatus,
  type OptimisticTarget,
  type RequestValue,
  type RunResult,
  type SignalMutation,
  type InvalidationTarget,
} from './types';
import { nextRetryDelay, noop, normalizeRetry, resolveRequest, withGlobalHeaders } from './utils';

/**
 * The handle a mutation keeps for one accepted call.
 *
 * It exists so a call that is waiting for a connection can be sent later, from a stack that no
 * longer has the `run()` frame that accepted it — without a second copy of the send/cancel logic.
 * Everything else (the request, the stream, the optimistic undo, the settle handlers) stays in the
 * closure that created it.
 */
interface AcceptedCall {
  /** Subscribes the request. Called at `run()` when online, and once per replay. */
  send(): void;
  /** Rejects with `RequestCancelledError` and rolls the optimistic write back. */
  cancel(): void;
  /** Stops waiting for a connection without sending. Idempotent. */
  release(): void;
  /** `true` while the call is waiting for a connection. */
  paused: boolean;
}

interface MutationFactory {
  <T = unknown, TArgs = void, TContext = undefined>(
    request: (args: TArgs) => RequestValue,
    options?: MutationOptions<T, TArgs, TContext>,
  ): SignalMutation<T, TArgs, TContext>;
}

/** What a call that belongs to the durable outbox needs beyond an ordinary accepted call. */
interface DurableCall {
  readonly entry: PersistedMutationEntry;
  readonly replayed: boolean;
  /**
   * `true` when the queue, not the `run()` stack, awaits the promise. A replay has no caller to
   * settle and lets the queue classify the rejection.
   */
  readonly queueManaged: boolean;
  /** The queue had older work, so this call waits for the queue's retry hook. */
  readonly deferred: boolean;
}

const JSON_ARGS_CODEC: MutationArgsCodec<unknown> = {
  serialize(value) {
    if (value === undefined) return undefined;
    const raw = JSON.stringify(value) as string | undefined;
    if (raw === undefined) {
      throw new Error(
        'Mutation persistence needs JSON-serializable args; pass `persistence.codec` for anything else.',
      );
    }
    return JSON.parse(raw) as unknown;
  },
  deserialize(value) {
    return value;
  },
};

function newIdempotencyKey(): string {
  const crypto = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (array: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  if (crypto?.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // RFC 4122 version 4, so the value is a UUID rather than 16 random bytes with a prefix.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
      16,
      20,
    )}-${hex.slice(20)}`;
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function readHeader(headers: HttpResourceRequest['headers'], name: string): string | null {
  if (headers instanceof HttpHeaders) return headers.get(name);
  if (headers === undefined) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[]>)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

function withHeader(
  headers: HttpResourceRequest['headers'],
  name: string,
  value: string,
): HttpHeaders {
  const normalized =
    headers instanceof HttpHeaders ? headers : new HttpHeaders(headers as Record<string, string>);
  return normalized.set(name, value);
}

/**
 * The bare `createMutation` is a `POST`; `.post` / `.put` / `.patch` / `.delete` pick another
 * verb. It never comes from a `method` field in the builder.
 */
export interface CreateMutation extends MutationFactory {
  post: MutationFactory;
  put: MutationFactory;
  patch: MutationFactory;
  delete: MutationFactory;
}

/** A function whose `name` is shown by Angular in "must be called in an injection context" errors. */
function named(name: string): () => void {
  const fn = (): void => {};
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

function mutationFactory(label: string, method: string): MutationFactory {
  return (request, options = {}) => buildMutationFactory(method, request, options, named(label));
}

function buildMutationFactory<T, TArgs, TContext>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs, TContext>,
  caller: () => void,
): SignalMutation<T, TArgs, TContext> {
  let injector = options.injector;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () =>
    buildMutation<T, TArgs, TContext>(method, request, options),
  );
}

const POST = /*#__PURE__*/ mutationFactory('createMutation', 'POST');

/**
 * Creates an imperative write operation with signal state.
 *
 * Unlike `createRequest` it is never reactive and never fires on its own – you call `run(args)`.
 * It talks to `HttpClient` directly, because `httpResource` is meant for reads (it is eager and
 * cancels the previous request, which is not what you want for writes).
 *
 * The bare call is a `POST`; pick another verb with `.put` / `.patch` / `.delete`.
 *
 * @example
 * ```ts
 * // The args double as a params bag, so the builder can stay a bare url:
 * // `path` fills the placeholder, `body` becomes the request body.
 * readonly save = createMutation.put<User, { path: { id: number }; body: Partial<User> }>(
 *   () => '/users/:id',
 *   { invalidates: () => [this.users], concurrency: 'exhaust' },
 * );
 * await this.save.run({ path: { id: 1 }, body: { name: 'Ada' } });
 * // → PUT /users/1   body: {"name":"Ada"}
 * ```
 */
/* The `as CreateMutation` below is not redundant: without it `Object.assign` would infer the
   intersection of `POST` and the object literal, and `createMutation`'s public type would be that
   intersection rather than the documented interface. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
export const createMutation: CreateMutation = /*#__PURE__*/ Object.assign(POST, {
  post: /*#__PURE__*/ mutationFactory('createMutation.post', 'POST'),
  put: /*#__PURE__*/ mutationFactory('createMutation.put', 'PUT'),
  patch: /*#__PURE__*/ mutationFactory('createMutation.patch', 'PATCH'),
  delete: /*#__PURE__*/ mutationFactory('createMutation.delete', 'DELETE'),
}) as CreateMutation;

function buildMutation<T, TArgs, TContext>(
  method: string,
  request: (args: TArgs) => RequestValue,
  options: MutationOptions<T, TArgs, TContext>,
): SignalMutation<T, TArgs, TContext> {
  const http = inject(HttpClient);
  const config = inject(SIGNAL_REQUEST_CONFIG);
  const errorHandler = inject(ErrorHandler);
  const cache = inject(QueryCache);
  const mutations = inject(MutationRegistry);
  /**
   * Only used when `invalidates` is given a key. Injected unconditionally so that a mutation
   * built without one still behaves identically — `inject()` here resolves from the same
   * application injector either way, and there is nothing to lazily.
   */
  const client = inject(QueryClient);
  const retryPolicy = normalizeRetry(options.retry, {
    timeouts: options.retryTimeouts ?? config.retryTimeouts,
  });
  const concurrency = options.concurrency ?? 'parallel';
  const networkMode: NetworkMode = options.networkMode ?? config.networkMode ?? 'always';
  const online = resolveConnectivity(networkMode, false);

  const persistedQueue = inject(MUTATION_QUEUE, { optional: true });
  let persistence = options.persistence;
  if (persistence !== undefined) {
    if (persistence.key.trim() === '') {
      throw new Error('createMutation: `persistence.key` must be a non-empty string.');
    }
    if (concurrency === 'switch') {
      const message =
        'createMutation: `concurrency: "switch"` cannot be combined with `persistence`; ' +
        'a superseded write would still have to reach the server. Persistence is disabled.';
      if (isDevMode()) throw new Error(message);
      console.warn(message);
      persistence = undefined;
    } else if (networkMode !== 'online') {
      const message =
        'createMutation: `persistence` requires `networkMode: "online"`. Persistence is disabled.';
      if (isDevMode()) console.warn(message);
      persistence = undefined;
    } else if (persistedQueue === null) {
      const message =
        'createMutation: `persistence` requires `providePersistedMutationQueue(...)`. ' +
        'Persistence is disabled.';
      if (isDevMode()) console.warn(message);
      persistence = undefined;
    }
  }
  const persistenceCodec: MutationArgsCodec<TArgs> | undefined =
    persistence === undefined
      ? undefined
      : ((persistence.codec ?? JSON_ARGS_CODEC) as MutationArgsCodec<TArgs>);
  const persistenceVersion = persistence?.version ?? 1;
  const idempotencyHeader =
    persistence?.idempotencyHeader === undefined
      ? 'Idempotency-Key'
      : persistence.idempotencyHeader;
  if (persistence !== undefined && idempotencyHeader === false && isDevMode()) {
    console.warn(
      'createMutation: `persistence.idempotencyHeader: false` cannot protect against a duplicate ' +
        'write. The queue will not retry a timeout or a 5xx, but the server must deduplicate.',
    );
  }

  const response = signal<T | undefined>(undefined);
  const error = signal<Error | undefined>(undefined);
  /**
   * Timeout of the call that produced `error`. A builder may set its own `timeout`, so the
   * option alone is not enough to tell a deliberate timeout from a plain abort.
   */
  const errorTimeout = signal<number | undefined>(undefined);
  /** The same failure as `error`, classified. */
  const requestError = computed<RequestErrorView | undefined>(() => {
    const cause = error();
    if (cause === undefined) return undefined;
    const timeout = errorTimeout();
    return toRequestError(cause, {
      ...(timeout === undefined ? {} : { timeout }),
      offline: reportedOffline(online),
    });
  });
  const args = signal<TArgs | undefined>(undefined);
  /** Whatever the last call's `onMutate` produced. See `MutationOptions.onMutate`. */
  const context = signal<TContext | undefined>(undefined);
  const progress = signal<HttpProgressEvent | undefined>(undefined);
  const inFlight = signal(0);
  const finished = signal<Exclude<MutationStatus, 'loading'>>('idle');

  const status = computed<MutationStatus>(() => (inFlight() > 0 ? 'loading' : finished()));
  const loading = computed(() => inFlight() > 0);

  /**
   * Every accepted call that has not settled, in call order.
   *
   * Queued calls are members too, which is what makes `cancel()` and `switch` treat a call that has
   * not been sent the same way as one that has: it counts towards `isMutating`, it is cancelled the
   * same way, and it settles exactly once.
   */
  const calls = new Set<AcceptedCall>();
  /** Paused calls, oldest first. Its length is what `paused()` reports. */
  const queue: AcceptedCall[] = [];
  const queuedCount = signal(0);
  const paused = computed(() => queuedCount() > 0);
  /** The one reconnect listener a mutation needs, armed while anything is queued. */
  let detachReplay: (() => void) | undefined;
  let exhausted: Promise<T> | undefined;
  let destroyed = false;
  let unregisterQueue: (() => void) | undefined;

  /**
   * Sends everything that was queued when the reconnect arrived, in call order.
   *
   * The queue is drained **by snapshot** rather than by `while (queue.length)`: a send that fails
   * synchronously (a custom backend, a test double) re-queues itself, and a `while` loop would pick
   * it straight back up and spin. Snapshotting also makes the order a fact — `splice` preserves the
   * order the calls were accepted in, which is the order the application made them in.
   */
  const replay = (): void => {
    detachReplay?.();
    detachReplay = undefined;
    // Drained by snapshot: a send that fails synchronously re-queues itself, and a `while` loop
    // would pick it straight back up and spin. Snapshotting also makes the order a fact — `splice`
    // preserves the order the calls were accepted in, which is the order the application made them.
    const batch = queue.splice(0);
    queuedCount.update((n) => n - batch.length);
    mutations.release(batch.length);
    for (const call of batch) {
      call.paused = false;
      call.send();
    }
  };

  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      errorHandler.handleError(e);
    }
  };

  /**
   * A query key is an array; a handle is an object with `reload()`.
   *
   * A hand-written guard rather than a bare `Array.isArray`: the built-in narrows its *true* branch
   * to `any[]` and leaves `readonly unknown[]` in the false branch, so `target.reload()` would not
   * type-check on what is left.
   */
  const isQueryKey = (target: InvalidationTarget): target is QueryKey => Array.isArray(target);

  /** The same discrimination for `target`, which takes a handle or a key. */
  const isKeyTarget = (target: OptimisticTarget<unknown> | QueryKey): target is QueryKey =>
    Array.isArray(target);

  /**
   * Applies `invalidates` after a successful call.
   *
   * Handles are reloaded directly; keys go through `QueryClient`, which invalidates **every**
   * cached entry under that key — not just the one this mutation happens to hold a reference
   * to. That is the whole reason a key is worth accepting here: the list showing the new row is
   * usually a different component from the one holding the mutation.
   */
  const reloadInvalidated = (): void => {
    const list =
      typeof options.invalidates === 'function' ? options.invalidates() : options.invalidates;
    for (const target of list ?? []) {
      if (isQueryKey(target)) client.invalidate(target);
      else target.reload();
    }
  };

  /** The mutation's own `response`, shaped like an `OptimisticTarget` so it needs no special case. */
  const selfTarget: OptimisticTarget<T> = {
    response: response.asReadonly(),
    set: (value: T) => response.set(value),
  };

  /**
   * Resolves `target` to something writable.
   *
   * A key goes through `peek`, never `resolve`: an entry nobody is holding a handle for has no
   * request description, and minting one would leave an orphan that can never fetch and that
   * nothing is subscribed to — so nothing would ever collect it either. Returning `undefined`
   * makes the optimistic write a no-op instead, which is the honest outcome: nobody is looking.
   */
  const resolveTarget = (): OptimisticTarget<T> | undefined => {
    const configured = options.target;
    if (configured === undefined) return selfTarget;
    if (!isKeyTarget(configured)) return configured;
    const entry = cache.peek<T>(configured);
    if (!entry) return undefined;
    // Adapted rather than satisfied directly: an entry stores through `setData`, which also moves
    // its timestamps and clears `invalidated`. Going through it keeps a local write indistinguishable
    // from `setData()` on the handle itself.
    return { response: entry.data, set: (value: T) => void entry.setData(value) };
  };

  /**
   * Writes the optimistic value for one call and returns the undo.
   *
   * The undo is a compare-and-swap: it restores the snapshot only when this call's own value is
   * still what the target holds. Without that guard `concurrency: 'parallel'` would let a failing
   * call wipe the value a sibling call had just written — the rollback would then *introduce* a
   * stale value instead of removing a fake one. Under `exhaust` / `switch` only one call is ever in
   * flight, so the guard always passes and the behaviour is a plain restore.
   *
   * A throwing `optimistic` is reported and the call proceeds without one, rather than taking the
   * whole write down before it was sent.
   */
  const applyOptimistic = (callArgs: TArgs): (() => void) => {
    if (!options.optimistic) return noop;
    const target = resolveTarget();
    if (!target) return noop;
    const snapshot = untracked(target.response);
    let next: T;
    try {
      next = options.optimistic(snapshot, callArgs);
    } catch (e) {
      safe(() => errorHandler.handleError(e));
      return noop;
    }
    target.set(next);
    return () => {
      // `undefined` is restored as-is: there was nothing before, and leaving the invented value
      // up would be the one case where the rollback silently does nothing visible.
      if (untracked(target.response) === next) target.set(snapshot as T);
    };
  };

  const rejected = (reason: Error): Promise<T> => {
    const promise = Promise.reject<T>(reason);
    promise.catch(noop);
    return promise;
  };

  /**
   * Runs `onMutate` and returns the context it produced.
   *
   * Deliberately **before** the optimistic write: a hook that snapshots state wants to see the
   * world as it was, before this call changed anything. A rejection fails the call outright —
   * nothing is sent and nothing was shown — because a preparation that could not run means the
   * call was never really made.
   */
  const runOnMutate = async (callArgs: TArgs): Promise<TContext> => {
    if (!options.onMutate) return undefined as TContext;
    return await options.onMutate(callArgs);
  };

  const launch = (
    callArgs: TArgs,
    ctx: TContext,
    built: NonNullable<ReturnType<typeof resolveRequest>>,
    timeout: number | undefined,
    stream: Observable<unknown>,
    durable?: DurableCall,
  ): Promise<T> => {
    const meta: MutationHookMeta = { replayed: durable?.replayed ?? false };
    const queueManaged = durable?.queueManaged ?? false;
    const activeQueue =
      persistedQueue !== null && persistence !== undefined && durable !== undefined && !queueManaged
        ? persistedQueue
        : undefined;
    const activeEntryId = durable?.entry.id;

    inFlight.update((n) => n + 1);
    args.set(callArgs);
    context.set(ctx);
    error.set(undefined);
    progress.set(undefined);
    mutations.begin(options.mutationKey);

    // The state flips synchronously on `online`, but the reconnect is announced in a microtask. A
    // `run()` that lands in that window must not overtake writes that were made earlier, so the
    // queue is drained before this call is sent.
    if (queue.length > 0 && online.online()) replay();

    const promise = new Promise<T>((resolve, reject) => {
      let settled = false;
      // Read by `call.cancel`, assigned by `send`. The initializer is what keeps `prefer-const` from
      // asking for a binding it cannot have.
      let subscription: Subscription | undefined = undefined;
      /** Undoes this call's optimistic write. See `applyOptimistic`. */
      let undo: () => void = noop;
      /** The same-page retry hook the durable queue can call while this frame is still alive. */
      let detachQueueRetry: (() => void) | undefined;
      /** Fires when another tab or the service worker delivered this call's entry. */
      let detachQueueSettled: (() => void) | undefined;

      const clearQueueRetry = (): void => {
        detachQueueRetry?.();
        detachQueueRetry = undefined;
        detachQueueSettled?.();
        detachQueueSettled = undefined;
      };

      /** Leaves the local queue, if this call is in it. Idempotent - `finish` and a replay both call it. */
      const releaseQueued = (): void => {
        if (!call.paused) return;
        call.paused = false;
        const index = queue.indexOf(call);
        if (index >= 0) queue.splice(index, 1);
        queuedCount.update((n) => n - 1);
        mutations.release();
        if (queue.length === 0) {
          detachReplay?.();
          detachReplay = undefined;
        }
      };

      /**
       * Parks the call until the next reconnect.
       *
       * A durable call does not join the in-memory queue: the persistent queue owns global FIFO
       * and replays it on reconnect. The live closure is attached as a retry hook so the original
       * `run()` promise can still settle without a second copy of the send logic.
       */
      const hold = (): void => {
        progress.set(undefined);
        if (activeQueue && activeEntryId !== undefined) {
          attachQueueRetry();
          return;
        }
        call.paused = true;
        queue.push(call);
        queuedCount.update((n) => n + 1);
        mutations.hold();
        detachReplay ??= online.onReconnect(replay);
      };

      const attachQueueRetry = (): void => {
        if (!activeQueue || activeEntryId === undefined || settled) return;
        clearQueueRetry();
        activeQueue.inactive(activeEntryId);
        detachQueueRetry = activeQueue.attachRetry(activeEntryId, () => {
          if (settled) return;
          activeQueue.active(activeEntryId);
          send();
        });
        // A tab that queued this call without owning replay cannot settle it itself once another
        // tab (or the service worker) delivers the entry. Without this the call would stay in
        // flight forever and `isMutating()` would never go back to zero.
        detachQueueSettled = activeQueue.attachSettled?.(activeEntryId, () => {
          if (settled) return;
          finish();
          finished.set('success');
          safe(reloadInvalidated);
          safe(() => options.onSettled?.(callArgs, ctx, meta));
          resolve(undefined as T);
        });
      };

      const send = (): void => {
        subscription = stream.subscribe({ next: onEvent, error: (e) => fail(toError(e)) });
        // A custom `HttpBackend` may answer synchronously, in which case `settled` is already true
        // here and the completed subscription must not be handed to `cancel`. The type checker
        // narrows `settled` to `false` because it cannot see that the callback ran inside `subscribe`.
        if (settled) subscription.unsubscribe();
      };

      const call: AcceptedCall = {
        paused: false,
        send,
        cancel: () => {
          if (settled) return;
          // A destroyed handle has no observer left to correct, and writing to a dead signal is
          // pure noise; a plain `cancel()` (or a `switch` superseding this call) does roll back,
          // because leaving an invented value on screen is the worse outcome.
          if (!destroyed) undo();
          releaseQueued();
          clearQueueRetry();
          if (activeQueue && activeEntryId !== undefined) {
            activeQueue.inactive(activeEntryId);
            // `destroy()` keeps the durable entry for the next page; `cancel()` removes it.
            if (!destroyed) {
              void activeQueue
                .remove(activeEntryId)
                .catch((e: unknown) => errorHandler.handleError(e));
            }
          }
          finish();
          subscription?.unsubscribe();
          reject(
            destroyed && durable !== undefined
              ? new MutationDetachedError(durable.entry.id)
              : new RequestCancelledError(),
          );
        },
        release: releaseQueued,
      };
      const finish = (): void => {
        settled = true;
        releaseQueued();
        clearQueueRetry();
        calls.delete(call);
        inFlight.update((n) => n - 1);
        mutations.end(options.mutationKey);
        // A settled call has no progress left to report, and leaving the last event behind would
        // pin a `<progress [value]="">` at its final value. Cleared on every settle path - success,
        // failure and cancel - so `progress()` is `undefined` again until the next call reports.
        progress.set(undefined);
      };
      const isEvent = (raw: unknown): raw is HttpEvent<unknown> =>
        typeof raw === 'object' && raw !== null && 'type' in raw && raw.type !== undefined;

      const succeed = (raw: unknown): void => {
        if (settled) return;
        let value: T;
        try {
          value = options.parse ? options.parse(raw) : (raw as T);
        } catch (e) {
          fail(toError(e));
          return;
        }
        finish();
        response.set(value);
        finished.set('success');
        if (activeQueue && activeEntryId !== undefined) {
          activeQueue.inactive(activeEntryId);
          activeQueue.succeeded(activeEntryId);
        }
        // Settle order is fixed and worth stating, because the rollback and the refetch both
        // touch the same display: invalidate -> onSuccess -> onSettled. So a hook that reads the
        // refreshed value sees the fresh list, not the one that is about to be replaced.
        safe(reloadInvalidated);
        safe(() => options.onSuccess?.(value, callArgs, ctx, meta));
        safe(() => config.onSuccess?.(value, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs, ctx, meta));
        resolve(value);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        // A replay that the server already applied is a success for the queue. It has no response
        // body to hand to `onSuccess`, so only the settle hook runs.
        if (durable?.replayed && persistence?.isAlreadyApplied) {
          let applied = false;
          try {
            applied = persistence.isAlreadyApplied(err);
          } catch (e) {
            errorHandler.handleError(e);
          }
          if (applied) {
            finish();
            finished.set('success');
            safe(reloadInvalidated);
            safe(() => options.onSettled?.(callArgs, ctx, meta));
            resolve(undefined as T);
            return;
          }
        }
        // A live replay that died because the connection dropped again is not a final failure - the
        // durable queue still owns it. A replay from a previous page rejects instead: the queue
        // catches it and keeps the entry pending.
        if (
          !queueManaged &&
          networkMode === 'online' &&
          !online.online() &&
          toRequestError(err).kind === 'network'
        ) {
          hold();
          return;
        }
        if (activeQueue && activeEntryId !== undefined) {
          const decision = activeQueue.failed(activeEntryId, err, {
            ...(timeout === undefined ? {} : { timeout }),
            replay: false,
            idempotencyHeader: idempotencyHeader !== false,
          });
          if (decision !== 'failed') {
            attachQueueRetry();
            return;
          }
        }
        // The optimistic value never became real, so it must not stay on screen. `undo` is a
        // compare-and-swap, so a value another call wrote in the meantime survives.
        undo();
        finish();
        errorTimeout.set(timeout);
        error.set(err);
        finished.set('error');
        safe(() => options.onError?.(err, callArgs, ctx, meta));
        safe(() => config.onError?.(err, { url: built.url, method }));
        safe(() => options.onSettled?.(callArgs, ctx, meta));
        reject(err);
      };
      /**
       * `observe: 'events'` delivers the body inside a `Response` event, with `Sent` and the
       * progress events around it. Everything that is not the body updates `progress`.
       */
      const onEvent = (raw: unknown): void => {
        if (!isEvent(raw)) {
          succeed(raw); // defensive: no `HttpEvent` wrapper
          return;
        }
        switch (raw.type) {
          case HttpEventType.UploadProgress:
          case HttpEventType.DownloadProgress:
            progress.set(raw);
            return;
          case HttpEventType.Response:
            succeed(raw.body);
            return;
          default:
            return; // `Sent` and anything else carry no body
        }
      };

      calls.add(call);
      // A replay never writes an optimistic value: the original page's `onRestore` is the hook for
      // putting the row back on screen, and a replay cannot know what the current list looks like.
      undo = durable?.replayed ? noop : applyOptimistic(callArgs);

      // Older durable work owns dispatch. Attach and let the queue call us when this entry is head.
      if (durable?.deferred) {
        attachQueueRetry();
        return;
      }
      // Offline under `'online'`: the write is already prepared and shown, and the persistent queue
      // sends it on reconnect rather than this stack. A non-durable call uses the in-memory queue.
      if (networkMode === 'online' && !online.online()) {
        hold();
        return;
      }
      if (activeQueue && activeEntryId !== undefined) activeQueue.active(activeEntryId);
      send();
    });
    promise.catch(noop);
    return promise;
  };

  const prepare = (
    callArgs: TArgs,
    ctx: TContext,
    replayEntry?: PersistedMutationEntry,
  ): Promise<T> => {
    // `TArgs` doubles as a params bag: its `body` / `path` / `headers` keys fill the
    // matching request slots and the rest become the query string. The verb comes from
    // the variant that was called.
    let built: ReturnType<typeof resolveRequest>;
    try {
      built = resolveRequest(request(callArgs), method, config.baseUrl, callArgs);
    } catch (e) {
      return rejected(toError(e)); // a throwing builder must not make run() throw synchronously
    }
    if (!built)
      return rejected(
        new RequestCancelledError(
          'The mutation is disabled: its request returned undefined/null/false.',
        ),
      );

    // `method` is already the first argument of `http.request`; the option wins over a builder value.
    const { url, method: _method, ...rest } = built;
    const timeout = options.timeout ?? built.timeout;

    // A function-shaped global `headers` is read at call time, so it picks up the current
    // token even though a mutation has no reactive chain to invalidate.
    const withHeaders =
      options.headers === undefined ? built : { ...built, headers: options.headers };
    const { headers } = withGlobalHeaders(withHeaders, config.headers);

    const makeStream = (finalHeaders: HttpResourceRequest['headers']): Observable<unknown> => {
      let stream: Observable<unknown> = http.request<unknown>(method, url, {
        ...rest,
        headers: finalHeaders,
        // `events` is what makes `reportProgress: true` observable. It is the full
        // `HttpEvent` stream, so `next` can be a progress event, the body, or a `Sent` event.
        observe: 'events',
        responseType: options.responseType ?? 'json',
        timeout,
      } as never);
      if (retryPolicy) {
        stream = stream.pipe(
          retry({
            delay: (err: unknown, attemptNo: number) => {
              const delay = nextRetryDelay(retryPolicy, attemptNo, toError(err));
              return delay === undefined ? throwError(() => err) : timer(delay);
            },
          }),
        );
      }
      return stream;
    };

    if (replayEntry !== undefined) {
      const replayHeaders =
        idempotencyHeader === false
          ? headers
          : withHeader(headers, idempotencyHeader, replayEntry.idempotencyKey);
      return launch(callArgs, ctx, built, timeout, makeStream(replayHeaders), {
        entry: replayEntry,
        replayed: true,
        queueManaged: true,
        deferred: false,
      });
    }

    if (persistence === undefined || persistedQueue === null || persistenceCodec === undefined) {
      return launch(callArgs, ctx, built, timeout, makeStream(headers));
    }

    let storedArgs: unknown;
    try {
      storedArgs = persistenceCodec.serialize(callArgs);
    } catch (e) {
      return rejected(toError(e));
    }

    let idempotencyKey: string;
    try {
      const existing = idempotencyHeader === false ? null : readHeader(headers, idempotencyHeader);
      idempotencyKey = persistence.idempotencyKey?.(callArgs) ?? existing ?? newIdempotencyKey();
    } catch (e) {
      return rejected(toError(e));
    }

    const finalHeaders =
      idempotencyHeader === false
        ? headers
        : persistence.idempotencyKey !== undefined
          ? withHeader(headers, idempotencyHeader, idempotencyKey)
          : readHeader(headers, idempotencyHeader) === null
            ? withHeader(headers, idempotencyHeader, idempotencyKey)
            : headers;

    return persistedQueue
      .enqueue({
        key: persistence.key,
        version: persistenceVersion,
        args: storedArgs,
        idempotencyKey,
      })
      .then(
        (result) => {
          if (result === null) {
            if (isDevMode()) {
              console.warn(
                'createMutation: the persisted mutation queue is unavailable; this call runs without durability.',
              );
            }
            return launch(callArgs, ctx, built, timeout, makeStream(finalHeaders));
          }
          return launch(callArgs, ctx, built, timeout, makeStream(finalHeaders), {
            entry: result.entry,
            replayed: false,
            queueManaged: false,
            deferred: result.deferred,
          });
        },
        (e: unknown) => rejected(toError(e)),
      );
  };

  const replayPersisted = (entry: PersistedMutationEntry): Promise<unknown> => {
    if (persistenceCodec === undefined) {
      return rejected(new Error('The mutation has no persistence codec for replay.'));
    }
    let callArgs: TArgs;
    try {
      callArgs = persistenceCodec.deserialize(entry.args);
    } catch (e) {
      return rejected(
        new MutationQueueQuarantineError(
          `The stored args for "${entry.key}" could not be deserialized.`,
          e,
        ),
      );
    }
    return prepare(callArgs, undefined as TContext, entry);
  };

  if (persistence !== undefined && persistedQueue !== null && persistenceCodec !== undefined) {
    const activePersistence = persistence;
    const handler: MutationQueueHandler = {
      key: activePersistence.key,
      version: persistenceVersion,
      idempotencyHeader: idempotencyHeader !== false,
      replay: replayPersisted,
      ...(activePersistence.onRestore === undefined
        ? {}
        : {
            restore: async (entry: PersistedMutationEntry): Promise<void> => {
              const callArgs = persistenceCodec.deserialize(entry.args);
              await activePersistence.onRestore?.(callArgs, entry);
            },
          }),
    };
    unregisterQueue = persistedQueue.register(handler);
  }
  const cancelAll = (): void => {
    for (const call of [...calls]) call.cancel();
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    detachReplay?.();
    detachReplay = undefined;
    cancelAll();
    unregisterQueue?.();
    unregisterQueue = undefined;
  };

  inject(DestroyRef).onDestroy(destroy);

  /**
   * Runs the call, with `onMutate` in front of it when there is one.
   *
   * Without `onMutate` this calls `execute` **synchronously**, which is load-bearing: the request
   * is on the wire before `run()` returns, so `run(); expectOne(url)` in a test works and a
   * `switch`-mode cancel still sees the previous call in the same tick. Routing everything through
   * a promise chain "for symmetry" would push dispatch into a microtask and quietly change that.
   */
  const start = (callArgs: TArgs): Promise<T> => {
    if (!options.onMutate) return prepare(callArgs, undefined as TContext);

    return runOnMutate(callArgs).then(
      (ctx) => prepare(callArgs, ctx),
      // `onMutate` threw or rejected: the call was never made, so it fails like any other
      // failed call — hooks run, the promise rejects, nothing was sent.
      (reason: unknown) => {
        const failure = toError(reason);
        const meta: MutationHookMeta = { replayed: false };
        args.set(callArgs);
        context.set(undefined);
        error.set(failure);
        finished.set('error');
        safe(() => options.onError?.(failure, callArgs, undefined, meta));
        safe(() => config.onError?.(failure, { url: undefined, method }));
        safe(() => options.onSettled?.(callArgs, undefined, meta));
        return rejected(failure);
      },
    );
  };

  const run = (callArgs: TArgs): Promise<T> => {
    if (destroyed) return rejected(new RequestCancelledError('The mutation was destroyed.'));
    switch (concurrency) {
      case 'exhaust': {
        if (exhausted) return exhausted;
        const promise = start(callArgs);
        exhausted = promise;
        const clear = (): void => {
          if (exhausted === promise) exhausted = undefined;
        };
        promise.then(clear, clear);
        return promise;
      }
      case 'switch':
        cancelAll();
        return start(callArgs);
      default:
        return start(callArgs);
    }
  };

  const api = {
    response: response.asReadonly(),
    error: error.asReadonly(),
    requestError,
    loading,
    status,
    args: args.asReadonly(),
    context: context.asReadonly(),
    progress: progress.asReadonly(),
    paused,
    run: (...a: [TArgs?]) => run(a[0] as TArgs),
    tryRun: (...a: [TArgs?]): Promise<RunResult<T>> =>
      run(a[0] as TArgs).then(
        (value): RunResult<T> => ({ ok: true, response: value }),
        (e: unknown): RunResult<T> => ({ ok: false, error: toError(e) }),
      ),
    cancel: cancelAll,
    reset: (): void => {
      response.set(undefined);
      error.set(undefined);
      args.set(undefined);
      context.set(undefined);
      progress.set(undefined);
      if (untracked(inFlight) === 0) finished.set('idle');
    },
    destroy,
  };
  return api;
}
