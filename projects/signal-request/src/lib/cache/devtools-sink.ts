import { InjectionToken } from '@angular/core';
import type { CacheEntry, FetchAttempt, RetryEvent } from './cache-entry';

/**
 * The only devtools surface the core knows about.
 *
 * History is a debugging feature, so it must not be a per-entry cost for applications that never
 * open a panel. `CacheEntry` keeps an optional reference to this interface and calls it when an
 * attempt settles, a retry is armed, or an observer subscribes. The implementation lives in the
 * separate `/devtools` entry point and owns the arrays and the `WeakMap`.
 *
 * The sink is write-only. Reads live on the `/devtools` implementation, so the core never exposes
 * a history shape it would have to keep stable.
 */
export interface DevtoolsSink {
  recordAttempt<T>(entry: CacheEntry<T>, attempt: FetchAttempt): void;
  recordRetry<T>(entry: CacheEntry<T>, retry: RetryEvent): void;
  addObserver<T>(entry: CacheEntry<T>, name: string | undefined): void;
  removeObserver<T>(entry: CacheEntry<T>, name: string | undefined): void;
}

/**
 * Installs a devtools history sink in the application injector.
 *
 * Pass `provideDevtoolsHistory()` from `ng-signal-request/devtools` to opt in. The provider must
 * be registered before the first keyed handle is created; history is not backfilled for entries
 * that already exist.
 */
export const DEVTOOLS_SINK = new InjectionToken<DevtoolsSink>('ng-signal-request: devtools sink');
