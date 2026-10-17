import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';

import {
  createRequest,
  toRequestError,
  type RequestError,
  type RequestErrorOf,
  type RequestErrorView,
} from '../public-api';
import { fail, respond, settle, setup } from '../../testing/testing';

/**
 * `HttpTestingController`'s `error()` wants an `ErrorEvent | ProgressEvent` and stores it as
 * `HttpErrorResponse.error`. The real fetch backend instead aborts with a `TimeoutError`
 * DOMException, so we hand the backend an object with the same `name` — that is what
 * `toRequestError` actually inspects.
 */
function abortEvent(name: 'AbortError' | 'TimeoutError'): ProgressEvent {
  return { name } as unknown as ProgressEvent;
}

/* `offline` reads a global, so the three cases (offline / online / no `navigator` at all) are set up
 * by shadowing it and put back afterwards. `onLine` is a getter on `Navigator.prototype` in jsdom, so
 * an own property on the instance is the only way to change it. */
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');

function setOnLine(onLine: boolean | undefined): void {
  if (onLine === undefined) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    return;
  }
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: onLine });
}

afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  const navigator: { onLine?: unknown } = globalThis.navigator;
  if (onLineDescriptor) Object.defineProperty(navigator, 'onLine', onLineDescriptor);
  else delete navigator.onLine;
});

describe('toRequestError', () => {
  it('classifies an HTTP status response', () => {
    const cause = new HttpErrorResponse({
      status: 404,
      statusText: 'Not Found',
      url: '/items/1',
      error: { message: 'yok' },
    });

    expect(toRequestError(cause)).toEqual({
      kind: 'http',
      status: 404,
      statusText: 'Not Found',
      url: '/items/1',
      body: { message: 'yok' },
    });
  });

  it('classifies an opaque status 0 as a network failure', () => {
    const cause = new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') });
    expect(toRequestError(cause)).toEqual({ kind: 'network', cause });
  });

  it('omits the status text when the cause carries none', () => {
    // Angular's own constructor substitutes `'Unknown Error'` for a missing reason phrase, so this
    // shape only reaches the classifier through a custom backend or a hand-built cause. It still
    // matters: interpolating unconditionally would produce `HTTP 500 ` with a trailing space, which
    // is the kind of string somebody eventually `===`-compares.
    const cause = new HttpErrorResponse({ status: 500, statusText: 'Server Error' });
    Object.defineProperty(cause, 'statusText', { value: '' });

    expect(toRequestError(cause).message).toBe('HTTP 500');
  });

  it('adds `offline: true` when the browser reports no connection', () => {
    // The one case where the library can do better than "no connection": the browser itself said so,
    // and that is worth telling a user, because "you are offline" has an action and "check your
    // connection" does not.
    setOnLine(false);
    const cause = new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') });

    expect(toRequestError(cause)).toEqual({ kind: 'network', cause, offline: true });
    expect(toRequestError(cause).message).toBe('Offline');
  });

  it('omits `offline` when the browser believes it is online', () => {
    // "The browser thinks it is online" is not "the request reached a server": a CORS rejection and
    // a dropped socket land in this same member, so `offline: false` would be a claim it cannot back.
    setOnLine(true);
    expect(toRequestError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'network',
      cause: expect.any(TypeError),
    });
  });

  it('omits `offline` where there is no `navigator` to ask', () => {
    setOnLine(undefined);
    const error = toRequestError(new TypeError('Failed to fetch'));

    expect('offline' in error).toBe(false);
    expect(error.message).toBe('No connection');
  });

  it('types `offline` as `true`, so its presence is the whole statement', () => {
    const network = toRequestError(new TypeError('Failed to fetch')).network();
    expectTypeOf(network?.offline).toEqualTypeOf<true | undefined>();
  });

  it('classifies an abort, and a timeout when one is configured', () => {
    const abort = new HttpErrorResponse({
      status: 0,
      error: new DOMException('aborted', 'AbortError'),
    });
    const timeout = new HttpErrorResponse({
      status: 0,
      error: new DOMException('signal timed out', 'TimeoutError'),
    });

    expect(toRequestError(abort)).toEqual({ kind: 'aborted' });
    expect(toRequestError(timeout)).toEqual({ kind: 'aborted' });
    expect(toRequestError(timeout, { timeout: 5_000 })).toEqual({ kind: 'timeout', ms: 5_000 });
    expect(toRequestError(abort, { timeout: 5_000 })).toEqual({ kind: 'timeout', ms: 5_000 });
  });

  it('classifies a bare TypeError and anything else', () => {
    expect(toRequestError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'network',
      cause: expect.any(TypeError),
    });
    expect(toRequestError('boom')).toEqual({ kind: 'unknown', cause: 'boom' });
    // A rejection whose value is neither an Error nor a string still has to become an Error,
    // otherwise `tryRun().error` would hand callers a non-Error.
    expect(toRequestError(42)).toEqual({ kind: 'unknown', cause: 42 });
  });

  it('normalizes a source that throws a non-Error into a real Error', async () => {
    const { create } = setup();
    // A throwing source must not make run() throw synchronously, and the rejection value
    // must be a real Error — `tryRun().error` is typed `Error`.
    const r = create(() =>
      createRequest<number>(
        () => {
          throw 'just a string';
        },
        { lazy: true },
      ),
    );

    const result = await r.tryRun();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('should have failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('just a string');
    // `error()` stays empty on purpose: the request never went out, so this is a caller bug
    // rather than an HTTP failure. It surfaces on the `run()` promise, not on the handle.
    expect(r.error()).toBeUndefined();
  });

  it('narrows per kind', () => {
    const error = toRequestError(new HttpErrorResponse({ status: 500, statusText: '' }));
    // Still a `RequestError` — the view only *adds* to it, so `kind` and the payload fields are
    // untouched and every existing use keeps compiling.
    expectTypeOf(error).toExtend<RequestError>();
    expectTypeOf(error).toEqualTypeOf<RequestErrorView>();

    if (error.kind !== 'http') throw new Error('http bekleniyordu');
    expectTypeOf(error.status).toEqualTypeOf<number>();
    expectTypeOf(error.body).toEqualTypeOf<unknown>();
    expect(error.url).toBeNull();
  });
});

describe('RequestErrorView — predicates and message', () => {
  /** Every kind, with a cause that actually carries something to say. */
  const cases = [
    {
      name: 'http',
      error: () => toRequestError(new HttpErrorResponse({ status: 404, statusText: 'Not Found' })),
      message: 'HTTP 404 Not Found',
      withText: 'HTTP 503 Service Unavailable',
    },
    {
      name: 'timeout',
      // A timeout is only ever *classified* as one when the cause is abort-like — which is the
      // whole caveat the README's "`status: 0` is ambiguous" section is about.
      error: () => toRequestError({ name: 'TimeoutError' } as never, { timeout: 5_000 }),
      message: 'Timed out after 5000ms',
      withText: 'Timed out after 5000ms',
    },
    {
      name: 'network',
      // `status: 0` is how `HttpClient` reports "no response" — the realistic network failure.
      error: () => toRequestError(new HttpErrorResponse({ status: 0 })),
      message: 'No connection',
      withText: 'No connection',
    },
    {
      name: 'aborted',
      error: () => toRequestError({ name: 'AbortError' } as never),
      message: 'Request cancelled',
      withText: 'Request cancelled',
    },
    {
      name: 'unknown',
      error: () => toRequestError('boom'),
      message: 'boom',
      withText: 'boom',
    },
  ] as const;

  it('each predicate returns the error itself, and undefined for every other kind', () => {
    for (const current of cases) {
      const error = current.error();
      expect(error.kind).toBe(current.name);

      for (const other of cases) {
        const result = error[other.name]();
        if (other.name === current.name) {
          // Identity, not a copy: the payload has to be the thing on screen.
          expect(result).toBe(error);
        } else {
          expect(result).toBeUndefined();
        }
      }
    }
  });

  it('types each predicate as its own union member', () => {
    // Spelled out one by one: inside the loop above TypeScript widens the key to the union of
    // every kind, which is exactly the precision this test exists to pin.
    const error = toRequestError(new HttpErrorResponse({ status: 404, statusText: 'Not Found' }));

    expectTypeOf(error.http()).toEqualTypeOf<RequestErrorOf<'http'> | undefined>();
    expectTypeOf(error.timeout()).toEqualTypeOf<RequestErrorOf<'timeout'> | undefined>();
    expectTypeOf(error.network()).toEqualTypeOf<RequestErrorOf<'network'> | undefined>();
    expectTypeOf(error.unknown()).toEqualTypeOf<RequestErrorOf<'unknown'> | undefined>();
    expectTypeOf(error.aborted()).toEqualTypeOf<RequestErrorOf<'aborted'> | undefined>();
    expectTypeOf(error.message).toEqualTypeOf<string>();

    // The alias in `@if (error.http(); as http)` is the narrow member, not the whole union —
    // that is the compiler-checked narrowing the template gets for free.
    const http = error.http();
    if (http) {
      expectTypeOf(http.status).toEqualTypeOf<number>();
      expectTypeOf(http.body).toEqualTypeOf<unknown>();
    }
  });

  it('summarizes every kind into a one-line message', () => {
    for (const current of cases) {
      expect(current.error().message).toBe(current.message);
    }
  });

  it('appends the statusText Angular gives it', () => {
    // `HttpErrorResponse` substitutes 'Unknown Error' for an empty `statusText`, so in practice
    // this branch is always taken and the summary always reads `HTTP <status> <text>`.
    expect(toRequestError(new HttpErrorResponse({ status: 500, statusText: '' })).message).toBe(
      'HTTP 500 Unknown Error',
    );
  });

  it('digs a real message out of an unknown cause', () => {
    expect(toRequestError(new Error('kapı bozuk')).message).toBe('kapı bozuk');
    expect(toRequestError({ nope: true }).message).toBe('Unknown error');
    expect(toRequestError('').message).toBe('Unknown error');
  });

  it('keeps the helpers off the data: toEqual, JSON and spread see only fields', () => {
    // The whole reason the predicates live on a prototype. If they became own properties every
    // `toEqual({ kind: … })` assertion in this suite would start failing on the extra members.
    const error = toRequestError({ name: 'AbortError' } as never);

    expect(error).toEqual({ kind: 'aborted' });
    expect(JSON.stringify(error)).toBe('{"kind":"aborted"}');
    expect(Object.keys(error)).toEqual(['kind']);
    expect({ ...error }).toEqual({ kind: 'aborted' });
    // …while still being reachable, which is the whole feature.
    expect(typeof error.http).toBe('function');
    expect(error.message).toBe('Request cancelled');
  });
});

describe('requestError()', () => {
  it('mirrors error() but classified', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n'));

    expect(r.requestError()).toBeUndefined();

    await settle();
    await respond(http, '/n', 1);
    expect(r.requestError()).toBeUndefined();

    r.reload();
    await settle();
    await fail(http, '/n', 404);
    expect(r.requestError()).toEqual({
      kind: 'http',
      status: 404,
      statusText: 'Error',
      url: '/n',
      body: { message: 'boom' },
    });
    // the raw signal is untouched
    expect(r.error()).toBeInstanceOf(HttpErrorResponse);
  });

  it('stays undefined while a retry is in flight, then classifies the final failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { http, create } = setup();
      const r = create(() =>
        createRequest<number>('/n', { retry: { count: 1, delay: 10, when: () => true } }),
      );

      await settle();
      await fail(http, '/n', 500);
      // retrying: both signals are masked
      expect(r.retryAttempt()).toBe(1);
      expect(r.error()).toBeUndefined();
      expect(r.requestError()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(10);
      await settle();
      await fail(http, '/n', 500);
      // `retryAttempt()` keeps its last value after giving up, so the UI can say "we tried
      // N times" — it is only reset by a success, a new key, or `idle`.
      expect(r.retryAttempt()).toBe(1);
      expect(r.requestError()).toEqual({
        kind: 'http',
        status: 500,
        statusText: 'Error',
        url: '/n',
        body: { message: 'boom' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a deliberate timeout as its own kind, not as an abort', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/slow', { timeout: 30, retry: 0 }));

    await settle();
    // The testing backend does not implement `timeout`, so we assert the plumbing: the option
    // reaches the outgoing request and the classification context is wired up.
    const req = http.expectOne('/slow');
    expect((req.request as { timeout?: number }).timeout).toBe(30);

    // Simulate what the fetch backend does on timeout: abort with a TimeoutError reason.
    req.error(abortEvent('TimeoutError'), { status: 0, statusText: 'Unknown Error' });
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 30 });
  });

  it('classifies a timeout that the source itself set, not only the option', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>({ url: '/slow', timeout: 40 }, { retry: 0 }));

    await settle();
    const req = http.expectOne('/slow');
    expect(req.request.timeout).toBe(40);
    req.error(abortEvent('TimeoutError'), { status: 0, statusText: 'Unknown Error' });
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 40 });
  });

  it('reports the same abort as plain `aborted` when no timeout is configured', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    http
      .expectOne('/n')
      .error(abortEvent('AbortError'), { status: 0, statusText: 'Unknown Error' });
    await settle();

    expect(r.requestError()).toEqual({ kind: 'aborted' });
  });
});
