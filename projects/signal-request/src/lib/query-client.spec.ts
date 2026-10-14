import { inject } from '@angular/core';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createMutation, createRequest, QueryClient, type MutationOptions } from '../public-api';
import { cache, settle, setup } from '../../testing/testing';

interface User {
  id: number;
  name: string;
}

/**
 * `setup()` and a client from the **same** injector.
 *
 * Calling `setup()` twice would configure TestBed twice, so tests that need both go through here
 * and tests that only need a client use `setup()` alone.
 */
function pair(): { client: QueryClient; create: <T>(fn: () => T) => T; http: ReturnType<typeof setup>['http'] } {
  const s = setup();
  return { client: s.create(() => inject(QueryClient)), create: s.create, http: s.http };
}

describe('QueryClient — key matching', () => {
  it('matches by prefix, so ["users"] reaches every page under it', async () => {
    const { client, create } = pair();

    create(() => {
      createRequest<User[]>('/users', { key: () => ['users', 1], refetchOnMount: false });
      createRequest<User[]>('/users', { key: () => ['users', 2], refetchOnMount: false });
      createRequest<User[]>('/users', { key: () => ['users', { page: 3 }], refetchOnMount: false });
      createRequest<User[]>('/posts', { key: () => ['posts', 1], refetchOnMount: false });
    });
    // Entries are created by the subscription effect, so the graph has to settle first.
    await settle();

    expect(client.count(['users'])).toBe(3);
    expect(client.count(['posts'])).toBe(1);
    // The empty prefix matches everything.
    expect(client.count([])).toBe(4);
  });

  it('accepts a predicate over the ORIGINAL segments', async () => {
    // `['users', { admin: true }]` — the predicate sees `{ admin: true }`, not a normalized string.
    const { client, create } = pair();
    create(() => {
      createRequest<User[]>('/users', { key: () => ['users', { admin: true }], refetchOnMount: false });
      createRequest<User[]>('/users', { key: () => ['users', { admin: false }], refetchOnMount: false });
    });
    await settle();

    expect(
      client.count((segment) => typeof segment === 'object' && segment !== null && 'admin' in segment),
    ).toBe(2);
    expect(client.count((segment) => segment === 'users')).toBe(2);
  });
});

describe('QueryClient — invalidate', () => {
  it('refetches every entry under the key that has a subscriber', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => {
      createRequest<User[]>('/users', { key: () => ['users', 1], initialValue: [] });
      createRequest<User[]>('/users', { key: () => ['users', 2], initialValue: [] });
      createRequest<User[]>('/posts', { key: () => ['posts'], initialValue: [] });
    });
    await settle();
    const initial = http.match('/users');
    initial[0].flush([{ id: 1, name: 'Ada' }]);
    initial[1].flush([{ id: 2, name: 'Grace' }]);
    http.expectOne('/posts').flush([]);
    await settle();

    expect(client.invalidate(['users'])).toBe(2);
    await settle();

    // Both user pages refetched; the posts query was not touched.
    const refetched = http.match('/users');
    expect(refetched.length).toBe(2);
    refetched[0].flush([{ id: 1, name: 'Ada II' }]);
    refetched[1].flush([{ id: 2, name: 'Grace II' }]);
    await settle();
    http.expectNone('/posts');
  });

  it('batches several invalidations in one tick into a single fetch per entry', async () => {
    // Three mutations landing in the same tick must not produce three refetches.
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    client.invalidate(['users']);
    client.invalidate(['users']);
    client.invalidate(() => true);
    await settle();

    // One request, not three.
    http.expectOne('/users').flush([{ id: 1, name: 'Ada II' }]);
    await settle();
    expect(cache().peek<User[]>(['users'])!.fetchCount()).toBe(2);
  });

  it('marks unsubscribed entries without fetching them', async () => {
    const { http, create, createChild } = setup();
    const client = create(() => inject(QueryClient));
    const a = createChild();

    a.create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    a.destroy();
    await settle();

    client.invalidate(['users']);
    await settle();

    // Nobody is watching, so nothing was sent…
    http.expectNone('/users');
    // …but the entry remembers it owes a fetch.
    expect(cache().peek<User[]>(['users'])!.isStale(0)).toBe(true);
  });

  it('runs the lifecycle hooks for a refetch the cache started', async () => {
    // From the user's point of view their component did reload, even though nothing in their code
    // asked for it — a mutation elsewhere invalidated the key.
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const onSuccess = vi.fn();
    const onSettled = vi.fn();

    create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [], onSuccess, onSettled }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    onSuccess.mockClear();
    onSettled.mockClear();

    client.invalidate(['users']);
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada II' }]);
    await settle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith([{ id: 1, name: 'Ada II' }]);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('fires onSuccess once per fetch even when two handles share the entry', async () => {
    const { http, create, createChild } = setup();
    const a = createChild();
    const b = createChild();
    const first = vi.fn();
    const second = vi.fn();

    a.create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [], onSuccess: first }));
    b.create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [], onSuccess: second }));
    await settle();
    // One network call…
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // …and exactly one call of each handle's hook, not two from the join.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('QueryClient — data access', () => {
  it('reads and writes by key', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users', 1], initialValue: [] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(client.getData<User[]>(['users', 1])).toEqual([{ id: 1, name: 'Ada' }]);
    expect(client.getData(['users', 99])).toBeUndefined();

    client.setData<User[]>(['users', 1], (previous) => [...(previous ?? []), { id: 2, name: 'Grace' }]);
    expect(client.getData<User[]>(['users', 1])).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]);

    client.setData<User[]>(['users', 1], []);
    expect(client.getData<User[]>(['users', 1])).toEqual([]);
  });

  it('a local write clears the invalidated flag', async () => {
    // Not "clears staleness": with `staleTime: 0` an entry is stale by definition. What a local
    // write does clear is the *invalidation* — after it, nothing is owed until something says so.
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], staleTime: 60_000, initialValue: [] }),
    );
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    const entry = cache().peek<User[]>(['users'])!;
    expect(entry.invalidated()).toBe(false);

    client.invalidate(['users']);
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // The successful fetch above consumed the invalidation.
    expect(entry.invalidated()).toBe(false);

    entry.markInvalidated();
    expect(entry.invalidated()).toBe(true);
    client.setData(['users'], []);
    expect(entry.invalidated()).toBe(false);
  });

  it('reports isFetching globally and per filter', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }));
    await settle();

    expect(client.isFetching()).toBe(true);
    expect(client.isFetching(['users'])).toBe(true);
    expect(client.isFetching(['posts'])).toBe(false);

    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    expect(client.isFetching()).toBe(false);
  });

  it('removes entries and cancels what they had in flight', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    await settle();
    const request = http.expectOne('/users');

    expect(client.remove(['users'])).toBe(1);
    expect(request.cancelled).toBe(true);
    expect(cache().size).toBe(0);
  });

  it('cancel(filter) aborts matching entries', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    await settle();
    const request = http.expectOne('/users');

    client.cancel(['users']);
    expect(request.cancelled).toBe(true);
  });

  it('refetch(filter) does not mark the entry stale', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    create(() => createRequest<User[]>('/users', { key: () => ['users'], staleTime: 60_000, initialValue: [] }));
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    client.refetch(['users']);
    await settle();
    http.expectOne('/users').flush([{ id: 1, name: 'Ada II' }]);
    await settle();

    // Still fresh: `refetch` refreshed the screen without claiming the data is stale.
    expect(cache().peek<User[]>(['users'])!.isStale(60_000)).toBe(false);
  });
});

describe('createMutation — invalidates by key', () => {
  it('invalidates: [["users"]] refreshes every open ["users", …] query', async () => {
    // The acceptance criterion. Two separate components hold two pages of the same list, and the
    // mutation invalidates a key — so neither needs to be referenced by the mutation.
    const { http, create, createChild } = setup();
    const pageOne = createChild();
    const pageTwo = createChild();
    const writer = createChild();

    const first = pageOne.create(() =>
      createRequest<User[]>('/users', { key: () => ['users', 1], initialValue: [] }),
    );
    const second = pageTwo.create(() =>
      createRequest<User[]>('/users', { key: () => ['users', 2], initialValue: [] }),
    );

    await settle();
    const initial = http.match('/users');
    initial[0].flush([{ id: 1, name: 'Ada' }]);
    initial[1].flush([{ id: 2, name: 'Grace' }]);
    await settle();

    const save = writer.create(() =>
      createMutation<number, string>((name) => ({ url: '/users', body: { name } }), {
        invalidates: () => [['users']],
      }),
    );
    const pending = save.run('Hopper');
    http.expectOne('/users').flush(3, { status: 201, statusText: 'Created' });
    await pending;
    await settle();

    // Both pages refetched from one invalidation.
    const refetched = http.match('/users');
    expect(refetched.length).toBe(2);
    refetched[0].flush([{ id: 1, name: 'Ada' }, { id: 3, name: 'Hopper' }]);
    refetched[1].flush([{ id: 2, name: 'Grace' }, { id: 3, name: 'Hopper' }]);
    await settle();

    expect(first.response()).toEqual([{ id: 1, name: 'Ada' }, { id: 3, name: 'Hopper' }]);
    expect(second.response()).toEqual([{ id: 2, name: 'Grace' }, { id: 3, name: 'Hopper' }]);

    pageOne.destroy();
    pageTwo.destroy();
    writer.destroy();
  });

  it('accepts a mix of handles and keys', async () => {
    const { http, create } = setup();

    const { list, save } = create(() => {
      const list = createRequest<string[]>('/items', { initialValue: [] });
      const save = createMutation<number, string>((name) => ({ url: '/items', body: { name } }), {
        invalidates: () => [list, ['items', 'count']],
      });
      return { list, save };
    });
    await settle();
    http.expectOne('/items').flush(['a']);
    await settle();

    create(() => createRequest<number>('/items/count', { key: () => ['items', 'count'], initialValue: 0 }));
    await settle();
    http.expectOne('/items/count').flush(1);
    await settle();

    const pending = save.run('b');
    http.expectOne('/items').flush(1, { status: 201, statusText: 'Created' });
    await pending;
    await settle();

    // The handle was reloaded…
    const reloadedList = http.expectOne('/items');
    reloadedList.flush(['a', 'b']);
    // …and the key was invalidated.
    http.expectOne('/items/count').flush(2);
    await settle();
    expect(list.response()).toEqual(['a', 'b']);
  });

  it('does not invalidate on failure', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number, string>((name) => ({ url: '/users', body: { name } }), {
        invalidates: () => [['users']],
      }),
    );
    create(() => createRequest<User[]>('/users', { key: () => ['users'], initialValue: [] }));
    await settle();
    http.expectOne('/users').flush([]);
    await settle();

    const pending = save.tryRun('x');
    http.expectOne('/users').flush('nope', { status: 500, statusText: 'Err' });
    await pending;
    await settle();

    http.expectNone(() => true);
  });

  it('accepts keys and handles in one invalidates list', () => {
    const { create } = setup();
    const list = create(() => createRequest<User[]>('/users', { key: () => ['users'] }));
    const options: MutationOptions<number, string> = {
      // A handle and two keys, mixed. That this compiles is the assertion — `expectTypeOf`
      // cannot express "this union of array and function accepts both shapes".
      invalidates: () => [list, ['users'], ['posts', { page: 1 }]],
    };
    expect(typeof options.invalidates).toBe('function');
    // @ts-expect-error — a bare value is neither a handle nor a key.
    const wrong: MutationOptions<number, string> = { invalidates: () => [42] };
    expect(typeof wrong.invalidates).toBe('function');
  });
});