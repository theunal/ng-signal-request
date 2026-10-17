import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { QueryCache } from 'ng-signal-request';

export interface TestSetup {
  readonly http: HttpTestingController;
  /** Runs `fn` in the root injection context of the testing module. */
  readonly create: <T>(fn: () => T) => T;
  /** A standalone injection scope, for standing in for a second component. */
  readonly createChild: () => ChildScope;
}

/**
 * A child injection scope with its own `DestroyRef`.
 *
 * `setup().create` runs in the **root** testing injector, so two handles made that way share one
 * `DestroyRef` and destroying one of them would be indistinguishable from destroying both. Anything
 * testing "two components on the same key" needs real scopes: `TestBed` tears the root injector
 * down after each test, but nothing tears a child down until you do.
 */
export interface ChildScope {
  readonly injector: EnvironmentInjector;
  /** Runs `fn` in this scope. */
  readonly create: <T>(fn: () => T) => T;
  /** Destroys the scope — the component's `ngOnDestroy`, for lifetime tests. */
  destroy(): void;
  /** True once `destroy()` has run. */
  readonly isDestroyed: boolean;
}

/**
 * Configures `TestBed` with `HttpClient` + the testing backend and any extra providers.
 * Call once per test, before anything is injected.
 *
 * `QueryCache` is `providedIn: 'root'` and TestBed's teardown destroys the root injector after
 * every test, so **each test starts with an empty cache** — there is no `clear()` to forget.
 */
export function setup(providers: Array<Provider | EnvironmentProviders> = []): TestSetup {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), ...providers],
  });
  const parent = TestBed.inject(EnvironmentInjector);
  return {
    http: TestBed.inject(HttpTestingController),
    create: <T>(fn: () => T): T => TestBed.runInInjectionContext(fn),
    createChild: () => {
      let destroyed = false;
      const injector = createEnvironmentInjector([], parent);
      return {
        injector,
        create: <T>(fn: () => T): T => runInInjectionContext(injector, fn),
        destroy: () => {
          destroyed = true;
          injector.destroy();
        },
        get isDestroyed() {
          return destroyed;
        },
      };
    },
  };
}

/** The live cache, for assertions about entries rather than about HTTP. */
export function cache(): QueryCache {
  return TestBed.inject(QueryCache);
}

/**
 * Moves the clock forward without waiting.
 *
 * `staleTime` and `gcTime` are read from `Date.now()` rather than from a timer, so fake timers
 * alone do not make an entry stale — a test that only advances timers would keep seeing fresh data.
 */
export function advanceClock(ms: number): void {
  const shifted = Date.now() + ms;
  vi.spyOn(Date, 'now').mockReturnValue(shifted);
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
export async function respond(
  http: HttpTestingController,
  url: string,
  body: unknown,
): Promise<void> {
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
