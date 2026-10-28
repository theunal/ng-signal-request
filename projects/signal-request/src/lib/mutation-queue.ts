import { InjectionToken, type Signal } from '@angular/core';

/**
 * The shape of one accepted write in the durable outbox.
 *
 * This lives in the core entry point rather than `/persist/queue` because `createMutation` has to
 * name it while it is building the request. The storage implementation, hydration and replay loop
 * live in `/persist/queue`; the core only knows the contract.
 */
export interface PersistedMutationEntry {
  /** Stable id of this accepted call. Not the mutation definition's `persistence.key`. */
  readonly id: string;
  /** The application-unique identity of the mutation definition. */
  readonly key: string;
  /** Application args version. */
  readonly version: number;
  /** Serialized args, absent for a `void` mutation. */
  readonly args?: unknown;
  readonly createdAt: number;
  readonly seq: number;
  /** Reserved for a later lane-isolation release. V1 still replays global FIFO. */
  readonly lane?: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly lastAttemptAt?: number;
  readonly nextAttemptAt?: number;
  readonly state: 'pending' | 'failed' | 'quarantined';
  readonly lastError?: PersistedMutationError;
}

export interface PersistedMutationError {
  readonly kind: string;
  readonly status?: number;
  readonly message: string;
  readonly at: number;
}

export interface MutationQueueSnapshot {
  readonly version: number;
  readonly timestamp: number;
  readonly buster?: string;
  readonly entries: readonly PersistedMutationEntry[];
}

/** The minimum a core mutation needs from the durable queue. */
export interface MutationQueueEnqueueInput {
  readonly key: string;
  readonly version: number;
  readonly args?: unknown;
  readonly idempotencyKey: string;
  readonly lane?: string;
}

export interface MutationQueueEnqueueResult {
  readonly entry: PersistedMutationEntry;
  /**
   * `true` when an older entry is still ahead of this one and the queue owns dispatch.
   * The core then waits for the queue instead of sending immediately.
   */
  readonly deferred: boolean;
}

/**
 * What the queue needs to know about a failure. `isAlreadyApplied` is handled by the core, because
 * it belongs to the mutation definition and not to storage.
 */
export interface MutationQueueFailureContext {
  readonly timeout?: number;
  readonly replay: boolean;
  readonly idempotencyHeader: boolean;
}

export type MutationQueueDecision = 'retry' | 'failed' | 'auth';

export interface MutationQueueHandler {
  readonly key: string;
  readonly version: number;
  /** Whether replay requests carry the mutation's idempotency header. */
  readonly idempotencyHeader?: boolean;
  /** Application-owned optimistic restore, called after hydration and before replay. */
  restore?(entry: PersistedMutationEntry): void | Promise<void>;
  /** Rebuilds and sends the request from stored args through the current mutation definition. */
  replay(entry: PersistedMutationEntry): Promise<unknown>;
}

/**
 * The seam `createMutation` reads. `/persist/queue` implements it; an application that never calls
 * `providePersistedMutationQueue` gets `null` from the optional token and the 0.2.0 path.
 */
export interface MutationQueueAdapter {
  readonly enabled: Signal<boolean>;
  register(handler: MutationQueueHandler): () => void;
  enqueue(input: MutationQueueEnqueueInput): Promise<MutationQueueEnqueueResult | null>;
  succeeded(id: string): void;
  failed(id: string, error: Error, context: MutationQueueFailureContext): MutationQueueDecision;
  /** A same-page retry path. Hydrated entries have no live closure, so the queue uses replay(). */
  attachRetry(id: string, retry: () => void): () => void;
  /**
   * Notifies the caller when an entry left the queue without this tab sending it - another tab or
   * the application's service worker delivered it.
   *
   * Optional, and only meaningful for a queue that accepts writes without owning replay: without
   * it the creating tab would keep a call pending forever after another tab settled the same entry.
   */
  attachSettled?(id: string, settled: () => void): () => void;
  active(id: string): void;
  inactive(id: string): void;
  remove(id: string): Promise<void>;
}

export const MUTATION_QUEUE = new InjectionToken<MutationQueueAdapter>(
  'ng-signal-request: persisted mutation queue',
);

export class MutationQueueFullError extends Error {
  override readonly name = 'MutationQueueFullError';
  constructor(readonly maxEntries: number) {
    super(`The persisted mutation queue is full (${maxEntries} entries).`);
  }
}

export class MutationQueueDisabledError extends Error {
  override readonly name = 'MutationQueueDisabledError';
  constructor(
    message = 'The persisted mutation queue is disabled.',
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Marks a stored entry whose args can no longer be understood.
 *
 * The queue quarantines the entry instead of retrying it: sending a request rebuilt from the wrong
 * shape would be worse than leaving the write for the application to inspect. The class lives in the
 * core because `createMutation` is where deserialization happens; `/persist/queue` only has to
 * recognize it.
 */
export class MutationQueueQuarantineError extends Error {
  override readonly name = 'MutationQueueQuarantineError';
  constructor(
    message = 'The stored mutation args could not be deserialized.',
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
