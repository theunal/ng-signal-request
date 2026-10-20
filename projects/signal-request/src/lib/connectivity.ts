import { isPlatformBrowser } from '@angular/common';
import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  Injector,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import { noop } from './utils';

/**
 * How a request treats connectivity.
 *
 * - `'online'` — do not start while the browser reports no connection; start (or resume) once on
 *   reconnect. The request is **paused**, not failed, and its `run()` promise stays pending.
 * - `'offlineFirst'` — the first attempt always runs, because a service worker, a cache or a proxy
 *   may be able to answer it; **retries** pause while offline.
 * - `'always'` — connectivity is never consulted. This is the **default**, and it is what 0.1.x did
 *   on every path, which is why nothing changes for an application that does not opt in.
 *
 * The default is `'always'` rather than `'online'` on purpose: no code before 0.2.0 ever read
 * `navigator.onLine` before opening a connection, so making `'online'` the default would turn every
 * request that used to fire and fail loudly into one that silently waits, and would leave the
 * failure a caller was already handling never arriving. See `docs/design-0.2.md`, Phase 2.
 */
export type NetworkMode = 'online' | 'always' | 'offlineFirst';

/**
 * The seam the core reads connectivity through.
 *
 * Two outputs rather than one, because the library asks two different questions:
 *
 * - `online()` is the **state**, read before deciding whether to start something.
 * - `onReconnect(listener)` is the **event** — "a connection just appeared". A state cannot express
 *   that: on a connected machine `online()` is already `true` at start-up, so "it is true" is not a
 *   reconnect, and `refetchOnReconnect` would never fire.
 *
 * `OnlineManager` is the implementation an application gets; a test provides its own through the
 * `OnlineManager` token, which is why driving connectivity needs no browser global.
 */
export interface Connectivity {
  /** Whether the browser says there is a connection. */
  readonly online: Signal<boolean>;
  /** Calls `listener` on each reconnect. Returns the unsubscribe. */
  onReconnect(listener: () => void): () => void;
}

/**
 * The connectivity of an environment that is always online, with no listeners.
 *
 * The default for anything constructed without a {@link Connectivity} — a `CacheEntry` built
 * directly by a test, most importantly — so the absence of a manager means "never paused", which is
 * 0.1.x's behaviour and keeps the entry's own unit tests free of connectivity.
 */
export const ALWAYS_ONLINE: Connectivity = {
  online: computed(() => true),
  onReconnect: () => noop,
};

/**
 * The one place in the library that touches connectivity.
 *
 * Reads the browser's initial state from `navigator.onLine`, keeps it current from the `online` /
 * `offline` events, and re-announces reconnects to whoever asked. It is `providedIn: 'root'` and
 * injectable, so it is also the seam a test drives with `setOnline` instead of stubbing a global.
 *
 * **On the server it reads `true` and registers nothing** — no `navigator`, no `window`, no timer,
 * no listener — so `networkMode` is inert during a render and nothing holds stability.
 *
 * Like the browser itself, `online()` means "an interface is up", **not** "a request will get
 * through": a captive portal or a dropped route reports online and still fails. That caveat is
 * carried by `refetchOnReconnect` in the README and by the `offline` field on a `network` error,
 * which is a report rather than a guess.
 */
@Injectable({ providedIn: 'root' })
export class OnlineManager implements Connectivity {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly state = signal(readInitialOnline(this.isBrowser));

  readonly online: Signal<boolean> = this.state.asReadonly();

  private readonly listeners = new Set<() => void>();
  /**
   * Whether a notification microtask is already queued.
   *
   * The browser can fire `online` several times in a turn (a Wi-Fi interface comes up, then a VPN
   * does), and each of those is one reconnect as far as anything that resumes work is concerned.
   * Coalescing in one microtask turns a burst into one notification; the state itself is written
   * synchronously, because a paused fetch has to see the new value in the same turn it is released.
   */
  private announceScheduled = false;

  constructor() {
    // A server render is always online and has nobody to listen to. Returning before touching
    // `window` is what makes `vi.getTimerCount() === 0` assertable on the server platform.
    if (!this.isBrowser) return;

    const onOnline = (): void => this.apply(true);
    const onOffline = (): void => this.apply(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });
  }

  onReconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Drives connectivity without a browser: the test seam.
   *
   * `setOnline(true)` also announces a reconnect, so a test can release a paused request the same
   * way the `online` event would. `setOnline(false)` only updates the state — going offline does not
   * notify anyone, because there is nothing for a listener to do.
   *
   * A no-op on the server, for the same reason the constructor registers nothing there: a render is
   * always online, and a test seam must not be able to create a state the environment cannot reach.
   */
  setOnline(value: boolean): void {
    this.apply(value);
  }

  private apply(value: boolean): void {
    if (!this.isBrowser) return;
    this.state.set(value);
    if (!value) return;

    if (this.announceScheduled) return;
    this.announceScheduled = true;
    queueMicrotask(() => {
      this.announceScheduled = false;
      // Copied before iterating: a listener is allowed to unsubscribe itself, which it does when a
      // paused entry resumes and settles synchronously.
      for (const listener of [...this.listeners]) listener();
    });
  }
}

/**
 * The initial state, read defensively.
 *
 * Anything other than an explicit `false` means "no report", i.e. online: `navigator` is absent in
 * Node and optional in the DOM lib, and a browser that cannot say whether it is offline has not
 * said it is. This is the same reading `errors.ts` has always used for the `offline` field.
 */
function readInitialOnline(isBrowser: boolean): boolean {
  if (!isBrowser) return true;
  const navigator = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  return navigator?.onLine !== false;
}

/**
 * Connectivity for a handle that may never ask a connectivity question.
 *
 * `OnlineManager` is a browser listener, a signal and a public class; an application that leaves
 * `networkMode` at its default and does not ask for `refetchOnReconnect` should not pay for any of
 * it. Resolving through `Injector.get` rather than a constructor-time `inject` leaves the class
 * unreferenced in that case, so a production build can drop it - which is what the size probes in
 * `projects/probe` measure.
 *
 * The mode and the reconnect flag are read once, at construction, exactly like the rest of the
 * options. Passing `'always'` with reconnect off therefore means `ALWAYS_ONLINE`: no listener, no
 * `navigator` read, and `paused()` is permanently `false` - the 0.1.x behaviour.
 */
export function resolveConnectivity(
  networkMode: NetworkMode,
  refetchOnReconnect: boolean,
): Connectivity {
  if (networkMode === 'always' && !refetchOnReconnect) return ALWAYS_ONLINE;
  return inject(Injector).get(OnlineManager);
}

/**
 * What a failure should report for `RequestErrorContext.offline`.
 *
 * `undefined` when nobody is listening to connectivity, so `toRequestError` falls back to the same
 * `navigator.onLine` read 0.1.0 used. Reporting `false` there would be a claim ("the browser is
 * online") that a lazily skipped manager never made, and would change the `offline` field of every
 * default-configuration failure.
 */
export function reportedOffline(connectivity: Connectivity): boolean | undefined {
  return connectivity === ALWAYS_ONLINE ? undefined : !connectivity.online();
}
