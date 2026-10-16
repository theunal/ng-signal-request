import { effect, signal, type Signal } from '@angular/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createInfiniteRequest, createRequest, type CachedRequest, type SignalRequest } from '../public-api';
import { settle, setup } from '../../testing/testing';

interface User {
  name: string;
  age: number;
}

describe('select() — the projection', () => {
  it('projects the response, and infers the projection type', async () => {
    const { http, create } = setup();
    const user = create(() =>
      createRequest<User>(() => ({ url: '/me' }), { key: () => ['me'] }),
    );

    const name = user.select((u) => u.name);
    expectTypeOf(name).toEqualTypeOf<Signal<string | undefined>>();

    await settle();
    http.expectOne('/me').flush({ name: 'Ada', age: 36 });
    await settle();

    expect(name()).toBe('Ada');
    user.destroy();
  });

  it('is undefined in, undefined out — the selector never sees an empty response', async () => {
    const { http, create } = setup();
    const calls: User[] = [];
    const user = create(() =>
      createRequest<User>(() => ({ url: '/me' }), { key: () => ['me'] }),
    );
    const name = user.select((u) => {
      calls.push(u);
      return u.name;
    });

    await settle();
    // Nothing has arrived, and the selector was not asked to handle that.
    expect(name()).toBeUndefined();
    expect(calls).toEqual([]);

    http.expectOne('/me').flush({ name: 'Ada', age: 36 });
    await settle();
    expect(name()).toBe('Ada');
    expect(calls).toEqual([{ name: 'Ada', age: 36 }]);

    user.destroy();
  });

  it('works on an uncached handle as well as a cached one', async () => {
    const { http, create } = setup();
    const plain = create(() => createRequest<User>(() => ({ url: '/me' })));
    expectTypeOf(plain).toEqualTypeOf<SignalRequest<User>>();
    const cached = create(() =>
      createRequest<User>(() => ({ url: '/me' }), { key: () => ['me'] }),
    );
    expectTypeOf(cached).toEqualTypeOf<CachedRequest<User>>();

    const a = plain.select((u) => u.age);
    const b = cached.select((u) => u.age);

    await settle();
    // Two handles, two requests: one is uncached and has no entry to share.
    for (const request of http.match('/me')) request.flush({ name: 'Ada', age: 36 });
    await settle();

    expect(a()).toBe(36);
    expect(b()).toBe(36);

    plain.destroy();
    cached.destroy();
  });

  it('a custom equal stops a rebuilt object from notifying its consumers', async () => {
    // This is the one thing a bare `computed` cannot do: `{ label }` is a new object on every
    // response, so the default `Object.is` would wake the template even when the label is the
    // same. Half of this test is the control — the default *does* notify.
    const { http, create } = setup();
    const user = create(() =>
      createRequest<User>(() => ({ url: '/me' }), { key: () => ['me'] }),
    );
    await settle();
    http.expectOne('/me').flush({ name: 'Ada', age: 36 });
    await settle();

    const guarded = user.select((u) => ({ label: u.name }), {
      equal: (a, b) => a.label === b.label,
    });
    const unguarded = user.select((u) => ({ label: u.name }));

    let guardedRuns = 0;
    let unguardedRuns = 0;
    create(() => {
      effect(() => {
        guarded();
        guardedRuns++;
      });
      effect(() => {
        unguarded();
        unguardedRuns++;
      });
    });
    await settle();
    const guardedBefore = guardedRuns;
    const unguardedBefore = unguardedRuns;

    user.reload();
    await settle();
    // `age` changed, `name` did not.
    http.expectOne('/me').flush({ name: 'Ada', age: 37 });
    await settle();

    expect(guardedRuns).toBe(guardedBefore);
    expect(unguardedRuns).toBeGreaterThan(unguardedBefore);

    user.destroy();
  });

  it('carries an initialValue through, so the selection is defined from the start', async () => {
    const { http, create } = setup();
    const user = create(() =>
      createRequest<User>(() => ({ url: '/me' }), {
        key: () => ['me'],
        initialValue: { name: 'unknown', age: 0 },
      }),
    );
    const name = user.select((u) => u.name);

    // The selector runs against the `initialValue` before any request settles.
    expect(name()).toBe('unknown');

    await settle();
    http.expectOne('/me').flush({ name: 'Ada', age: 36 });
    await settle();
    expect(name()).toBe('Ada');

    user.destroy();
  });

  it('projects the flattened pages of an infinite handle', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<User[], number>((page) => ({ url: '/users', params: { page } }), {
        key: () => ['users'],
        initialPageParam: 0,
        getNextPageParam: (last, _all, param) => (last && last.length === 2 ? param + 1 : undefined),
      }),
    );
    const names = feed.select((users) => users.map((u) => u.name));
    // Never `undefined` here: an empty accumulation is an empty array.
    expectTypeOf(names).toEqualTypeOf<Signal<string[]>>();

    expect(names()).toEqual([]);

    await settle();
    http.expectOne('/users?page=0').flush([
      { name: 'Ada', age: 36 },
      { name: 'Alan', age: 41 },
    ]);
    await settle();

    expect(names()).toEqual(['Ada', 'Alan']);

    feed.destroy();
  });
});

describe('select() — the reason it is a method', () => {
  it('infers through a `select`-shaped method, which an option could not', () => {
    // The regression this pins: TypeScript has no partial type-argument inference, so
    // `createRequest<User>(url, { select: (u) => u.name })` can never infer the selection — naming
    // `User` has already switched inference off. A method is the only shape where `S` is the sole
    // type parameter in play. See `docs/design.md` for the two probes.
    const { create } = setup();
    const user = create(() => createRequest<User>(() => '/me'));

    // Naming `T` explicitly and *still* getting the projection inferred.
    const age = user.select((u) => u.age);
    expectTypeOf(age).toEqualTypeOf<Signal<number | undefined>>();

    // And with no explicit naming at all.
    const names = user.select((u) => [u.name]);
    expectTypeOf(names).toEqualTypeOf<Signal<string[] | undefined>>();

    user.destroy();
  });

  it('reads a signal inside the selector, so it re-projects', async () => {
    const { http, create } = setup();
    const suffix = signal('!');
    const user = create(() =>
      createRequest<User>(() => ({ url: '/me' }), { key: () => ['me'] }),
    );
    const decorated = user.select((u) => u.name + suffix());

    await settle();
    http.expectOne('/me').flush({ name: 'Ada', age: 36 });
    await settle();
    expect(decorated()).toBe('Ada!');

    suffix.set('?');
    await settle();
    expect(decorated()).toBe('Ada?');

    user.destroy();
  });
});
