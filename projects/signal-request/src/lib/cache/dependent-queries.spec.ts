import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequest, provideSignalRequest } from '../../public-api';
import { cache, respond, settle, setup } from '../../../testing/testing';

interface Post {
  id: number;
  title: string;
}

interface Comment {
  id: number;
  body: string;
}

const GC = 60_000;

/**
 * Dependent queries on the cached path.
 *
 * The uncached path can chain (`ctx.chain(upstream.resource)`), and a cached request deliberately
 * cannot: its entry is shared and outlives the handle, so "wait for *my* component's resource" has no
 * meaning there. The replacement is not a workaround — it is the better contract, and these tests are
 * what the error message points at instead of just describing the problem:
 *
 * > Read the upstream handle and put its value in this request's `key` instead, so the dependency
 * > becomes part of the cache identity.
 *
 * Two halves make it work, and both are asserted below: the **key** carries the dependency (so two
 * upstream values can never share one downstream entry), and the **source** returns `undefined` while
 * there is nothing to ask for (so no request is sent, and no entry is invented, before there is
 * something to depend on).
 */
describe('dependent cached queries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends nothing and creates nothing until the dependency has a value', async () => {
    const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
    const selected = signal<number | undefined>(undefined);

    const post = create(() =>
      createRequest<Post>(() => (selected() === undefined ? undefined : `/posts/${selected()}`), {
        key: () => ['post', selected()],
      }),
    );
    const comments = create(() =>
      createRequest<Comment[]>(
        () => (selected() === undefined ? undefined : `/posts/${selected()}/comments`),
        { key: () => ['comments', selected()] },
      ),
    );

    await settle();
    http.expectNone(() => true);
    // The important half: no entry was invented for `['post', undefined]`. `resolve` is never
    // reached when the source opts out, so the cache stays exactly as empty as the screen is.
    expect(cache().size).toBe(0);
    expect(post.status()).toBe('idle');
    expect(comments.status()).toBe('idle');

    selected.set(1);
    await settle();
    await respond(http, '/posts/1', { id: 1, title: 'one' });
    await respond(http, '/posts/1/comments', [{ id: 1, body: 'a' }]);

    expect(cache().size).toBe(2);
    expect(cache().peek(['post', 1])).toBeDefined();
    expect(cache().peek(['comments', 1])).toBeDefined();
    expect(comments.response()).toEqual([{ id: 1, body: 'a' }]);
  });

  it('keys the dependent request on the upstream value, so the pair cannot collide', async () => {
    const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
    const selected = signal(1);

    const post = create(() =>
      createRequest<Post>(() => `/posts/${selected()}`, { key: () => ['post', selected()] }),
    );
    const comments = create(() =>
      createRequest<Comment[]>(
        () => {
          // Read the upstream *handle*, not a copy of its signal: whatever the post handle
          // currently shows is what this request is about.
          const current = post.response();
          return current === undefined ? undefined : `/posts/${current.id}/comments`;
        },
        { key: () => ['comments', post.response()?.id] },
      ),
    );

    await settle();
    // Nothing downstream yet: the post's value is what gates it, and the post has not answered.
    http.expectOne('/posts/1').flush({ id: 1, title: 'one' });
    await settle();
    await respond(http, '/posts/1/comments', [{ id: 1, body: 'a' }]);

    expect(comments.response()).toEqual([{ id: 1, body: 'a' }]);
    expect(cache().peek(['comments', 1])).toBeDefined();

    // Another post re-points both handles, and the second post gets its own comments entry rather
    // than reading the first post's — which is exactly what a shared, chain-shaped subscription
    // could not have promised.
    selected.set(2);
    await settle();
    await respond(http, '/posts/2', { id: 2, title: 'two' });
    await respond(http, '/posts/2/comments', []);

    expect(cache().peek(['comments', 2])).toBeDefined();
    // The first pair is collectable rather than deleted: going back to post 1 is a cache hit.
    expect(cache().peek(['comments', 1])).toBeDefined();
    expect(cache().size).toBe(4);
  });

  it('carries `key` through the params bag too, which is the same mechanism', async () => {
    // A dependent query keyed on the id of a *list* selection: the id is a normal signal, the key is
    // built from the value the request is made about, and nothing about it is chain-specific.
    const { http, create } = setup([provideSignalRequest({ gcTime: GC })]);
    const id = signal(7);

    const detail = create(() =>
      createRequest<Post>(() => ({ url: '/posts/:id', path: { id: id() } }), {
        key: () => ['detail', id()],
      }),
    );

    await settle();
    http.expectOne('/posts/7').flush({ id: 7, title: 'seven' });
    await settle();

    expect(detail.response()).toEqual({ id: 7, title: 'seven' });
    expect(cache().peek(['detail', 7])).toBeDefined();
  });
});
