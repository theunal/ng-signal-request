import { HttpErrorResponse, HttpParams } from '@angular/common/http';
import { effect, Injector, signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, expectTypeOf, it, vi, afterEach } from 'vitest';
import { createRequest, provideSignalRequest, RequestCancelledError, type RequestConfig } from '../public-api';
import { fail, respond, settle, setup } from '../../testing/testing';

interface User {
  id: number;
  name: string;
}

interface ListQuery {
  param1: string;
  param2: number;
  body: unknown;
}

interface SaveQuery {
  path?: { id: number };
  body?: Record<string, unknown> | null;
  headers?: Record<string, string>;
  q?: string;
}

interface QueryBag {
  keep: string;
  gone: string;
  list: string[];
  flag: boolean;
  when: Date;
}

describe('createRequest – basics', () => {
  it('fires automatically and exposes signals', async () => {
    const { http, create } = setup();
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const users = create(() => createRequest<User[]>('/users', { onSuccess, onSettled }));

    await settle();
    expect(users.status()).toBe('loading');
    expect(users.loading()).toBe(true);
    expect(users.initialLoading()).toBe(true);
    expect(users.response()).toBeUndefined();

    await respond(http, '/users', [{ id: 1, name: 'Ada' }]);
    expect(users.status()).toBe('resolved');
    expect(users.loading()).toBe(false);
    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(users.statusCode()).toBe(200);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith([{ id: 1, name: 'Ada' }]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    http.verify();
  });

  it('re-fetches when a signal changes and cancels the outdated request', async () => {
    const { http, create } = setup();
    const id = signal(1);
    const user = create(() => createRequest<User>(() => `/users/${id()}`));
    await settle();

    const first = http.expectOne('/users/1');
    id.set(2);
    await settle();
    expect(first.cancelled).toBe(true);

    await respond(http, '/users/2', { id: 2, name: 'Grace' });
    expect(user.response()?.name).toBe('Grace');
  });

  it('is disabled while the source returns undefined / false / null', async () => {
    const { http, create } = setup();
    const id = signal<number | undefined>(undefined);
    const user = create(() => createRequest<User>(() => (id() === undefined ? undefined : `/users/${id()}`)));
    await settle();
    expect(user.status()).toBe('idle');
    http.expectNone(() => true);

    id.set(7);
    await settle();
    await respond(http, '/users/7', { id: 7, name: 'Linus' });
    expect(user.response()?.id).toBe(7);
  });

  it('uses initialValue as a non-nullable response', async () => {
    const { http, create } = setup();
    const list = create(() => createRequest<string[]>('/l', { initialValue: [] }));
    const n: number = list.response().length; // compile-time: no `undefined`
    expect(n).toBe(0);
    await settle();
    await respond(http, '/l', ['a']);
    expect(list.response()).toEqual(['a']);
  });

  it('uses `equal` to decide whether a new response is a change', async () => {
    // By default a fresh object identity counts as a change, so a structurally identical body
    // still re-emits and downstream computeds recompute. A custom comparator that says "equal"
    // keeps them put. Note this is about the *value* propagating, not about `onSuccess`, which
    // fires once per settled request either way.
    const { http, create } = setup();
    const emissions = vi.fn();
    const strict = create(() => createRequest<{ id: number }[]>('/n', { initialValue: [] }));
    const loose = create(() =>
      createRequest<{ id: number }[]>('/l', {
        initialValue: [],
        equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      }),
    );

    // `effect` is the honest probe: it re-runs only when the value it reads actually changes.
    TestBed.runInInjectionContext(() => {
      effect(() => {
        strict.response();
        emissions('strict');
      });
      effect(() => {
        loose.response();
        emissions('loose');
      });
    });

    await settle();
    emissions.mockClear();

    await respond(http, '/n', [{ id: 1 }]);
    await respond(http, '/l', [{ id: 1 }]);
    await settle();
    // Both emit their first real value.
    expect(emissions.mock.calls.map((c) => c[0])).toEqual(['strict', 'loose']);
    emissions.mockClear();

    // Reload both with a body that is equal in content but new in identity.
    strict.reload();
    loose.reload();
    await settle();
    await respond(http, '/n', [{ id: 1 }]);
    await respond(http, '/l', [{ id: 1 }]);
    await settle();

    // Default equality: new object identity is a change, so it re-emits. Custom `equal`:
    // nothing changed, so the effect stays put.
    expect(emissions.mock.calls.map((c) => c[0])).toEqual(['strict']);

    // A real change still propagates through `equal`.
    emissions.mockClear();
    loose.reload();
    await settle();
    await respond(http, '/l', [{ id: 2 }]);
    await settle();
    expect(emissions.mock.calls.map((c) => c[0])).toEqual(['loose']);
    expect(loose.response()).toEqual([{ id: 2 }]);
  });

  it('parses / validates the raw body', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/n', { parse: (raw) => (raw as { v: string }).v.length }),
    );
    await settle();
    await respond(http, '/n', { v: 'hello' });
    expect(r.response()).toBe(5);
  });

  it('surfaces parse errors as error state (not retried by default)', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/n', {
        retry: 3,
        parse: () => {
          throw new Error('bad shape');
        },
      }),
    );
    await settle();
    await respond(http, '/n', {});
    expect(r.status()).toBe('error');
    expect(r.error()?.message).toContain('bad shape');
    expect(r.retryAttempt()).toBe(0);
  });

  it('supports text / blob variants', async () => {
    const { http, create } = setup();
    const t = create(() => createRequest.text('/t'));
    const b = create(() => createRequest.blob('/b'));
    await settle();
    http.expectOne('/t').flush('plain');
    http.expectOne('/b').flush(new Blob(['x']));
    await settle();
    expect(t.response()).toBe('plain');
    expect(b.response()).toBeInstanceOf(Blob);
  });

  it('survives a hook that throws instead of corrupting the request', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number>('/n', {
        retry: 0,
        onSuccess: () => {
          throw new Error('hook exploded');
        },
        onSettled: () => {
          throw new Error('hook exploded too');
        },
      }),
    );

    await settle();
    await respond(http, '/n', 5);
    // A throwing lifecycle hook is reported to the ErrorHandler, but the value still lands.
    expect(r.response()).toBe(5);
    expect(r.status()).toBe('resolved');
  });

  it('run() on a lazy params-gated request rejects until params are set', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<number, ListQuery>('/n', { params: { param1: 'a', param2: 1, body: null }, lazy: true }),
    );

    await settle();
    http.expectNone(() => true);

    // Params are present, so this one goes out.
    const p = r.run();
    await settle();
    const req = http.expectOne('/n?param1=a&param2=1');
    req.flush(3);
    await expect(p).resolves.toBe(3);

    // Clear the gate: the request is disabled, so run() rejects instead of sending a bad url.
    r.params.set(undefined as unknown as ListQuery);
    await expect(r.run()).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('cancel() is a no-op when nothing is in flight', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n'));

    await settle();
    await respond(http, '/n', 1);
    r.cancel(); // resolved, not loading — must not throw or wipe the value
    expect(r.response()).toBe(1);

    r.cancel();
    await settle();
    expect(r.response()).toBe(1);
    http.expectNone(() => true);
  });

  it('reload() revives a cancelled request without run()', async () => {
    // `cancel()` parks the request by setting a gate that `reload()` clears, instead of
    // re-evaluating the source. So this revives without `run()` — and, unlike `run()`, it does
    // not reject while the source is still live.
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n'));

    await settle();
    const inflight = http.expectOne('/n');
    r.cancel();
    await settle();
    expect(inflight.cancelled).toBe(true);
    expect(r.status()).toBe('idle');

    expect(r.reload()).toBe(true);
    await settle();
    await respond(http, '/n', 2);
    expect(r.response()).toBe(2);
  });

  it('reload() reports false on a disabled request', async () => {
    // A source evaluating to `undefined` is not a cancellation, so there is no gate to clear and
    // `resource.reload()` declines. `run()` rejects instead; `reload()` just says "not now".
    const { http, create } = setup();
    const on = signal(false);
    const r = create(() => createRequest<number>(() => (on() ? '/n' : undefined)));

    await settle();
    expect(r.status()).toBe('idle');
    expect(r.reload()).toBe(false);
    expect(r.status()).toBe('idle');
    http.expectNone(() => true);

    // Re-enabling fires on its own, without any reload() call.
    on.set(true);
    await settle();
    expect(r.status()).toBe('loading');
    await respond(http, '/n', 1);
    expect(r.response()).toBe(1);
  });

  it('throws a helpful error outside of an injection context, works with { injector }', async () => {
    const { http } = setup();
    expect(() => createRequest('/x')).toThrowError(/createRequest\(\) can only be used within an injection context/);
    const r = createRequest<number>('/x', { injector: TestBed.inject(Injector) });
    await settle();
    await respond(http, '/x', 1);
    expect(r.response()).toBe(1);
  });
});

describe('createRequest – request building', () => {
  it('applies baseUrl, fills :path params, and cleans query params', async () => {
    const { http, create } = setup([provideSignalRequest({ baseUrl: 'https://api.test/v1/' })]);
    // A url with an unfilled `:placeholder` disables the request — sending `/users/:id` to a
    // server is never what the caller meant.
    const disabled = create(() => createRequest('/users/:id/posts'));
    await settle();
    expect(disabled.status()).toBe('idle');
    http.expectNone(() => true);

    const when = new Date('2026-01-02T03:04:05.000Z');
    create(() =>
      createRequest(() => ({
        url: '/users/:id/posts',
        path: { id: 'a b' },
        params: {
          q: 'x',
          empty: undefined,
          nothing: null,
          page: 2,
          tags: ['a', null, 'b'],
          since: when,
        },
      })),
    );
    await settle();
    http.expectOne(
      'https://api.test/v1/users/a%20b/posts?q=x&page=2&tags=a&tags=b&since=2026-01-02T03:04:05.000Z',
    );
  });

  it('does not touch absolute urls and disables the request while a path param is missing', async () => {
    const { http, create } = setup([provideSignalRequest({ baseUrl: 'https://api.test' })]);
    const id = signal<number | undefined>(undefined);
    const r = create(() => createRequest(() => ({ url: 'https://other.test/u/:id', path: { id: id() } })));
    await settle();
    expect(r.status()).toBe('idle');
    id.set(3);
    await settle();
    http.expectOne('https://other.test/u/3');
  });
});

describe('createRequest – lazy mode & run()', () => {
  it('does nothing until run(), resolves with the response, and ignores later signal changes', async () => {
    const { http, create } = setup();
    const term = signal('a');
    const r = create(() => createRequest<string[]>(() => ({ url: '/s', params: { q: term() } }), { lazy: true }));
    await settle();
    http.expectNone(() => true);
    expect(r.status()).toBe('idle');

    const p = r.run();
    await settle();
    http.expectOne('/s?q=a').flush(['x']);
    await expect(p).resolves.toEqual(['x']);
    expect(r.response()).toEqual(['x']);

    term.set('b'); // lazy: no automatic re-fetch
    await settle();
    http.expectNone(() => true);

    const p2 = r.run(); // uses latest signal values
    await settle();
    http.expectOne('/s?q=b').flush(['y']);
    await expect(p2).resolves.toEqual(['y']);
  });

  it('rejects run() on failure, never rejects tryRun()', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<string[]>('/s', { lazy: true }));
    const p = r.run();
    await settle();
    await fail(http, '/s', 400);
    await expect(p).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(r.error()).toBeInstanceOf(HttpErrorResponse);

    const t = r.tryRun();
    await settle();
    await fail(http, '/s', 400);
    const result = await t;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(HttpErrorResponse);

    const ok = r.tryRun();
    await settle();
    await respond(http, '/s', ['fine']);
    expect(await ok).toEqual({ ok: true, response: ['fine'] });
  });

  it('two overlapping run() calls share the result of the latest request', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { lazy: true }));
    const a = r.run();
    await settle();
    const first = http.expectOne('/n');
    const b = r.run();
    await settle();
    expect(first.cancelled).toBe(true);
    http.expectOne('/n').flush(42);
    await settle();
    await expect(Promise.all([a, b])).resolves.toEqual([42, 42]);
  });

  it('run() in auto mode reloads; rejects while the request is disabled', async () => {
    const { http, create } = setup();
    const on = signal(true);
    const r = create(() => createRequest<number>(() => (on() ? '/n' : undefined)));
    await settle();
    await respond(http, '/n', 1);

    const p = r.run();
    await settle();
    expect(r.status()).toBe('reloading');
    expect(r.response()).toBe(1); // previous value stays during reload
    await respond(http, '/n', 2);
    await expect(p).resolves.toBe(2);

    on.set(false);
    await settle();
    await expect(r.run()).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('fire-and-forget run() does not produce unhandled rejections', async () => {
    const { http, create } = setup();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const r = create(() => createRequest<number>('/n', { lazy: true }));
    r.run();
    await settle();
    await fail(http, '/n', 400);
    await new Promise((res) => setTimeout(res, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(r.error()).toBeTruthy();
  });
});

describe('createRequest – retry', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('retries transient errors, hides the error meanwhile and succeeds', async () => {
    const { http, create } = setup();
    const onError = vi.fn();
    const r = create(() => createRequest<number>('/n', { retry: { count: 2, delay: 100 }, onError }));
    await settle();
    await fail(http, '/n', 503);

    expect(r.error()).toBeUndefined(); // masked while retrying
    expect(r.status()).toBe('reloading');
    expect(r.loading()).toBe(true);
    expect(r.retryAttempt()).toBe(1);
    http.expectNone('/n');

    await vi.advanceTimersByTimeAsync(100);
    await settle();
    await respond(http, '/n', 9);
    expect(r.response()).toBe(9);
    expect(r.status()).toBe('resolved');
    expect(r.retryAttempt()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('gives up after `count` retries and reports the final error once', async () => {
    const onError = vi.fn();
    const global = vi.fn();
    const s = setup([provideSignalRequest({ onError: global })]);
    const r = s.create(() => createRequest<number>('/n', { retry: { count: 2, delay: 10 }, onError }));
    await settle();
    await fail(s.http, '/n', 500);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    await fail(s.http, '/n', 500);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(r.retryAttempt()).toBe(2);
    await fail(s.http, '/n', 500);

    expect(r.status()).toBe('error');
    expect(r.error()).toBeInstanceOf(HttpErrorResponse);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0][1]).toEqual({ url: '/n', method: 'GET' });
  });

  it('does not retry 4xx by default, but `when` can override', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/a', { retry: 3 }));
    const custom = create(() =>
      createRequest<number>('/b', { retry: { count: 1, delay: 0, when: (e) => (e as HttpErrorResponse).status === 404 } }),
    );
    await settle();
    await fail(http, '/a', 404);
    expect(r.status()).toBe('error');
    expect(r.retryAttempt()).toBe(0);

    await fail(http, '/b', 404);
    expect(custom.status()).toBe('reloading');
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    await respond(http, '/b', 1);
    expect(custom.response()).toBe(1);
  });

  it('default back-off grows exponentially', async () => {
    const { http, create } = setup();
    create(() => createRequest<number>('/n', { retry: 3 }));
    await settle();
    await fail(http, '/n', 500);
    await vi.advanceTimersByTimeAsync(999);
    http.expectNone('/n');
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    await fail(http, '/n', 500);
    await vi.advanceTimersByTimeAsync(1999);
    http.expectNone('/n');
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    http.expectOne('/n');
  });

  it('cancel() while waiting for a retry stops retrying and surfaces the error', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { retry: { count: 5, delay: 1000 }, lazy: true }));
    const p = r.run();
    await settle();
    await fail(http, '/n', 500);
    expect(r.status()).toBe('reloading');
    r.cancel();
    await expect(p).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(r.status()).toBe('error');
    await vi.advanceTimersByTimeAsync(5000);
    http.expectNone('/n');
  });

  it('a new source value resets the retry cycle', async () => {
    const { http, create } = setup();
    const id = signal(1);
    const r = create(() => createRequest<number>(() => `/n/${id()}`, { retry: { count: 3, delay: 1000 } }));
    await settle();
    await fail(http, '/n/1', 500);
    expect(r.retryAttempt()).toBe(1);
    id.set(2);
    await settle();
    expect(r.retryAttempt()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    await respond(http, '/n/2', 2);
    expect(r.response()).toBe(2);
  });
});

describe('createRequest – keepPreviousValue, debounce, polling', () => {
  it('keepPreviousValue keeps showing the last response while the next one loads', async () => {
    const { http, create } = setup();
    const page = signal(1);
    const r = create(() =>
      createRequest<string[]>(() => ({ url: '/p', params: { page: page() } }), { keepPreviousValue: true }),
    );
    const plain = create(() => createRequest<string[]>(() => ({ url: '/q', params: { page: page() } })));
    await settle();
    await respond(http, '/p?page=1', ['one']);
    await respond(http, '/q?page=1', ['one']);

    page.set(2);
    await settle();
    expect(r.status()).toBe('loading');
    expect(r.response()).toEqual(['one']);
    expect(plain.response()).toBeUndefined();

    await respond(http, '/p?page=2', ['two']);
    http.expectOne('/q?page=2');
    expect(r.response()).toEqual(['two']);
  });

  describe('timers', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('debounce: first request immediate, later changes trailing-debounced', async () => {
      const { http, create } = setup();
      const term = signal('a');
      create(() => createRequest(() => ({ url: '/s', params: { q: term() } }), { debounce: 300 }));
      await settle();
      http.expectOne('/s?q=a'); // immediate

      term.set('ab');
      await settle();
      await vi.advanceTimersByTimeAsync(200);
      term.set('abc');
      await settle();
      await vi.advanceTimersByTimeAsync(299);
      http.expectNone(() => true);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      http.expectOne('/s?q=abc');
    });

    it('polling re-fetches after each settled request and stops on destroy', async () => {
      const { http, create } = setup();
      const onSuccess = vi.fn();
      const r = create(() => createRequest<number>('/tick', { pollInterval: 1000, onSuccess }));
      await settle();
      await respond(http, '/tick', 1);
      expect(onSuccess).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(r.status()).toBe('reloading');
      await respond(http, '/tick', 1); // same primitive value must still count as a new success
      expect(onSuccess).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      await respond(http, '/tick', 3);
      expect(r.response()).toBe(3);

      r.destroy();
      await vi.advanceTimersByTimeAsync(5000);
      http.expectNone(() => true);
    });

    it('polling can be switched off reactively', async () => {
      const { http, create } = setup();
      const interval = signal<number | false>(500);
      create(() => createRequest<number>('/tick', { pollInterval: () => interval() }));
      await settle();
      await respond(http, '/tick', 1);
      interval.set(false);
      await settle();
      await vi.advanceTimersByTimeAsync(5000);
      http.expectNone(() => true);
    });

    describe('pollWhenHidden', () => {
      // `document.hidden` is a read-only accessor, so it has to be redefined rather than assigned.
      // Restoring the original descriptor in `afterEach` keeps the rest of the suite honest.
      let original: PropertyDescriptor | undefined;

      const setHidden = (hidden: boolean): void => {
        Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
      };

      beforeEach(() => {
        original = Object.getOwnPropertyDescriptor(document, 'hidden');
      });

      afterEach(() => {
        if (original) Object.defineProperty(document, 'hidden', original);
      });

      it('skips the tick while hidden and resumes when the tab is shown again', async () => {
        const { http, create } = setup();
        const r = create(() => createRequest<number>('/tick', { pollInterval: 1000 }));
        await settle();
        await respond(http, '/tick', 1);

        setHidden(true);
        await vi.advanceTimersByTimeAsync(5000);
        await settle();
        // Still no request: the timer re-arms itself instead of firing while hidden.
        http.expectNone(() => true);
        expect(r.status()).toBe('resolved');

        setHidden(false);
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(r.status()).toBe('reloading');
        await respond(http, '/tick', 2);
        expect(r.response()).toBe(2);
      });

      it('keeps ticking while hidden when `pollWhenHidden: true`', async () => {
        const { http, create } = setup();
        const r = create(() =>
          createRequest<number>('/tick', { pollInterval: 1000, pollWhenHidden: true }),
        );
        await settle();
        await respond(http, '/tick', 1);

        setHidden(true);
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(r.status()).toBe('reloading');
        await respond(http, '/tick', 2);
        expect(r.response()).toBe(2);

        // Still polling while hidden — a second tick goes out without anything being shown.
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(r.status()).toBe('reloading');
        await respond(http, '/tick', 3);
        expect(r.response()).toBe(3);
      });
    });
  });
});

describe('createRequest – cancel, set/update, destroy', () => {
  it('cancel() aborts the in-flight request and rejects waiting run() calls; run() resumes', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { lazy: true }));
    const p = r.run();
    await settle();
    const req = http.expectOne('/n');
    r.cancel();
    await settle();
    expect(req.cancelled).toBe(true);
    expect(r.status()).toBe('idle');
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);

    const again = r.run();
    await settle();
    http.expectOne('/n').flush(5);
    await expect(again).resolves.toBe(5);
  });

  it('cancel() in auto mode stays cancelled until the source changes', async () => {
    const { http, create } = setup();
    const id = signal(1);
    const r = create(() => createRequest<number>(() => `/n/${id()}`));
    await settle();
    http.expectOne('/n/1');
    r.cancel();
    await settle();
    expect(r.status()).toBe('idle');
    http.expectNone(() => true);

    id.set(2);
    await settle();
    await respond(http, '/n/2', 2);
    expect(r.response()).toBe(2);
  });

  it('set() / update() overwrite the value locally (optimistic updates)', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number[]>('/n', { initialValue: [] }));
    await settle();
    await respond(http, '/n', [1, 2]);
    r.update((list) => [...list, 3]);
    expect(r.response()).toEqual([1, 2, 3]);
    expect(r.status()).toBe('local');
    r.set([9]);
    expect(r.response()).toEqual([9]);
    expect(r.reload()).toBe(true);
    await settle();
    await respond(http, '/n', [1, 2]);
    expect(r.response()).toEqual([1, 2]);
  });

  it('set() settles a waiting run() with the local value', async () => {
    // A `run()` in flight is waiting on the network. An optimistic `set()` is a real answer, so the
    // pending promise must resolve with it rather than hang. This is the `local` branch of the
    // supervisor, and it behaves like `cancel()`: writing a local value aborts the request for real,
    // so there is no late network response left to overwrite the optimistic value.
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { lazy: true }));

    const p = r.run();
    await settle();
    const inflight = http.expectOne('/n');

    r.set(7);
    await expect(p).resolves.toBe(7);
    expect(r.status()).toBe('local');
    expect(r.response()).toBe(7);
    expect(inflight.cancelled).toBe(true);
  });

  it('update() settles a waiting run() with the mapped local value', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { lazy: true, initialValue: 1 }));

    const p = r.run();
    await settle();
    http.expectOne('/n');
    r.update((current) => current + 10);
    await expect(p).resolves.toBe(11);
  });

  it('cancel() and reload() are inert after destroy()', async () => {
    // Both are public API, so both must be safe to call on a dead handle rather than throwing.
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n'));
    await settle();
    await respond(http, '/n', 1);

    r.destroy();
    expect(r.reload()).toBe(false);
    expect(() => r.cancel()).not.toThrow();
    // `destroy()` tears the resource down, so the value goes with it — the handle is spent.
    expect(r.response()).toBeUndefined();
    http.expectNone(() => true);
  });

  it('destroy() rejects waiting run() calls and stops timers', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n', { lazy: true }));
    const p = r.run();
    await settle();
    http.expectOne('/n');
    r.destroy();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await expect(r.run()).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('is tied to the owning injector: destroying the context aborts in-flight requests', async () => {
    const { http } = setup();
    // The root TestBed injector stands in for a component-scoped one. A child created with
    // `Injector.create` would be closer to the real thing, but it is not destroyable, so there
    // would be nothing to assert against — `resetTestingModule()` is the destroyable equivalent.
    createRequest<number>('/n', { injector: TestBed.inject(Injector) });
    await settle();
    const req = http.expectOne('/n');
    TestBed.resetTestingModule();
    expect(req.cancelled).toBe(true);
  });
});

describe('createRequest – chaining (Angular 22 ctx.chain)', () => {
  it('waits for the upstream resource and then fires with its value', async () => {
    const { http, create } = setup();
    const { user, posts } = create(() => {
      const user = createRequest<User>('/user');
      // 1st argument is params, 2nd is Angular's params context (where ctx.chain lives)
      const posts = createRequest<string[], void>((_params, ctx) => `/users/${ctx.chain(user.resource)!.id}/posts`);
      return { user, posts };
    });
    await settle();
    http.expectNone('/users/5/posts');
    expect(posts.status()).not.toBe('error');

    await respond(http, '/user', { id: 5, name: 'Ada' });
    await settle();
    await respond(http, '/users/5/posts', ['p1']);
    expect(posts.response()).toEqual(['p1']);
    expect(user.response()?.id).toBe(5);
  });
});

describe('createRequest – documented limits', () => {
  it('debounce + ctx.chain fails fast with an explanatory error', () => {
    const { create } = setup();
    expect(() =>
      create(() => {
        const a = createRequest<{ id: number }>('/a');
        return createRequest<number, void>((_params, ctx) => `/b/${ctx.chain(a.resource)!.id}`, { debounce: 100 });
      }),
    ).toThrowError(/ctx\.chain\(\) is only available in auto mode without `debounce`/);
  });

  it('reports a throwing source to the global hooks without a url', async () => {
    // A source can throw *while being evaluated* (`ctx.chain` on a resource that is not ready,
    // a property access on undefined). There is then no request to describe, so the global hook
    // gets `url: undefined` rather than a half-built one — and the resource is not left spinning.
    const global = vi.fn();
    const { http, create } = setup([provideSignalRequest({ onError: global })]);
    const armed = signal(true);
    const r = create(() =>
      createRequest<number>(() => {
        if (armed()) throw new Error('source blew up');
        return '/n';
      }, { retry: 0 }),
    );

    await settle();
    http.expectNone(() => true);
    expect(r.status()).toBe('error');
    expect(r.error()?.message).toBe('source blew up');

    // A throwing source is reported once, with no url and the default verb.
    expect(global).toHaveBeenCalledTimes(1);
    expect(global.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(global.mock.calls[0][1]).toEqual({ url: undefined, method: 'GET' });

    // Once the source recovers, normal behaviour resumes.
    armed.set(false);
    await settle();
    await respond(http, '/n', 5);
    expect(r.response()).toBe(5);
  });

  it('lazy run() returns a rejected promise (does not throw) when the source throws', async () => {
    const { create } = setup();
    const r = create(() =>
      createRequest<number>(
        () => {
          throw new Error('source blew up');
        },
        { lazy: true },
      ),
    );
    const p = r.run();
    await expect(p).rejects.toThrowError('source blew up');
  });
});

describe('createRequest – params signal', () => {
  it('builds the request from the initial params', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<Item[], ListQuery>(
        (params) => ({ url: `/items/${params.param1}`, params: { size: params.param2 } }),
        { params: { param1: '1', param2: 10, body: null }, initialValue: [] },
      ),
    );

    // whatever is left in params automatically falls through to the query string
    await settle();
    await respond(http, '/items/1?size=10&param1=1&param2=10', []);
    expect(r.response()).toEqual([]);
  });

  it('re-fires when params are set, and success() flips', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<Item[], ListQuery>(
        (params) => ({ url: `/items/${params.param1}` }),
        { params: { param1: 'a', param2: 1, body: null }, initialValue: [] },
      ),
    );

    await settle();
    await respond(http, '/items/a?param1=a&param2=1', ['x']);
    expect(r.success()).toBe(true);

    r.params.set({ param1: 'b', param2: 2, body: null });
    await settle();
    expect(r.success()).toBe(false); // loading again
    expect(r.loading()).toBe(true);

    await respond(http, '/items/b?param1=b&param2=2', ['y']);
    expect(r.success()).toBe(true);
    expect(r.response()).toEqual(['y']);
  });

  it('is disabled while params is undefined', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<Item[], ListQuery>((params) => ({ url: `/items/${params.param1}` }), {
        params: undefined as unknown as ListQuery,
        initialValue: [],
      }),
    );

    await settle();
    expect(r.status()).toBe('idle');
    expect(r.success()).toBe(false);
    http.expectNone(() => true);

    r.params.set({ param1: 'z', param2: 0, body: null });
    await settle();
    await respond(http, '/items/z?param1=z&param2=0', ['ok']);
    expect(r.response()).toEqual(['ok']);
  });

  it('is exposed and writable even without a TParams type argument', () => {
    const { create } = setup();
    const r = create(() => createRequest<string>('/x'));
    expect(r.params()).toBeUndefined();
  });
});

describe('createRequest – method variants', () => {
  it('sends GET for the bare call and for .get', async () => {
    const { http, create } = setup();

    const bare = create(() => createRequest<string>('/bare'));
    const explicit = create(() => createRequest.get<string>('/get'));
    await settle();

    for (const url of ['/bare', '/get']) {
      const req = http.expectOne(url);
      expect(req.request.method).toBe('GET');
      req.flush(url);
    }
    await settle();
    expect(bare.response()).toBe('/bare');
    expect(explicit.response()).toBe('/get');
  });

  it('sends the verb of each variant', async () => {
    const { http, create } = setup();
    const cases: Array<[string, Signal<string | undefined>]> = [
      ['POST', create(() => createRequest.post<string>('/post')).response],
      ['PUT', create(() => createRequest.put<string>('/put')).response],
      ['PATCH', create(() => createRequest.patch<string>('/patch')).response],
      ['DELETE', create(() => createRequest.delete<string>('/delete')).response],
    ];

    await settle();
    for (const [method, response] of cases) {
      const url = `/${method.toLowerCase()}`;
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      req.flush(method);
      await settle();
      expect(response()).toBe(method);
    }
  });

  it('covers the binary response types under a non-GET verb', async () => {
    const { http, create } = setup();
    const download = create(() => createRequest.delete.blob('/file'));
    const raw = create(() => createRequest.put.arrayBuffer('/raw'));
    expectTypeOf(download.response()).toEqualTypeOf<Blob | undefined>();
    expectTypeOf(raw.response()).toEqualTypeOf<ArrayBuffer | undefined>();

    await settle();
    const a = http.expectOne('/file');
    expect(a.request.method).toBe('DELETE');
    expect(a.request.responseType).toBe('blob');
    a.flush(new Blob(['x']));

    const b = http.expectOne('/raw');
    expect(b.request.method).toBe('PUT');
    expect(b.request.responseType).toBe('arraybuffer');
    b.flush(new ArrayBuffer(2));
    await settle();

    expect(download.response()).toBeInstanceOf(Blob);
    expect(raw.response()).toBeInstanceOf(ArrayBuffer);
  });

  it('combines a verb with lazy: true', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest.post<string>('/s', { lazy: true }));

    await settle();
    http.expectNone(() => true);

    const p = r.run();
    await settle();
    const req = http.expectOne('/s');
    expect(req.request.method).toBe('POST');
    req.flush('done');
    await expect(p).resolves.toBe('done');
  });

  it('never lets a runtime `method` survive on the outgoing request', async () => {
    const { http, create } = setup();
    // A JS caller (or a value typed `as RequestConfig`) can still smuggle `method` in.
    // The variant must win — this is what makes `method` un-overridable by design.
    create(() =>
      createRequest<Item[]>({ url: '/x', method: 'DELETE' } as never, { initialValue: [] }),
    );

    await settle();
    const req = http.expectOne('/x');
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 1 }]);
  });

  it('combines a verb with a response type', async () => {
    const { http, create } = setup();
    const search = create(() => createRequest.post.text('/search', { initialValue: '' }));
    expectTypeOf(search.response()).toEqualTypeOf<string>();

    await settle();
    const req = http.expectOne('/search');
    expect(req.request.method).toBe('POST');
    expect(req.request.responseType).toBe('text');
    req.flush('ok');
    await settle();
    expect(search.response()).toBe('ok');
  });

  it('picks the verb up in the global onError report', async () => {
    const global = vi.fn();
    const { http, create } = setup([provideSignalRequest({ onError: global })]);
    create(() => createRequest.put('/boom'));

    await settle();
    http.expectOne('/boom').flush('nope', { status: 500, statusText: 'Err' });
    await settle();
    expect(global).toHaveBeenCalledWith(expect.anything(), { url: '/boom', method: 'PUT' });
  });

  it('names the failing call with its full path', () => {
    setup();
    // Called outside an injection context on purpose, so Angular reports the function name.
    expect(() => createRequest.post.text('/x')).toThrowError(/createRequest\.post\.text/);
    expect(() => createRequest.put('/x')).toThrowError(/createRequest\.put/);
    expect(() => createRequest('/x')).toThrowError(/createRequest\(\)/);
  });

  it('rejects a `method` field in a source at compile time', () => {
    // A valid description still narrows, so the rejection below is about `method` alone.
    expectTypeOf<{ url: string }>().toExtend<RequestConfig>();
    // @ts-expect-error `method` is not part of a request description — pick a variant instead.
    const config: RequestConfig = { url: '/x', method: 'POST' };
    expect(config.url).toBe('/x');
  });
});

describe('createRequest – params placement', () => {
  it('routes body / path / headers from params and leaves the rest as query', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest.patch<Item[], SaveQuery>(
        { url: '/users/:id' },
        { params: { path: { id: 7 }, body: { name: 'Ada' }, headers: { 'x-trace': 'abc' } } },
      ),
    );

    await settle();
    const req = http.expectOne('/users/7');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ name: 'Ada' });
    expect(req.request.headers.get('x-trace')).toBe('abc');
    req.flush([{ id: 7 }]);
    await settle();
    expect(r.response()).toEqual([{ id: 7 }]);
  });

  it('treats a `method` key in params as an ordinary query value', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[], { method: string }>('/search', { params: { method: 'PUT' } }),
    );

    await settle();
    // The verb cannot come from a params bag — it can only be a query value.
    const req = http.expectOne('/search?method=PUT');
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 1 }]);
  });

  it('keeps reserved keys out of the query string', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[], SaveQuery>(
        { url: '/users/:id' },
        { params: { path: { id: 7 }, body: { name: 'Ada' }, q: 'search' } },
      ),
    );

    await settle();
    // `path` and `body` must not appear as `?path=…` / `?body=…`
    http.expectOne('/users/7?q=search').flush([{ id: 7 }]);
  });

  it('lets params override what the source put in the same slot', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest.post<Item[], SaveQuery>(
        { url: '/users/:id', body: { from: 'source' }, params: { q: 'source' } },
        { params: { path: { id: 1 }, body: { from: 'params' }, q: 'params' } },
      ),
    );

    await settle();
    const req = http.expectOne('/users/1?q=params');
    expect(req.request.method).toBe('POST'); // the verb came from `createRequest.post`
    expect(req.request.body).toEqual({ from: 'params' });
    req.flush([{ id: 1 }]);
  });

  it('clears the source body with `body: null` and keeps it with `body: undefined`', async () => {
    const { http, create } = setup();

    // Only the outgoing body matters here, so the handles themselves are not bound.
    create(() =>
      createRequest.post<Item[], SaveQuery>(
        { url: '/a', body: { x: 1 } },
        { params: { body: null as unknown as SaveQuery['body'] } },
      ),
    );
    await settle();
    expect(http.expectOne('/a').request.body).toBeNull();

    create(() =>
      createRequest.post<Item[], SaveQuery>(
        { url: '/b', body: { x: 1 } },
        { params: { body: undefined as unknown as SaveQuery['body'] } },
      ),
    );
    await settle();
    expect(http.expectOne('/b').request.body).toEqual({ x: 1 });
  });

  it('disables the request while a referenced :placeholder has no value', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest<Item[], { path: { id: string | undefined } }>(
        { url: '/users/:id' },
        { params: { path: { id: undefined } } },
      ),
    );

    await settle();
    expect(r.status()).toBe('idle');
    http.expectNone(() => true);
  });

  it('accepts an HttpParams instance from the source and merges the bag over it', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[], { q: string }>(
        { url: '/h', params: new HttpParams({ fromObject: { sort: 'asc', page: '1' } }) },
        { params: { q: 'ada' } },
      ),
    );

    await settle();
    // `sort` and `page` survive the flatten, `q` comes from the bag.
    http.expectOne('/h?sort=asc&page=1&q=ada').flush([{ id: 1 }]);
  });

  it('keeps a repeated HttpParams value as an array instead of collapsing it', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[]>({ url: '/h', params: new HttpParams().append('tag', 'a').append('tag', 'b') }),
    );

    await settle();
    http.expectOne('/h?tag=a&tag=b').flush([{ id: 1 }]);
  });

  it('lets the bag override a key that the source put in an HttpParams', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[], { page: number }>(
        { url: '/h', params: new HttpParams({ fromObject: { page: '1', sort: 'asc' } }) },
        { params: { page: 2 } },
      ),
    );

    await settle();
    http.expectOne('/h?page=2&sort=asc').flush([{ id: 1 }]);
  });

  it('drops null/undefined query values and keeps arrays, dates and booleans', async () => {
    const { http, create } = setup();
    create(() =>
      createRequest<Item[], QueryBag>(
        { url: '/q' },
        {
          params: {
            keep: 'yes',
            gone: null as unknown as string,
            list: ['a', 'b'],
            flag: true,
            when: new Date('2026-01-02T03:04:05.000Z'),
          },
        },
      ),
    );

    await settle();
    http.expectOne('/q?keep=yes&list=a&list=b&flag=true&when=2026-01-02T03:04:05.000Z').flush([{ id: 1 }]);
  });

  it('re-fires when only `body` changes', async () => {
    const { http, create } = setup();
    const r = create(() =>
      createRequest.post<Item[], SaveQuery>({ url: '/save' }, { params: { body: { v: 1 } } }),
    );

    await settle();
    (await http.expectOne('/save')).flush([{ id: 1 }]);
    await settle();
    expect(r.response()).toEqual([{ id: 1 }]);

    r.params.set({ body: { v: 2 } });
    await settle();
    (await http.expectOne('/save')).flush([{ id: 2 }]);
    await settle();
    expect(r.response()).toEqual([{ id: 2 }]);
  });

  it('never touches the request when no TParams is declared', async () => {
    const { http, create } = setup();
    create(() => createRequest.post<Item>({ url: '/plain', body: { keep: 1 } }));

    await settle();
    const req = http.expectOne('/plain');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ keep: 1 });
  });
});

describe('createRequest – success()', () => {
  it('is false before, true after, false on failure, false while retrying', async () => {
    const { http, create } = setup();
    const r = create(() => createRequest<number>('/n'));

    expect(r.success()).toBe(false);

    await settle();
    expect(r.success()).toBe(false);

    await respond(http, '/n', 1);
    expect(r.success()).toBe(true);

    r.reload();
    await settle();
    expect(r.success()).toBe(false);
    await respond(http, '/n', 2);
    expect(r.success()).toBe(true);

    r.reload();
    await settle();
    expect(r.success()).toBe(false); // false while reloading

    await fail(http, '/n', 500);
    expect(r.success()).toBe(false);
    expect(r.error()).toBeTruthy();
  });
});

describe('createRequest – params typing', () => {
  it('requires a params option whenever TParams is given', () => {
    const { create } = setup();

    // @ts-expect-error — a `params` option is required once TParams is declared
    const missing = () => createRequest<number, ListQuery>(() => '/n', { initialValue: 0 });

    // @ts-expect-error — the `params` option is rejected when no TParams is declared
    const extra = () => createRequest<number>(() => '/n', { params: { a: 1 } });

    expectTypeOf(missing).toBeFunction();
    expectTypeOf(extra).toBeFunction();
  });

  it('infers the params type in the source and exposes it on the handle', () => {
    const { create } = setup();
    const r = create(() =>
      createRequest<number, ListQuery>(
        (params) => {
          expectTypeOf(params).toEqualTypeOf<ListQuery>();
          return { url: `/items/${params.param1}` };
        },
        { params: { param1: '1', param2: 2, body: null } },
      ),
    );

    expectTypeOf(r.params).toEqualTypeOf<WritableSignal<ListQuery | undefined>>();
    expectTypeOf(r.response).toEqualTypeOf<Signal<number | undefined>>();
    expectTypeOf(r.success).toEqualTypeOf<Signal<boolean>>();
  });
});

interface Item {
  id: number;
}

