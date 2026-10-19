import { InjectionToken, signal, type Signal } from '@angular/core';

/**
 * Whoever fills the cache from storage, seen from the side that reads it.
 *
 * A cached request cannot await anything: it builds its entry inside a `computed`, so a promise
 * there would either be ignored or make the key non-deterministic. That is why a snapshot that
 * arrives asynchronously — IndexedDB, a preloaded `fetch` — lands *after* the first mount, and the
 * mount has already started a request of its own by then. The application is then holding two
 * answers for one key with no rule for which is the truth.
 *
 * `RestoreGate` is the seam that fixes the order without teaching the core about storage. The core
 * asks one question — "is a restore in flight?" — and reads the answer as a **signal**, so the
 * fetch it held is released the moment the answer changes. `/persist` implements the interface;
 * an application with its own snapshot mechanism can implement it too and get the same ordering;
 * an application that restores nothing gets {@link IDLE_RESTORE_GATE}, which is never busy.
 *
 * The core cost of the seam is this file, one `inject` per cached request and one signal read, so a
 * request that never touches persistence pays nothing worth measuring.
 */
export interface RestoreGate {
  /**
   * `true` while a restore is in flight.
   *
   * **Read reactively, and written through a signal.** A plain property would never release the
   * fetches that are waiting on it: the only thing that restarts them is this value changing.
   */
  readonly isRestoring: Signal<boolean>;
  /**
   * Settles when the restore in flight does. Its bound elapsing counts as settling.
   *
   * **Never rejects.** A storage that fails is a restore that restored nothing, not an error to
   * hand to `run()`; a persister reports that failure by disabling itself. Resolves immediately
   * when nothing is in flight.
   */
  restored(): Promise<void>;
}

/** The gate of an application that restores nothing: never busy, never holds a fetch. */
export const IDLE_RESTORE_GATE: RestoreGate = {
  isRestoring: signal(false),
  restored: () => Promise.resolve(),
};

/**
 * The {@link RestoreGate} the cache reads. Idle unless something replaces it.
 *
 * `providePersistedCache` replaces it with a gate backed by its own persister, which is the whole
 * reason this token is in the core: an application that never persists must not pay for the
 * persistence code, and it must not have to provide anything to get the default behaviour.
 */
export const RESTORE_GATE = new InjectionToken<RestoreGate>('ng-signal-request: restore gate', {
  providedIn: 'root',
  factory: () => IDLE_RESTORE_GATE,
});
