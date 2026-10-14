import type { HttpHeaders, HttpProgressEvent, HttpResourceRequest } from '@angular/common/http';
import { HttpClient, HttpEventType, type HttpEvent, type HttpResponse } from '@angular/common/http';
import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import { retry, throwError, timer, type Subscription } from 'rxjs';
import { RequestCancelledError, toError } from '../errors';
import { noop, nextRetryDelay, type NormalizedRetry } from '../utils';
import type { NormalizedKey } from './key';
import type { StructuralSharingFn } from './structural-sharing';

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
  ) {
    this.hash = key.hash;
    this.segments = key.segments;
    this.raw = key.raw;
    this.http = http;
    this.isBrowser = isBrowser;
    this.onDestroy = onDestroy;

    this.data = signal<T | undefined>(undefined);
    this.error = signal<Error | undefined>(undefined);
    this.errorTimeout = signal<number | undefined>(undefined);
    this.isFetching = signal(false);
    this.dataUpdatedAt = signal(0);
    this.updatedAt = signal(0);
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

  /** Tears the entry down and releases its timers. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    clearTimeout(this.gcTimer);
    this.gcTimer = undefined;
    this.onDestroy();
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
        resolve(shared);
      };

      const fail = (err: Error): void => {
        if (settled) return;
        finish();
        this.error.set(err);
        this.errorTimeout.set(request.timeout);
        this.updatedAt.set(Date.now());
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
            this.progress.set(raw as HttpProgressEvent);
            return;
          case HttpEventType.Response: {
            const response = raw as HttpResponse<unknown>;
            // Recorded before the body is promoted, so `statusCode()` survives a `parse` that
            // throws — a failed call still told you what the server answered.
            this.statusCode.set(response.status);
            this.headers.set(response.headers);
            succeed(response.body);
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
  return (
    typeof raw === 'object' && raw !== null && 'type' in raw && (raw as { type: unknown }).type !== undefined
  );
}

/** A rejected promise that is never left unhandled by a fire-and-forget caller. */
function rejected<T>(error: Error): Promise<T> {
  const promise = Promise.reject<T>(error);
  promise.catch(noop);
  return promise;
}