import { computed, inject, type Signal } from '@angular/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createMutation, createRequest, QueryClient, type SignalMutation } from '../public-api';
import { settle, setup } from '../../testing/testing';

interface Todo {
  id: number;
  title: string;
}

/**
 * Lets a call with `onMutate` reach the wire.
 *
 * `run()` dispatches synchronously only when there is no `onMutate`; with one, the preparation is
 * awaited first and `execute` lands on a microtask. That is the documented order, so tests that
 * use `onMutate` have to wait before reaching for the request.
 */
async function dispatch(): Promise<void> {
  await settle();
}

describe('createMutation — onMutate', () => {
  it('runs before the request and before the optimistic write', async () => {
    // The order matters: a hook that snapshots state wants to see the world as it was, before
    // this call has changed anything on screen.
    const order: string[] = [];
    const { http, create } = setup();
    const list = create(() => createRequest<Todo[]>('/todos', { initialValue: [] }));

    const save = create(() =>
      createMutation<Todo[], string, { seen: number }>(
        (title) => ({ url: '/todos', body: { title } }),
        {
          onMutate: (_title) => {
            order.push(`onMutate saw ${list.response().length}`);
            return { seen: list.response().length };
          },
          optimistic: (todos, title) => {
            order.push(`optimistic saw ${list.response().length}`);
            return [...(todos ?? []), { id: -1, title }];
          },
        },
      ),
    );

    await settle();
    http.expectOne('/todos').flush([]);
    await settle();

    const p = save.run('write');
    await dispatch();
    expect(order).toEqual(['onMutate saw 0', 'optimistic saw 0']);

    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;

    list.destroy();
    save.destroy();
  });

  it('threads the context into onError, onSettled and context()', async () => {
    const { http, create } = setup();
    const onError = vi.fn();
    const onSettled = vi.fn();

    const save = create(() =>
      createMutation<number, string, { attempted: string }>(
        (title) => ({ url: '/todos', body: { title } }),
        {
          onMutate: (title) => ({ attempted: title }),
          onError,
          onSettled,
        },
      ),
    );

    expect(save.context()).toBeUndefined();

    const p = save.tryRun('write');
    await dispatch();
    http.expectOne('/todos').flush('nope', { status: 500, statusText: 'Err' });
    const result = await p;
    await settle();

    expect(result.ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.anything(), 'write', { attempted: 'write' });
    expect(onSettled).toHaveBeenCalledWith('write', { attempted: 'write' });
    expect(save.context()).toEqual({ attempted: 'write' });

    save.destroy();
  });

  it('awaits an async onMutate before sending', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number, string, { prepared: string }>(
        (title) => ({ url: '/todos', body: { title } }),
        {
          onMutate: async (title) => {
            await Promise.resolve();
            return { prepared: title };
          },
        },
      ),
    );

    const p = save.run('write');
    // Nothing on the wire yet: the preparation is still running.
    http.expectNone('/todos');

    await dispatch();
    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;
    await settle();

    save.destroy();
  });

  it('a throwing onMutate fails the call without sending anything', async () => {
    const { http, create } = setup();
    const onError = vi.fn();
    const onSettled = vi.fn();

    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        onMutate: () => {
          throw new Error('could not prepare');
        },
        onError,
        onSettled,
      }),
    );

    const result = await save.tryRun('write');
    await settle();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe('could not prepare');
    // The decisive part: nothing was sent, so a failed preparation cannot half-write.
    http.expectNone(() => true);
    expect(save.status()).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    save.destroy();
  });

  it('clears the context on reset()', async () => {
    const { http, create } = setup();
    const save = create(() =>
      createMutation<number, string, { title: string }>(
        (title) => ({ url: '/todos', body: { title } }),
        {
          onMutate: (title) => ({ title }),
        },
      ),
    );
    const p = save.run('write');
    await dispatch();
    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;
    expect(save.context()).toEqual({ title: 'write' });

    save.reset();
    expect(save.context()).toBeUndefined();

    save.destroy();
  });
});

describe('createMutation — optimistic target by key', () => {
  it('writes into the cached entry behind a key, with no reference to the handle', async () => {
    const { http, create } = setup();
    const list = create(() =>
      createRequest<Todo[]>('/todos', { key: () => ['todos'], initialValue: [] }),
    );
    await settle();
    http.expectOne('/todos').flush([{ id: 1, title: 'existing' }]);
    await settle();

    const save = create(() =>
      createMutation<Todo[], Todo>((draft) => ({ url: '/todos', body: draft }), {
        optimistic: (todos, draft) => [...(todos ?? []), draft],
        target: ['todos'],
        invalidates: () => [['todos']],
      }),
    );

    const p = save.run({ id: 2, title: 'new' });
    // Visible in the list before the server answered.
    expect(list.response()).toEqual([
      { id: 1, title: 'existing' },
      { id: 2, title: 'new' },
    ]);

    http.expectOne('/todos?id=2&title=new').flush(2, { status: 201, statusText: 'Created' });
    await p;
    await settle();

    // …and replaced by the real list once the invalidation came back.
    http.expectOne('/todos').flush([
      { id: 1, title: 'existing' },
      { id: 2, title: 'new' },
    ]);
    await settle();
    expect(list.response()).toEqual([
      { id: 1, title: 'existing' },
      { id: 2, title: 'new' },
    ]);

    list.destroy();
    save.destroy();
  });

  it('rolls back into the entry on failure', async () => {
    const { http, create } = setup();
    const list = create(() =>
      createRequest<Todo[]>('/todos', { key: () => ['todos'], initialValue: [] }),
    );
    await settle();
    http.expectOne('/todos').flush([{ id: 1, title: 'existing' }]);
    await settle();

    const save = create(() =>
      createMutation<Todo[], Todo>((draft) => ({ url: '/todos', body: draft }), {
        optimistic: (todos, draft) => [...(todos ?? []), draft],
        target: ['todos'],
      }),
    );

    const p = save.tryRun({ id: 2, title: 'new' });
    expect(list.response()).toHaveLength(2);

    http.expectOne('/todos?id=2&title=new').flush('nope', { status: 500, statusText: 'Err' });
    await p;
    await settle();

    expect(list.response()).toEqual([{ id: 1, title: 'existing' }]);

    list.destroy();
    save.destroy();
  });

  it('is a no-op when the key has no entry yet', async () => {
    // No handle for `['todos']` anywhere, so there is nothing to write into — and minting an
    // entry would produce one that can never fetch and that nothing subscribes to.
    const { http, create } = setup();
    const save = create(() =>
      createMutation<Todo[], Todo>((draft) => ({ url: '/todos', body: draft }), {
        optimistic: (todos, draft) => [...(todos ?? []), draft],
        target: ['todos'],
      }),
    );

    const p = save.run({ id: 1, title: 'x' });
    http.expectOne('/todos?id=1&title=x').flush(1, { status: 201, statusText: 'Created' });
    await p;

    save.destroy();
  });
});

describe('mutationKey and isMutating', () => {
  it('counts in-flight mutations globally and per key', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const savingTodos = client.isMutating(['todos']);
    const savingUsers = client.isMutating(['users']);
    const anySaving = client.isMutating();

    expect(savingTodos()).toBe(false);

    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        mutationKey: ['todos'],
      }),
    );

    const p = save.run('a');
    expect(savingTodos()).toBe(true);
    expect(savingUsers()).toBe(false);
    expect(anySaving()).toBe(true);
    expect(client.mutatingCount()()).toBe(1);
    expect(client.mutatingCount(['todos'])()).toBe(1);

    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;
    await settle();

    expect(savingTodos()).toBe(false);
    expect(anySaving()).toBe(false);
    expect(client.mutatingCount()()).toBe(0);

    save.destroy();
  });

  it('prefix-matches the mutation key', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const saving = client.isMutating(['todos']);

    const save = create(() =>
      createMutation<number, number>((id) => ({ url: '/todos', body: { id } }), {
        mutationKey: ['todos', 7],
      }),
    );

    const p = save.run(1);
    // `['todos']` is a prefix of `['todos', 7]`, so the group covers it.
    expect(saving()).toBe(true);

    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;
    expect(saving()).toBe(false);

    save.destroy();
  });

  it('decrements on failure and on cancel, never below zero', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const saving = client.isMutating();

    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        mutationKey: ['todos'],
      }),
    );

    const failed = save.tryRun('a');
    http.expectOne('/todos').flush('nope', { status: 500, statusText: 'Err' });
    await failed;
    expect(saving()).toBe(false);

    const cancelled = save.run('b');
    http.expectOne('/todos');
    save.cancel();
    await cancelled.catch(() => {});
    expect(saving()).toBe(false);
    expect(client.mutatingCount()()).toBe(0);

    save.destroy();
  });

  it('counts parallel calls separately', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const count = client.mutatingCount(['todos']);

    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        mutationKey: ['todos'],
      }),
    );

    const a = save.run('a');
    const b = save.run('b');
    expect(count()).toBe(2);

    const [ra, rb] = http.match('/todos');
    ra.flush(1, { status: 201, statusText: 'Created' });
    await a;
    expect(count()).toBe(1);

    rb.flush(2, { status: 201, statusText: 'Created' });
    await b;
    expect(count()).toBe(0);

    save.destroy();
  });

  it('forgets a key once its last mutation settles', async () => {
    // An app that has used a thousand distinct mutation keys should not carry a thousand entries.
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));

    const save = create(() =>
      createMutation<number, number>((id) => ({ url: '/todos', body: { id } }), {
        mutationKey: ['todos', 1],
      }),
    );

    const p = save.run(1);
    expect(client.mutatingCount(['todos', 1])()).toBe(1);
    http.expectOne('/todos').flush(1, { status: 201, statusText: 'Created' });
    await p;
    expect(client.mutatingCount(['todos', 1])()).toBe(0);
    expect(client.count(['todos'])).toBe(0);

    save.destroy();
  });

  it('retry stays off by default, so a 500 is not retried', async () => {
    const { http, create } = setup();
    const client = create(() => inject(QueryClient));
    const save = create(() =>
      createMutation<number, string>((title) => ({ url: '/todos', body: { title } }), {
        mutationKey: ['todos'],
      }),
    );

    const p = save.tryRun('a');
    http.expectOne('/todos').flush('nope', { status: 500, statusText: 'Err' });
    const result = await p;
    await settle();

    expect(result.ok).toBe(false);
    // One attempt, no back-off timer, nothing queued behind it.
    http.expectNone(() => true);
    expect(client.mutatingCount()()).toBe(0);

    save.destroy();
  });
});

describe('createMutation — context typing', () => {
  it('carries the named context type onto the handle', () => {
    const { create } = setup();
    const save = create(() =>
      createMutation<number, string, { title: string; at: number }>(
        (title) => ({ url: '/todos', body: { title } }),
        { onMutate: (title) => ({ title, at: 1 }) },
      ),
    );

    expectTypeOf(save).toExtend<SignalMutation<number, string, { title: string; at: number }>>();
    expectTypeOf(save.context).toEqualTypeOf<Signal<{ title: string; at: number } | undefined>>();
  });

  it('infers everything when no type arguments are written at all', () => {
    // The one case where `TContext` is inferred: TypeScript fills any type argument you leave out
    // with its **default**, so writing `<number, string>` locks `TContext` to `undefined` before
    // `onMutate` is even looked at. Omit them all and everything is inferred.
    const { create } = setup();
    const save = create(() =>
      createMutation((title: string) => ({ url: '/todos', body: { title } }), {
        onMutate: (title) => ({ title, at: 1 }),
      }),
    );

    expectTypeOf(save.context).toEqualTypeOf<Signal<{ title: string; at: number } | undefined>>();
  });

  it('keeps context `undefined` when no onMutate is given', () => {
    const { create } = setup();
    const save = create(() => createMutation<number, string>((t) => ({ url: '/x', body: { t } })));
    expectTypeOf(save.context).toEqualTypeOf<Signal<undefined>>();
  });

  it('fails loudly rather than silently when a returning onMutate skips `TContext`', () => {
    // The trap in the test above, from the other side: writing `<number, string>` means the callback
    // has to satisfy `() => undefined`, so this is a compile error. That is the *good* outcome — the
    // alternative fix (capturing the options object in a type parameter) compiles but degrades
    // `context()` to `unknown`, which is a silent loss of the type this feature exists to carry.
    // `docs/design-0.2.md` §5.5 records the probe.
    const { create } = setup();
    const save = create(() =>
      createMutation<number, string>((t) => ({ url: '/x', body: { t } }), {
        // @ts-expect-error `TContext` defaults to `undefined` when it is not written.
        onMutate: (t) => ({ title: t }),
      }),
    );

    // The consequence, not just the error: there is nothing to read back, which is exactly why the
    // compile error above is the *better* failure mode.
    expectTypeOf(save.context).toEqualTypeOf<Signal<undefined>>();
  });

  it('an old two-argument callback still type-checks', () => {
    const { create } = setup();
    // The pre-v0.1.0 signature. Adding a trailing optional parameter is a widening, so every
    // existing callback compiles without a change.
    create(() =>
      createMutation<number, string>((t) => ({ url: '/x', body: { t } }), {
        onSuccess: (response, args) => void [response, args],
        onError: (error, args) => void [error, args],
        onSettled: (args) => void args,
      }),
    );
    expect(computed).toBeTypeOf('function');
  });
});
