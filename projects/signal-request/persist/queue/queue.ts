/**
 * `ng-signal-request/persist/queue` - the durable outbox behind `createMutation({ persistence })`.
 *
 * The core knows only the {@link MutationQueueAdapter} contract. This entry point owns everything
 * storage-shaped: the snapshot, hydration, the Web Locks owner, replay order and retry clock. It is
 * deliberately a separate subpath so an application that only persists the read cache never ships
 * any of it.
 */
import { isPlatformBrowser } from '@angular/common';
import {
  computed,
  DestroyRef,
  ErrorHandler,
  inject,
  Injectable,
  InjectionToken,
  isDevMode,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
  signal,
  type EnvironmentProviders,
  type ProviderToken,
  type Signal,
} from '@angular/core';
import {
  MUTATION_QUEUE,
  MutationDetachedError,
  MutationQueueDisabledError,
  MutationQueueFullError,
  MutationQueueQuarantineError,
  RESTORE_GATE,
  OnlineManager,
  toError,
  toRequestError,
  type MutationQueueAdapter,
  type MutationQueueDecision,
  type MutationQueueEnqueueInput,
  type MutationQueueEnqueueResult,
  type MutationQueueFailureContext,
  type MutationQueueHandler,
  type MutationQueueSnapshot,
  type PersistedMutationEntry,
  type PersistedMutationError,
} from 'ng-signal-request';
import { indexedDbStorage, type CacheStorage } from 'ng-signal-request/persist';

// The queue is the natural home for these names: an application that injects the queue should not
// have to import the core just to name the entry type or catch its own errors.
export {
  MUTATION_QUEUE,
  MutationDetachedError,
  MutationQueueDisabledError,
  MutationQueueFullError,
  MutationQueueQuarantineError,
} from 'ng-signal-request';
export type {
  MutationArgsCodec,
  MutationQueueSnapshot,
  PersistedMutationEntry,
  PersistedMutationError,
} from 'ng-signal-request';
export type { CacheStorage as MutationQueueStorage } from 'ng-signal-request/persist';

/** Snapshot schema. Bump together with a provider-level `migrate`. */
export const MUTATION_QUEUE_VERSION = 1;

const DEFAULT_QUEUE_KEY = 'ng-signal-request:mutation-queue';
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_NO_HANDLER_WARN_AFTER_MS = 5_000;

export interface PersistedMutationQueueRetryOptions {
  /** Attempts after the first one. Default `5`. */
  readonly maxAttempts?: number;
  /** First backoff in ms. Default `1_000`. */
  readonly baseDelay?: number;
  /** Backoff cap in ms. Default `30_000`. */
  readonly maxDelay?: number;
}

export interface PersistedMutationQueueOptions {
  /**
   * Storage for the queue snapshot. Defaults to IndexedDB, falling back to `localStorage`.
   * Pass `null` to disable the queue explicitly.
   */
  readonly storage?: CacheStorage | null;
  /** Storage key / Web Lock name. Defaults to `ng-signal-request:mutation-queue`. */
  readonly key?: string;
  /** A snapshot with a different buster is quarantined, never deleted. */
  readonly buster?: string;
  /** Hard cap on stored entries, pending and failed. Default `100`. */
  readonly maxEntries?: number;
  /** Replay hydrated work automatically once a handler is registered. Default `true`. */
  readonly autoReplay?: boolean;
  /**
   * Stop at the first failed entry instead of skipping it. Default `true`, which is what makes
   * global FIFO meaningful; set it to `false` to let later entries overtake a failed one.
   */
  readonly stopOnFailure?: boolean;
  /**
   * Skip Web Locks and assume this is the only tab. Needed in environments without the API;
   * otherwise durable persistence is disabled rather than risking a two-tab double send.
   */
  readonly assumeSingleTab?: boolean;
  /**
   * Services to construct before automatic replay starts, so their mutation definitions are
   * registered and hydrated entries have a handler before the queue looks at them.
   */
  readonly eager?: readonly ProviderToken<unknown>[];
  /** How long a missing handler blocks replay before a dev warning. Default `5_000`. */
  readonly noHandlerWarnAfterMs?: number;
  /** What to do when a storage write fails. Default `degrade` (fall back to no durability). */
  readonly onStorageError?: 'degrade' | 'fail';
  /** Retry clock for pending entries. */
  readonly retry?: PersistedMutationQueueRetryOptions;
  /** Envelope migration. Return `null` to quarantine the snapshot. */
  readonly migrate?: (snapshot: unknown, version: number) => MutationQueueSnapshot | null;
  /** Per-entry migration. Return `null` to quarantine that entry. */
  readonly migrateEntry?: (
    entry: PersistedMutationEntry,
    version: number,
  ) => PersistedMutationEntry | null;
}

export type PersistedMutationQueueEvent =
  | { readonly type: 'enqueued'; readonly entry: PersistedMutationEntry }
  | { readonly type: 'succeeded'; readonly entry: PersistedMutationEntry }
  | { readonly type: 'failed'; readonly entry: PersistedMutationEntry; readonly error: Error }
  | { readonly type: 'retry'; readonly entry: PersistedMutationEntry; readonly error: Error }
  | { readonly type: 'auth'; readonly entry: PersistedMutationEntry }
  | {
      readonly type: 'blocked';
      readonly entry: PersistedMutationEntry | undefined;
      readonly reason: 'offline' | 'paused' | 'auth' | 'no-handler' | 'quarantined' | 'failed';
    }
  | { readonly type: 'removed'; readonly id: string }
  | { readonly type: 'queue-full'; readonly maxEntries: number }
  | { readonly type: 'quarantined'; readonly reason: string }
  | { readonly type: 'restored'; readonly entries: readonly PersistedMutationEntry[] };

export type PersistedMutationQueueListener = (event: PersistedMutationQueueEvent) => void;

/** The options token is internal; applications configure the queue through the provider. */
export const PERSISTED_MUTATION_QUEUE_OPTIONS = new InjectionToken<PersistedMutationQueueOptions>(
  'ng-signal-request: persisted mutation queue options',
);

interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

interface Deferred {
  readonly resolve: () => void;
  readonly promise: Promise<void>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function newEntryId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `entry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readError(value: unknown): PersistedMutationError | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value['kind'];
  const message = value['message'];
  const at = finiteNumber(value['at']);
  if (typeof kind !== 'string' || typeof message !== 'string' || at === null) return undefined;
  const status = finiteNumber(value['status']);
  return { kind, ...(status === null ? {} : { status }), message, at };
}

interface ReadEntry {
  readonly entry: PersistedMutationEntry;
  /** Non-null when the entry must be quarantined rather than replayed. */
  readonly problem: string | null;
}

/**
 * Reads one stored entry without trusting any of it.
 *
 * `null` is the only unrecoverable case - a value that is not even an object, or that has no usable
 * `id` - and it quarantines the whole snapshot, because an entry the queue cannot name is one it
 * cannot show, remove or block on. Everything else becomes a readable entry; a defect marks it
 * `quarantined` with a reason instead of dropping user data or replaying the wrong shape.
 */
function readEntry(value: unknown): ReadEntry | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || id === '') return null;

  const problems: string[] = [];
  const key = typeof value['key'] === 'string' ? value['key'] : '';
  if (key === '') problems.push('missing key');
  const idempotencyKey = typeof value['idempotencyKey'] === 'string' ? value['idempotencyKey'] : '';
  if (idempotencyKey === '') problems.push('missing idempotency key');
  const version = finiteNumber(value['version']);
  if (version === null) problems.push('invalid version');
  const createdAt = finiteNumber(value['createdAt']);
  if (createdAt === null) problems.push('invalid createdAt');
  const seq = finiteNumber(value['seq']);
  if (seq === null) problems.push('invalid seq');
  const attempts = finiteNumber(value['attempts']);
  if (attempts === null) problems.push('invalid attempts');
  const lane = value['lane'];
  if (lane !== undefined && typeof lane !== 'string') problems.push('invalid lane');
  const rawState = value['state'];
  const state =
    rawState === 'pending' || rawState === 'failed' || rawState === 'quarantined'
      ? rawState
      : 'quarantined';
  if (state !== rawState) problems.push('unknown state');
  const lastError = readError(value['lastError']);

  return {
    entry: {
      id,
      key,
      version: version ?? 0,
      ...(value['args'] === undefined ? {} : { args: value['args'] }),
      createdAt: createdAt ?? 0,
      seq: seq ?? 0,
      ...(typeof lane === 'string' ? { lane } : {}),
      idempotencyKey,
      attempts: attempts ?? 0,
      ...(finiteNumber(value['lastAttemptAt']) === null
        ? {}
        : { lastAttemptAt: finiteNumber(value['lastAttemptAt']) as number }),
      ...(finiteNumber(value['nextAttemptAt']) === null
        ? {}
        : { nextAttemptAt: finiteNumber(value['nextAttemptAt']) as number }),
      state,
      ...(lastError === undefined ? {} : { lastError }),
    },
    problem:
      problems.length === 0 ? null : `The stored entry is unreadable: ${problems.join(', ')}.`,
  };
}

/** The envelope is checked separately from its entries, so one bad entry is not a bad queue. */
function isEnvelope(
  value: unknown,
): value is { readonly version: number; readonly timestamp: number; readonly entries: unknown[] } {
  return (
    isRecord(value) &&
    typeof value['version'] === 'number' &&
    typeof value['timestamp'] === 'number' &&
    Array.isArray(value['entries'])
  );
}

function defaultStorage(): CacheStorage | null {
  // Prefer IndexedDB: a queue entry can contain a body larger than a localStorage quota, and IDB
  // will not block the main thread while writing it.
  if (typeof indexedDB !== 'undefined') {
    return indexedDbStorage({ store: 'mutations' });
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Storage access can throw (Safari private mode). Absence is a disabled queue, not a crash.
  }
  return null;
}

/**
 * The durable outbox.
 *
 * It is provided by {@link providePersistedMutationQueue}; injecting it directly is supported but
 * not the recommended setup, because the provider is what constructs eager services and starts
 * hydration in the right order.
 */
@Injectable()
export class PersistedMutationQueue implements MutationQueueAdapter {
  private readonly options = inject(PERSISTED_MUTATION_QUEUE_OPTIONS);
  private readonly errorHandler = inject(ErrorHandler);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly restoreGate = inject(RESTORE_GATE, { optional: true });
  private readonly online = inject(OnlineManager);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private readonly entryState = signal<readonly PersistedMutationEntry[]>([]);
  private readonly enabledState = signal(false);
  private readonly ownerState = signal(false);
  private readonly replayingState = signal(false);
  private readonly authState = signal(false);

  /** Entries in global FIFO order. */
  readonly entries: Signal<readonly PersistedMutationEntry[]> = this.entryState.asReadonly();
  /** Pending entries, which is what a UI usually shows as "waiting to save". */
  readonly pendingCount: Signal<number> = computed(
    () => this.entryState().filter((entry) => entry.state === 'pending').length,
  );
  /** Entries parked after a permanent failure. They are never dropped automatically. */
  readonly failedCount: Signal<number> = computed(
    () => this.entryState().filter((entry) => entry.state === 'failed').length,
  );
  readonly isReplaying: Signal<boolean> = this.replayingState.asReadonly();
  /** `true` after a 401/403 while replaying; `resume()` clears it. */
  readonly needsAuth: Signal<boolean> = this.authState.asReadonly();
  /** Whether this tab owns the queue. `false` when another tab holds the Web Lock. */
  readonly owner: Signal<boolean> = this.ownerState.asReadonly();
  /** `false` when storage is unavailable, the queue is corrupt, or another tab owns it. */
  readonly enabled: Signal<boolean> = this.enabledState.asReadonly();

  private readonly handlers = new Map<string, MutationQueueHandler>();
  private readonly retryHooks = new Map<string, () => void>();
  private readonly activeIds = new Set<string>();
  private readonly restoredIds = new Set<string>();
  /** Entries whose version migration / `onRestore` has not finished; replay must not touch them. */
  private readonly reviewing = new Set<string>();
  private readonly listeners = new Set<PersistedMutationQueueListener>();

  /**
   * Resolves once storage and hydration are ready. `enqueue()` waits for this but deliberately not
   * for `RESTORE_GATE`: a write made while the cache is restoring must still be durably stored
   * immediately (design §19.4).
   */
  private readonly hydratedReady = deferred();
  /** Resolves after `hydratedReady` and the cache restore gate, before any handler restore/replay. */
  private readonly restoreReady = deferred();
  private storage: CacheStorage | null = null;
  private rawSnapshot: string | null = null;
  private quarantined = false;
  private started = false;
  private hydrated = false;
  private destroyed = false;
  private paused = false;
  private allowReplay = true;
  private replayScheduled = false;
  private replaying = false;
  private nextSeq = 1;
  private replayTimer: ReturnType<typeof setTimeout> | undefined;
  private noHandlerTimer: ReturnType<typeof setTimeout> | undefined;
  private noHandlerId: string | undefined;
  private warnedNoHandler = new Set<string>();
  private releaseLock: (() => void) | undefined;
  private detachOnline: (() => void) | undefined;
  private writing: Promise<unknown> = Promise.resolve();

  private readonly key = this.options.key ?? DEFAULT_QUEUE_KEY;
  private readonly maxEntries = Math.max(1, this.options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  private readonly maxAttempts = Math.max(
    1,
    this.options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  );
  private readonly baseDelay = Math.max(10, this.options.retry?.baseDelay ?? DEFAULT_BASE_DELAY);
  private readonly maxDelay = Math.max(
    this.baseDelay,
    this.options.retry?.maxDelay ?? DEFAULT_MAX_DELAY,
  );
  private readonly noHandlerWarnAfterMs = Math.max(
    0,
    this.options.noHandlerWarnAfterMs ?? DEFAULT_NO_HANDLER_WARN_AFTER_MS,
  );

  constructor() {
    this.destroyRef.onDestroy(() => this.destroy());
  }

  /**
   * Starts hydration. The provider calls this after constructing eager services, though it is
   * idempotent and safe for a manually provided queue too.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.initialize();
  }

  register(handler: MutationQueueHandler): () => void {
    const existing = this.handlers.get(handler.key);
    if (existing) {
      const message =
        `[ng-signal-request/persist/queue] Two mutations registered persistence key ` +
        `"${handler.key}". The first definition wins.`;
      if (isDevMode()) throw new Error(message);
      console.warn(message);
      return () => {};
    }
    this.handlers.set(handler.key, handler);
    this.reviewHandler(handler);
    this.scheduleReplay();
    return () => {
      if (this.handlers.get(handler.key) === handler) this.handlers.delete(handler.key);
    };
  }

  async enqueue(input: MutationQueueEnqueueInput): Promise<MutationQueueEnqueueResult | null> {
    // Only hydration gates the write. The cache restore gate belongs to replay and `onRestore`, so
    // an offline write is not held behind an unrelated IndexedDB cache read.
    await this.hydratedReady.promise;
    if (!this.enabledState() || this.destroyed || this.quarantined) return null;

    if (this.entryState().length >= this.maxEntries) {
      this.emit({ type: 'queue-full', maxEntries: this.maxEntries });
      throw new MutationQueueFullError(this.maxEntries);
    }

    const entry: PersistedMutationEntry = {
      id: newEntryId(),
      key: input.key,
      version: input.version,
      ...(input.args === undefined ? {} : { args: input.args }),
      createdAt: Date.now(),
      seq: this.nextSeq++,
      ...(input.lane === undefined ? {} : { lane: input.lane }),
      idempotencyKey: input.idempotencyKey,
      attempts: 0,
      state: 'pending',
    };
    const previous = this.entryState();
    this.setEntries([...previous, entry]);
    // Claim the entry until the `run()` stack has either sent it or attached its retry hook. This
    // closes the window between `enqueue()` returning and `launch()` reaching `send()`; without it
    // an already-scheduled replay could send the same call twice.
    this.activeIds.add(entry.id);
    try {
      await this.persist();
    } catch (error) {
      this.activeIds.delete(entry.id);
      this.setEntries(previous);
      this.handleStorageError(error);
      if (this.options.onStorageError === 'fail') {
        // A dedicated error, because this is not a failed write: nothing was sent, and the
        // application asked to hear about it rather than get a non-durable call.
        throw new MutationQueueDisabledError(
          'The persisted mutation queue could not store this call. ' +
            '`onStorageError: "fail"` rejects instead of sending it without durability.',
          error,
        );
      }
      return null;
    }

    this.emit({ type: 'enqueued', entry });
    const deferred = this.isDeferred(entry);
    // A new head is dispatched by the `run()` that created it. A non-head entry is the queue's,
    // and scheduling is how it gets a chance to become head after earlier work settles.
    if (deferred) this.scheduleReplay();
    return { entry, deferred };
  }

  succeeded(id: string): void {
    const entry = this.find(id);
    if (entry === undefined) return;
    this.activeIds.delete(id);
    this.retryHooks.delete(id);
    this.restoredIds.delete(id);
    this.setEntries(this.entryState().filter((candidate) => candidate.id !== id));
    this.emit({ type: 'succeeded', entry });
    void this.persistQuietly();
    this.scheduleReplay();
  }

  failed(id: string, error: Error, context: MutationQueueFailureContext): MutationQueueDecision {
    const entry = this.find(id);
    if (entry === undefined) return 'failed';
    this.activeIds.delete(id);

    // A handle destroyed mid-replay is not a failed write. The entry stays exactly where it was so
    // the next page can pick it up.
    if (error instanceof MutationDetachedError || error.name === 'MutationDetachedError') {
      this.replaceEntry({ ...entry, lastError: this.errorOf(error) });
      void this.persistQuietly();
      return 'retry';
    }

    // Stored args that no longer match the codec are not a transient server problem. Sending a
    // rebuilt request from the wrong shape would be worse than quarantining the entry.
    if (
      error instanceof MutationQueueQuarantineError ||
      error.name === 'MutationQueueQuarantineError'
    ) {
      return this.quarantineEntry(entry, error.message);
    }

    const decision = this.decide(entry, error, context);
    if (decision === 'retry') {
      const attempts = entry.attempts + 1;
      if (attempts >= this.maxAttempts) {
        return this.markFailed(entry, error, attempts, 'attempts');
      }
      const nextAttemptAt = Date.now() + (this.retryAfterMs(error) ?? this.backoff(attempts));
      const next: PersistedMutationEntry = {
        ...entry,
        attempts,
        lastAttemptAt: Date.now(),
        nextAttemptAt,
        lastError: this.errorOf(error),
      };
      this.replaceEntry(next);
      this.emit({ type: 'retry', entry: next, error });
      void this.persistQuietly();
      this.scheduleReplay();
      return 'retry';
    }

    if (decision === 'auth') {
      const next: PersistedMutationEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        lastAttemptAt: Date.now(),
        lastError: this.errorOf(error),
      };
      this.replaceEntry(next);
      this.authState.set(true);
      this.paused = true;
      this.emit({ type: 'auth', entry: next });
      this.emit({ type: 'blocked', entry: next, reason: 'auth' });
      void this.persistQuietly();
      return 'auth';
    }

    return this.markFailed(entry, error, entry.attempts + 1, 'permanent');
  }

  attachRetry(id: string, retry: () => void): () => void {
    this.retryHooks.set(id, retry);
    return () => {
      if (this.retryHooks.get(id) === retry) this.retryHooks.delete(id);
    };
  }

  active(id: string): void {
    this.activeIds.add(id);
  }

  inactive(id: string): void {
    this.activeIds.delete(id);
  }

  async remove(id: string): Promise<void> {
    const entry = this.find(id);
    if (entry === undefined) return;
    this.retryHooks.delete(id);
    this.activeIds.delete(id);
    this.restoredIds.delete(id);
    this.setEntries(this.entryState().filter((candidate) => candidate.id !== id));
    this.emit({ type: 'removed', id });
    await this.persistQuietly();
    this.scheduleReplay();
  }

  /** Re-enables replay after `needsAuth` and attempts to take the queue over from another tab. */
  resume(): void {
    this.paused = false;
    this.authState.set(false);
    this.allowReplay = true;
    if (!this.ownerState() && this.started) {
      void this.retryOwnership();
      return;
    }
    this.scheduleReplay();
  }

  pause(): void {
    this.paused = true;
    this.emit({ type: 'blocked', entry: this.head(), reason: 'paused' });
  }

  /** Moves one failed entry back to pending without touching the other entries. */
  retry(id: string): void {
    const entry = this.find(id);
    if (entry === undefined) return;
    const next: PersistedMutationEntry = {
      ...entry,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: undefined,
      lastAttemptAt: undefined,
      lastError: undefined,
    };
    this.replaceEntry(next);
    void this.persistQuietly();
    this.scheduleReplay();
  }

  /** Moves every failed entry back to pending. */
  retryAll(): void {
    const next = this.entryState().map((entry) =>
      entry.state === 'failed'
        ? {
            ...entry,
            state: 'pending' as const,
            attempts: 0,
            nextAttemptAt: undefined,
            lastAttemptAt: undefined,
            lastError: undefined,
          }
        : entry,
    );
    this.setEntries(next);
    void this.persistQuietly();
    this.scheduleReplay();
  }

  /** Removes every entry. Unlike the cache, this is an explicit destructive action. */
  async clear(): Promise<void> {
    this.retryHooks.clear();
    this.activeIds.clear();
    this.restoredIds.clear();
    this.setEntries([]);
    try {
      await this.storage?.removeItem(this.key);
    } catch (error) {
      this.handleStorageError(error);
    }
    if (this.quarantined) {
      this.quarantined = false;
      this.rawSnapshot = null;
      this.enabledState.set(this.ownerState());
    }
    if (this.ownerState()) this.enabledState.set(true);
    this.scheduleReplay();
  }

  /**
   * The snapshot as JSON, for a debug screen or a support bundle. A quarantined snapshot is
   * returned byte-for-byte rather than normalized, so it can still be inspected.
   */
  export(): string {
    if (this.quarantined && this.rawSnapshot !== null) return this.rawSnapshot;
    return JSON.stringify(this.snapshot());
  }

  onEvent(listener: PersistedMutationQueueListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async initialize(): Promise<void> {
    try {
      if (!this.isBrowser) {
        this.enabledState.set(false);
        return;
      }
      this.storage = this.options.storage === undefined ? defaultStorage() : this.options.storage;
      if (this.storage === null) {
        this.warn(
          'No storage is available for the persisted mutation queue; calls will run without durability.',
        );
        this.enabledState.set(false);
        return;
      }

      const owns = await this.acquireLock();
      if (!owns) {
        this.enabledState.set(false);
        return;
      }
      this.ownerState.set(true);
      await this.hydrate();
      // Hydration is the last thing `enqueue()` needs. Let a write land durably even if the cache
      // restore gate below is still waiting on an IndexedDB read.
      this.hydratedReady.resolve();
      await this.restoreGate?.restored();
      this.allowReplay = this.options.autoReplay ?? true;
      this.detachOnline = this.online.onReconnect(() => this.scheduleReplay());
      if (this.allowReplay) this.scheduleReplay();
    } catch (error) {
      this.errorHandler.handleError(error);
      this.enabledState.set(false);
    } finally {
      // Every early return above must release both waiters; resolving a deferred twice is a no-op
      // because the promise has already settled.
      this.hydratedReady.resolve();
      this.restoreReady.resolve();
    }
  }

  private async retryOwnership(): Promise<void> {
    if (this.destroyed || this.ownerState()) return;
    try {
      if (!(await this.acquireLock())) return;
      this.ownerState.set(true);
      if (!this.hydrated) await this.hydrate();
      await this.restoreGate?.restored();
      this.enabledState.set(!this.quarantined);
      for (const handler of this.handlers.values()) this.reviewHandler(handler);
      this.allowReplay = true;
      this.scheduleReplay();
    } catch (error) {
      this.errorHandler.handleError(error);
    }
  }

  private async acquireLock(): Promise<boolean> {
    if (this.options.assumeSingleTab) return true;
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (locks === undefined) {
      this.warn(
        'The Web Locks API is unavailable. Persisted mutations are disabled; pass ' +
          '`assumeSingleTab: true` only if this application really runs in one tab.',
      );
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (value: boolean): void => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      void locks
        .request(
          `ng-signal-request:mutation-queue:${this.key}`,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (lock === null) {
              answer(false);
              return;
            }
            answer(true);
            // Hold the lock for as long as this tab owns the queue. The promise is released by
            // `destroy`, which is also when the browser would release it on navigation.
            return new Promise<void>((release) => {
              this.releaseLock = release;
            });
          },
        )
        .catch((error: unknown) => {
          this.errorHandler.handleError(error);
          answer(false);
        });
    });
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated || this.storage === null) return;
    let raw: string | null;
    try {
      raw = await this.storage.getItem(this.key);
    } catch (error) {
      this.handleStorageError(error);
      return;
    }
    if (raw === null) {
      this.hydrated = true;
      this.enabledState.set(true);
      return;
    }
    this.rawSnapshot = raw;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine('The queue snapshot is not valid JSON.');
      return;
    }

    let snapshot: unknown = parsed;
    const fromVersion = isRecord(parsed) ? parsed['version'] : undefined;
    if (typeof fromVersion === 'number' && fromVersion !== MUTATION_QUEUE_VERSION) {
      if (this.options.migrate === undefined) {
        this.quarantine(`Unsupported queue snapshot version ${String(fromVersion)}.`);
        return;
      }
      try {
        snapshot = this.options.migrate(parsed, fromVersion);
      } catch (error) {
        this.errorHandler.handleError(error);
        this.quarantine('Queue snapshot migration threw.');
        return;
      }
      if (snapshot === null) {
        this.quarantine('Queue snapshot migration returned null.');
        return;
      }
    }

    const buster = isRecord(snapshot) ? snapshot['buster'] : undefined;
    if (!isEnvelope(snapshot)) {
      this.quarantine('The queue snapshot has an invalid shape.');
      return;
    }
    if (
      this.options.buster !== undefined &&
      buster !== undefined &&
      buster !== this.options.buster
    ) {
      this.quarantine('The queue snapshot belongs to another buster.');
      return;
    }

    // One unreadable entry must not cost the whole queue. Entries are validated individually;
    // only a value the queue cannot even name quarantines the snapshot (design §15.4).
    const read: PersistedMutationEntry[] = [];
    const seenIds = new Set<string>();
    const seenSeq = new Set<number>();
    for (const candidate of snapshot.entries) {
      const parsed = readEntry(candidate);
      if (parsed === null) {
        this.quarantine('The queue snapshot contains an entry without a usable id.');
        return;
      }
      let { entry, problem } = parsed;
      if (problem === null && seenIds.has(entry.id)) problem = 'Duplicate entry id.';
      if (problem === null && seenSeq.has(entry.seq)) problem = 'Duplicate entry seq.';
      seenIds.add(entry.id);
      seenSeq.add(entry.seq);
      if (problem !== null) {
        entry = {
          ...entry,
          state: 'quarantined',
          lastError: { kind: 'corrupt', message: problem, at: Date.now() },
        };
      }
      read.push(entry);
    }

    this.setEntries(read);
    this.nextSeq = read.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
    this.hydrated = true;
    this.enabledState.set(true);
    this.emit({ type: 'restored', entries: read });
    for (const handler of this.handlers.values()) this.reviewHandler(handler);
  }

  private quarantine(reason: string): void {
    this.quarantined = true;
    this.hydrated = true;
    this.enabledState.set(false);
    this.emit({ type: 'quarantined', reason });
    this.warn(reason);
  }

  /**
   * Brings the entries of one mutation definition up to the handler's version, then runs its
   * `onRestore`.
   *
   * The migration is deliberately **synchronous**: replay is scheduled from several places
   * (hydration, registration, reconnect), and an entry that is waiting for an asynchronous
   * migration would otherwise be dispatched with the args shape the application just said it can no
   * longer read. `reviewing` marks the entry for the whole review, so `drain()` skips it.
   */
  private reviewHandler(handler: MutationQueueHandler): void {
    if (this.destroyed || this.quarantined || this.storage === null) return;

    const matching = this.entryState().filter((entry) => entry.key === handler.key);
    const reviewed: PersistedMutationEntry[] = [];
    for (const entry of matching) {
      this.reviewing.add(entry.id);
      const current = this.migrateForHandler(entry, handler);
      if (current === undefined) {
        this.reviewing.delete(entry.id);
        continue;
      }
      reviewed.push(current);
    }
    void this.runRestore(handler, reviewed);
  }

  /** Returns the entry as the handler should see it, or `undefined` when it was quarantined. */
  private migrateForHandler(
    entry: PersistedMutationEntry,
    handler: MutationQueueHandler,
  ): PersistedMutationEntry | undefined {
    if (entry.version === handler.version) return entry;

    const reason = `Entry version ${entry.version} has no migration.`;
    if (this.options.migrateEntry === undefined) {
      this.quarantineEntry(entry, reason);
      return undefined;
    }

    let migrated: PersistedMutationEntry | null;
    try {
      // The application needs the version the stored args were written with, not the version the
      // handler expects; otherwise it cannot know which shape it is being asked to upgrade.
      migrated = this.options.migrateEntry(entry, entry.version);
    } catch (error) {
      this.errorHandler.handleError(error);
      migrated = null;
    }
    if (migrated === null) {
      this.quarantineEntry(entry, reason);
      return undefined;
    }

    const current: PersistedMutationEntry = { ...migrated, version: handler.version };
    this.replaceEntry(current);
    void this.persistQuietly();
    return current;
  }

  /** Runs `onRestore` after the cache restore gate, then releases the entries for replay. */
  private async runRestore(
    handler: MutationQueueHandler,
    entries: readonly PersistedMutationEntry[],
  ): Promise<void> {
    // `onRestore` is specified to run after hydration and the cache restore gate, before replay.
    // Waiting for both is what makes the ordering true even when the handler registers during
    // application bootstrap.
    await this.restoreReady.promise;
    try {
      for (const entry of entries) {
        if (this.destroyed || this.quarantined) return;
        const current = this.find(entry.id) ?? entry;
        if (current.state !== 'pending' || handler.restore === undefined) {
          this.restoredIds.add(current.id);
          continue;
        }
        if (this.restoredIds.has(current.id)) continue;
        this.restoredIds.add(current.id);
        try {
          await handler.restore(current);
        } catch (error) {
          // A failed optimistic restore must not take the queue down. The entry is still there and
          // replay can still make the server agree.
          this.errorHandler.handleError(error);
        }
      }
    } finally {
      for (const entry of entries) this.reviewing.delete(entry.id);
      this.scheduleReplay();
    }
  }

  private quarantineEntry(entry: PersistedMutationEntry, reason: string): 'failed' {
    const next: PersistedMutationEntry = {
      ...entry,
      state: 'quarantined',
      lastError: {
        kind: 'quarantine',
        message: reason,
        at: Date.now(),
      },
    };
    this.replaceEntry(next);
    void this.persistQuietly();
    this.emit({ type: 'blocked', entry: next, reason: 'quarantined' });
    return 'failed';
  }

  private scheduleReplay(): void {
    if (
      this.destroyed ||
      !this.started ||
      !this.hydrated ||
      !this.enabledState() ||
      this.quarantined ||
      this.replaying ||
      this.replayScheduled ||
      !this.allowReplay
    ) {
      return;
    }
    if (this.paused) {
      this.emit({
        type: 'blocked',
        entry: this.head(),
        reason: this.authState() ? 'auth' : 'paused',
      });
      return;
    }
    if (this.authState()) {
      this.emit({ type: 'blocked', entry: this.head(), reason: 'auth' });
      return;
    }
    if (!this.online.online()) {
      this.emit({ type: 'blocked', entry: this.head(), reason: 'offline' });
      return;
    }
    this.replayScheduled = true;
    queueMicrotask(() => {
      this.replayScheduled = false;
      void this.drain();
    });
  }

  /**
   * `true` when replay must not start: destroyed, disabled, paused, waiting for auth, or offline.
   *
   * A method rather than an inline expression because the same condition is checked at the top of
   * `drain()` and on every loop iteration, and TypeScript narrows `this.paused` / `this.destroyed`
   * across the loop in a way that makes the second check look redundant - which it is not, because
   * the replays themselves can pause the queue.
   */
  private isStopped(): boolean {
    return (
      this.destroyed ||
      !this.enabledState() ||
      this.paused ||
      this.authState() ||
      !this.online.online()
    );
  }

  private async drain(): Promise<void> {
    if (this.replaying || this.isStopped() || !this.allowReplay) {
      return;
    }
    this.replaying = true;
    this.replayingState.set(true);
    try {
      while (!this.isStopped()) {
        this.clearNoHandlerTimer();
        const entries = this.entryState();
        let advanced = false;
        for (const entry of entries) {
          if (entry.state === 'failed') {
            if (this.options.stopOnFailure ?? true) {
              this.emit({ type: 'blocked', entry, reason: 'failed' });
              return;
            }
            continue;
          }
          if (entry.state === 'quarantined') {
            this.emit({ type: 'blocked', entry, reason: 'quarantined' });
            return;
          }
          if (this.activeIds.has(entry.id)) return;
          // An entry that is being migrated or restored is not ready to send. Waiting is the point:
          // the stored args shape is exactly what the review is about to change or reject.
          if (this.reviewing.has(entry.id)) return;

          const handler = this.handlers.get(entry.key);
          if (handler === undefined) {
            this.scheduleNoHandler(entry);
            this.emit({ type: 'blocked', entry, reason: 'no-handler' });
            return;
          }
          // Belt and braces: a review always runs after registration and hydration, so a mismatch
          // here means the review has not reached this entry yet. Sending it would use args the
          // application said it cannot read.
          if (entry.version !== handler.version) return;
          if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > Date.now()) {
            this.scheduleTimer(entry.nextAttemptAt);
            return;
          }

          const retry = this.retryHooks.get(entry.id);
          if (retry !== undefined) {
            this.activeIds.add(entry.id);
            try {
              retry();
            } catch (error) {
              this.activeIds.delete(entry.id);
              const decision = this.failed(entry.id, toError(error), {
                replay: true,
                idempotencyHeader: handler.idempotencyHeader !== false,
              });
              if (decision !== 'failed') return;
            }
            return;
          }

          let failed: Error | undefined;
          try {
            await handler.replay(entry);
          } catch (error) {
            failed = toError(error);
          }
          if (failed === undefined) {
            this.succeeded(entry.id);
            advanced = true;
            continue;
          }
          const decision = this.failed(entry.id, failed, {
            replay: true,
            idempotencyHeader: handler.idempotencyHeader !== false,
          });
          advanced = true;
          if (decision !== 'failed') return;
          if (this.options.stopOnFailure ?? true) {
            this.emit({ type: 'blocked', entry: this.find(entry.id) ?? entry, reason: 'failed' });
            return;
          }
        }
        if (!advanced) return;
      }
    } finally {
      this.replaying = false;
      this.replayingState.set(false);
    }
  }

  private decide(
    entry: PersistedMutationEntry,
    error: Error,
    context: MutationQueueFailureContext,
  ): Exclude<MutationQueueDecision, 'failed'> | 'failed' {
    const view = toRequestError(error, {
      ...(context.timeout === undefined ? {} : { timeout: context.timeout }),
      offline: !this.online.online(),
    });
    switch (view.kind) {
      case 'network':
        // The browser's own report is the only status-0 signal we trust. A status-0 failure while
        // online is a real failure, not an invitation to wait forever.
        return view.offline === true ? 'retry' : 'failed';
      case 'timeout':
        return context.idempotencyHeader ? 'retry' : 'failed';
      case 'http':
        if (view.status === 401 || view.status === 403) return 'auth';
        if (view.status === 408 || view.status === 425 || view.status === 429) return 'retry';
        if (view.status >= 500) return context.idempotencyHeader ? 'retry' : 'failed';
        return 'failed';
      case 'aborted':
        // A replay cancelled because its handle was destroyed is handled before this point. Any
        // other abort is only safe to retry when the server can deduplicate it.
        return context.idempotencyHeader ? 'retry' : 'failed';
      default:
        return 'failed';
    }
  }

  private markFailed(
    entry: PersistedMutationEntry,
    error: Error,
    attempts: number,
    _reason: 'attempts' | 'permanent',
  ): MutationQueueDecision {
    const next: PersistedMutationEntry = {
      ...entry,
      state: 'failed',
      attempts,
      lastAttemptAt: Date.now(),
      nextAttemptAt: undefined,
      lastError: this.errorOf(error),
    };
    this.replaceEntry(next);
    this.emit({ type: 'failed', entry: next, error });
    void this.persistQuietly();
    if (this.options.stopOnFailure ?? true) {
      this.emit({ type: 'blocked', entry: next, reason: 'failed' });
    } else {
      this.scheduleReplay();
    }
    return 'failed';
  }

  private shouldDefer(entry: PersistedMutationEntry): boolean {
    const earlier = this.entryState().filter((candidate) => candidate.seq < entry.seq);
    const blocked = earlier.some(
      (candidate) =>
        candidate.state === 'quarantined' ||
        (candidate.state === 'failed' && (this.options.stopOnFailure ?? true)),
    );
    const pending = earlier.some((candidate) => candidate.state === 'pending');
    return blocked || pending || this.paused || this.authState() || !this.online.online();
  }

  private isDeferred(entry: PersistedMutationEntry): boolean {
    return this.shouldDefer(entry);
  }

  private scheduleTimer(at: number): void {
    if (this.replayTimer !== undefined) clearTimeout(this.replayTimer);
    const delay = Math.max(0, at - Date.now());
    this.replayTimer = setTimeout(() => {
      this.replayTimer = undefined;
      this.scheduleReplay();
    }, delay);
  }

  private scheduleNoHandler(entry: PersistedMutationEntry): void {
    if (this.noHandlerId === entry.id && this.noHandlerTimer !== undefined) return;
    this.clearNoHandlerTimer();
    this.noHandlerId = entry.id;
    const warn = (): void => {
      if (this.warnedNoHandler.has(entry.id)) return;
      if (this.handlers.has(entry.key) || this.find(entry.id) === undefined) return;
      this.warnedNoHandler.add(entry.id);
      this.warn(
        `A persisted mutation with key "${entry.key}" has no registered handler yet; ` +
          'replay is waiting for its service.',
      );
    };
    if (this.noHandlerWarnAfterMs === 0) {
      warn();
      return;
    }
    this.noHandlerTimer = setTimeout(() => {
      this.noHandlerTimer = undefined;
      this.noHandlerId = undefined;
      warn();
    }, this.noHandlerWarnAfterMs);
  }

  private clearNoHandlerTimer(): void {
    if (this.noHandlerTimer !== undefined) {
      clearTimeout(this.noHandlerTimer);
      this.noHandlerTimer = undefined;
    }
    this.noHandlerId = undefined;
  }

  private backoff(attempts: number): number {
    // `attempts` is 1 for the first backoff. The jitter is deliberately small (80-120%) and is
    // applied after the exponential cap, so a crowd of tabs retrying one failed API does not
    // synchronize. Tests assert the retry state, not the exact millisecond.
    const exponential = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.max(0, attempts - 1));
    return Math.min(this.maxDelay, Math.round(exponential * (0.8 + Math.random() * 0.4)));
  }

  /**
   * `Retry-After`, when the failure carries readable headers.
   *
   * Deliberately duck-typed: an `HttpErrorResponse` is not the only error shape a custom backend can
   * produce, and the queue should not import the HTTP package just to read one header.
   */
  private retryAfterMs(error: Error): number | undefined {
    const headers = (error as { headers?: { get?: (name: string) => string | null } }).headers;
    const raw = headers?.get?.('Retry-After');
    if (raw === null || raw === undefined || raw.trim() === '') return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(this.maxDelay, seconds * 1_000);
    }
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    return Math.min(this.maxDelay, Math.max(0, at - Date.now()));
  }

  private errorOf(error: Error): PersistedMutationError {
    const view = toRequestError(error, { offline: !this.online.online() });
    return {
      kind: view.kind,
      ...(view.kind === 'http' ? { status: view.status } : {}),
      message: error.message,
      at: Date.now(),
    };
  }

  private snapshot(): MutationQueueSnapshot {
    return {
      version: MUTATION_QUEUE_VERSION,
      timestamp: Date.now(),
      ...(this.options.buster === undefined ? {} : { buster: this.options.buster }),
      entries: this.entryState(),
    };
  }

  private async persist(): Promise<void> {
    if (this.storage === null || this.quarantined) return;
    const raw = JSON.stringify(this.snapshot());
    const write = this.writing.then(() => this.storage?.setItem(this.key, raw));
    this.writing = write.catch(() => undefined);
    await write;
  }

  private async persistQuietly(): Promise<void> {
    try {
      await this.persist();
    } catch (error) {
      this.handleStorageError(error);
    }
  }

  private handleStorageError(error: unknown): void {
    this.errorHandler.handleError(error);
    if (this.options.onStorageError === 'fail') return;
    this.enabledState.set(false);
    if (isDevMode()) {
      console.warn(
        '[ng-signal-request/persist/queue] A queue write failed; durability is disabled for this page.',
      );
    }
  }

  private setEntries(entries: readonly PersistedMutationEntry[]): void {
    this.entryState.set([...entries].sort((a, b) => a.seq - b.seq));
  }

  private replaceEntry(entry: PersistedMutationEntry): void {
    this.setEntries(
      this.entryState().map((candidate) => (candidate.id === entry.id ? entry : candidate)),
    );
  }

  private find(id: string): PersistedMutationEntry | undefined {
    return this.entryState().find((entry) => entry.id === id);
  }

  private head(): PersistedMutationEntry | undefined {
    return this.entryState()[0];
  }

  private emit(event: PersistedMutationQueueEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.errorHandler.handleError(error);
      }
    }
  }

  private warn(message: string): void {
    if (isDevMode()) console.warn(`[ng-signal-request/persist/queue] ${message}`);
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearNoHandlerTimer();
    if (this.replayTimer !== undefined) {
      clearTimeout(this.replayTimer);
      this.replayTimer = undefined;
    }
    this.detachOnline?.();
    this.detachOnline = undefined;
    this.releaseLock?.();
    this.releaseLock = undefined;
    this.hydratedReady.resolve();
    this.restoreReady.resolve();
  }
}

/**
 * Installs the durable outbox.
 *
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [
 *     provideHttpClient(),
 *     providePersistedMutationQueue({ eager: [TodoStore] }),
 *   ],
 * });
 * ```
 *
 * `eager` is constructed before automatic replay, which matters because a mutation definition is
 * what registers the handler a hydrated entry needs in order to be rebuilt.
 */
export function providePersistedMutationQueue(
  options: PersistedMutationQueueOptions = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: PERSISTED_MUTATION_QUEUE_OPTIONS, useValue: options },
    PersistedMutationQueue,
    { provide: MUTATION_QUEUE, useExisting: PersistedMutationQueue },
    provideEnvironmentInitializer(() => {
      const queue = inject(PersistedMutationQueue);
      const errorHandler = inject(ErrorHandler);
      for (const token of options.eager ?? []) {
        try {
          inject(token);
        } catch (error) {
          errorHandler.handleError(error);
        }
      }
      queue.start();
    }),
  ]);
}
