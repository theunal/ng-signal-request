import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRequest, toRequestError, type RequestError } from '../public-api';
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
      createRequest<number>(() => {
        throw 'just a string';
      }, { lazy: true }),
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
    expectTypeOf(error).toEqualTypeOf<RequestError>();

    if (error.kind !== 'http') throw new Error('http bekleniyordu');
    expectTypeOf(error.status).toEqualTypeOf<number>();
    expectTypeOf(error.body).toEqualTypeOf<unknown>();
    expect(error.url).toBeNull();
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
    http.expectOne('/n').error(abortEvent('AbortError'), { status: 0, statusText: 'Unknown Error' });
    await settle();

    expect(r.requestError()).toEqual({ kind: 'aborted' });
  });
});
