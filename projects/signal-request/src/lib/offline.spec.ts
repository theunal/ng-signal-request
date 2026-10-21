import { PLATFORM_ID, signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createInfiniteRequest,
  createMutation,
  createRequest,
  MutationRegistry,
  provideSignalRequest,
  QueryClient,
  RequestCancelledError,
  RESTORE_GATE,
  type CachedRequest,
  type InfiniteRequest,
  type MutationOptions,
  type NetworkMode,
  type RestoreGate,
  type SignalMutation,
  type SignalRequest,
} from '../public-api';
import { OnlineManager } from './connectivity';
import { cache, settle, setup } from '../../testing/testing';

/**
 * Connectivity under `networkMode`.
 *
 * Everything here drives the manager rather than the browser global: `OnlineManager` is the one
 * source of truth the library reads, and the point of the seam is that a test does not have to
 * pretend to be an operating system.
 */
const manager = (): OnlineManager => TestBed.inject(OnlineManager);
const goOffline = (): void => manager().setOnline(false);
const goOnline = async (): Promise<void> => {
  manager().setOnline(true);
  await settle();
};

describe('networkMode', () => {
  it('defaults to `always`: a request still fires while offline', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() => createRequest<number>('/items'));

    await settle();
    http.expectOne('/items').flush(1);
    await settle();

    expect(list.response()).toBe(1);
    expect(list.paused()).toBe(false);
  });

  it('holds an `online` request at mount and starts it once on reconnect', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() => createRequest<number>('/items', { networkMode: 'online' }));

    await settle();
    http.expectNone('/items');
    expect(list.paused()).toBe(true);
    expect(list.status()).toBe('loading');
    expect(list.loading()).toBe(true);

    await goOnline();
    http.expectOne('/items').flush(1);
    await settle();

    expect(list.response()).toBe(1);
    expect(list.paused()).toBe(false);
    expect(list.status()).toBe('resolved');
    http.expectNone(() => true);
  });

  it('keeps a `run()` made while paused pending until the reconnect', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() => createRequest<number>('/items', { networkMode: 'online' }));
    await settle();

    let resolved = false;
    const p = list.run().then((value) => {
      resolved = true;
      return value;
    });
    await settle();

    expect(resolved).toBe(false);
    expect(list.paused()).toBe(true);

    await goOnline();
    http.expectOne('/items').flush(7);

    await expect(p).resolves.toBe(7);
    expect(resolved).toBe(true);
  });

  it('rejects a cancelled paused request with `RequestCancelledError`', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() => createRequest<number>('/items', { networkMode: 'online' }));
    await settle();
    const p = list.run();

    list.cancel();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    expect(list.paused()).toBe(false);

    // Nothing was armed: a reconnect must not resurrect the cancelled request.
    await goOnline();
    http.expectNone(() => true);
  });

  it('runs the first attempt under `offlineFirst` and pauses only the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { http, create } = setup();
      goOffline();
      const list = create(() =>
        createRequest<number>('/items', {
          networkMode: 'offlineFirst',
          retry: { count: 3, delay: 1_000 },
          // The reconnect has two reasons to act: the paused retry and this refetch. They must
          // resolve to one request, not two.
          refetchOnReconnect: true,
        }),
      );

      await settle();
      // The first attempt is not held.
      http.expectOne('/items').error(new ProgressEvent('error'), {
        status: 0,
        statusText: 'Unknown Error',
      });
      await settle();

      expect(list.paused()).toBe(true);
      // No back-off timer and no attempt spent: the wait is for a connection, not for a clock.
      expect(list.retryAttempt()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      await goOnline();
      http.expectOne('/items').flush(3);
      await settle();

      expect(list.response()).toBe(3);
      expect(list.paused()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the global config set the mode, and the request override it', async () => {
    const { http, create } = setup([provideSignalRequest({ networkMode: 'online' })]);
    goOffline();
    const inherited = create(() => createRequest<number>('/inherited'));
    const always = create(() => createRequest<number>('/always', { networkMode: 'always' }));

    await settle();
    http.expectNone('/inherited');
    http.expectOne('/always').flush(1);
    await settle();
    expect(always.response()).toBe(1);

    await goOnline();
    http.expectOne('/inherited').flush(2);
    await settle();
    expect(inherited.response()).toBe(2);
  });

  it('does not treat a throwing source as paused', async () => {
    const { create } = setup();
    goOffline();
    const list = create(() =>
      createRequest<number>(
        () => {
          throw new Error('bad source');
        },
        { networkMode: 'online' },
      ),
    );
    await settle();

    // `status()` reads the request to decide, so the read has to be non-throwing: a broken source is
    // an error, not a reason to wait for a connection.
    expect(list.paused()).toBe(false);
    expect(() => list.status()).not.toThrow();
    expect(list.error()).toBeInstanceOf(Error);
  });

  it('survives a reconnect whose refetch microtask lands after destroy()', async () => {
    const { http, createChild } = setup();
    const scope = createChild();
    scope.create(() => createRequest<number>('/items', { refetchOnReconnect: true }));
    await settle();
    http.expectOne('/items').flush(1);
    await settle();

    // The refetch is deferred a microtask *inside* the announcement; the scope goes away between
    // the two, which is the window the `destroyed` guard exists for.
    manager().setOnline(true);
    await Promise.resolve();
    scope.destroy();
    await settle();

    http.expectNone(() => true);
  });

  it('does nothing on reconnect for a lazy handle whose source is disabled', async () => {
    const { http, create } = setup();
    const list = create(() =>
      createRequest<number>(() => undefined, { lazy: true, refetchOnReconnect: true }),
    );
    await settle();

    await goOnline();
    http.expectNone(() => true);
    expect(list.status()).toBe('idle');
    expect(list.paused()).toBe(false);
  });

  it('ignores `networkMode` on the server', async () => {
    const { http, create } = setup([{ provide: PLATFORM_ID, useValue: 'server' }]);
    // Even with the manager reporting offline, a render must not hold: there is no browser to
    // reconnect, and a held render would hold stability forever.
    TestBed.inject(OnlineManager).setOnline(false);
    const list = create(() => createRequest<number>('/items', { networkMode: 'online' }));

    await settle();
    http.expectOne('/items').flush(1);
    await settle();

    expect(list.response()).toBe(1);
  });
});

describe('networkMode – cached entries', () => {
  it('pauses the shared entry, reports it through the handle and through `isPaused`', async () => {
    const { http, create } = setup();
    const client = TestBed.inject(QueryClient);
    goOffline();
    const list = create(() =>
      createRequest<number>('/items', { key: () => ['items'], networkMode: 'online' }),
    );

    await settle();
    http.expectNone('/items');
    expect(list.paused()).toBe(true);
    expect(list.status()).toBe('loading');
    expect(cache().all()[0].paused()).toBe(true);
    expect(client.isPaused()).toBe(true);
    expect(client.isAnythingPaused()).toBe(true);
    expect(client.isPaused(['items'])).toBe(true);
    expect(client.isPaused(['other'])).toBe(false);

    await goOnline();
    http.expectOne('/items').flush(1);
    await settle();
    expect(client.isPaused()).toBe(false);
    expect(client.isAnythingPaused()).toBe(false);
    expect(list.response()).toBe(1);
  });

  it('lets two handles on one key share the pause and the single resumed request', async () => {
    const { http, createChild } = setup();
    const a = createChild();
    const b = createChild();
    goOffline();

    const first = a.create(() =>
      createRequest<number>('/items', { key: () => ['items'], networkMode: 'online' }),
    );
    const second = b.create(() =>
      createRequest<number>('/items', { key: () => ['items'], networkMode: 'online' }),
    );
    await settle();

    expect(first.paused()).toBe(true);
    expect(second.paused()).toBe(true);

    await goOnline();
    // One request for the key: the second handle joined the hold, and joined the resume.
    http.expectOne('/items').flush(5);
    await settle();

    expect(first.response()).toBe(5);
    expect(second.response()).toBe(5);
    expect(first.fetchCount()).toBe(1);
  });

  it('cancels a paused entry when its last observer goes away', async () => {
    const { http, createChild } = setup();
    const scope = createChild();
    goOffline();
    scope.create(() =>
      createRequest<number>('/items', { key: () => ['items'], networkMode: 'online' }),
    );
    await settle();

    scope.destroy();
    await settle();

    // The hold lived in `inFlight`, so the last-observer teardown cancelled it like any other
    // request. A reconnect has nothing left to release, and the entry is no longer paused.
    await goOnline();
    http.expectNone(() => true);
    expect(cache().all()[0].paused()).toBe(false);
  });

  it('marks the entry as reloading, not loading, when it is paused with data', async () => {
    const { http, create } = setup();
    const list = create(() =>
      createRequest<number>('/items', {
        key: () => ['items'],
        networkMode: 'online',
        staleTime: 0,
      }),
    );
    await settle();
    http.expectOne('/items').flush(1);
    await settle();

    goOffline();
    // A refetch that cannot start is a reload, because there is a value to keep showing.
    void list.run();
    await settle();

    expect(list.paused()).toBe(true);
    expect(list.status()).toBe('reloading');
    expect(list.response()).toBe(1);
  });

  it('pauses a cached retry without spending an attempt, then resumes on reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { http, create } = setup();
      goOffline();
      const list = create(() =>
        createRequest<number>('/items', {
          key: () => ['items'],
          networkMode: 'offlineFirst',
          retry: { count: 3, delay: 1_000 },
        }),
      );

      await settle();
      http.expectOne('/items').error(new ProgressEvent('error'), {
        status: 0,
        statusText: 'Unknown Error',
      });
      await settle();

      expect(list.paused()).toBe(true);
      expect(list.retryAttempt()).toBe(0);
      expect(list.status()).toBe('loading');
      expect(vi.getTimerCount()).toBe(0);

      await goOnline();
      http.expectOne('/items').flush(4);
      await settle();

      expect(list.response()).toBe(4);
      expect(list.paused()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches a paused cached retry when the handle is cancelled', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() =>
      createRequest<number>('/items', {
        key: () => ['items'],
        networkMode: 'offlineFirst',
        retry: { count: 3, delay: 1_000 },
      }),
    );
    await settle();
    http.expectOne('/items').error(new ProgressEvent('error'), {
      status: 0,
      statusText: 'Unknown Error',
    });
    await settle();
    expect(list.paused()).toBe(true);

    list.cancel();
    await settle();

    // The pause lived in a subscription, so cancelling tore it down with the listener.
    expect(list.paused()).toBe(false);
    await goOnline();
    http.expectNone(() => true);
  });

  it('coalesces a reconnect with an invalidation into one fetch', async () => {
    const { http, create } = setup();
    const client = TestBed.inject(QueryClient);
    const list = create(() =>
      createRequest<number>('/items', { key: () => ['items'], refetchOnReconnect: true }),
    );
    await settle();
    http.expectOne('/items').flush(1);
    await settle();

    // The state flips synchronously and the reconnect is announced in a microtask; the invalidation
    // lands in between. Both must resolve to a single request.
    manager().setOnline(true);
    client.invalidate(['items']);
    await settle();

    http.expectOne('/items').flush(2);
    await settle();
    http.expectNone(() => true);
    expect(list.response()).toBe(2);
  });

  it('starts one refetch per entry when connectivity flaps within a tick', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() =>
      createRequest<number>('/items', {
        key: () => ['items'],
        networkMode: 'online',
        refetchOnReconnect: true,
      }),
    );
    await settle();
    http.expectNone('/items');

    // A browser that reports the interface four times before the announcement microtask runs. The
    // manager coalesces the announcements; the entry's in-flight dedup absorbs anything left.
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    await settle();

    http.expectOne('/items').flush(1);
    await settle();
    http.expectNone(() => true);
    expect(list.response()).toBe(1);
  });

  it('re-fires at most one request when a reconnect releases a held fetch', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() =>
      createRequest<number>('/items', { networkMode: 'online', refetchOnReconnect: true }),
    );
    await settle();

    await goOnline();
    // The reconnect both released the hold and triggered the reconnect refetch; the entry's dedup
    // makes them one request. `expectOne` would throw on a second.
    http.expectOne('/items').flush(1);
    await settle();
    http.expectNone(() => true);
    expect(list.response()).toBe(1);
  });

  it('reports reloading for a paused infinite request that already has a page', async () => {
    const { http, create } = setup();
    const pages = create(() =>
      createInfiniteRequest<number[], number>((page) => ({ url: '/rows', params: { page } }), {
        key: () => ['rows'],
        networkMode: 'online',
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
    );
    await settle();
    http.expectOne('/rows?page=0').flush([1, 2]);
    await settle();

    goOffline();
    pages.reload();
    await settle();

    expect(pages.paused()).toBe(true);
    expect(pages.status()).toBe('reloading');
    expect(pages.response()).toEqual([1, 2]);

    await goOnline();
    http.expectOne('/rows?page=0').flush([3]);
    await settle();
    expect(pages.status()).toBe('resolved');
    expect(pages.response()).toEqual([3]);
  });

  it('refetches an infinite request on reconnect, and detaches its listener on destroy', async () => {
    const { http, createChild } = setup();
    const scope = createChild();
    const pages = scope.create(() =>
      createInfiniteRequest<number[], number>((page) => ({ url: '/rows', params: { page } }), {
        key: () => ['rows'],
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        refetchOnReconnect: true,
      }),
    );
    await settle();
    http.expectOne('/rows?page=0').flush([1, 2]);
    await settle();

    await goOnline();
    http.expectOne('/rows?page=0').flush([3, 4]);
    await settle();
    expect(pages.response()).toEqual([3, 4]);

    scope.destroy();
    await settle();

    // The listener went with the scope: a later reconnect can neither fetch nor throw.
    await goOnline();
    http.expectNone(() => true);
  });

  it('reports `paused` as false for a cached handle with no entry', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() =>
      createRequest<number>(() => undefined, { key: () => ['items'], networkMode: 'online' }),
    );

    await settle();
    http.expectNone(() => true);
    expect(list.status()).toBe('idle');
    expect(list.paused()).toBe(false);
    expect(list.retryAttempt()).toBe(0);
  });

  it('inherits the mode in an infinite request and pauses every page', async () => {
    const { http, create } = setup([provideSignalRequest({ networkMode: 'online' })]);
    goOffline();
    const pages = create(() =>
      createInfiniteRequest<number[], number>((page) => ({ url: '/rows', params: { page } }), {
        key: () => ['rows'],
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
    );

    await settle();
    http.expectNone(() => true);
    expect(pages.paused()).toBe(true);
    expect(pages.status()).toBe('loading');

    await goOnline();
    http.expectOne('/rows?page=0').flush([1, 2]);
    await settle();
    expect(pages.paused()).toBe(false);
    expect(pages.response()).toEqual([1, 2]);
  });
});

describe('resilience – no timers or listeners leak', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves nothing behind after destroying many paused keyed handles', async () => {
    const { http, createChild } = setup();
    const scope = createChild();
    goOffline();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    const count = 10_000;
    for (let i = 0; i < count; i++) {
      scope.create(() =>
        createRequest<number>(`/rows/${i}`, {
          key: () => ['rows', i],
          networkMode: 'online',
          // Evict on release, so the assertion below is about the pause machinery rather than
          // about the cache's legitimate `gcTime` countdown.
          gcTime: 0,
        }),
      );
    }
    await settle();

    scope.destroy();
    await settle();

    expect(vi.getTimerCount()).toBe(0);
    await goOnline();
    http.expectNone(() => true);
  });
});

describe('networkMode – mutations', () => {
  const make = (options: MutationOptions<number, string> = {}) => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        networkMode: 'online',
        ...options,
      }),
    );
    return { http, save };
  };

  it('queues a call made offline and replays it once, in order, on reconnect', async () => {
    const { http, save } = make({ concurrency: 'parallel' });
    goOffline();

    const a = save.run('a');
    const b = save.run('b');
    const c = save.run('c');
    await settle();

    http.expectNone(() => true);
    expect(save.paused()).toBe(true);
    expect(save.status()).toBe('loading');
    expect(save.loading()).toBe(true);

    await goOnline();
    const requests = http.match('/todos');
    expect(requests.map((r) => r.request.body)).toEqual([
      { title: 'a' },
      { title: 'b' },
      { title: 'c' },
    ]);
    requests.forEach((request, index) => request.flush(index));

    await expect(a).resolves.toBe(0);
    await expect(b).resolves.toBe(1);
    await expect(c).resolves.toBe(2);
    expect(save.paused()).toBe(false);
  });

  it('does not let a new call overtake a queued one in the reconnect microtask window', async () => {
    const { http, save } = make();
    goOffline();
    const a = save.run('a');

    // The manager's state is already `true`, but the reconnect has not been announced yet.
    manager().setOnline(true);
    const b = save.run('b');
    await settle();

    const requests = http.match('/todos');
    expect(requests.map((r) => r.request.body)).toEqual([{ title: 'a' }, { title: 'b' }]);
    requests[0].flush(1);
    requests[1].flush(2);

    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe(2);
    expect(save.paused()).toBe(false);
  });

  it('counts a queued call as in flight', async () => {
    const { create } = setup();
    const client = TestBed.inject(QueryClient);
    goOffline();
    const save = create(() =>
      createMutation<number, string>(() => '/todos', {
        networkMode: 'online',
        mutationKey: ['todos'],
      }),
    );

    const p = save.run('a');
    await settle();

    expect(client.isMutating()()).toBe(true);
    expect(client.isMutating(['todos'])()).toBe(true);

    save.cancel();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await settle();
    expect(client.isMutating()()).toBe(false);
  });

  it('includes a queued mutation in `isAnythingPaused` but not in `isPaused`', async () => {
    const { create } = setup();
    const client = TestBed.inject(QueryClient);
    goOffline();
    const save = create(() =>
      createMutation<number, string>(() => '/todos', {
        networkMode: 'online',
        mutationKey: ['todos'],
      }),
    );

    expect(client.isAnythingPaused()).toBe(false);
    const p = save.run('a');
    await settle();

    expect(save.paused()).toBe(true);
    expect(client.isPaused()).toBe(false);
    expect(client.isAnythingPaused()).toBe(true);

    save.cancel();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await settle();
    expect(client.isAnythingPaused()).toBe(false);
  });

  it('MutationRegistry.reset() clears in-flight and paused counts', () => {
    setup();
    const registry = TestBed.inject(MutationRegistry);

    registry.begin(['todos']);
    registry.begin(undefined);
    registry.hold();
    expect(registry.isMutating()).toBe(true);
    expect(registry.isPaused()).toBe(true);
    expect(registry.countMatching(['todos'])()).toBe(1);

    registry.reset();

    expect(registry.isMutating()).toBe(false);
    expect(registry.isPaused()).toBe(false);
    expect(registry.countMatching(['todos'])()).toBe(0);
  });

  it('returns the queued promise under `exhaust` instead of queueing a second call', async () => {
    const { http, save } = make({ concurrency: 'exhaust' });
    goOffline();

    const a = save.run('a');
    const b = save.run('b');
    expect(b).toBe(a);

    await goOnline();
    const requests = http.match('/todos');
    expect(requests).toHaveLength(1);
    requests[0].flush(1);
    await expect(a).resolves.toBe(1);
  });

  it('cancels the previous queued call under `switch`', async () => {
    const { http, save } = make({ concurrency: 'switch' });
    goOffline();

    const first = save.run('a');
    const second = save.run('b');
    await expect(first).rejects.toBeInstanceOf(RequestCancelledError);

    await goOnline();
    const requests = http.match('/todos');
    expect(requests).toHaveLength(1);
    expect(requests[0].request.body).toEqual({ title: 'b' });
    requests[0].flush(2);
    await expect(second).resolves.toBe(2);
  });

  it('rejects a queued call cancelled before the reconnect, and rolls the optimistic write back', async () => {
    const { http, create } = setup();
    goOffline();
    const list = create(() => createRequest<string[]>('/todos', { initialValue: [] }));
    const add = create(() =>
      createMutation<string[], string>((title) => ({ url: '/todos', body: { title } }), {
        networkMode: 'online',
        optimistic: (todos, title) => [`${title} (sending)`, ...(todos ?? [])],
        target: list,
      }),
    );

    const p = add.run('a');
    expect(list.response()).toEqual(['a (sending)']);

    add.cancel();
    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await settle();

    // Rolled back: the queued write never became real, and it will never be sent.
    expect(list.response()).toEqual([]);
    expect(add.paused()).toBe(false);
    expect(add.status()).toBe('idle');
    await goOnline();
    http.expectNone('/todos');
  });

  it('runs `onMutate` and the optimistic write at `run()`, and `onSuccess` only after the replay', async () => {
    const { http, create } = setup();
    const onMutate = vi.fn();
    const onSuccess = vi.fn();
    goOffline();
    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        networkMode: 'online',
        onMutate: (title) => onMutate(title),
        optimistic: (_current, title) => title.length,
        onSuccess,
      }),
    );

    const p = save.run('abcd');
    await settle();

    expect(onMutate).toHaveBeenCalledWith('abcd');
    expect(save.response()).toBe(4);
    expect(onSuccess).not.toHaveBeenCalled();
    http.expectNone(() => true);

    await goOnline();
    http.expectOne('/todos').flush(9);
    await expect(p).resolves.toBe(9);
    expect(onSuccess).toHaveBeenCalledWith(9, 'abcd', undefined);
  });

  it('puts a replay back in the queue when the connection drops again', async () => {
    const { http, save } = make();
    goOffline();
    const p = save.run('a');
    await goOnline();

    const first = http.expectOne('/todos');
    // The interface went away again while the replay was on the wire.
    goOffline();
    first.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    await settle();

    // Not a failure: the call is waiting, with the same promise, for the next reconnect.
    expect(save.paused()).toBe(true);
    expect(save.status()).toBe('loading');
    expect(save.error()).toBeUndefined();

    await goOnline();
    http.expectOne('/todos').flush(3);
    await expect(p).resolves.toBe(3);
  });

  it('treats a status-0 failure while online as a real failure', async () => {
    const { http, save } = make();
    const p = save.run('a');
    const request = http.expectOne('/todos');

    request.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    await expect(p).rejects.toBeTruthy();
    expect(save.status()).toBe('error');
    expect(save.paused()).toBe(false);
  });

  it('sends nothing after `destroy()` while queued', async () => {
    const { http, save } = make();
    goOffline();
    const p = save.run('a');
    save.destroy();

    await expect(p).rejects.toBeInstanceOf(RequestCancelledError);
    await goOnline();
    http.expectNone('/todos');
  });

  it('defaults to `always`: a call made offline is sent anyway', async () => {
    const { http, create } = setup();
    goOffline();
    const save = create(() => createMutation<number, string>(() => '/todos'));

    const p = save.run('a');
    http.expectOne('/todos').flush(1);
    await expect(p).resolves.toBe(1);
    expect(save.paused()).toBe(false);
  });
});

describe('restore gate ordering', () => {
  it('restores first, then waits for connectivity', async () => {
    const restoring = signal(true);
    let release!: () => void;
    const restored = new Promise<void>((resolve) => (release = resolve));
    const gate: RestoreGate = { isRestoring: restoring.asReadonly(), restored: () => restored };

    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: gate }]);
    goOffline();
    const list = create(() =>
      createRequest<number>('/items', { key: () => ['items'], networkMode: 'online' }),
    );

    // The gate is closed, so the mount fetch is held for the snapshot. That is not a connectivity
    // pause: nothing was attempted, so `paused` stays `false` and the panel does not lie.
    await settle();
    http.expectNone('/items');
    expect(list.paused()).toBe(false);

    // The snapshot arrives. The gate opens, the restore ordering is satisfied, and *then* the
    // request is held again — this time for the connection.
    restoring.set(false);
    release();
    await settle();
    http.expectNone('/items');
    expect(list.paused()).toBe(true);

    await goOnline();
    http.expectOne('/items').flush(1);
    await settle();

    expect(list.response()).toBe(1);
    expect(list.paused()).toBe(false);
  });
});

describe('networkMode - public types', () => {
  it('declares `paused` on every handle and `networkMode` on every options object', () => {
    expectTypeOf<SignalRequest<number>>().toHaveProperty('paused');
    expectTypeOf<SignalRequest<number>['paused']>().toEqualTypeOf<Signal<boolean>>();
    expectTypeOf<CachedRequest<number>>().toHaveProperty('paused');
    expectTypeOf<InfiniteRequest<number[], number>>().toHaveProperty('paused');
    expectTypeOf<SignalMutation<number>>().toHaveProperty('paused');
    expectTypeOf<NetworkMode>().toEqualTypeOf<'online' | 'always' | 'offlineFirst'>();
  });
});
