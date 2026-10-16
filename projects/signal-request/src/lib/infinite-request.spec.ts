import { inject, signal, type Signal } from '@angular/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createInfiniteRequest,
  createRequest,
  QueryClient,
  type FlattenedPages,
  type InfiniteRequest,
  type InfiniteRequestOptions,
} from '../public-api';
import { cache, settle, setup } from '../../testing/testing';

interface Item {
  id: number;
}

/**
 * Array pages, because that is what most endpoints return and it is the shape where
 * `response()` can flatten.
 *
 * Two items per page except the last, which is how `getNextPageParam` knows it is done.
 */
const pages: Item[][] = [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]];

function feedOptions(
  extra: Partial<InfiniteRequestOptions<Item[], number>> = {},
): InfiniteRequestOptions<Item[], number> {
  return {
    key: () => ['items'],
    initialPageParam: 0,
    getNextPageParam: (last, _all, param) => (last && last.length === 2 ? param + 1 : undefined),
    ...extra,
  };
}

describe('createInfiniteRequest — accumulation', () => {
  it('loads page one and flattens it', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );

    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    expect(feed.pages()).toEqual([pages[0]]);
    expect(feed.response()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(feed.pageParams()).toEqual([0]);
    expect(feed.status()).toBe('resolved');

    feed.destroy();
  });

  it('appends pages and accumulates them in order', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    expect(feed.hasNextPage()).toBe(true);

    const next = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    await settle();

    expect(feed.pageParams()).toEqual([0, 1]);
    expect(feed.response()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);

    const last = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=2').flush(pages[2]);
    await last;
    await settle();

    expect(feed.response()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    expect(feed.hasNextPage()).toBe(false);

    feed.destroy();
  });

  it('fetchNextPage resolves only once the page is on screen', async () => {
    // Not a timeout, not a microtask drain: the entry's own promise, so `await` means "arrived".
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    let resolved = false;
    const next = feed.fetchNextPage().then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);

    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    expect(resolved).toBe(true);
    expect(feed.pages()).toHaveLength(2);

    feed.destroy();
  });

  it('fetchNextPage is a no-op when there is no next page', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[2]); // the short page, so there is no next
    await settle();

    expect(feed.hasNextPage()).toBe(false);
    await feed.fetchNextPage();
    await settle();

    expect(feed.pageParams()).toEqual([0]);
    http.expectNone(() => true);

    feed.destroy();
  });

  it('prepends with getPreviousPageParam, and says so when there is none', async () => {
    const { http, create } = setup();
    const oneWay = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    // Without the option, "previous" does not exist — and says so rather than pretending.
    expect(oneWay.hasPreviousPage()).toBe(false);
    oneWay.destroy();

    const both = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), {
        key: () => ['items'],
        initialPageParam: 1,
        getNextPageParam: (_last, _all, param) => param + 1,
        getPreviousPageParam: (_first, _all, param) => (param > 0 ? param - 1 : undefined),
      }),
    );
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await settle();

    expect(both.hasPreviousPage()).toBe(true);
    const back = both.fetchPreviousPage();
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await back;
    await settle();

    expect(both.pageParams()).toEqual([0, 1]);
    expect(both.response()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(both.hasPreviousPage()).toBe(false);

    both.destroy();
  });

  it('exposes isFetchingNextPage separately from isFetching', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    const next = feed.fetchNextPage();
    await settle();
    expect(feed.isFetching()).toBe(true);
    expect(feed.isFetchingNextPage()).toBe(true);
    expect(feed.status()).toBe('reloading');

    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    await settle();
    expect(feed.isFetchingNextPage()).toBe(false);

    feed.destroy();
  });
});

describe('createInfiniteRequest — each page is a real entry', () => {
  it('keys pages as base + param, so a prefix invalidation reaches all of them', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();
    const next = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    await settle();

    // Entries are `['items', 0]` and `['items', 1]`.
    expect(client.count(['items'])).toBe(2);

    client.invalidate(['items']);
    await settle();

    const refetched = http.match((req) => req.url === '/items');
    expect(refetched.length).toBe(2);
    refetched[0].flush([{ id: 1 }, { id: 2 }, { id: 9 }]);
    refetched[1].flush(pages[1]);
    await settle();

    expect(feed.response()).toHaveLength(5);

    feed.destroy();
  });

  it('shares page 1 with a createRequest on the same key', async () => {
    // The dedup has to work between the two primitives, or a paginated list and the summary above
    // it would each fetch the same page.
    const { http, create } = setup();

    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    const samePage = create(() => createRequest<Item[]>(() => ({ url: '/items', params: { page: 0 } }), { key: () => ['items', 0] }));

    await settle();
    // One request, even though two handles are watching it.
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    expect(feed.response()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(samePage.response()).toEqual(pages[0]);
    expect(cache().size).toBe(1);

    feed.destroy();
    samePage.destroy();
  });

  it('reloads every loaded page, in order, and does not duplicate them', async () => {
    // The recipe this replaces needed a hand-written guard here, because `onSuccess` fires on every
    // settle. Each page being its own entry means a reload *replaces*.
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();
    const next = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    await settle();

    expect(feed.pages()).toHaveLength(2);
    expect(feed.reload()).toBe(true);

    // Sequential: page 1 is not asked for until page 0 has settled, because offset pagination is
    // only coherent when the pages are requested in sequence.
    http.expectOne('/items?page=0').flush([{ id: 1 }]);
    http.expectNone('/items?page=1');
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await settle();

    // Replaced, not appended: still two pages.
    expect(feed.pages()).toHaveLength(2);
    expect(feed.response()).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);

    feed.destroy();
  });
});

describe('createInfiniteRequest — filters, maxPages, teardown', () => {
  it('restarts the accumulation when a signal in the key changes, leaving the cache alone', async () => {
    const { http, create } = setup();
    const filter = signal('all');
    const feed = create(() =>
      createInfiniteRequest<Item[], number>(
        (page) => ({ url: '/items', params: { page, filter: filter() } }),
        {
          key: () => ['items', { filter: filter() }],
          initialPageParam: 0,
          getNextPageParam: (last, _all, param) => (last && last.length === 2 ? param + 1 : undefined),
        },
      ),
    );
    await settle();
    http.expectOne('/items?page=0&filter=all').flush(pages[0]);
    await settle();
    const next = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1&filter=all').flush(pages[1]);
    await next;
    await settle();
    expect(feed.pages()).toHaveLength(2);

    filter.set('mine');
    await settle();

    // Back to one page…
    expect(feed.pageParams()).toEqual([0]);
    http.expectOne('/items?page=0&filter=mine').flush([{ id: 7 }]);
    await settle();
    expect(feed.response()).toEqual([{ id: 7 }]);

    // …but the old pages are still cached, because nothing said to remove them.
    expect(cache().size).toBe(3);

    feed.destroy();
  });

  it('reuses a cached page when the filter flips back and it is still fresh', async () => {
    // `staleTime` has to be set for this to be a cache hit at all: the default of `0` means
    // "always stale", so a remount would refetch by design.
    const { http, create } = setup();
    const filter = signal('all');
    const feed = create(() =>
      createInfiniteRequest<Item[], number>(
        (page) => ({ url: '/items', params: { page, filter: filter() } }),
        feedOptions({
          key: () => ['items', { filter: filter() }],
          staleTime: 60_000,
        }),
      ),
    );
    await settle();
    http.expectOne('/items?page=0&filter=all').flush(pages[0]);
    await settle();

    filter.set('mine');
    await settle();
    http.expectOne('/items?page=0&filter=mine').flush([{ id: 7 }]);
    await settle();

    filter.set('all');
    await settle();
    // Page 0 for `all` was still fresh, so no request — a cache hit, which is the point.
    http.expectNone(() => true);
    expect(feed.response()).toEqual([{ id: 1 }, { id: 2 }]);

    feed.destroy();
  });

  it('maxPages drops the oldest pages, and releases their subscriptions', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>(
        (page) => ({ url: '/items', params: { page } }),
        feedOptions({ maxPages: 2 }),
      ),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    const second = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await second;
    await settle();

    const third = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=2').flush(pages[2]);
    await third;
    await settle();

    // Only the last two are accumulated…
    expect(feed.pageParams()).toEqual([1, 2]);
    expect(feed.response()).toEqual([{ id: 3 }, { id: 4 }, { id: 5 }]);
    // …but page 0's entry is still in the cache, just no longer subscribed.
    expect(cache().peek(['items', 0])?.observerCount).toBe(0);

    feed.destroy();
  });

  it('destroy returns every page entry to zero observers', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();
    const next = feed.fetchNextPage();
    await settle();
    http.expectOne('/items?page=1').flush(pages[1]);
    await next;
    await settle();

    expect(cache().peek(['items', 0])?.observerCount).toBe(1);
    expect(cache().peek(['items', 1])?.observerCount).toBe(1);

    feed.destroy();
    expect(cache().peek(['items', 0])?.observerCount).toBe(0);
    expect(cache().peek(['items', 1])?.observerCount).toBe(0);
  });

  it('remove() clears the accumulation but keeps the cache', async () => {
    const { http, create } = setup();
    const feed = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    await settle();
    http.expectOne('/items?page=0').flush(pages[0]);
    await settle();

    feed.remove();
    await settle();

    expect(feed.pageParams()).toEqual([]);
    expect(feed.pages()).toEqual([]);
    expect(cache().peek(['items', 0])).toBeDefined();

    feed.destroy();
  });
});

describe('createInfiniteRequest — types', () => {
  it('flattens an array page and leaves an envelope alone', () => {
    const { create } = setup();
    const flat = create(() =>
      createInfiniteRequest<Item[], number>((page) => ({ url: '/items', params: { page } }), feedOptions()),
    );
    expectTypeOf(flat).toEqualTypeOf<InfiniteRequest<Item[], number>>();
    expectTypeOf(flat.pages).toEqualTypeOf<Signal<readonly Item[][]>>();
    expectTypeOf(flat.response).toEqualTypeOf<Signal<readonly Item[]>>();
    expectTypeOf(flat.pageParams).toEqualTypeOf<Signal<readonly number[]>>();
    flat.destroy();

    // An envelope is not an array, so nothing is flattened — and the type says so rather than
    // promising an item list it cannot produce.
    interface Envelope {
      items: Item[];
      cursor: string | null;
    }
    const paged = create(() =>
      createInfiniteRequest<Envelope, string>((cursor) => ({ url: '/items', params: { cursor } }), {
        key: () => ['items'],
        initialPageParam: '',
        getNextPageParam: (last) => last?.cursor ?? undefined,
      }),
    );
    expectTypeOf(paged.response).toEqualTypeOf<Signal<FlattenedPages<Envelope>>>();
    expectTypeOf(paged.response).toEqualTypeOf<Signal<readonly Envelope[]>>();
    paged.destroy();
  });

  it('names the failing call with its full path', () => {
    setup();
    expect(() =>
      createInfiniteRequest(() => '/x', {
        key: () => ['x'],
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
    ).toThrowError(/createInfiniteRequest/);
  });
});