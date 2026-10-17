import type { HttpHeaders, HttpProgressEvent, HttpResourceRequest } from '@angular/common/http';
import { type HttpClient, HttpEventType, type HttpEvent } from '@angular/common/http';
import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import { retry, throwError, timer, type Subscription } from 'rxjs';
import { RequestCancelledError, toError } from '../errors';
import { noop, nextRetryDelay, type NormalizedRetry } from '../utils';
import type { NormalizedKey } from './key';
import type { StructuralSharingFn } from './structural-sharing';

/** How a fetch ended, as reported to {@link CacheEntry.addSettleListener}. */
export type SettleOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

/**
 * A value that did not come from the network — a persisted snapshot, or a server render's transfer
 * state.
 *
 * Deliberately **constructor input** rather than a write after the fact. `QueryCache.resolve` runs
 * inside the handle's key `computed`, and Angular 22 forbids writing a signal from inside a
 * `computed` (`NG0600`). Initialising the signals with the value gives the same result with no
 * write at all, and it does so before anyone can read the entry, so there is no window in which a
 * handle sees an empty entry and starts a fetch the seed was supposed to prevent.
 */
export interface SeedValue<T> {
  readonly value: T;
  /** Epoch ms of the original fetch. Restored so `staleTime` measures real age, not a fresh copy. */
  readonly dataUpdatedAt: number;
}

/** One fetch's worth of configuration, supplied by the handle that starts it. */
export interface FetchPlan<T> {
  readonly request: HttpResourceRequest;
  readonly structuralSharing: StructuralSharingFn<T>;
  readonly retry: NormalizedRetry | undefined;
  readonly parse: ((raw: unknown) => T) | undefined;
  /** Which `HttpClient` body reader to use, from the verb variant that was called. */
  readonly responseType: 'json' | 'text' | 'blob' | 'arraybuffer';
}

/**
 * One cached resource, and the only place in the library that owns a network
 * request for a given key.
 *
 * The entry is a coordinator, not a reactive primitive. It holds the data, the
 * refcount, the in-flight request and its abort, the gc timer and the retry
 * state — and it decides *whether* to fetch, never *what a fetch means to a
 * template*. That policy stays in the handle, which is why this class is
 * deliberately free of options like `staleTime`.
 *
 * Its state is plain signals, so subscribers are `computed`s reading them and no
 * `effect()` is involved in the steady state.
 */
export class CacheEntry<T = unknown> {
  /** Map key. Derived from `key`; stable for the life of the entry. */
  readonly hash: string;
  /** Normalized segments, kept for prefix matching. See `key.ts`. */
  readonly segments: readonly string[];
  /** The caller's original key array, for predicate filters and the devtools panel. */
  readonly raw: readonly unknown[];

  readonly data: WritableSignal<T | undefined>;
  readonly error: WritableSignal<Error | undefined>;
  /**
   * Timeout of the call that produced `error`, so a deliberate timeout can be told
   * apart from a plain abort when it is classified.
   */
  readonly errorTimeout: WritableSignal<number | undefined>;
  readonly isFetching: WritableSignal<boolean>;
  /** Epoch ms of the last successful fetch, or `0` when there has never been one. */
  readonly dataUpdatedAt: WritableSignal<number>;
  /** Epoch ms of the last settled attempt, successful or not. */
  readonly updatedAt: WritableSignal<number>;
  /** How many times this entry has hit the network. */
  readonly fetchCount: WritableSignal<number>;
  /** 0 unless a retry is scheduled. */
  readonly retryAttempt: WritableSignal<number>;
  /** Latest progress event. `undefined` between events and after a settle. */
  readonly progress: WritableSignal<HttpProgressEvent | undefined>;
  /**
   * Set by `invalidate()`, cleared by the next successful fetch.
   *
   * Distinct from "stale" on purpose: an entry goes stale with the passage of
   * time, but being invalidated means something else changed the data and a fetch
   * is owed regardless of `staleTime`.
   */
  readonly invalidated: WritableSignal<boolean>;
  /**
   * `true` while the value came from `set` / `update` / `setData` rather than from a fetch.
   *
   * Only reason it exists is to keep the public `status()` honest: a local write used to report
   * `'local'` on the uncached path, and a cached handle reports the same thing rather than
   * pretending the value came from the network. Cleared by the next successful fetch.
   */
  readonly local: WritableSignal<boolean>;
  /** Response headers of the last fetch, mirroring `SignalRequest.headers`. */
  readonly headers: WritableSignal<HttpHeaders | undefined>;
  /** Status code of the last fetch, mirroring `SignalRequest.statusCode`. */
  readonly statusCode: WritableSignal<number | undefined>;
  /** True once a value has arrived. Lets a handle tell `loading` from `reloading`. */
  readonly hasData: Signal<boolean>;

  private readonly http: HttpClient;
  private readonly isBrowser: boolean;

  private observers = 0;
  private inFlight: Promise<T | undefined> | undefined;
  private subscription: Subscription | undefined;
  /** Rejects the in-flight promise when the entry is cancelled. */
  private abortCurrent: (() => void) | undefined;
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private gcMs = 0;
  private destroyed = false;

  /**
   * The last plan a subscriber registered.
   *
   * This is what makes cache-driven refetch possible: `QueryClient.invalidate()` acts on a
   * **key**, at a moment when no handle is asking for anything, so the entry needs to be able
   * to rebuild the request on its own. The handle re-registers on every evaluation of its
   * params, so the stored request is never staler than the newest subscriber's.
   *
   * Two handles with one key must therefore agree on the request — which is the same rule the
   * `key` option documents.
   */
  private plan: FetchPlan<T> | undefined;

  /**
   * Notified once per settled fetch, to every handle watching this entry.
   *
   * A listener list rather than a per-call `.then()` so that joining an in-flight fetch does not
   * produce two sets of lifecycle hooks for one network call, and so a cache-driven refetch —
   * which no handle asked for — still runs the hooks the user registered.
   */
  private readonly settleListeners = new Set<(outcome: SettleOutcome<T>) => void>();

  /**
   * Called once, when the entry tears itself down, so the cache can drop it.
   *
   * A callback rather than a back-reference to the cache: an entry holding the
   * cache would keep every other entry reachable from itself, and `gcTime` exists
   * precisely to let things be collected.
   */
  private readonly onDestroy: () => void;

  constructor(
    key: NormalizedKey,
    http: HttpClient,
    readonly debugName: string | undefined,
    isBrowser: boolean,
    onDestroy: () => void = () => {},
    seed?: SeedValue<T>,
  ) {
    this.hash = key.hash;
    this.segments = key.segments;
    this.raw = key.raw;
    this.http = http;
    this.isBrowser = isBrowser;
    this.onDestroy = onDestroy;

    // A seeded entry starts life already holding its value. Everything else stays at its empty
    // default, so a restored entry is an ordinary entry that happens to have old data: it is not
    // `local`, it is not `invalidated`, and `fetchCount` is 0 because nothing has hit the network.
    const restoredAt = seed?.dataUpdatedAt ?? 0;
    this.data = signal<T | undefined>(seed?.value);
    this.error = signal<Error | undefined>(undefined);
    this.errorTimeout = signal<number | undefined>(undefined);
    this.isFetching = signal(false);
    this.dataUpdatedAt = signal(seed === undefined ? 0 : restoredAt);
    this.updatedAt = signal(seed === undefined ? 0 : restoredAt);
    this.fetchCount = signal(0);
    this.retryAttempt = signal(0);
    this.progress = signal<HttpProgressEvent | undefined>(undefined);
    this.invalidated = signal(false);
    this.local = signal(false);
    this.headers = signal<HttpHeaders | undefined>(undefined);
    this.statusCode = signal<number | undefined>(undefined);
    this.hasData = computed(() => this.data() !== undefined);
  }

  /* --------------------------------------------------------------------- */
  /*  Subscription                                                           */
  /* --------------------------------------------------------------------- */

  /**
   * Registers an observer and returns the unsubscribe.
   *
   * `gcTime` is passed in rather than fixed at construction because it is only
   * read on the way *down* to zero observers — the moment when there is no handle
   * left to ask for it.
   *
   * Calling the returned function twice is a no-op, so a handle can hand it to a
   * `DestroyRef` without tracking whether it already ran.
   */
  subscribe(gcTime: number): () => void {
    if (this.destroyed) return noop;
    this.observers += 1;
    this.gcMs = gcTime;
    // A returning subscriber means the entry is wanted again, so the countdown stops.
    clearTimeout(this.gcTimer);
    this.gcTimer = undefined;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /** Notified once per settled fetch. Returns the unsubscribe. */
  addSettleListener(listener: (outcome: SettleOutcome<T>) => void): () => void {
    this.settleListeners.add(listener);
    return () => {
      this.settleListeners.delete(listener);
    };
  }

  /**
   * Stores the plan a subscriber would use, so a cache-driven refetch can rebuild the request.
   *
   * Cleared when the last observer leaves: an entry nobody is watching has no live request
   * description, and holding one would keep the body and headers of the last call alive.
   */
  registerPlan(plan: FetchPlan<T>): void {
    this.plan = plan;
  }

  /**
   * Fetches again using the stored plan.
   *
   * Returns `undefined` when there is nothing to fetch with — no subscriber has registered a
   * plan, so no handle is in a position to say what this request should be. Skipping is the
   * honest answer; guessing would send something the user never described.
   */
  refetch(): Promise<T | undefined> | undefined {
    if (this.destroyed || this.plan === undefined) return undefined;
    return this.fetch(this.plan);
  }

  /** The stored plan, or `undefined`. Devtools and tests. */
  get hasPlan(): boolean {
    return this.plan !== undefined;
  }

  /** Observer count. Surfaced by the devtools panel and asserted by the leak tests. */
  get observerCount(): number {
    return this.observers;
  }

  /** Entries with no observer left, which is when the gc timer is armed. */
  get isIdle(): boolean {
    return this.observers === 0;
  }

  private release(): void {
    this.observers = Math.max(0, this.observers - 1);
    if (this.observers > 0) return;

    // Nobody is watching, so nothing is in a position to describe a later refetch,
    // and nobody is left to tell that a fetch settled.
    this.plan = undefined;
    this.settleListeners.clear();

    // The last observer left. The entry keeps whatever it already delivered, but
    // the request it is waiting on has nobody to deliver to — so it is cancelled.
    // A later subscriber refetches; cached data, if any, is untouched.
    this.cancel();
    this.armGcTimer();
  }

  private armGcTimer(): void {
    // A server-side timer would only hold stability, so it never runs there.
    if (!this.isBrowser) return;
    if (this.gcMs <= 0) {
      this.destroy();
      return;
    }
    this.gcTimer = setTimeout(() => this.destroy(), this.gcMs);
  }

  /**
   * Tears the entry down and releases its timers. Idempotent.
   *
   * Writes signals, through `cancel()`. That is why {@link evict} exists: `QueryCache.resolve` runs
   * inside a handle's key `computed`, and it is where `maxEntries` eviction happens, so eviction
   * cannot come through here.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.plan = undefined;
    this.settleListeners.clear();
    this.cancel();
    this.teardown();
  }

  /**
   * `destroy()` for an entry with **nothing in flight**, and therefore without a single signal write.
   *
   * Only valid where `observerCount === 0 && !isFetching()` — the entries the cache is allowed to
   * take. For those, `cancel()` had nothing left to do: an entry loses its last observer through
   * `release()`, which cancels on the way out, and the eviction selector refuses anything with a
   * request in flight. Skipping it is what makes eviction callable from `resolve`, which runs inside
   * a `computed`, where writing a signal is `NG0600`.
   */
  evict(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.plan = undefined;
    this.settleListeners.clear();
    this.teardown();
  }

  /** The tail `destroy()` and `evict()` share: a timer to clear, and an owner to tell. */
  private teardown(): void {
    clearTimeout(this.gcTimer);
    this.gcTimer = undefined;
    this.onDestroy();
  }

  /**
   * Tells every watching handle how the fetch ended.
   *
   * Copied before iterating, because a listener is allowed to unsubscribe itself — which it
   * does whenever its injector is destroyed, and that can happen from inside a settle if the
   * handler tears the component down.
   */
  private notifySettle(outcome: SettleOutcome<T>): void {
    for (const listener of [...this.settleListeners]) listener(outcome);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /* --------------------------------------------------------------------- */
  /*  Fetching                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * Runs one fetch, or joins the one already running.
   *
   * The early return **is** the dedup: two components mounting on the same key
   * call this microseconds apart and the second one joins the first's promise
   * instead of opening a second connection.
   */
  fetch(plan: FetchPlan<T>): Promise<T | undefined> {
    if (this.destroyed) {
      return rejected(new RequestCancelledError('The query was removed from the cache.'));
    }
    if (this.inFlight) return this.inFlight;

    this.isFetching.set(true);
    this.error.set(undefined);
    this.errorTimeout.set(undefined);
    this.retryAttempt.set(0);
    this.updatedAt.set(Date.now());
    this.fetchCount.update((n) => n + 1);

    const promise = this.execute(plan);
    this.inFlight = promise;
    // The slot has to be cleared before any new fetch can start, or the next
    // caller would join an already-settled promise.
    const clear = (): void => {
      if (this.inFlight === promise) this.inFlight = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  /** The in-flight promise, or `undefined`. Devtools and tests only. */
  get pending(): Promise<T | undefined> | undefined {
    return this.inFlight;
  }

  private execute(plan: FetchPlan<T>): Promise<T | undefined> {
    const { request } = plan;
    let stream = this.http.request<unknown>(request.method ?? 'GET', request.url, {
      ...request,
      // `events` is what makes `reportProgress: true` observable. Without it the
      // body arrives bare and the progress events are swallowed.
      observe: 'events',
      responseType: plan.responseType,
    } as never);

    if (plan.retry) {
      const policy = plan.retry;
      stream = stream.pipe(
        retry({
          delay: (err: unknown, attemptNo: number) => {
            const delay = nextRetryDelay(policy, attemptNo, toError(err));
            if (delay === undefined) return throwError(() => err);
            // Reporting the attempt here is what keeps `retryAttempt()` honest
            // without a separate supervisor.
            this.retryAttempt.set(attemptNo);
            return timer(delay);
          },
        }),
      );
    }

    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false;

      const finish = (): void => {
        settled = true;
        this.subscription = undefined;
        this.abortCurrent = undefined;
        this.isFetching.set(false);
        this.retryAttempt.set(0);
        // A settled call has no progress left to report; leaving it behind would
        // pin a `<progress>` element at its final value.
        this.progress.set(undefined);
      };

      const succeed = (raw: unknown): void => {
        if (settled) return;
        let value: T;
        try {
          value = plan.parse ? plan.parse(raw) : (raw as T);
        } catch (e) {
          fail(toError(e));
          return;
        }
        finish();

        // Sharing runs *before* the write: an unchanged response must not touch
        // the signal at all, or every consumer re-renders for nothing.
        const previous = untracked(this.data);
        const shared = plan.structuralSharing(previous, value);
        const now = Date.now();
        if (!Object.is(shared, previous)) {
          this.data.set(shared);
          this.dataUpdatedAt.set(now);
        }
        this.updatedAt.set(now);
        this.invalidated.set(false);
        this.local.set(false);
        this.notifySettle({ ok: true, value: shared });
        resolve(shared);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        finish();
        this.error.set(err);
        this.errorTimeout.set(request.timeout);
        this.updatedAt.set(Date.now());
        this.notifySettle({ ok: false, error: err });
        reject(err);
      };

      const onEvent = (raw: unknown): void => {
        if (!isHttpEvent(raw)) {
          succeed(raw); // defensive: no `HttpEvent` wrapper
          return;
        }
        switch (raw.type) {
          case HttpEventType.UploadProgress:
          case HttpEventType.DownloadProgress:
            this.progress.set(raw);
            return;
          case HttpEventType.Response: {
            // Recorded before the body is promoted, so `statusCode()` survives a `parse` that
            // throws — a failed call still told you what the server answered.
            this.statusCode.set(raw.status);
            this.headers.set(raw.headers);
            succeed(raw.body);
            return;
          }
          default:
            return; // `Sent` and anything else carry no body
        }
      };

      // Without this, a cancelled fetch would leave `run()` awaiting a promise that
      // can never settle. Cancelling has to reject, not abandon.
      this.abortCurrent = () => {
        if (settled) return;
        finish();
        reject(new RequestCancelledError());
      };

      this.subscription = stream.subscribe({ next: onEvent, error: (e) => fail(toError(e)) });
      // A custom `HttpBackend` may answer synchronously, in which case `finish()` has already run
      // and left the completed subscription behind. The type checker narrows `settled` to `false`
      // because it cannot see that the callback ran inside `subscribe`.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (settled) this.subscription.unsubscribe();
    });
  }

  /**
   * Aborts the in-flight request, if any.
   *
   * Unsubscribing is what actually cancels the network call for Angular's fetch
   * backend, so the subscription *is* the abort handle — no `AbortController`
   * needed, and nothing leaks into the request context.
   */
  cancel(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.abortCurrent?.();
    this.abortCurrent = undefined;
    this.inFlight = undefined;
    this.isFetching.set(false);
    this.retryAttempt.set(0);
    this.progress.set(undefined);
  }

  /* --------------------------------------------------------------------- */
  /*  Local writes                                                           */
  /* --------------------------------------------------------------------- */

  /**
   * Writes a value without touching the network (`set` / `update` / `setData`).
   *
   * `updatedAt` moves so the entry is no longer stale, and `invalidated` is
   * cleared: a local write *is* the new truth until something says otherwise.
   */
  setData(value: T): T {
    const now = Date.now();
    this.data.set(value);
    this.dataUpdatedAt.set(now);
    this.updatedAt.set(now);
    this.invalidated.set(false);
    this.local.set(true);
    this.error.set(undefined);
    return value;
  }

  /** Marks the entry as owing a fetch, whatever `staleTime` says. */
  markInvalidated(): void {
    this.invalidated.set(true);
  }

  /**
   * Applies a value that came from somewhere other than a fetch — a persisted snapshot, or a server
   * render's transfer state — to an entry that **already exists**.
   *
   * A new entry takes its seed through the constructor instead ({@link SeedValue}), because
   * `restore` writes signals and creation happens inside a `computed`. This method is the other half
   * of that pair, for the case where the cache already holds the key when the snapshot arrives.
   *
   * Deliberately **not** `setData`, which is right for a user edit and wrong here in two ways that
   * would both be silent bugs. `setData` stamps `Date.now()`, so restored data would look freshly
   * fetched and `staleTime` would never expire it; and it sets `local`, so restored data would
   * report as a local write — which is what `status()` says, what optimistic mutations look like,
   * and what the devtools panel would show. Here the original fetch time is restored with the value
   * and the entry stays an ordinary fetched entry that happens to be old.
   */
  restore(value: T, dataUpdatedAt: number): void {
    this.data.set(value);
    this.dataUpdatedAt.set(dataUpdatedAt);
    this.updatedAt.set(dataUpdatedAt);
    this.error.set(undefined);
    this.errorTimeout.set(undefined);
    this.invalidated.set(false);
  }

  /**
   * Whether `staleTime` has elapsed since the last value.
   *
   * Plain rather than a `computed`: freshness depends on the wall clock, and a
   * computed would have to be woken by a timer to notice the passage of time.
   * Reading it on demand is correct and free.
   */
  isStale(staleTime: number): boolean {
    const updatedAt = untracked(this.dataUpdatedAt);
    if (updatedAt === 0) return true; // never fetched: always worth a fetch
    if (untracked(this.invalidated)) return true;
    return Date.now() - updatedAt >= staleTime;
  }
}

function isHttpEvent(raw: unknown): raw is HttpEvent<unknown> {
  return typeof raw === 'object' && raw !== null && 'type' in raw && raw.type !== undefined;
}

/** A rejected promise that is never left unhandled by a fire-and-forget caller. */
function rejected<T>(error: Error): Promise<T> {
  const promise = Promise.reject<T>(error);
  promise.catch(noop);
  return promise;
}
