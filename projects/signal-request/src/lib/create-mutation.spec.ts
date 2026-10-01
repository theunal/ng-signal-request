import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { inject, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createMutation,
  createRequest,
  provideSignalRequest,
  RequestCancelledError,
  type MutationOptions,
} from '../public-api';
import { settle, setup } from '../../testing/testing';

interface User {
  id: number;
  name: string;
}

describe('createMutation', () => {
  it('sends the request on run(), tracks state and resolves with the response', async () => {
    const { http, create } = setup();
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const save = create(() =>
      createMutation.put<User, Partial<User>>(
        (user) => ({ url: '/users/:id', path: { id: user.id }, body: user }),
        { onSuccess, onSettled },
      ),
    );
    expect(save.status()).toBe('idle');
    http.expectNone(() => true); // never fires on its own

    const p = save.run({ id: 4, name: 'Ada' });
    expect(save.status()).toBe('loading');
    expect(save.loading()).toBe(true);
    expect(save.args()).toEqual({ id: 4, name: 'Ada' });

    // `TArgs` doubles as a params bag. `id` and `name` are not reserved, so they also land in
    // the query string — the point of the bag is that you can name them `body` / `path` instead.
    const req = http.expectOne('/users/4?id=4&name=Ada');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ id: 4, name: 'Ada' });
    req.flush({ id: 4, name: 'Ada' });

    await expect(p).resolves.toEqual({ id: 4, name: 'Ada' });
    expect(save.status()).toBe('success');
    expect(save.response()).toEqual({ id: 4, name: 'Ada' });
    expect(onSuccess).toHaveBeenCalledWith({ id: 4, name: 'Ada' }, { id: 4, name: 'Ada' });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('defaults to POST and supports void args', async () => {
    const { http, create } = setup();
    const ping = create(() => createMutation<{ ok: boolean }>(() => ({ url: '/ping', body: {} })));
    const p = ping.run();
    const req = http.expectOne('/ping');
    expect(req.request.method).toBe('POST');
    req.flush({ ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('sends the verb of each variant', async () => {
    const { http, create } = setup();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['PUT', create(() => createMutation.put<{ ok: boolean }>(() => '/put')).run],
      ['PATCH', create(() => createMutation.patch<{ ok: boolean }>(() => '/patch')).run],
      ['DELETE', create(() => createMutation.delete<void>(() => '/delete')).run],
    ];

    for (const [method, run] of cases) {
      const p = run();
      const req = http.expectOne(`/${method.toLowerCase()}`);
      expect(req.request.method).toBe(method);
      req.flush({ ok: true });
      await p;
    }
  });

  it('rejects run() on errors, exposes error(), calls callbacks, tryRun never rejects', async () => {
    const onError = vi.fn();
    const global = vi.fn();
    const { http, create } = setup([provideSignalRequest({ onError: global })]);
    const del = create(() =>
      createMutation.delete<void, number>((id) => ({ url: `/users/${id}` }), { onError }),
    );
    const p = del.run(1);
    http.expectOne('/users/1').flush({ m: 'nope' }, { status: 403, statusText: 'Forbidden' });
    await expect(p).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(del.status()).toBe('error');
    expect(del.error()).toBeInstanceOf(HttpErrorResponse);
    expect(onError).toHaveBeenCalledWith(expect.any(HttpErrorResponse), 1);
    expect(global).toHaveBeenCalledWith(expect.any(HttpErrorResponse), { url: '/users/1', method: 'DELETE' });

    const t = del.tryRun(2);
    http.expectOne('/users/2').flush('x', { status: 500, statusText: 'Err' });
    const result = await t;
    expect(result.ok).toBe(false);

    const again = del.tryRun(3);
    http.expectOne('/users/3').flush(null);
    expect((await again).ok).toBe(true);
    expect(del.error()).toBeUndefined();
  });

  it('exposes requestError() next to the untouched error()', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation.put<number>(() => '/save'));

    expect(save.error()).toBeUndefined();
    expect(save.requestError()).toBeUndefined();

    const p = save.run();
    http.expectOne('/save').flush('nope', { status: 500, statusText: 'Err' });
    await expect(p).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(save.error()).toBeInstanceOf(HttpErrorResponse);
    expect(save.requestError()?.kind).toBe('http');

    save.reset();
    expect(save.error()).toBeUndefined();
    expect(save.requestError()).toBeUndefined();
  });

  it('merges its own headers over the global defaults for the call', async () => {
    // The per-mutation `headers` option has to win over the global bag without wiping it, and it
    // applies to every call of that mutation (unlike `reportProgress`, which is per call).
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo', 'X-Env': 'prod' } })]);
    const save = s.create(() =>
      createMutation<number>(() => '/save', { headers: { 'X-Env': 'dev', 'X-Trace': 'abc' } }),
    );

    const p = save.run();
    const req = s.http.expectOne('/save');
    expect(req.request.headers.get('X-App')).toBe('demo'); // global survives
    expect(req.request.headers.get('X-Env')).toBe('dev'); // per-mutation wins
    expect(req.request.headers.get('X-Trace')).toBe('abc');
    req.flush(1);
    await expect(p).resolves.toBe(1);
  });

  it('gives up immediately when the retry policy declines the error', async () => {
    // `retry` is wired through an `delay` callback, so "no more retries" has to be expressible as a
    // rejection rather than a delay. A 404 is not transient: the call must fail on the first try
    // even though `count` allows more.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { http, create } = setup();
      const save = create(() =>
        createMutation<number>(() => '/save', { retry: { count: 3, delay: 10_000 } }),
      );

      const p = save.run();
      http.expectOne('/save').flush('nope', { status: 404, statusText: 'Not Found' });
      await expect(p).rejects.toBeInstanceOf(HttpErrorResponse);
      await settle();

      // No retry was scheduled, so nothing is waiting on the 10s back-off.
      expect(save.status()).toBe('error');
      http.expectNone(() => true);
      await vi.advanceTimersByTimeAsync(60_000);
      http.expectNone(() => true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a timeout only when the timeout option is set', async () => {
    const { http, create } = setup();
    const plain = create(() => createMutation<number>(() => '/a', { timeout: 5_000 }));
    const p = plain.run();
    http
      .expectOne('/a')
      .error({ name: 'TimeoutError' } as unknown as ProgressEvent);
    await expect(p).rejects.toBeTruthy();
    expect(plain.requestError()).toEqual({ kind: 'timeout', ms: 5_000 });
  });

  it('uses a function delay to space the retries out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { http, create } = setup();
      const seen: number[] = [];
      const r = create(() =>
        createRequest<number>('/n', {
          retry: {
            count: 2,
            delay: (attempt) => {
              seen.push(attempt);
              return 1_000;
            },
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(10);
      http.expectOne('/n').flush('x', { status: 500, statusText: 'Err' });
      await vi.advanceTimersByTimeAsync(1_500);
      http.expectOne('/n').flush('x', { status: 500, statusText: 'Err' });
      await vi.advanceTimersByTimeAsync(1_500);
      http.expectOne('/n').flush(7);
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toEqual([1, 2]);
      expect(r.response()).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an explicit injector so it can be built outside an injection context', async () => {
    const { http } = setup();
    const save = createMutation.put<number>(() => '/save', { injector: TestBed.inject(Injector) });

    const p = save.run();
    const req = http.expectOne('/save');
    expect(req.request.method).toBe('PUT');
    req.flush(1);
    await expect(p).resolves.toBe(1);
  });

  it('names the failing call with its full path', () => {
    setup();
    expect(() => createMutation.put(() => '/x')).toThrowError(/createMutation\.put/);
    expect(() => createMutation(() => '/x')).toThrowError(/createMutation\(\)/);
  });

  it('destroy() aborts in-flight calls and makes the handle unusable', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save'));

    const p = save.run();
    const req = http.expectOne('/save');
    save.destroy();

    expect(req.cancelled).toBe(true);
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    expect(save.loading()).toBe(false);

    // Terminal, and idempotent.
    save.destroy();
    await expect(save.run()).rejects.toBeInstanceOf(RequestCancelledError);
    http.expectNone(() => true);
  });

  it('destroy() is the only way to tear down a mutation built with an explicit injector', async () => {
    const { http } = setup();
    // This is the case the injector-lifetime rule cannot cover: nothing owns this injector here.
    const save = createMutation<number>(() => '/save', { injector: TestBed.inject(Injector) });

    const p = save.run();
    const req = http.expectOne('/save');
    save.destroy();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    expect(req.cancelled).toBe(true);
  });

  it('reports upload progress when the builder asks for it', async () => {
    const { http, create } = setup();
    const upload = create(() =>
      createMutation<number, { body: unknown }>(
        (args) => ({ url: '/upload', body: args.body, reportProgress: true }),
      ),
    );

    expect(upload.progress()).toBeUndefined();

    const p = upload.run({ body: 'payload' });
    const req = http.expectOne('/upload');
    // `HttpUploadProgressEvent` is type-only in Angular 22, so the event is built by hand.
    req.event({ type: HttpEventType.UploadProgress, loaded: 3, total: 9 } as never);
    expect(upload.progress()?.loaded).toBe(3);
    expect(upload.progress()?.total).toBe(9);
    expect(upload.loading()).toBe(true);

    // The body still arrives as the `Response` event and must not be mistaken for progress.
    req.flush({ ok: true } as never);
    await expect(p).resolves.toEqual({ ok: true });
    expect(upload.status()).toBe('success');
  });

  it('clears progress once the call settles', async () => {
    // The documented contract: `progress()` is undefined before the first event and after the
    // call settles. Leaving the last event behind would pin a `<progress [value]>` at its final
    // value forever. Covers all three settle paths, not just success.
    const { http, create } = setup();
    const upload = create(() =>
      createMutation<number, { body: unknown }>(
        (args) => ({ url: '/upload', body: args.body, reportProgress: true }),
      ),
    );

    // success
    const ok = upload.run({ body: 'payload' });
    const okReq = http.expectOne('/upload');
    okReq.event({ type: HttpEventType.UploadProgress, loaded: 3, total: 9 } as never);
    expect(upload.progress()?.loaded).toBe(3);
    okReq.flush({ ok: true } as never);
    await expect(ok).resolves.toEqual({ ok: true });
    await settle();
    expect(upload.progress()).toBeUndefined();

    // failure
    const bad = upload.run({ body: 'payload' });
    const badReq = http.expectOne('/upload');
    badReq.event({ type: HttpEventType.UploadProgress, loaded: 5, total: 9 } as never);
    badReq.flush({ m: 'nope' }, { status: 500, statusText: 'Err' });
    await expect(bad).rejects.toBeInstanceOf(HttpErrorResponse);
    await settle();
    expect(upload.progress()).toBeUndefined();

    // cancel
    const dropped = upload.run({ body: 'payload' });
    const droppedReq = http.expectOne('/upload');
    droppedReq.event({ type: HttpEventType.UploadProgress, loaded: 7, total: 9 } as never);
    upload.cancel();
    await expect(dropped).rejects.toBeInstanceOf(RequestCancelledError);
    await settle();
    expect(upload.progress()).toBeUndefined();
  });

  it('rejects `reportProgress` as a mutation option — it belongs on the builder', () => {
    // The flag is per call, not per mutation: one may upload, another may delete. It used to be
    // declared here and silently ignored, so the outgoing request never reported progress.
    // @ts-expect-error — `reportProgress` is set on the builder, not in the options.
    const options: MutationOptions<number> = { reportProgress: true };
    expect(options).toEqual({ reportProgress: true });
  });

  it('leaves progress undefined for a call that did not ask for it', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save'));

    expect(save.progress()).toBeUndefined();
    const p = save.run();
    http.expectOne('/save').flush(1);
    await expect(p).resolves.toBe(1);
    expect(save.progress()).toBeUndefined();
  });

  it('calls the global onSuccess with the response and the verb', async () => {
    const global = vi.fn();
    const { http, create } = setup([provideSignalRequest({ onSuccess: global })]);
    const save = create(() => createMutation.put<number>(() => '/save'));
    create(() => createRequest<number>('/q'));
    await settle(); // the query auto-fires, but not synchronously

    const p = save.run();
    http.expectOne('/q').flush(2);
    http.expectOne('/save').flush(1);
    await p;
    await settle();

    expect(global).toHaveBeenCalledWith(1, { url: '/save', method: 'PUT' });
    expect(global).toHaveBeenCalledWith(2, { url: '/q', method: 'GET' });
  });

  it('keeps concurrency and responseType on a variant', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation.patch<string, void>(() => '/save', {
        concurrency: 'exhaust',
        responseType: 'text',
      }),
    );

    const a = save.run();
    const b = save.run();
    expect(b).toBe(a); // 'exhaust' honoured on a variant, not just on the bare call
    const req = http.expectOne('/save');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.responseType).toBe('text');
    req.flush('saved');
    await expect(a).resolves.toBe('saved');
  });

  it('invalidates: reloads the listed requests after success only', async () => {
    const { http, create } = setup();
    const { list, add } = create(() => {
      const list = createRequest<string[]>('/items', { initialValue: [] });
      const add = createMutation<string, string>((name) => ({ url: '/items', body: { name } }), {
        invalidates: () => [list],
      });
      return { list, add };
    });
    await settle();
    http.expectOne('/items').flush(['a']);
    await settle();

    const failing = add.tryRun('b');
    http.expectOne('/items').flush('x', { status: 500, statusText: 'Err' });
    await failing;
    await settle();
    http.expectNone('/items'); // no reload after a failure

    const p = add.run('c');
    http.expectOne('/items').flush('c');
    await p;
    await settle();
    http.expectOne('/items').flush(['a', 'c']);
    await settle();
    expect(list.response()).toEqual(['a', 'c']);
  });

  it('concurrency "exhaust" ignores calls while one is in flight (double-click protection)', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save', { concurrency: 'exhaust' }));
    const a = save.run();
    const b = save.run();
    expect(b).toBe(a);
    http.expectOne('/save').flush(1);
    await a;
    const c = save.run();
    expect(c).not.toBe(a);
    http.expectOne('/save').flush(2);
    await expect(c).resolves.toBe(2);
  });

  it('concurrency "switch" aborts the previous call', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save', { concurrency: 'switch' }));
    const a = save.run();
    const first = http.expectOne('/save');
    const b = save.run();
    expect(first.cancelled).toBe(true);
    await expect(a).rejects.toBeInstanceOf(RequestCancelledError);
    http.expectOne('/save').flush(2);
    await expect(b).resolves.toBe(2);
    expect(save.loading()).toBe(false);
  });

  it('concurrency "parallel" (default) sends every call and keeps the loading flag until all finish', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save'));
    const a = save.run();
    const b = save.run();
    const [r1, r2] = http.match('/save');
    r1.flush(1);
    await a;
    expect(save.loading()).toBe(true);
    r2.flush(2);
    await b;
    expect(save.loading()).toBe(false);
    expect(save.response()).toBe(2);
  });

  it('cancel() aborts in-flight calls; reset() clears state', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save'));
    const p = save.run();
    const req = http.expectOne('/save');
    save.cancel();
    expect(req.cancelled).toBe(true);
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    expect(save.loading()).toBe(false);

    const q = save.run();
    http.expectOne('/save').flush(7);
    await q;
    expect(save.status()).toBe('success');
    save.reset();
    expect(save.status()).toBe('idle');
    expect(save.response()).toBeUndefined();
  });

  it('retry is opt-in and uses the same policy as queries', async () => {
    // rxjs `timer` is interval based
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { http, create } = setup();
      const save = create(() => createMutation<number>(() => '/save', { retry: { count: 1, delay: 50 } }));
      const p = save.run();
      http.expectOne('/save').flush('x', { status: 503, statusText: 'Err' });
      await vi.advanceTimersByTimeAsync(50);
      http.expectOne('/save').flush(5);
      await expect(p).resolves.toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parse can validate / map and turns thrown errors into a failed call', async () => {
    const { http, create } = setup();
    const m = create(() =>
      createMutation<number>(() => '/n', {
        parse: (raw) => {
          if (typeof raw !== 'number') throw new Error('not a number');
          return raw * 2;
        },
      }),
    );
    const ok = m.run();
    http.expectOne('/n').flush(4);
    await expect(ok).resolves.toBe(8);

    const bad = m.tryRun();
    http.expectOne('/n').flush('nope');
    const r = await bad;
    expect(r.ok).toBe(false);
    expect(m.error()?.message).toBe('not a number');
  });

  it('a throwing `parse` settles the call like a failure, not a success', async () => {
    // The body arrived fine; the validation rejected it. That still has to clear `loading`, flip
    // `status` to `error`, run the failure hooks and reject the promise — otherwise the handle is
    // left half-settled with no way for a caller to notice.
    const { http, create } = setup();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const onSuccess = vi.fn();
    const m = create(() =>
      createMutation<number>(() => '/n', {
        parse: () => {
          throw new Error('bad shape');
        },
        onError,
        onSettled,
        onSuccess,
      }),
    );

    const p = m.run();
    expect(m.loading()).toBe(true);
    http.expectOne('/n').flush({ anything: true });

    await expect(p).rejects.toThrowError('bad shape');
    await settle();

    expect(m.loading()).toBe(false);
    expect(m.status()).toBe('error');
    expect(m.response()).toBeUndefined(); // never promoted to a value
    expect(m.requestError()?.kind).toBe('unknown');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Still usable afterwards: the next call settles normally.
    const next = m.tryRun();
    http.expectOne('/n').flush(1);
    // The same throwing `parse` fails again, which proves the handle was not left broken.
    expect((await next).ok).toBe(false);
  });

  it('survives a lifecycle hook that throws instead of corrupting the call', async () => {
    // Mirrors the `createRequest` case: a throwing hook is reported to the ErrorHandler, but the
    // mutation still settles normally. Without this, a bad `onSuccess` would leave the handle
    // stuck in `loading` forever.
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number>(() => '/save', {
        onSuccess: () => {
          throw new Error('hook exploded');
        },
        onSettled: () => {
          throw new Error('settled hook exploded too');
        },
      }),
    );

    const p = save.run();
    http.expectOne('/save').flush(7);

    await expect(p).resolves.toBe(7);
    expect(save.status()).toBe('success');
    expect(save.loading()).toBe(false);
    expect(save.response()).toBe(7);
    expect(save.error()).toBeUndefined();
  });

  it('routes body / path from the args bag', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<User, { path: { id: number }; body: Partial<User> }>(() => '/users/:id'));

    const p = save.run({ path: { id: 9 }, body: { name: 'Grace' } });

    const req = http.expectOne('/users/9');
    // the bag supplied both, so the builder did not have to
    expect(req.request.method).toBe('POST'); // the verb came from bare `createMutation`
    expect(req.request.body).toEqual({ name: 'Grace' });
    req.flush({ id: 9, name: 'Grace' });

    await expect(p).resolves.toEqual({ id: 9, name: 'Grace' });
  });

  it('is disabled when a referenced :placeholder has no value', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<User, { path: { id: number | undefined } }>(() => '/users/:id'));

    const result = await save.tryRun({ path: { id: undefined } });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeInstanceOf(RequestCancelledError);
    http.expectNone(() => true);
  });

  it('is cancelled together with its owning injector', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => '/save'));
    const p = save.run();
    const req = http.expectOne('/save');
    TestBed.resetTestingModule();
    expect(req.cancelled).toBe(true);
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('keeps a timeout set by the builder instead of overwriting it with undefined', async () => {
    const { http, create } = setup();
    const save = create(() => createMutation<number>(() => ({ url: '/save', timeout: 1234 })));
    const p = save.run();
    const req = http.expectOne('/save');
    expect(req.request.timeout).toBe(1234);
    req.flush(1);
    await expect(p).resolves.toBe(1);
  });

  it('lets the timeout option win over the builder', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number>(() => ({ url: '/save', timeout: 1234 }), { timeout: 50 }),
    );
    void save.run();
    expect(http.expectOne('/save').request.timeout).toBe(50);
  });

  it('rejects instead of throwing synchronously when the builder throws', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number>(() => {
        throw new Error('bad builder');
      }),
    );
    let promise: Promise<number> | undefined;
    expect(() => (promise = save.run())).not.toThrow();
    await expect(promise).rejects.toThrow('bad builder');
    expect(save.status()).toBe('idle');
    http.expectNone(() => true);
  });

  it('accepts a factory config that can inject()', async () => {
    const seen: string[] = [];
    const { http, create } = setup([
      provideSignalRequest(() => {
        const injector = inject(Injector); // only legal because the factory runs in an injection context
        return { baseUrl: 'https://api.test', onError: (e) => seen.push(`${!!injector}:${e.message}`) };
      }),
    ]);
    const save = create(() => createMutation<number>(() => '/save'));
    const p = save.tryRun();
    http.expectOne('https://api.test/save').flush('x', { status: 400, statusText: 'Bad' });
    const result = await p;
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^true:/);
  });
});
