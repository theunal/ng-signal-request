import { TestBed } from '@angular/core/testing';
import { Injector, signal } from '@angular/core';
import type { Signal, WritableSignal } from '@angular/core';
import { EMPTY, Observable, of } from 'rxjs';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createQuery,
  createRequest,
  QueryClient,
  RequestCancelledError,
  type QueryRequest,
} from '../public-api';
import { cache, settle, setup } from '../../testing/testing';
import { OnlineManager } from './connectivity';

interface User {
  id: number;
  name: string;
}

const user: User = { id: 1, name: 'Ada' };

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createQuery — a Promise source', () => {
  it('fetches on mount and exposes the cached handle shape', async () => {
    const { create } = setup();
    let calls = 0;

    const query = create(() =>
      createQuery<User[]>(
        async () => {
          calls += 1;
          return [user];
        },
        { key: () => ['users'], staleTime: 60_000 },
      ),
    );

    await settle();

    expect(calls).toBe(1);
    expect(query.response()).toEqual([user]);
    expect(query.status()).toBe('resolved');
    expect(query.success()).toBe(true);
    expect(query.loading()).toBe(false);
    expect(query.fetchCount()).toBe(1);
    expect(query.dataUpdatedAt()).toBeGreaterThan(0);
    expect(query.isStale()).toBe(false);
    expect(cache().size).toBe(1);
  });

  it('shares one entry and one call between two handles on one key', async () => {
    const { createChild } = setup();
    const a = createChild();
    const b = createChild();
    const pending = deferred<User[]>();

    const one = a.create(() => createQuery(() => pending.promise, { key: () => ['users'] }));
    const two = b.create(() => createQuery(() => pending.promise, { key: () => ['users'] }));
    await settle();

    pending.resolve([user]);
    await settle();

    expect(one.fetchCount()).toBe(1);
    expect(two.fetchCount()).toBe(1);
    expect(two.response()).toEqual([user]);

    a.destroy();
    b.destroy();
  });

  it('gives `run()`, `tryRun()`, `reload`, `set` and `update` their cached meaning', async () => {
    const { create } = setup();
    let calls = 0;
    const query = create(() =>
      createQuery<User>(
        async () => {
          calls += 1;
          return { id: calls, name: `User ${calls}` };
        },
        { key: () => ['user'] },
      ),
    );

    await settle();
    expect(query.response()).toEqual({ id: 1, name: 'User 1' });

    query.set({ id: 9, name: 'Set' });
    expect(query.response()).toEqual({ id: 9, name: 'Set' });
    expect(query.status()).toBe('local');

    query.update((current) => ({ ...(current as User), name: 'Updated' }));
    expect(query.response()).toEqual({ id: 9, name: 'Updated' });

    expect(query.reload()).toBe(true);
    await settle();
    expect(calls).toBe(2);

    await expect(query.run()).resolves.toEqual({ id: 3, name: 'User 3' });
    await expect(query.tryRun()).resolves.toEqual({
      ok: true,
      response: { id: 4, name: 'User 4' },
    });
  });

  it('is lazy when asked', async () => {
    const { create } = setup();
    let calls = 0;
    const query = create(() =>
      createQuery<number>(
        async () => {
          calls += 1;
          return 7;
        },
        { key: () => ['lazy'], lazy: true },
      ),
    );

    await settle();
    expect(calls).toBe(0);
    expect(query.status()).toBe('idle');

    await expect(query.run()).resolves.toBe(7);
    expect(calls).toBe(1);
  });

  it('applies params, gates on undefined, and reports a disabled run', async () => {
    const { create } = setup();
    const seen: number[] = [];
    const query = create(() =>
      createQuery<User, { id: number }>(
        async (params) => {
          seen.push(params.id);
          return { id: params.id, name: `User ${params.id}` };
        },
        { key: () => ['param-user'], params: { id: 1 } },
      ),
    );

    await settle();
    expect(seen).toEqual([1]);

    query.params.set({ id: 2 });
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(query.response()).toEqual({ id: 2, name: 'User 2' });

    query.params.set(undefined);
    await settle();
    expect(query.status()).toBe('idle');
    await expect(query.run()).rejects.toBeInstanceOf(RequestCancelledError);
    expect(query.reload()).toBe(false);
  });

  it('uses a persisted seed and does not call the source while it is fresh', async () => {
    const { create } = setup();
    let calls = 0;
    cache().seed(['draft'], { text: 'saved' }, Date.now());

    const query = create(() =>
      createQuery<{ text: string }>(
        async () => {
          calls += 1;
          return { text: 'network' };
        },
        { key: () => ['draft'], staleTime: 60_000 },
      ),
    );

    await settle();

    expect(query.response()).toEqual({ text: 'saved' });
    expect(calls).toBe(0);
    expect(query.status()).toBe('resolved');
  });

  it('supports a structural-sharing function and a selector', async () => {
    const { create } = setup();
    const query = create(() =>
      createQuery<User[]>(async () => [user], {
        key: () => ['selected'],
        structuralSharing: (previous, next) => previous ?? next,
      }),
    );

    await settle();

    const names = query.select((users) => users.map((u) => u.name));
    expect(names()).toEqual(['Ada']);
  });

  it('reads safely before the first value, and update is a no-op when disabled', async () => {
    const { create } = setup();
    const query = create(() =>
      createQuery<User, { id: number }>(async () => user, {
        key: () => ['safe-reads'],
        params: { id: 1 },
        lazy: true,
      }),
    );

    expect(query.response()).toBeUndefined();
    expect(query.requestError()).toBeUndefined();
    expect(query.dataUpdatedAt()).toBe(0);
    expect(query.fetchCount()).toBe(0);
    expect(query.isStale()).toBe(true);
    expect(query.status()).toBe('idle');

    query.params.set(undefined);
    await settle();
    query.update(() => user);
    expect(query.response()).toBeUndefined();
    expect(query.paused()).toBe(false);
  });

  it('can be destroyed twice, after which run and reload refuse', async () => {
    const { create } = setup();
    const query = create(() =>
      createQuery<number>(async () => 1, { key: () => ['destroyed'], lazy: true }),
    );

    query.destroy();
    query.destroy();

    await expect(query.run()).rejects.toBeInstanceOf(RequestCancelledError);
    const attempt = await query.tryRun();
    expect(attempt.ok).toBe(false);
    expect(query.reload()).toBe(false);
  });

  it('keeps the previous value across a key change when asked', async () => {
    const { create } = setup();
    const id = signal(1);
    const second = deferred<User>();

    const query = create(() =>
      createQuery<User>(() => (id() === 1 ? Promise.resolve(user) : second.promise), {
        key: () => ['keep-previous', id()],
        keepPreviousValue: true,
      }),
    );

    await settle();
    expect(query.response()).toEqual(user);

    id.set(2);
    await settle();

    expect(cache().peek(['keep-previous', 2])).toBeDefined();
    expect(query.status()).toBe('loading');
    expect(query.response()).toEqual(user);

    second.resolve({ id: 2, name: 'Grace' });
    await settle();
    expect(query.response()).toEqual({ id: 2, name: 'Grace' });
  });

  it('accepts an explicit injector outside an injection context', async () => {
    const { create } = setup();
    const injector = create(() => TestBed.inject(Injector));

    const query = createQuery<number>(async () => 5, {
      key: () => ['explicit-injector'],
      injector,
      lazy: true,
    });

    await expect(query.run()).resolves.toBe(5);
  });
});

describe('createQuery — an Observable source', () => {
  it('takes the first emission as the value and unsubscribes', async () => {
    const { create } = setup();
    const teardown = vi.fn();
    const query = create(() =>
      createQuery<number>(
        () =>
          new Observable<number>((subscriber) => {
            subscriber.next(1);
            subscriber.next(2);
            subscriber.complete();
            return teardown;
          }),
        { key: () => ['observable'] },
      ),
    );

    await settle();

    expect(query.response()).toBe(1);
    expect(query.status()).toBe('resolved');
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('accepts a synchronous `of()` and keeps the first value', async () => {
    const { create } = setup();
    const query = create(() => createQuery<number>(() => of(10, 20), { key: () => ['of'] }));

    await settle();
    expect(query.response()).toBe(10);
  });

  it('treats completion without a value as an error', async () => {
    const { create } = setup();
    const query = create(() => createQuery<number>(() => EMPTY, { key: () => ['empty'] }));

    await settle();

    expect(query.status()).toBe('error');
    expect(query.error()?.message).toContain('completed without emitting');
    expect(query.requestError()?.kind).toBe('unknown');
  });

  it('retries by calling the function again, not by resubscribing a promise', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { create } = setup();
    let attempts = 0;

    const query = create(() =>
      createQuery<number>(
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('first attempt');
          return 42;
        },
        {
          key: () => ['retry-query'],
          retry: { count: 1, delay: 100, when: () => true },
        },
      ),
    );

    await settle();
    expect(attempts).toBe(1);
    expect(query.retryAttempt()).toBe(1);
    // A retry in flight masks the failure, exactly like the HTTP path.
    expect(query.error()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(attempts).toBe(2);
    expect(query.response()).toBe(42);
    expect(query.retryAttempt()).toBe(0);
  });
});

describe('createQuery — aborts and late results', () => {
  it('aborts the signal on cancel(), and a late resolve never writes', async () => {
    const { create } = setup();
    const pending = deferred<User>();
    let seen: AbortSignal | undefined;

    const query = create(() =>
      createQuery<User>(
        async (_params, ctx) => {
          seen = ctx.signal;
          return pending.promise;
        },
        { key: () => ['cancel-query'] },
      ),
    );
    await settle();

    expect(seen?.aborted).toBe(false);
    query.cancel();
    expect(seen?.aborted).toBe(true);

    pending.resolve(user);
    await settle();

    expect(query.response()).toBeUndefined();
    expect(query.error()).toBeUndefined();
    expect(cache().peek<User>(['cancel-query'])?.data()).toBeUndefined();
  });

  it('aborts when the last subscriber leaves, and drops the late result', async () => {
    const { createChild } = setup();
    const child = createChild();
    const pending = deferred<User>();
    let seen: AbortSignal | undefined;

    const query = child.create(() =>
      createQuery<User>(
        async (_params, ctx) => {
          seen = ctx.signal;
          return pending.promise;
        },
        { key: () => ['unmount-query'] },
      ),
    );
    await settle();
    expect(seen?.aborted).toBe(false);

    child.destroy();
    await settle();
    expect(seen?.aborted).toBe(true);
    expect(query.isFetching()).toBe(false);

    pending.resolve(user);
    await settle();
    expect(cache().peek<User>(['unmount-query'])?.data()).toBeUndefined();
  });

  it('cancels before the first effect ran when the scope is destroyed immediately', async () => {
    const { createChild } = setup();
    const child = createChild();
    let called = false;

    child.create(() =>
      createQuery<number>(
        async () => {
          called = true;
          return 1;
        },
        { key: () => ['destroyed-query'] },
      ),
    );
    child.destroy();
    await settle();

    expect(called).toBe(false);
    expect(cache().peek(['destroyed-query'])?.data()).toBeUndefined();
  });

  it('does not abort a shared request when only one of two handles is destroyed', async () => {
    const { createChild } = setup();
    const a = createChild();
    const b = createChild();
    const pending = deferred<User>();
    let seen: AbortSignal | undefined;

    a.create(() =>
      createQuery<User>(
        async (_params, ctx) => {
          seen = ctx.signal;
          return pending.promise;
        },
        { key: () => ['shared-abort'] },
      ),
    );
    const two = b.create(() =>
      createQuery<User>(async () => user, { key: () => ['shared-abort'] }),
    );
    await settle();

    a.destroy();
    await settle();
    expect(seen?.aborted).toBe(false);

    pending.resolve(user);
    await settle();
    expect(two.response()).toEqual(user);
    b.destroy();
  });
});

describe('createQuery — errors', () => {
  it('normalizes a non-HTTP failure to `unknown` with the original cause', async () => {
    const { create } = setup();
    const failure = new TypeError('a bug in the function');
    const query = create(() =>
      createQuery<User>(() => Promise.reject(failure), { key: () => ['error-query'] }),
    );

    await settle();

    expect(query.status()).toBe('error');
    expect(query.error()).toBe(failure);
    const requestError = query.requestError();
    expect(requestError?.kind).toBe('unknown');
    expect(requestError?.unknown()?.cause).toBe(failure);
  });

  it('keeps an abort-like rejection classified as aborted', async () => {
    const { create } = setup();
    const query = create(() =>
      createQuery<User>(() => Promise.reject(new DOMException('stop', 'AbortError')), {
        key: () => ['abort-error'],
      }),
    );

    await settle();
    expect(query.requestError()?.kind).toBe('aborted');
  });

  it('fails the entry when `parse` throws', async () => {
    const { create } = setup();
    const query = create(() =>
      createQuery<User>(async () => user, {
        key: () => ['parse-query'],
        parse: () => {
          throw new Error('bad shape');
        },
      }),
    );

    await settle();
    expect(query.status()).toBe('error');
    expect(query.error()?.message).toContain('bad shape');
  });
});

describe('createQuery — sharing with a keyed createRequest', () => {
  it('a createRequest joins an in-flight query instead of sending a request', async () => {
    const { http, create } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pending = deferred<User[]>();
    let queryCalls = 0;

    const query = create(() =>
      createQuery<User[]>(
        () => {
          queryCalls += 1;
          return pending.promise;
        },
        { key: () => ['cross-kind'] },
      ),
    );
    await settle();

    const request = create(() =>
      createRequest<User[]>('/cross-kind', { key: () => ['cross-kind'] }),
    );
    await settle();

    expect(queryCalls).toBe(1);
    http.expectNone(() => true);

    pending.resolve([user]);
    await settle();

    expect(request.response()).toEqual([user]);
    expect(request.fetchCount()).toBe(1);
    expect(query.fetchCount()).toBe(1);
  });

  it('a createQuery joins an in-flight keyed request and never calls its source', async () => {
    const { http, create } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let queryCalls = 0;

    const request = create(() =>
      createRequest<User[]>('/cross-kind-http', { key: () => ['cross-kind-http'] }),
    );
    await settle();

    const query = create(() =>
      createQuery<User[]>(
        () => {
          queryCalls += 1;
          return Promise.resolve([user]);
        },
        { key: () => ['cross-kind-http'] },
      ),
    );
    await settle();

    expect(queryCalls).toBe(0);
    http.expectOne('/cross-kind-http').flush([user]);
    await settle();

    expect(query.response()).toEqual([user]);
    expect(query.fetchCount()).toBe(1);
    expect(request.headers()).toBeDefined();
    expect(request.progress()).toBeUndefined();
  });

  it('warns once in dev mode when two kinds register the same key', async () => {
    const { http, create } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    create(() => createRequest<User[]>('/kind-warning', { key: () => ['kind-warning'] }));
    create(() => createQuery<User[]>(async () => [user], { key: () => ['kind-warning'] }));
    await settle();

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(
      messages.filter((m) => m.includes('both a createRequest and a createQuery')),
    ).toHaveLength(1);

    // Re-evaluating the same handle must not warn again.
    create(() => createQuery<User[]>(async () => [user], { key: () => ['kind-warning'] }));
    await settle();
    expect(
      messages.filter((m) => m.includes('both a createRequest and a createQuery')),
    ).toHaveLength(1);

    http.expectOne('/kind-warning').flush([user]);
    await settle();
  });
});

describe('createQuery — networkMode and invalidation', () => {
  it('pauses an `online` query and starts it once on reconnect', async () => {
    const { create } = setup();
    const manager = TestBed.inject(OnlineManager);
    manager.setOnline(false);

    let calls = 0;
    const query = create(() =>
      createQuery<User>(
        async () => {
          calls += 1;
          return user;
        },
        { key: () => ['paused-query'], networkMode: 'online' },
      ),
    );
    await settle();

    expect(calls).toBe(0);
    expect(query.paused()).toBe(true);
    expect(query.status()).toBe('loading');

    manager.setOnline(true);
    await settle();

    expect(calls).toBe(1);
    expect(query.paused()).toBe(false);
    expect(query.response()).toEqual(user);
  });

  it('does not duplicate an in-flight query on invalidate, and refetches after it settles', async () => {
    const { create } = setup();
    const client = TestBed.inject(QueryClient);
    let calls = 0;
    const first = deferred<User>();

    const query = create(() =>
      createQuery<User>(
        () => {
          calls += 1;
          return calls === 1 ? first.promise : Promise.resolve({ id: 2, name: 'Grace' });
        },
        { key: () => ['invalidated-query'] },
      ),
    );
    await settle();

    client.invalidate(['invalidated-query']);
    await settle();
    expect(calls).toBe(1);

    first.resolve(user);
    await settle();
    expect(query.response()).toEqual(user);

    client.invalidate(['invalidated-query']);
    await settle();
    expect(calls).toBe(2);
    expect(query.response()).toEqual({ id: 2, name: 'Grace' });
  });

  it('is visible through QueryClient.isPaused', async () => {
    const { create } = setup();
    TestBed.inject(OnlineManager).setOnline(false);
    create(() =>
      createQuery<User>(async () => user, {
        key: () => ['client-paused'],
        networkMode: 'online',
      }),
    );
    await settle();

    expect(TestBed.inject(QueryClient).isPaused(['client-paused'])).toBe(true);
  });
});

describe('createQuery — types', () => {
  it('infers the handle, the params, the selector and `initialValue`', () => {
    const { create } = setup();

    const plain = create(() =>
      createQuery<User[]>(async () => [user], { key: () => ['types-plain'] }),
    );
    expectTypeOf(plain).toEqualTypeOf<QueryRequest<User[], User[] | undefined>>();
    expectTypeOf(plain.response).toEqualTypeOf<Signal<User[] | undefined>>();

    const withInitial = create(() =>
      createQuery<User[]>(async () => [user], {
        key: () => ['types-initial'],
        initialValue: [],
      }),
    );
    expectTypeOf(withInitial.response).toEqualTypeOf<Signal<User[]>>();

    const names = plain.select((users) => users.map((u) => u.name));
    expectTypeOf(names).toEqualTypeOf<Signal<string[] | undefined>>();

    const withParams = create(() =>
      createQuery<User, { id: number }>(
        (params, ctx) => {
          expectTypeOf(params).toEqualTypeOf<{ id: number }>();
          expectTypeOf(ctx.params).toEqualTypeOf<{ id: number }>();
          expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
          return Promise.resolve({ id: params.id, name: 'typed' });
        },
        { key: () => ['types-params'], params: { id: 1 } },
      ),
    );
    expectTypeOf(withParams.params).toEqualTypeOf<WritableSignal<{ id: number } | undefined>>();
  });

  it('rejects a params type without a `params` option', () => {
    const { create } = setup();
    create(() => {
      const build = () =>
        // @ts-expect-error `params` is required when `TParams` is declared.
        createQuery<User, { id: number }>(async () => user, { key: () => ['no-params'] });
      expectTypeOf(build).toBeFunction();
    });
  });
});
