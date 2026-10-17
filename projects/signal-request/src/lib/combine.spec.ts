import { signal, type Signal } from '@angular/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  combine,
  createRequests,
  createRequest,
  type Combinable,
  type Combined,
  type RequestSet,
} from '../public-api';
import { cache, settle, setup } from '../../testing/testing';

/**
 * A handle stand-in with counters.
 *
 * `Combinable` is deliberately structural, so the aggregate's own logic — "any loading", "first
 * error", "reload all of them without short-circuiting" — can be tested without an HTTP backend
 * and without depending on how a real handle happens to behave at the moment.
 */
function stub<T>(
  options: {
    data?: T;
    loading?: boolean;
    error?: Error;
    acceptReload?: boolean;
  } = {},
) {
  const response = signal<T | undefined>(options.data);
  const loading = signal(options.loading ?? false);
  const error = signal<Error | undefined>(options.error);
  let reloads = 0;
  let cancels = 0;
  let destroys = 0;

  const handle: Combinable<T> = {
    response: response.asReadonly(),
    loading: loading.asReadonly(),
    error: error.asReadonly(),
    reload: () => {
      reloads++;
      return options.acceptReload ?? true;
    },
    cancel: () => {
      cancels++;
    },
    destroy: () => {
      destroys++;
    },
  };

  return {
    handle,
    write: { response: response.set, loading: loading.set, error: error.set },
    counts: () => ({ reloads, cancels, destroys }),
  };
}

describe('combine() — the aggregate', () => {
  it('combines an array positionally', () => {
    const a = stub<number>({ data: 1 });
    const b = stub<number>({});
    const combined = combine([a.handle, b.handle]);

    expectTypeOf(combined).toEqualTypeOf<Combined<readonly (number | undefined)[]>>();
    expect(combined.response()).toEqual([1, undefined]);
  });

  it('combines a record by name, with per-key types', () => {
    const user = stub<{ name: string }>({ data: { name: 'Ada' } });
    const posts = stub<string[]>({ data: ['a'] });
    const combined = combine({ user: user.handle, posts: posts.handle });

    expectTypeOf(combined.response).toEqualTypeOf<
      Signal<{ readonly user: { name: string } | undefined; readonly posts: string[] | undefined }>
    >();
    expect(combined.response()).toEqual({ user: { name: 'Ada' }, posts: ['a'] });
  });

  it('is loading while any source is, and error as soon as one failed', () => {
    const a = stub<number>({ data: 1 });
    const b = stub<number>({ loading: true });
    const combined = combine([a.handle, b.handle]);

    expect(combined.loading()).toBe(true);
    // One source is still empty, so the screen is not ready — this is a load, not a refresh.
    expect(combined.status()).toBe('loading');

    b.write.loading(false);
    expect(combined.loading()).toBe(false);
    expect(combined.status()).toBe('resolved');

    expect(combined.error()).toBeUndefined();
  });

  it('reads as reloading only once nothing is missing', () => {
    const a = stub<number>({ data: 1 });
    // Has data *and* is loading: a refresh of something already on screen.
    const b = stub<number>({ data: 2, loading: true });
    const combined = combine([a.handle, b.handle]);

    expect(combined.loading()).toBe(true);
    expect(combined.status()).toBe('reloading');

    b.write.loading(false);
    expect(combined.status()).toBe('resolved');
  });

  it('reports the first failure in source order, not an arbitrary one', () => {
    const first = new Error('first');
    const second = new Error('second');
    const a = stub<number>({});
    const b = stub<number>({ error: second });
    const c = stub<number>({ error: first });
    const combined = combine([a.handle, b.handle, c.handle]);

    expect(combined.error()).toBe(second);
    expect(combined.status()).toBe('error');

    // Clearing the earlier one surfaces the later one instead of keeping a stale failure.
    b.write.error(undefined);
    expect(combined.error()).toBe(first);

    c.write.error(undefined);
    expect(combined.error()).toBeUndefined();
    // Nothing has data and nothing is loading, so the aggregate is simply idle.
    expect(combined.status()).toBe('idle');
  });

  it('reloads every source, without stopping at the first one that accepts', () => {
    // The bug this pins: `some()` would return at the first `true` and leave the rest of the
    // screen stale while reporting success.
    const a = stub<number>({ acceptReload: true });
    const b = stub<number>({ acceptReload: false });
    const c = stub<number>({ acceptReload: true });
    const combined = combine([a.handle, b.handle, c.handle]);

    expect(combined.reload()).toBe(true);
    expect(a.counts().reloads).toBe(1);
    expect(b.counts().reloads).toBe(1);
    expect(c.counts().reloads).toBe(1);
  });

  it('reloads nothing but still says so honestly when no source accepts', () => {
    const a = stub<number>({ acceptReload: false });
    const combined = combine([a.handle]);

    expect(combined.reload()).toBe(false);
    expect(a.counts().reloads).toBe(1);
  });

  it('cancels every source', () => {
    const a = stub<number>({});
    const b = stub<number>({});
    combine([a.handle, b.handle]).cancel();

    expect(a.counts().cancels).toBe(1);
    expect(b.counts().cancels).toBe(1);
  });

  it('does not own its sources — it has no destroy', () => {
    const a = stub<number>({});
    const combined = combine([a.handle]);
    expect('destroy' in combined).toBe(false);
    expect(a.counts().destroys).toBe(0);
  });

  it('combines real handles, loading and error included', async () => {
    const { http, create } = setup();
    const user = create(() => createRequest<{ name: string }>(() => ({ url: '/me' })));
    const posts = create(() => createRequest<string[]>(() => ({ url: '/posts' })));
    const view = combine({ user, posts });

    await settle();
    expect(view.loading()).toBe(true);
    expect(view.status()).toBe('loading');

    http.expectOne('/me').flush({ name: 'Ada' });
    await settle();
    expect(view.response().user).toEqual({ name: 'Ada' });
    expect(view.response().posts).toBeUndefined();
    // Still waiting on one of them.
    expect(view.status()).toBe('loading');

    http.expectOne('/posts').flush(['a']);
    await settle();
    expect(view.loading()).toBe(false);
    expect(view.status()).toBe('resolved');
    expect(view.error()).toBeUndefined();

    user.destroy();
    posts.destroy();
  });

  it('aggregates a real failure', async () => {
    const { http, create } = setup();
    const ok = create(() => createRequest<string>(() => ({ url: '/ok' })));
    const bad = create(() => createRequest<string>(() => ({ url: '/bad' })));
    const view = combine([ok, bad]);

    await settle();
    http.expectOne('/ok').flush('fine');
    http.expectOne('/bad').flush({ message: 'nope' }, { status: 500, statusText: 'Error' });
    await settle();

    expect(view.error()?.message).toContain('500');
    expect(view.status()).toBe('error');

    ok.destroy();
    bad.destroy();
  });
});

describe('createRequests() — the dynamic set', () => {
  it('builds one handle per item, in order, and keeps the cache keys apart', async () => {
    const { http, create } = setup();
    const ids = signal<readonly number[]>([1, 2]);
    const rows = create(() =>
      createRequests(
        () => ids(),
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );
    expectTypeOf(rows).toEqualTypeOf<RequestSet<string>>();

    await settle();
    expect(rows.handles()).toHaveLength(2);

    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush('two');
    await settle();

    expect(rows.response()).toEqual(['one', 'two']);
    expect(rows.loading()).toBe(false);
    expect(rows.status()).toBe('resolved');

    rows.destroy();
  });

  it('reuses a handle across a list change instead of rebuilding every one', async () => {
    // The point of reconciling by identity: adding one id to a list must not tear down and
    // re-subscribe the entry that was already there.
    const { http, create } = setup();
    const ids = signal<readonly number[]>([1, 2]);
    const rows = create(() =>
      createRequests(
        () => ids(),
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );
    await settle();
    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush('two');
    await settle();

    const before = rows.handles();

    ids.set([1, 2, 3]);
    await settle();

    const after = rows.handles();
    expect(after).toHaveLength(3);
    // The two that were already there are the *same objects*, not equal ones.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);

    // Only the new one goes to the wire; the other two are still fresh cache entries.
    http.expectOne('/rows/3').flush('three');
    await settle();
    expect(rows.response()).toEqual(['one', 'two', 'three']);

    rows.destroy();
  });

  it('reorders without rebuilding', async () => {
    const { http, create } = setup();
    const ids = signal<readonly number[]>([1, 2]);
    const rows = create(() =>
      createRequests(
        () => ids(),
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );
    await settle();
    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush('two');
    await settle();

    const [first, second] = rows.handles();

    ids.set([2, 1]);
    await settle();

    expect(rows.handles()[0]).toBe(second);
    expect(rows.handles()[1]).toBe(first);
    // Same data, in the new order.
    expect(rows.response()).toEqual(['two', 'one']);
    // And nothing was refetched to achieve it.
    http.expectNone(() => true);

    rows.destroy();
  });

  it('destroys the handle of an item that left the list', async () => {
    const { http, create } = setup();
    const ids = signal<readonly number[]>([1, 2]);
    const rows = create(() =>
      createRequests(
        () => ids(),
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );
    await settle();
    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush('two');
    await settle();

    const dropped = rows.handles()[1];

    ids.set([1]);
    await settle();

    expect(rows.handles()).toHaveLength(1);
    expect(rows.response()).toEqual(['one']);
    // The dropped handle released its subscription. The entry itself survives — an item leaving
    // the list is not a reason to evict data something else may still be showing.
    expect(cache().peek(['rows', 2])?.observerCount).toBe(0);

    rows.destroy();
  });

  it('aggregates loading and the first failure across the set', async () => {
    const { http, create } = setup();
    const ids = signal<readonly number[]>([1, 2]);
    const rows = create(() =>
      createRequests(
        () => ids(),
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );

    await settle();
    expect(rows.loading()).toBe(true);

    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush({ message: 'gone' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(rows.loading()).toBe(false);
    expect(rows.status()).toBe('error');
    expect(rows.error()?.message).toContain('404');
    // The one that succeeded is still readable next to the failure.
    expect(rows.response()).toEqual(['one', undefined]);

    rows.destroy();
  });

  it('uses `key` to identify items whose identity is not stable', async () => {
    // Two structurally equal objects are two identities, so without `key` this would rebuild —
    // and with a shared cache key, that would show up as a redundant subscribe rather than a
    // request, which is exactly the kind of thing that hides.
    const { http, create } = setup();
    const items = signal<readonly { id: number }[]>([{ id: 1 }, { id: 2 }]);
    const rows = create(() =>
      createRequests(
        () => items(),
        (item) =>
          createRequest<string>(() => ({ url: `/rows/${item.id}` }), {
            key: () => ['rows', item.id],
          }),
        { key: (item) => item.id },
      ),
    );
    await settle();
    http.expectOne('/rows/1').flush('one');
    http.expectOne('/rows/2').flush('two');
    await settle();

    const before = rows.handles();

    // New objects, same ids.
    items.set([{ id: 1 }, { id: 2 }]);
    await settle();

    expect(rows.handles()[0]).toBe(before[0]);
    expect(rows.handles()[1]).toBe(before[1]);

    rows.destroy();
  });

  it('destroy() clears the set and stops the handles', async () => {
    const { http, create } = setup();
    const rows = create(() =>
      createRequests(
        () => [1],
        (id) => createRequest<string>(() => ({ url: `/rows/${id}` }), { key: () => ['rows', id] }),
      ),
    );
    await settle();
    http.expectOne('/rows/1').flush('one');
    await settle();
    expect(cache().peek(['rows', 1])?.observerCount).toBe(1);

    rows.destroy();
    expect(rows.handles()).toEqual([]);
    // Every handle released its subscription. The entry survives — `destroy()` on a handle is not
    // a reason to evict data that something else may still be showing.
    expect(cache().peek(['rows', 1])?.observerCount).toBe(0);
  });

  it('names the failing call with its full path', () => {
    setup();
    expect(() =>
      createRequests(
        () => [1],
        (id) => createRequest<string>(() => `/rows/${id}`),
      ),
    ).toThrowError(/createRequests/);
  });
});
