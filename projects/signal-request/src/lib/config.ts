import { EnvironmentProviders, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import type { SignalRequestConfig } from './types';

/** Global defaults. Works without any setup (empty config). */
export const SIGNAL_REQUEST_CONFIG = new InjectionToken<SignalRequestConfig>('SIGNAL_REQUEST_CONFIG', {
  providedIn: 'root',
  factory: () => ({}),
});

/**
 * Registers global defaults.
 *
 * Pass a plain object, or a **factory** — the factory runs in an injection context, so it can
 * `inject()` services and capture them for the callbacks (which themselves run outside one):
 *
 * ```ts
 * bootstrapApplication(App, {
 *   providers: [
 *     provideHttpClient(withFetch()),
 *     provideSignalRequest(() => {
 *       const toast = inject(Toast);
 *       const auth = inject(AuthStore);
 *       return {
 *         baseUrl: 'https://api.example.com',
 *         retry: 2,
 *         headers: () => ({ Authorization: `Bearer ${auth.token()}` }),
 *         onError: (e) => toast.show(e.message),
 *       };
 *     }),
 *   ],
 * });
 * ```
 */
export function provideSignalRequest(
  config: SignalRequestConfig | (() => SignalRequestConfig),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    typeof config === 'function'
      ? { provide: SIGNAL_REQUEST_CONFIG, useFactory: config }
      : { provide: SIGNAL_REQUEST_CONFIG, useValue: config },
  ]);
}
