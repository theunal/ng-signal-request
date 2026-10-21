import type { HttpHeaders, HttpProgressEvent, HttpResourceRequest } from '@angular/common/http';
import { type HttpClient, HttpEventType, type HttpEvent } from '@angular/common/http';
import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import {
  defer,
  from,
  isObservable,
  Observable,
  retry,
  throwError,
  timer,
  type Subscription,
} from 'rxjs';
import { ALWAYS_ONLINE, type Connectivity, type NetworkMode } from '../connectivity';
import { RequestCancelledError, toError } from '../errors';
import { noop, nextRetryDelay, type NormalizedRetry } from '../utils';
import type { DevtoolsSink } from './devtools-sink';
import type { NormalizedKey } from './key';
import type { StructuralSharingFn } from './structural-sharing';

/** How a fetch ended, as reported to {@link CacheEntry.addSettleListener}. */
export type SettleOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

/** The two halves of a promise, kept apart so a held fetch can be settled by whoever releases it. */
interface HeldSettle<T> {
  readonly resolve: (value: T | undefined) => void;
  readonly reject: (error: Error) => void;
}

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

/** How a fetch ended. `aborted` is a cancel, not a failure, but it is still an attempt. */
export type FetchOutcome = 'success' | 'error' | 'aborted';

/**
 * One settled fetch on an entry, for the devtools panel.
 *
 * A fetch can contain retries; `durationMs` is the total wall time of the attempt that
 * `run()` was waiting on, and the retries are reported separately by {@link RetryEvent}.
 */
export interface FetchAttempt {
  /** Epoch ms when the fetch started — the same instant `updatedAt` records. */
  readonly startedAt: number;
  /** Wall time until the attempt settled, in ms. */
  readonly durationMs: number;
  /** How the attempt ended. An abort is recorded, because it was still an attempt. */
  readonly outcome: FetchOutcome;
}

/** One scheduled retry: the attempt number the retry policy counted and when it was armed. */
export interface RetryEvent {
  /** Epoch ms when the retry was scheduled (not when it eventually ran). */
  readonly at: number;
  /** 1-based retry number, the same value `retryAttempt()` reports while it is pending. */
  readonly attempt: number;
}

/** Fields both kinds of plan share. */
export interface BaseFetchPlan<T> {
  readonly structuralSharing: StructuralSharingFn<T>;
  readonly retry: NormalizedRetry | undefined;
  readonly parse: ((raw: unknown) => T) | undefined;
  /**
   * How this fetch treats connectivity. Optional, and `undefined` means `'always'`.
   *
   * It travels in the plan rather than in the constructor because the mode is a property of the
   * *request*, and the entry already stores the newest plan so a cache-driven refetch can rebuild
   * it. Two handles on one key therefore share the newest plan's mode — the same rule they already
   * follow for the request itself.
   */
  readonly networkMode?: NetworkMode;
}

/** One HTTP fetch's worth of configuration, supplied by the handle that starts it. */
export interface FetchPlan<T> extends BaseFetchPlan<T> {
  /** Absent on plans built before `createQuery` existed; treated as `'http'`. */
  readonly kind?: 'http';
  readonly request: HttpResourceRequest;
  /** Which `HttpClient` body reader to use, from the verb variant that was called. */
  readonly responseType: 'json' | 'text' | 'blob' | 'arraybuffer';
}

/**
 * One `createQuery` fetch's worth of configuration.
 *
 * `run` is called once per attempt with the entry's `AbortSignal`, so a retry re-invokes the
 * caller's function instead of resubscribing a promise that has already settled. The result may be
 * a `Promise` or an `Observable`; an Observable's **first** emission is the value and the entry
 * unsubscribes after it. Streaming is not part of 0.2.0.
 */
export interface QueryFetchPlan<T> extends BaseFetchPlan<T> {
  readonly kind: 'query';
  readonly run: (signal: AbortSignal) => Promise<T> | Observable<T>;
}

/** Either transport. `CacheEntry.fetch` accepts both; the stored plan is what `invalidate()` runs. */
export type EntryPlan<T> = FetchPlan<T> | QueryFetchPlan<T>;

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
  /**
   * Set while the entry is waiting for a connection rather than for a response.
   *
   * Two situations set it: a `networkMode: 'online'` fetch that has not started, and a retry that is
   * waiting to be let out. In both cases the entry is not failing and its `run()` promise is still
   * pending, so `status` alone would look like an ordinary slow request — which is why this is a
   * separate signal. It is deliberately **not** a `RequestStatus` member: a status is what the data
   * is, and being paused is why nothing is happening.
   */
  readonly paused: WritableSignal<boolean>;

  private readonly http: HttpClient;
  private readonly isBrowser: boolean;
  private readonly connectivity: Connectivity;

  private observers = 0;
  private inFlight: Promise<T | undefined> | undefined;
  private subscription: Subscription | undefined;
  /** Rejects the in-flight promise when the entry is cancelled. */
  private abortCurrent: (() => void) | undefined;
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private gcMs = 0;
  private destroyed = false;

  /**
   * The optional devtools sink. The only devtools field in the entry: history arrays and observer
   * names belong to the `/devtools` implementation, behind a `WeakMap` keyed by this entry.
   */
  private readonly sink: DevtoolsSink | undefined;
  /** Epoch ms of the attempt in flight, or `0` when nothing is running. */
  private attemptStartedAt = 0;
  /** Whether the current value came from a seed/restore rather than a fetch or a local write. */
  private seededValue: boolean;

  /**
   * The held fetch, when the entry is paused before its first attempt.
   *
   * Held as a promise rather than as a plan-and-a-flag so the existing dedup keeps working: `inFlight`
   * points at this promise, so a second handle on the same key **joins** it instead of starting a
   * request of its own. A paused entry and a fetching entry look identical to the dedup, which is
   * exactly what "one request per key" needs.
   */
  private held:
    { readonly promise: Promise<T | undefined>; readonly settle: HeldSettle<T> } | undefined;
  private heldPlan: EntryPlan<T> | undefined;
  private detachHold: (() => void) | undefined;

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
  private plan: EntryPlan<T> | undefined;

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
    /**
     * Where connectivity is read from. Defaults to {@link ALWAYS_ONLINE}, so an entry built without
     * one — every existing unit test, and any construction outside the cache — is never paused.
     *
     * Trailing and optional rather than required: the entry is constructed positionally by
     * `QueryCache`, and a required parameter here would have been a change to a public constructor
     * for a feature most applications never enable.
     */
    connectivity: Connectivity = ALWAYS_ONLINE,
    /**
     * Devtools history, when `provideDevtoolsHistory()` installed one. Optional for the same reason
     * as `connectivity`: no sink means no history, not a guaranteed per-entry allocation.
     */
    sink?: DevtoolsSink,
  ) {
    this.hash = key.hash;
    this.segments = key.segments;
    this.raw = key.raw;
    this.http = http;
    this.isBrowser = isBrowser;
    this.onDestroy = onDestroy;
    this.connectivity = connectivity;
    this.sink = sink;

    // A seeded entry starts life already holding its value. Everything else stays at its empty
    // default, so a restored entry is an ordinary entry that happens to have old data: it is not
    // `local`, it is not `invalidated`, and `fetchCount` is 0 because nothing has hit the network.
    const restoredAt = seed?.dataUpdatedAt ?? 0;
    this.seededValue = seed !== undefined;
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
    this.paused = signal(false);
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
   * `debugName` is optional and goes only to the devtools sink; it does not affect the count,
   * the gc timer or anything the request does.
   *
   * Calling the returned function twice is a no-op, so a handle can hand it to a
   * `DestroyRef` without tracking whether it already ran.
   */
  subscribe(gcTime: number, debugName?: string): () => void {
    if (this.destroyed) return noop;
    this.sink?.addObserver(this, debugName);
    this.observers += 1;
    this.gcMs = gcTime;
    // A returning subscriber means the entry is wanted again, so the countdown stops.
    clearTimeout(this.gcTimer);
    this.gcTimer = undefined;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sink?.removeObserver(this, debugName);
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
  registerPlan(plan: EntryPlan<T>): void {
    this.plan = plan;
  }

  /** Which factory registered the stored plan, or `undefined` before the first registration. */
  get planKind(): 'http' | 'query' | undefined {
    if (this.plan === undefined) return undefined;
    return this.plan.kind === 'query' ? 'query' : 'http';
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

  /**
   * Whether the value on screen came from a persisted seed / transfer rather than a fetch or a local
   * write. Cleared by a successful fetch or `setData`, set again by `restore`.
   */
  get seeded(): boolean {
    return this.seededValue;
  }

  private recordAttempt(outcome: FetchOutcome): void {
    if (this.attemptStartedAt === 0) return;
    const startedAt = this.attemptStartedAt;
    // Consume the start time: a settled attempt must never be recorded twice, even if a late abort
    // reaches `finish` after a newer fetch has already reset the field.
    this.attemptStartedAt = 0;
    this.sink?.recordAttempt(this, {
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
    });
  }

  private recordRetry(attempt: number): void {
    this.sink?.recordRetry(this, { at: Date.now(), attempt });
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
   * Runs one fetch, joins the one already running, or **holds** until the browser is online.
   *
   * The early return **is** the dedup: two components mounting on the same key
   * call this microseconds apart and the second one joins the first's promise
   * instead of opening a second connection. A held fetch participates in that — it puts its own
   * promise in `inFlight` — so "paused" and "fetching" are one state to everyone outside the entry.
   */
  fetch(plan: EntryPlan<T>): Promise<T | undefined> {
    if (this.destroyed) {
      return rejected(new RequestCancelledError('The query was removed from the cache.'));
    }
    if (this.inFlight) return this.inFlight;
    if (this.shouldHold(plan)) return this.hold(plan);
    return this.start(plan);
  }

  /**
   * Whether this fetch must wait for a connection.
   *
   * Connectivity is read through `untracked`: `fetch` runs from a handle's effect, and a tracked
   * read would make every connectivity flip re-run that effect. The entry reacts to connectivity
   * through its own `onReconnect` subscription instead, which is one notification rather than one
   * per handle.
   */
  private shouldHold(plan: EntryPlan<T>): boolean {
    return plan.networkMode === 'online' && !this.isOnline();
  }

  private isOnline(): boolean {
    return untracked(this.connectivity.online);
  }

  /**
   * Parks the fetch until the next reconnect, and returns the promise that will settle then.
   *
   * The held promise is stored as `inFlight`, so joining, `pending`, `cancel()` and the last-observer
   * teardown all behave exactly as they do for a fetch in flight: losing the last observer cancels a
   * paused request the same way it cancels a running one.
   */
  private hold(plan: EntryPlan<T>): Promise<T | undefined> {
    this.paused.set(true);
    this.heldPlan = plan;

    let settle!: HeldSettle<T>;
    const promise = new Promise<T | undefined>((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.held = { promise, settle };
    this.detachHold = this.connectivity.onReconnect(() => this.resume());

    this.inFlight = promise;
    const clear = (): void => {
      if (this.inFlight === promise) this.inFlight = undefined;
    };
    promise.then(clear, clear);
    return promise;
  }

  /**
   * Releases a held fetch: starts it, once.
   *
   * Synchronous up to the call to `start`, which puts its own promise in `inFlight` before returning
   * — so if two things react to the same reconnect, the second one joins the request the first
   * started rather than opening a connection of its own. That is what makes "one refetch per
   * reconnect" fall out of the dedup instead of needing a guard.
   */
  private resume(): void {
    const held = this.held;
    if (held === undefined) return;

    this.held = undefined;
    this.detachHold?.();
    this.detachHold = undefined;
    this.paused.set(false);
    if (this.inFlight === held.promise) this.inFlight = undefined;

    const plan = this.heldPlan;
    this.heldPlan = undefined;

    if (this.destroyed) {
      held.settle.reject(new RequestCancelledError('The query was removed from the cache.'));
      return;
    }
    if (plan === undefined) {
      held.settle.resolve(undefined);
      return;
    }

    this.start(plan).then(held.settle.resolve, held.settle.reject);
  }

  private start(plan: EntryPlan<T>): Promise<T | undefined> {
    const now = Date.now();
    this.attemptStartedAt = now;
    this.isFetching.set(true);
    this.error.set(undefined);
    this.errorTimeout.set(undefined);
    this.retryAttempt.set(0);
    this.updatedAt.set(now);
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

  private execute(plan: EntryPlan<T>): Promise<T | undefined> {
    return plan.kind === 'query' ? this.executeQuery(plan) : this.executeHttp(plan);
  }

  /**
   * Applies the retry policy to whichever transport produced the stream.
   *
   * Shared rather than copied: "wait for a connection instead of arming a clock" is the same
   * question whether the attempt was an HTTP call or a function.
   */
  private withRetry<V>(stream: Observable<V>, plan: EntryPlan<T>): Observable<V> {
    if (!plan.retry) return stream;
    const policy = plan.retry;
    // `'always'` never consults connectivity, so only the other two modes can pause a retry.
    const pauseRetries = (plan.networkMode ?? 'always') !== 'always';
    return stream.pipe(
      retry({
        delay: (err: unknown, attemptNo: number) => {
          const delay = nextRetryDelay(policy, attemptNo, toError(err));
          if (delay === undefined) return throwError(() => err);
          // The attempt is spent **only** on the branch that arms a timer. Offline, the retry waits
          // for a connection instead of counting down a clock that is not running, and `paused`
          // is what says so — `retryAttempt()` staying at 0 is the honest reading, because no
          // retry is scheduled.
          if (pauseRetries && !this.isOnline()) return this.waitForReconnect();
          // Reporting the attempt here is what keeps `retryAttempt()` honest
          // without a separate supervisor.
          this.retryAttempt.set(attemptNo);
          this.recordRetry(attemptNo);
          return timer(delay);
        },
      }),
    );
  }

  /**
   * The settlement closures every transport shares.
   *
   * `settled` is the late-write guard: `cancel()` settles before it aborts or unsubscribes, so a
   * promise that resolves anyway, or an Observable that emits after teardown, cannot touch the
   * entry. `timeout` is the HTTP request's, and `undefined` for a query.
   */
  private settler(
    plan: EntryPlan<T>,
    timeout: number | undefined,
    resolve: (value: T | undefined) => void,
    reject: (error: Error) => void,
  ): {
    succeed(raw: unknown): void;
    fail(error: Error): void;
    abort(error?: Error): void;
    readonly settled: boolean;
  } {
    let settled = false;

    const finish = (outcome: FetchOutcome): void => {
      settled = true;
      this.subscription = undefined;
      this.abortCurrent = undefined;
      this.isFetching.set(false);
      this.retryAttempt.set(0);
      this.recordAttempt(outcome);
      // A settled call has no progress left to report; leaving it behind would
      // pin a `<progress>` element at its final value.
      this.progress.set(undefined);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      finish('error');
      this.error.set(err);
      this.errorTimeout.set(timeout);
      this.updatedAt.set(Date.now());
      this.notifySettle({ ok: false, error: err });
      reject(err);
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
      finish('success');

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
      this.seededValue = false;
      this.invalidated.set(false);
      this.local.set(false);
      this.notifySettle({ ok: true, value: shared });
      resolve(shared);
    };

    return {
      succeed,
      fail,
      abort(error: Error = new RequestCancelledError()): void {
        if (settled) return;
        finish('aborted');
        reject(error);
      },
      get settled(): boolean {
        return settled;
      },
    };
  }

  private executeHttp(plan: FetchPlan<T>): Promise<T | undefined> {
    const { request } = plan;
    const stream = this.withRetry(
      this.http.request<unknown>(request.method ?? 'GET', request.url, {
        ...request,
        // `events` is what makes `reportProgress: true` observable. Without it the
        // body arrives bare and the progress events are swallowed.
        observe: 'events',
        responseType: plan.responseType,
      } as never),
      plan,
    );

    return new Promise<T | undefined>((resolve, reject) => {
      const settle = this.settler(plan, request.timeout, resolve, reject);

      const onEvent = (raw: unknown): void => {
        if (!isHttpEvent(raw)) {
          settle.succeed(raw); // defensive: no `HttpEvent` wrapper
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
            settle.succeed(raw.body);
            return;
          }
          default:
            return; // `Sent` and anything else carry no body
        }
      };

      // Without this, a cancelled fetch would leave `run()` awaiting a promise that
      // can never settle. Cancelling has to reject, not abandon.
      this.abortCurrent = () => settle.abort();

      this.subscription = stream.subscribe({
        next: onEvent,
        error: (e) => settle.fail(toError(e)),
      });
      // A custom `HttpBackend` may answer synchronously, in which case `finish()` has already run
      // and left the completed subscription behind.
      if (settle.settled) this.subscription.unsubscribe();
    });
  }

  /**
   * Runs a `createQuery` source.
   *
   * `defer` is deliberate: `retry` resubscribes the stream, and for a function-based source a
   * resubscription must **call the function again**. Subscribing a promise twice would retry
   * nothing, because the promise's rejection is already decided. The `AbortController` is
   * per-fetch and survives retries, so `cancel()` still aborts the attempt in progress.
   */
  private executeQuery(plan: QueryFetchPlan<T>): Promise<T | undefined> {
    const controller = new AbortController();

    return new Promise<T | undefined>((resolve, reject) => {
      const settle = this.settler(plan, undefined, resolve, reject);
      let unsubscribe: () => void = noop;

      this.abortCurrent = (): void => {
        settle.abort();
        controller.abort();
        unsubscribe();
      };

      const source = defer(() => {
        const produced = plan.run(controller.signal);
        return isObservable(produced) ? produced : from(produced);
      });

      const subscription = this.withRetry(source, plan).subscribe({
        next: (value) => {
          settle.succeed(value);
          unsubscribe();
        },
        error: (e) => settle.fail(toError(e)),
        complete: () => {
          if (!settle.settled) {
            settle.fail(new Error('The query completed without emitting a value.'));
          }
        },
      });
      unsubscribe = () => subscription.unsubscribe();
      this.subscription = subscription;
      if (settle.settled) subscription.unsubscribe();
    });
  }

  /**
   * Aborts the in-flight request, if any, and releases a held fetch.
   *
   * Unsubscribing is what actually cancels the network call for Angular's fetch
   * backend, so the subscription *is* the abort handle — no `AbortController`
   * needed, and nothing leaks into the request context.
   */
  cancel(): void {
    this.releaseHold(new RequestCancelledError());
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.abortCurrent?.();
    this.abortCurrent = undefined;
    this.inFlight = undefined;
    this.isFetching.set(false);
    this.retryAttempt.set(0);
    this.progress.set(undefined);
  }

  /**
   * Lets go of a held fetch, rejecting it.
   *
   * Everything a hold allocated is released here — the reconnect listener and the promise — so a
   * `cancel()` or a last-observer teardown while paused leaves no listener and no timer behind. The
   * `paused` flag is cleared first, because the rejection is what a waiting `run()` sees and it
   * should not be able to observe a paused entry with a settled promise.
   */
  private releaseHold(error: Error): void {
    const held = this.held;
    if (held === undefined) return;

    this.held = undefined;
    this.heldPlan = undefined;
    this.detachHold?.();
    this.detachHold = undefined;
    this.paused.set(false);
    if (this.inFlight === held.promise) this.inFlight = undefined;
    held.settle.reject(error);
  }

  /**
   * An observable that **emits** on the next reconnect, without arming a timer.
   *
   * `retry`'s `delay` callback is asked for a notifier: a `next` makes it resubscribe to the source,
   * which is the retry. Completion is *not* the same thing — a notifier that completes without
   * emitting ends the whole stream, so the call would never be retried at all.
   *
   * The teardown detaches the listener and clears `paused`, and `retry` unsubscribes the notifier as
   * soon as it emits — so the flag never outlives the wait. That is also what makes cancelling
   * mid-pause tidy: the subscription is the only thing holding the listener.
   */
  private waitForReconnect(): Observable<void> {
    return new Observable<void>((subscriber) => {
      this.paused.set(true);
      const detach = this.connectivity.onReconnect(() => subscriber.next());
      return () => {
        detach();
        this.paused.set(false);
      };
    });
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
    this.seededValue = false;
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
    this.seededValue = true;
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
