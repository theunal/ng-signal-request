import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { EnvironmentProviders, Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';

export interface TestSetup {
  readonly http: HttpTestingController;
  /** Runs `fn` in the root injection context of the testing module. */
  readonly create: <T>(fn: () => T) => T;
}

/**
 * Configures `TestBed` with `HttpClient` + the testing backend and any extra providers.
 * Call once per test, before anything is injected.
 */
export function setup(providers: Array<Provider | EnvironmentProviders> = []): TestSetup {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), ...providers],
  });
  return {
    http: TestBed.inject(HttpTestingController),
    create: <T>(fn: () => T): T => TestBed.runInInjectionContext(fn),
  };
}

/** Yields to the microtask queue without touching (possibly faked) timers. */
const microtask = (): Promise<void> => new Promise<void>((resolve) => queueMicrotask(resolve));

/**
 * Lets the reactive graph and the resource loaders catch up: runs pending effects and drains
 * the microtask queue a few times, because a resource hops through several promise ticks
 * between "request changed" and "value delivered".
 *
 * Deliberately avoids `setTimeout`, so it also works under `vi.useFakeTimers()`.
 */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    TestBed.tick();
    await microtask();
  }
  TestBed.tick();
}

/** Flushes the single pending request for `url` with `body` and waits for the graph to settle. */
export async function respond(http: HttpTestingController, url: string, body: unknown): Promise<void> {
  http.expectOne(url).flush(body as never);
  await settle();
}

/** Fails the single pending request for `url` with an HTTP `status` and waits for the graph to settle. */
export async function fail(
  http: HttpTestingController,
  url: string,
  status = 500,
  body: unknown = { message: 'boom' },
): Promise<void> {
  http.expectOne(url).flush(body as never, { status, statusText: 'Error' });
  await settle();
}

/** `HttpErrorResponse` is not `instanceof Error`, so tests narrow with this guard instead of casts. */
export function isHttpError(e: unknown): e is HttpErrorResponse {
  return e instanceof HttpErrorResponse;
}
