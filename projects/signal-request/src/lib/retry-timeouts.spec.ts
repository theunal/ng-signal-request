import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { createMutation, createRequest, provideSignalRequest } from '../public-api';
import { cache, settle, setup } from '../../testing/testing';

/**
 * `HttpTestingController`'s `error()` stores its second argument as `HttpErrorResponse.error`, and the
 * real backends abort a timed-out request with an `Error` whose `name` is `TimeoutError`. Handing the
 * backend an object with the same `name` is what makes it indistinguishable from the real thing —
 * that is the whole reason a timeout is hard to tell from a network failure, and the reason
 * `retryTimeouts` exists.
 */
function abortEvent(name: 'AbortError' | 'TimeoutError'): ProgressEvent {
  return { name } as unknown as ProgressEvent;
}

const timedOut = { status: 0, statusText: 'Unknown Error' } as const;

const GC = 60_000;

/**
 * `retryTimeouts` decides one case and only one: a timeout that arrives as an abort carrying
 * `status: 0`. These tests pin both sides of it, because the failure mode of a wrong default is a call
 * that takes four times as long as the timeout in front of a user.
 */
describe('retryTimeouts', () => {
  beforeEach(() => {
    // The retry back-off is a real timer on every path, and the two RxJS-driven ones (a cached
    // entry and a mutation both use `retry({ delay })`) go through `asyncScheduler`, which arms an
    // interval rather than a timeout. Faking all four is what makes the back-off observable without
    // waiting; the resource plumbing is all microtasks, which `settle()` drives.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a timeout by default, which is the 0.1.x behaviour', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/slow', { timeout: 30, retry: { count: 2, delay: 5 } }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    // Masked while the retry is pending: there is no failure to show yet.
    expect(r.retryAttempt()).toBe(1);
    expect(r.requestError()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();
    expect(r.retryAttempt()).toBe(2);

    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 30 });
    expect(r.retryAttempt()).toBe(2);
    http.expectNone(() => true);
  });

  it('reports the timeout instead, when the request says so', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/slow', {
        timeout: 30,
        retry: { count: 2, delay: 5 },
        retryTimeouts: false,
      }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 30 });
    expect(r.retryAttempt()).toBe(0);
    // Nothing scheduled, nothing pending: not even a back-off timer was armed.
    http.expectNone(() => true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads the global setting when the request does not set one', async () => {
    const { http, create } = setup([provideSignalRequest({ retryTimeouts: false })]);
    const r = create(() =>
      createRequest<number>('/slow', { timeout: 30, retry: { count: 1, delay: 5 } }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 30 });
    http.expectNone(() => true);
  });

  it('lets a request turn retries back on over a global `false`', async () => {
    const { http, create } = setup([provideSignalRequest({ retryTimeouts: false })]);
    const r = create(() =>
      createRequest<number>('/slow', {
        timeout: 30,
        retry: { count: 1, delay: 5 },
        retryTimeouts: true,
      }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();
    expect(r.retryAttempt()).toBe(1);

    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/slow').flush(1);
    await settle();

    expect(r.response()).toBe(1);
  });

  it('still retries a network failure that is not a timeout', async () => {
    // The flag is deliberately narrow. A dropped socket arrives as `status: 0` as well, and turning
    // retries off for *it* would be a different feature with a much worse default.
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/n', {
        timeout: 30,
        retry: { count: 1, delay: 5 },
        retryTimeouts: false,
      }),
    );

    await settle();
    http.expectOne('/n').error(new ProgressEvent('error'), timedOut);
    await settle();
    expect(r.retryAttempt()).toBe(1);

    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/n').flush(2);
    await settle();

    expect(r.response()).toBe(2);
  });

  it('lets an explicit `when` decide, whatever `retryTimeouts` says', async () => {
    // `when` answers the same question the flag does, so it wins: a predicate that says "retry this"
    // is more specific information than a flag that says "do not retry timeouts".
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/slow', {
        timeout: 30,
        retry: { count: 1, delay: 5, when: () => true },
        retryTimeouts: false,
      }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();
    expect(r.retryAttempt()).toBe(1);
  });

  it('applies to a mutation, whose retry is opt-in', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number>(() => '/save', { timeout: 30, retry: { count: 1, delay: 5 } }),
    );

    const outcome = save.tryRun();
    await settle();
    http.expectOne('/save').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    // Retrying: another `/save` is on the wire after the back-off, which is the observation.
    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/save').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(await outcome).toEqual({ ok: false, error: expect.anything() });
    expect(save.requestError()).toEqual({ kind: 'timeout', ms: 30 });
  });

  it('excludes the timeout on a mutation when asked to', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number>(() => '/save', {
        timeout: 30,
        retry: { count: 1, delay: 5 },
        retryTimeouts: false,
      }),
    );

    const outcome = save.tryRun();
    await settle();
    http.expectOne('/save').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(await outcome).toEqual({ ok: false, error: expect.anything() });
    expect(save.requestError()).toEqual({ kind: 'timeout', ms: 30 });
    http.expectNone(() => true);
  });

  it('reaches a cached request through its shared entry', async () => {
    const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
    const r = create(() =>
      createRequest<number>('/slow', {
        key: () => ['slow'],
        timeout: 30,
        retry: { count: 1, delay: 5 },
        retryTimeouts: false,
      }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();

    expect(r.requestError()).toEqual({ kind: 'timeout', ms: 30 });
    expect(r.fetchCount()).toBe(1);
    http.expectNone(() => true);
  });

  it('leaves a cached entry retrying a timeout by default', async () => {
    const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
    const r = create(() =>
      createRequest<number>('/slow', {
        key: () => ['slow'],
        timeout: 30,
        retry: { count: 1, delay: 5 },
      }),
    );

    await settle();
    http.expectOne('/slow').error(abortEvent('TimeoutError'), timedOut);
    await settle();
    expect(r.fetchCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5);
    await settle();
    http.expectOne('/slow').flush(3);
    await settle();

    expect(r.response()).toBe(3);
    // One `fetch()` for the handle, two HTTP attempts inside it: the retry lives inside the entry's
    // RxJS pipeline, so `fetchCount()` counts fetches, not wire calls. Worth pinning, because the
    // number being unchanged is exactly what a reader would otherwise read as a missing retry.
    expect(r.fetchCount()).toBe(1);
    expect(cache().size).toBe(1);
    http.expectNone(() => true);
  });
});
