/**
 * `ng-signal-request/persist/queue/sw` - the service-worker half of the durable mutation queue.
 *
 * The page queue owns the snapshot format, the handler registry and the Web Lock. A service worker
 * cannot import Angular or rebuild an application's request, so this entry point deliberately has
 * **no runtime dependency on the library**: the application supplies one plain replay function per
 * `persistence.key`, and this module owns everything around it - reading, validating, FIFO order,
 * retry bookkeeping and removing the entries that were actually sent.
 *
 * The page registers the sync tag through
 * `providePersistedMutationQueue({ backgroundSync: true })`. The application still owns the worker
 * file, its scope and its update lifecycle; the library never registers a service worker.
 */
import type {
  MutationQueueSnapshot,
  PersistedMutationEntry,
  PersistedMutationError,
} from 'ng-signal-request';

/** The Background Sync tag the page registers and the worker listens for. */
export const MUTATION_QUEUE_SYNC_TAG = 'ng-signal-request:mutation-queue';

/**
 * Snapshot schema this worker understands.
 *
 * Kept as a local constant rather than imported from `/persist/queue`: that module imports Angular,
 * and a service worker must not pull the framework in just to read a number. The page queue exports
 * the same value as `MUTATION_QUEUE_VERSION`; a mismatch is reported as a `version` block rather
 * than replayed with the wrong shape.
 */
export const MUTATION_QUEUE_SYNC_VERSION = 1;

const DEFAULT_QUEUE_KEY = 'ng-signal-request:mutation-queue';
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** The storage contract the page queue already implements (`CacheStorage` is structurally equal). */
export interface MutationQueueSyncStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** What a replay function needs from the queue. */
export interface MutationQueueSyncContext {
  readonly entry: PersistedMutationEntry;
  /** Send this verbatim. It is the key minted before the first attempt. */
  readonly idempotencyKey: string;
  /** `Idempotency-Key` by default; `false` when the mutation opted out of the header. */
  readonly idempotencyHeader: string | false;
}

/**
 * One application-owned replay function.
 *
 * `replay` is the only place that knows the request. It must send `context.idempotencyKey` in
 * `context.idempotencyHeader`; the helper cannot add the header because it does not build the
 * request. Throw on failure. An error with a numeric `status` is classified as HTTP; an error with
 * `kind: 'network' | 'timeout' | 'aborted'` is classified like the page queue's `RequestError`.
 */
export interface MutationQueueSyncHandler {
  /** `persistence.key` of the mutation definition. */
  readonly key: string;
  /** The args version this handler understands. Default `1`. */
  readonly version?: number;
  /** Header carrying the idempotency key. Default `Idempotency-Key`; `false` disables it. */
  readonly idempotencyHeader?: string | false;
  /** Deserializes stored args. Default: identity (the default codec stores JSON-safe args). */
  deserialize?(raw: unknown): unknown;
  /** Upgrades an entry from the version it was stored with. Return `null` to leave it blocked. */
  migrate?(entry: PersistedMutationEntry, fromVersion: number): PersistedMutationEntry | null;
  replay(args: unknown, context: MutationQueueSyncContext): Promise<void>;
}

export interface MutationQueueSyncRetryOptions {
  /** Attempts after the first one. Default `5`. */
  readonly maxAttempts?: number;
  /** First backoff in ms. Default `1_000`. */
  readonly baseDelay?: number;
  /** Backoff cap in ms. Default `30_000`. */
  readonly maxDelay?: number;
}

export interface MutationQueueSyncOptions {
  readonly storage: MutationQueueSyncStorage;
  /** Storage key. Default `ng-signal-request:mutation-queue`. */
  readonly key?: string;
  /** The same application content stamp the page queue uses. A mismatch blocks the queue. */
  readonly buster?: string;
  readonly handlers:
    readonly MutationQueueSyncHandler[] | Readonly<Record<string, MutationQueueSyncHandler>>;
  /** Stop at the first failed entry. Default `true`. */
  readonly stopOnFailure?: boolean;
  readonly retry?: MutationQueueSyncRetryOptions;
  /**
   * Take the page queue's Web Lock before draining. Default `true`.
   *
   * The lock is requested with `ifAvailable`, so a live page owner is never waited for: the page
   * can run `invalidates` and settle hooks, which the worker cannot. With no page open the lock is
   * free and the worker becomes the replay owner.
   */
  readonly lock?: boolean;
  /** Clock injection, for tests and for deterministic backoff. Default `Date.now`. */
  readonly now?: () => number;
  /** Receives one event per state change. A throwing listener is swallowed. */
  readonly onEvent?: (event: MutationQueueSyncEvent) => void;
}

export type MutationQueueSyncEvent =
  | { readonly type: 'succeeded'; readonly entry: PersistedMutationEntry }
  | { readonly type: 'removed'; readonly id: string }
  | {
      readonly type: 'retry';
      readonly entry: PersistedMutationEntry;
      readonly error: Error;
    }
  | {
      readonly type: 'failed';
      readonly entry: PersistedMutationEntry;
      readonly error: Error;
    }
  | {
      readonly type: 'blocked';
      readonly entry: PersistedMutationEntry | undefined;
      readonly reason: MutationQueueSyncBlockedReason;
    };

export type MutationQueueSyncBlockedReason =
  | 'locked'
  | 'corrupt'
  | 'version'
  | 'no-handler'
  | 'failed'
  | 'quarantined'
  | 'backoff'
  | 'auth'
  | 'offline'
  | 'storage';

export interface MutationQueueSyncResult {
  readonly status: 'empty' | 'done' | 'blocked';
  /** Entries this drain sent and removed. */
  readonly replayed: number;
  /**
   * Entries still stored when the drain stopped.
   *
   * Absent when the worker never read the queue, which is the `locked` case: a live page owns it
   * and counting its entries from here would be a second reader for no benefit.
   */
  readonly remaining?: number;
  readonly reason?: MutationQueueSyncBlockedReason;
  readonly entry?: PersistedMutationEntry;
}

export interface MutationQueueSyncRegistrationOptions {
  /** Sync tag. Default {@link MUTATION_QUEUE_SYNC_TAG}. */
  readonly tag?: string;
}

interface SyncManagerLike {
  register(tag: string): Promise<void>;
}

interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
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

function readEntry(value: unknown): PersistedMutationEntry | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const key = value['key'];
  const idempotencyKey = value['idempotencyKey'];
  const version = finiteNumber(value['version']);
  const createdAt = finiteNumber(value['createdAt']);
  const seq = finiteNumber(value['seq']);
  const attempts = finiteNumber(value['attempts']);
  const state = value['state'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof key !== 'string' ||
    key === '' ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey === '' ||
    version === null ||
    createdAt === null ||
    seq === null ||
    attempts === null ||
    (state !== 'pending' && state !== 'failed' && state !== 'quarantined')
  ) {
    return null;
  }
  const lane = value['lane'];
  if (lane !== undefined && typeof lane !== 'string') return null;
  const lastAttemptAt = finiteNumber(value['lastAttemptAt']);
  const nextAttemptAt = finiteNumber(value['nextAttemptAt']);
  const lastError = readError(value['lastError']);
  return {
    id,
    key,
    version,
    ...(value['args'] === undefined ? {} : { args: value['args'] }),
    createdAt,
    seq,
    ...(lane === undefined ? {} : { lane }),
    idempotencyKey,
    attempts,
    ...(lastAttemptAt === null ? {} : { lastAttemptAt }),
    ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
    state,
    ...(lastError === undefined ? {} : { lastError }),
  };
}

interface ReadSnapshot {
  readonly ok: true;
  readonly entries: readonly PersistedMutationEntry[];
  readonly buster: string | undefined;
}

interface BadSnapshot {
  readonly ok: false;
  readonly reason: 'corrupt' | 'version';
}

function readSnapshot(value: unknown, buster: string | undefined): ReadSnapshot | BadSnapshot {
  if (!isRecord(value)) return { ok: false, reason: 'corrupt' };
  const version = finiteNumber(value['version']);
  if (version === null) return { ok: false, reason: 'corrupt' };
  if (version !== MUTATION_QUEUE_SYNC_VERSION) return { ok: false, reason: 'version' };
  const rawEntries = value['entries'];
  if (!Array.isArray(rawEntries)) return { ok: false, reason: 'corrupt' };
  const snapshotBuster = value['buster'];
  if (snapshotBuster !== undefined && typeof snapshotBuster !== 'string') {
    return { ok: false, reason: 'corrupt' };
  }
  if (buster !== undefined && snapshotBuster !== undefined && snapshotBuster !== buster) {
    return { ok: false, reason: 'version' };
  }

  const entries: PersistedMutationEntry[] = [];
  const ids = new Set<string>();
  const seqs = new Set<number>();
  for (const candidate of rawEntries) {
    const entry = readEntry(candidate);
    // A worker is not the place to quarantine one entry and keep going: the page queue has the
    // signals and the UI for that. Leaving the raw snapshot untouched is the safe outcome.
    if (entry === null || ids.has(entry.id) || seqs.has(entry.seq)) {
      return { ok: false, reason: 'corrupt' };
    }
    ids.add(entry.id);
    seqs.add(entry.seq);
    entries.push(entry);
  }
  entries.sort((a, b) => a.seq - b.seq);
  return { ok: true, entries, buster: snapshotBuster };
}

function isHandlerList(
  value: MutationQueueSyncOptions['handlers'],
): value is readonly MutationQueueSyncHandler[] {
  return Array.isArray(value);
}

function handlerMap(
  handlers: MutationQueueSyncOptions['handlers'],
): Map<string, MutationQueueSyncHandler> {
  const map = new Map<string, MutationQueueSyncHandler>();
  const list = isHandlerList(handlers) ? handlers : Object.values(handlers);
  for (const handler of list) {
    // First definition wins, like the page registry. A duplicate key would otherwise make replay
    // depend on object enumeration order.
    if (!map.has(handler.key)) map.set(handler.key, handler);
  }
  return map;
}

function retryAfterMs(error: Error, maxDelay: number): number | undefined {
  const headers = (error as { headers?: { get?: (name: string) => string | null } }).headers;
  const raw = headers?.get?.('Retry-After');
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelay, seconds * 1_000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(maxDelay, Math.max(0, at - Date.now()));
}

function backoff(attempts: number, baseDelay: number, maxDelay: number): number {
  const exponential = Math.min(maxDelay, baseDelay * 2 ** Math.max(0, attempts - 1));
  return Math.min(maxDelay, Math.round(exponential * (0.8 + Math.random() * 0.4)));
}

type Decision = 'retry' | 'auth' | 'failed';

function classify(error: Error, idempotencyHeader: string | false): Decision {
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 408 || status === 425 || status === 429) return 'retry';
    if (status >= 500) return idempotencyHeader === false ? 'failed' : 'retry';
    return 'failed';
  }
  const kind = (error as { kind?: unknown }).kind;
  if (kind === 'timeout' || kind === 'aborted') {
    return idempotencyHeader === false ? 'failed' : 'retry';
  }
  // A network error while `navigator.onLine` is true is the same ambiguous status-0 case the page
  // treats as final. Offline is checked before the attempt and never reaches here.
  return 'failed';
}

function errorOf(error: Error): PersistedMutationError {
  const status = (error as { status?: unknown }).status;
  const kind = (error as { kind?: unknown }).kind;
  return {
    kind: typeof kind === 'string' ? kind : typeof status === 'number' ? 'http' : 'unknown',
    ...(typeof status === 'number' && Number.isFinite(status) ? { status } : {}),
    message: error.message,
    at: Date.now(),
  };
}

function blocked(
  reason: MutationQueueSyncBlockedReason,
  replayed: number,
  remaining?: number,
  entry?: PersistedMutationEntry,
): MutationQueueSyncResult {
  return {
    status: 'blocked',
    replayed,
    ...(remaining === undefined ? {} : { remaining }),
    reason,
    ...(entry === undefined ? {} : { entry }),
  };
}

/**
 * Drains the persisted queue from a service worker.
 *
 * ```ts
 * self.addEventListener('sync', (event) => {
 *   if (event.tag !== MUTATION_QUEUE_SYNC_TAG) return;
 *   event.waitUntil(drainMutationQueue({
 *     storage: indexedDbQueueStorage(),
 *     handlers: { 'todos.add': async (args, ctx) => { ... } },
 *   }));
 * });
 * ```
 *
 * The result is a summary rather than a throw for every expected stop. A missing handler, a locked
 * queue, a future backoff and an auth failure are states, not exceptions.
 */
export async function drainMutationQueue(
  options: MutationQueueSyncOptions,
): Promise<MutationQueueSyncResult> {
  const key = options.key ?? DEFAULT_QUEUE_KEY;
  const run = (): Promise<MutationQueueSyncResult> => drainUnlocked(options, key);

  if (options.lock === false) return run();
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks === undefined) return run();

  return new Promise<MutationQueueSyncResult>((resolve) => {
    void locks
      .request(
        `ng-signal-request:mutation-queue:${key}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            resolve(blocked('locked', 0));
            return;
          }
          resolve(await run());
        },
      )
      .catch(() => {
        // A lock manager that refuses the request is not a reason to risk two writers.
        resolve(blocked('locked', 0));
      });
  });
}

async function drainUnlocked(
  options: MutationQueueSyncOptions,
  key: string,
): Promise<MutationQueueSyncResult> {
  const storage = options.storage;
  const now = options.now ?? (() => Date.now());
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelay = Math.max(10, options.retry?.baseDelay ?? DEFAULT_BASE_DELAY);
  const maxDelay = Math.max(baseDelay, options.retry?.maxDelay ?? DEFAULT_MAX_DELAY);
  const stopOnFailure = options.stopOnFailure ?? true;
  const handlers = handlerMap(options.handlers);

  let raw: string | null;
  try {
    raw = await storage.getItem(key);
  } catch {
    return blocked('storage', 0, 0);
  }
  if (raw === null) return { status: 'empty', replayed: 0, remaining: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blocked('corrupt', 0, 0);
  }

  const read = readSnapshot(parsed, options.buster);
  if (!read.ok) return blocked(read.reason, 0, 0);

  const entries = [...read.entries];
  const buster = options.buster ?? read.buster;
  const persist = async (): Promise<boolean> => {
    const snapshot: MutationQueueSnapshot = {
      version: MUTATION_QUEUE_SYNC_VERSION,
      timestamp: now(),
      ...(buster === undefined ? {} : { buster }),
      entries,
    };
    try {
      await storage.setItem(key, JSON.stringify(snapshot));
      return true;
    } catch {
      return false;
    }
  };

  const emit = (event: MutationQueueSyncEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A listener is diagnostic. It must not stop the drain.
    }
  };

  const online = (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine;
  let replayed = 0;

  for (let index = 0; index < entries.length; index++) {
    let entry = entries[index];
    if (entry.state === 'quarantined') {
      emit({ type: 'blocked', entry, reason: 'quarantined' });
      return blocked('quarantined', replayed, entries.length, entry);
    }
    if (entry.state === 'failed') {
      if (stopOnFailure) {
        emit({ type: 'blocked', entry, reason: 'failed' });
        return blocked('failed', replayed, entries.length, entry);
      }
      continue;
    }

    const handler = handlers.get(entry.key);
    if (handler === undefined) {
      emit({ type: 'blocked', entry, reason: 'no-handler' });
      return blocked('no-handler', replayed, entries.length, entry);
    }

    const expectedVersion = handler.version ?? 1;
    if (entry.version !== expectedVersion) {
      if (handler.migrate === undefined) {
        emit({ type: 'blocked', entry, reason: 'version' });
        return blocked('version', replayed, entries.length, entry);
      }
      let migrated: PersistedMutationEntry | null;
      try {
        migrated = handler.migrate(entry, entry.version);
      } catch {
        migrated = null;
      }
      if (migrated === null) {
        emit({ type: 'blocked', entry, reason: 'version' });
        return blocked('version', replayed, entries.length, entry);
      }
      entry = { ...migrated, version: expectedVersion };
      entries[index] = entry;
      if (!(await persist())) return blocked('storage', replayed, entries.length, entry);
    }

    if (entry.nextAttemptAt !== undefined && entry.nextAttemptAt > now()) {
      emit({ type: 'blocked', entry, reason: 'backoff' });
      return blocked('backoff', replayed, entries.length, entry);
    }
    if (online === false) {
      emit({ type: 'blocked', entry, reason: 'offline' });
      return blocked('offline', replayed, entries.length, entry);
    }

    let args: unknown;
    try {
      args = handler.deserialize === undefined ? entry.args : handler.deserialize(entry.args);
    } catch (error) {
      const quarantined: PersistedMutationEntry = {
        ...entry,
        state: 'quarantined',
        lastError: {
          kind: 'deserialize',
          message: error instanceof Error ? error.message : String(error),
          at: now(),
        },
      };
      entries[index] = quarantined;
      emit({ type: 'blocked', entry: quarantined, reason: 'quarantined' });
      if (!(await persist())) return blocked('storage', replayed, entries.length, quarantined);
      return blocked('quarantined', replayed, entries.length, quarantined);
    }

    const idempotencyHeader = handler.idempotencyHeader ?? DEFAULT_IDEMPOTENCY_HEADER;
    const context: MutationQueueSyncContext = {
      entry,
      idempotencyKey: entry.idempotencyKey,
      idempotencyHeader,
    };

    try {
      await handler.replay(args, context);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const decision = classify(error, idempotencyHeader);
      if (decision === 'auth') {
        const next: PersistedMutationEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastAttemptAt: now(),
          lastError: errorOf(error),
        };
        entries[index] = next;
        emit({ type: 'blocked', entry: next, reason: 'auth' });
        if (!(await persist())) return blocked('storage', replayed, entries.length, next);
        return blocked('auth', replayed, entries.length, next);
      }
      if (decision === 'retry') {
        const attempts = entry.attempts + 1;
        if (attempts < maxAttempts) {
          const nextAttemptAt =
            now() + (retryAfterMs(error, maxDelay) ?? backoff(attempts, baseDelay, maxDelay));
          const next: PersistedMutationEntry = {
            ...entry,
            attempts,
            lastAttemptAt: now(),
            nextAttemptAt,
            lastError: errorOf(error),
          };
          entries[index] = next;
          emit({ type: 'retry', entry: next, error });
          if (!(await persist())) return blocked('storage', replayed, entries.length, next);
          return blocked('backoff', replayed, entries.length, next);
        }
      }

      const failedEntry: PersistedMutationEntry = {
        ...entry,
        state: 'failed',
        attempts: entry.attempts + 1,
        lastAttemptAt: now(),
        nextAttemptAt: undefined,
        lastError: errorOf(error),
      };
      entries[index] = failedEntry;
      emit({ type: 'failed', entry: failedEntry, error });
      if (!(await persist())) return blocked('storage', replayed, entries.length, failedEntry);
      if (stopOnFailure) {
        emit({ type: 'blocked', entry: failedEntry, reason: 'failed' });
        return blocked('failed', replayed, entries.length, failedEntry);
      }
      continue;
    }

    entries.splice(index, 1);
    index--;
    replayed++;
    emit({ type: 'succeeded', entry });
    emit({ type: 'removed', id: entry.id });
    if (!(await persist())) return blocked('storage', replayed, entries.length);
  }

  return { status: 'done', replayed, remaining: entries.length };
}

/**
 * Registers the Background Sync tag on an application's service worker.
 *
 * Returns `false` when the browser has no `SyncManager`; it never throws for that. The caller can
 * decide whether an unsupported browser is worth a warning. A real `register()` rejection is
 * propagated, because it is a configuration problem rather than a missing API.
 */
export async function registerMutationQueueSync(
  registration: ServiceWorkerRegistration,
  options: MutationQueueSyncRegistrationOptions = {},
): Promise<boolean> {
  const sync = (registration as { sync?: SyncManagerLike }).sync;
  if (sync === undefined) return false;
  await sync.register(options.tag ?? MUTATION_QUEUE_SYNC_TAG);
  return true;
}

const DEFAULT_DB_NAME = 'ng-signal-request';
const DEFAULT_DB_STORE = 'mutations';

export interface IndexedDbQueueStorageOptions {
  /** Database name. Default `ng-signal-request`, the page queue's default. */
  readonly database?: string;
  /** Object store name. Default `mutations`, the page queue's default. */
  readonly store?: string;
  /** Schema version. Default `1`. */
  readonly version?: number;
  /** The `IDBFactory` to use. Defaults to the global `indexedDB`. */
  readonly factory?: IDBFactory;
}

/**
 * The dependency-free IndexedDB adapter for the worker.
 *
 * It matches the page queue's defaults, so the page and the worker read the same database and
 * object store without configuration. An application that already has a storage adapter can pass
 * any {@link MutationQueueSyncStorage} instead.
 */
export function indexedDbQueueStorage(
  options: IndexedDbQueueStorageOptions = {},
): MutationQueueSyncStorage {
  const databaseName = options.database ?? DEFAULT_DB_NAME;
  const storeName = options.store ?? DEFAULT_DB_STORE;
  const schemaVersion = options.version ?? 1;
  let connection: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    if (factory === undefined) {
      return Promise.reject(
        new Error('ng-signal-request/persist/queue/sw: IndexedDB is not available.'),
      );
    }
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, schemaVersion);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          connection = undefined;
        };
        database.onclose = () => {
          connection = undefined;
        };
        resolve(database);
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB refused to open the database.'));
      request.onblocked = () =>
        reject(new Error('IndexedDB upgrade blocked by another tab with the database open.'));
    });
  };

  const db = (): Promise<IDBDatabase> => {
    if (connection === undefined) {
      const started = open();
      connection = started;
      started.catch(() => {
        if (connection === started) connection = undefined;
      });
    }
    return connection;
  };

  const withStore = <T>(
    mode: IDBTransactionMode,
    request: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    db().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(storeName, mode);
          const pending = request(transaction.objectStore(storeName));
          pending.onsuccess = () => resolve(pending.result);
          pending.onerror = () =>
            reject(pending.error ?? new Error('IndexedDB refused the request.'));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB aborted the transaction.'));
        }),
    );

  return {
    getItem: (key: string): Promise<string | null> =>
      withStore<unknown>('readonly', (store) => store.get(key) as IDBRequest<unknown>).then(
        (value) => (typeof value === 'string' ? value : null),
      ),
    setItem: (key: string, value: string): Promise<void> =>
      withStore('readwrite', (store) => store.put(value, key)).then(() => undefined),
    removeItem: (key: string): Promise<void> =>
      withStore('readwrite', (store) => store.delete(key)).then(() => undefined),
  };
}
