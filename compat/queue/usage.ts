/**
 * The durable-queue type fixture.
 *
 * This file is written against the **new** public surface added by the persisted mutation queue,
 * the way the README documents it, and compiled against the **built** declarations in
 * `dist/signal-request` by `pnpm check:types-queue`. `pnpm verify` runs that check after `build`.
 *
 * It is deliberately not part of `compat/v0.1.0/usage.ts`: that file is the historical claim "code
 * written against 0.1.0 still compiles" and may not mention a type that did not exist then.
 *
 * `concurrency: 'switch'` is rejected at **runtime** (dev throws, production disables persistence
 * for that definition with a warning), not by the type system. A union of option shapes would
 * widen inference for every existing `createMutation` call, so the documented fallback in
 * `docs/design-offline-mutation-queue.md` §20.1 is what ships. `switch` is therefore absent from
 * this fixture rather than written behind a `@ts-expect-error` that the compiler cannot satisfy.
 *
 * Nothing here is executed. It is compiled, which is the whole point.
 */

import { createMutation } from 'ng-signal-request';
import type {
  MutationArgsCodec,
  MutationHookMeta,
  MutationPersistenceOptions,
  MutationQueueSnapshot,
  PersistedMutationEntry,
  PersistedMutationError,
} from 'ng-signal-request';
import {
  MUTATION_QUEUE,
  MUTATION_QUEUE_VERSION,
  MutationDetachedError,
  MutationQueueDisabledError,
  MutationQueueFullError,
  MutationQueueQuarantineError,
  PERSISTED_MUTATION_QUEUE_OPTIONS,
  PersistedMutationQueue,
  providePersistedMutationQueue,
  type PersistedMutationQueueEvent,
  type PersistedMutationQueueListener,
  type PersistedMutationQueueOptions,
  type PersistedMutationQueueRetryOptions,
} from 'ng-signal-request/persist/queue';
import type { MutationQueueStorage } from 'ng-signal-request/persist/queue';
import {
  MUTATION_QUEUE_SYNC_TAG,
  MUTATION_QUEUE_SYNC_VERSION,
  drainMutationQueue,
  indexedDbQueueStorage,
  registerMutationQueueSync,
  type MutationQueueSyncBlockedReason,
  type MutationQueueSyncContext,
  type MutationQueueSyncEvent,
  type MutationQueueSyncHandler,
  type MutationQueueSyncResult,
  type MutationQueueSyncStorage,
} from 'ng-signal-request/persist/queue/sw';
import { inject, type EnvironmentProviders, type ProviderToken, type Signal } from '@angular/core';

interface Todo {
  readonly id: number;
  readonly title: string;
}

interface AddArgs {
  readonly title: string;
  readonly due: Date;
}

/** Args that JSON cannot round-trip need a codec; this is the shape the README shows. */
const dateCodec: MutationArgsCodec<AddArgs> = {
  serialize: (args) => ({ ...args, due: args.due.toISOString() }),
  deserialize: (value) => {
    const raw = value as { title: string; due: string };
    return { title: raw.title, due: new Date(raw.due) };
  },
};

export function persistenceOptions(): MutationPersistenceOptions<AddArgs> {
  return {
    key: 'todos.add',
    version: 2,
    codec: dateCodec,
    idempotencyKey: (args) => `todo:${args.title}`,
    idempotencyHeader: 'X-Idempotency-Key',
    onRestore: (args, entry) => {
      const due: Date = args.due;
      const id: string = entry.id;
      const state: 'pending' | 'failed' | 'quarantined' = entry.state;
      void [due, id, state];
    },
    isAlreadyApplied: (error) => error.name === 'HttpErrorResponse',
  };
}

export function durableMutation(): void {
  const add = createMutation<Todo, AddArgs, { titleAtStart: string }>(
    (args) => ({ url: '/todos', body: args }),
    {
      networkMode: 'online',
      persistence: persistenceOptions(),
      onMutate: (args) => ({ titleAtStart: args.title }),
      onSuccess: (todo, args, context, meta) => {
        const replayed: boolean = meta?.replayed ?? false;
        void [todo.id, args.title, context?.titleAtStart, replayed];
      },
      onError: (error, args, context, meta) => {
        const hookMeta: MutationHookMeta | undefined = meta;
        void [error.message, args.title, context?.titleAtStart, hookMeta];
      },
      onSettled: (_args, _context, meta) => {
        const replayed: boolean = meta?.replayed ?? false;
        void replayed;
      },
    },
  );

  add.run({ title: 'Buy milk', due: new Date() });
  add.destroy();

  // `idempotencyHeader: false` is allowed and is the documented "server must deduplicate" opt-out.
  createMutation<Todo, AddArgs>(() => '/todos', {
    persistence: { key: 'todos.add.no-header', idempotencyHeader: false },
  });
}

export function queueSetup(eager: readonly ProviderToken<unknown>[]): EnvironmentProviders {
  const retry: PersistedMutationQueueRetryOptions = {
    maxAttempts: 3,
    baseDelay: 500,
    maxDelay: 10_000,
  };
  const storage: MutationQueueStorage = localStorage;
  const options: PersistedMutationQueueOptions = {
    storage,
    key: 'todos:outbox',
    buster: 'v2',
    maxEntries: 50,
    autoReplay: true,
    stopOnFailure: true,
    assumeSingleTab: false,
    eager,
    noHandlerWarnAfterMs: 5000,
    onStorageError: 'degrade',
    backgroundSync: { tag: MUTATION_QUEUE_SYNC_TAG },
    retry,
    migrate: (snapshot, version) => (version === MUTATION_QUEUE_VERSION ? (snapshot as MutationQueueSnapshot) : null),
    migrateEntry: (entry) => entry,
  };
  return providePersistedMutationQueue(options);
}

export function queueService(): void {
  const queue: PersistedMutationQueue = inject(PersistedMutationQueue);
  const adapter = inject(MUTATION_QUEUE);
  const options = inject(PERSISTED_MUTATION_QUEUE_OPTIONS);
  void [adapter, options];

  const entries: Signal<readonly PersistedMutationEntry[]> = queue.entries;
  const pending: Signal<number> = queue.pendingCount;
  const failed: Signal<number> = queue.failedCount;
  const replaying: Signal<boolean> = queue.isReplaying;
  const needsAuth: Signal<boolean> = queue.needsAuth;
  const owner: Signal<boolean> = queue.owner;
  const enabled: Signal<boolean> = queue.enabled;
  void [entries, pending, failed, replaying, needsAuth, owner, enabled];

  const first: PersistedMutationEntry | undefined = entries()[0];
  const lastError: PersistedMutationError | undefined = first?.lastError;
  const idempotencyKey: string | undefined = first?.idempotencyKey;
  const lane: string | undefined = first?.lane;
  void [lastError, idempotencyKey, lane];

  const listener: PersistedMutationQueueListener = (event: PersistedMutationQueueEvent) => {
    switch (event.type) {
      case 'enqueued':
      case 'succeeded':
        void event.entry.id;
        break;
      case 'failed':
      case 'retry':
        void event.error.message;
        break;
      case 'blocked':
        void event.reason;
        break;
      case 'queue-full':
        void event.maxEntries;
        break;
      case 'removed':
        void event.id;
        break;
      case 'quarantined':
      case 'restored':
      case 'auth':
        break;
    }
  };
  const unsubscribe: () => void = queue.onEvent(listener);
  unsubscribe();

  queue.retry(first?.id ?? '');
  queue.retryAll();
  queue.pause();
  queue.resume();
  void queue.remove('id');
  void queue.clear();
  const snapshot: string = queue.export();
  void snapshot;
}

export function queueErrors(): void {
  const detached: Error = new MutationDetachedError('mutation-1');
  const full: Error = new MutationQueueFullError(100);
  const disabled: Error = new MutationQueueDisabledError();
  const quarantined: Error = new MutationQueueQuarantineError('bad args', new Error('cause'));
  void [detached, full, disabled, quarantined];
}

/**
 * The worker half, written the way the README documents it.
 *
 * The application owns the service worker file; this fixture only proves the built declarations
 * expose everything that file needs: the tag, the drain helper, the storage adapter and the handler
 * contract. Nothing here is registered or executed.
 */
export function workerReplay(registration: ServiceWorkerRegistration): void {
  const handler: MutationQueueSyncHandler = {
    key: 'todos.add',
    version: 2,
    idempotencyHeader: 'X-Idempotency-Key',
    deserialize: (raw) => raw,
    migrate: (entry, fromVersion) => (fromVersion === 1 ? { ...entry, version: 2 } : null),
    replay: async (args, context: MutationQueueSyncContext) => {
      const idempotencyKey: string = context.idempotencyKey;
      const idempotencyHeader: string | false = context.idempotencyHeader;
      const entry: PersistedMutationEntry = context.entry;
      void [args, idempotencyKey, idempotencyHeader, entry];
    },
  };

  const storage: MutationQueueSyncStorage = indexedDbQueueStorage({
    database: 'app',
    store: 'mutations',
    version: 1,
  });

  const result: Promise<MutationQueueSyncResult> = drainMutationQueue({
    storage,
    key: 'todos:outbox',
    buster: 'v2',
    handlers: [handler],
    stopOnFailure: true,
    retry: { maxAttempts: 3, baseDelay: 500, maxDelay: 10_000 },
    lock: true,
    now: () => Date.now(),
    onEvent: (event: MutationQueueSyncEvent) => {
      const reason: MutationQueueSyncBlockedReason | undefined =
        event.type === 'blocked' ? event.reason : undefined;
      void reason;
    },
  });
  void result;

  const registered: Promise<boolean> = registerMutationQueueSync(registration, {
    tag: MUTATION_QUEUE_SYNC_TAG,
  });
  const version: number = MUTATION_QUEUE_SYNC_VERSION;
  void [registered, version];
}
