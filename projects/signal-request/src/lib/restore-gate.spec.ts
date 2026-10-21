import { inject, signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  createRequest,
  RequestCancelledError,
  RESTORE_GATE,
  provideSignalRequest,
} from '../public-api';
import type { CachedRequest, RestoreGate } from '../public-api';
import { IDLE_RESTORE_GATE } from './restore-gate';
import { cache, settle, setup } from '../../testing/testing';

interface User {
  id: number;
  name: string;
}

/**
 * A gate a test drives by hand — the core's half of `/persist`, with the storage replaced by two
 * methods.
 *
 * `hold()` is a restore starting (a storage read that has not answered); `release()` is the seeds
 * landing. Deliberately not a `vi.fn` pair: what the core depends on is the *ordering* of a signal
 * flip and a promise settling, and a mock that records calls would not prove either.
 */
interface DrivenGate {
  readonly gate: RestoreGate;
  /** A restore starts. */
  hold(): void;
  /** The restore settles: the read came back and its seeds are in the cache. */
  release(): void;
  /** Whether anything is currently waiting on `restored()`. */
  readonly waiters: number;
}

function drivenGate(): DrivenGate {
  const isRestoring = signal(false);
  let settle: (() => void) | undefined;
  let restored: Promise<void> = Promise.resolve();
  let waiters = 0;

  return {
    gate: {
      isRestoring: isRestoring.asReadonly(),
      restored: () => {
        waiters++;
        return restored;
      },
    },
    hold: () => {
      isRestoring.set(true);
      restored = new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
    release: () => {
      isRestoring.set(false);
      settle?.();
      settle = undefined;
      restored = Promise.resolve();
    },
    get waiters() {
      return waiters;
    },
  };
}

function keyed(create: <T>(fn: () => T) => T, staleTime = 0): CachedRequest<User[]> {
  return create(() =>
    createRequest<User[]>('/users', {
      key: () => ['users'],
      staleTime,
      initialValue: [],
    }),
  );
}

describe('RESTORE_GATE — the default', () => {
  it('is the idle gate, so an application that never persists holds nothing', () => {
    const { create } = setup();

    // The token arrives `providedIn: 'root'` and resolves to a shared idle constant: an application
    // that never calls `providePersistedCache` neither provides anything nor allocates anything.
    expect(create(() => inject(RESTORE_GATE))).toBe(IDLE_RESTORE_GATE);
    expect(IDLE_RESTORE_GATE.isRestoring()).toBe(false);
    expect(IDLE_RESTORE_GATE.restored()).toBeInstanceOf(Promise);
  });

  it('does not hold a fetch when nothing replaces the idle gate', async () => {
    const { http, create } = setup();
    const users = keyed(create);
    await settle();

    // The fetch is on the wire in the same tick the handle mounted: the idle gate is never busy.
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    users.destroy();
  });
});

describe('a restore in flight', () => {
  it('holds the mount fetch until the restore settles, then releases it once', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const users = keyed(create);
    await settle();

    // Held: no request, no spinner, no data. A handle that is waiting for a snapshot it cannot see
    // must not report `loading`, because nothing is on the wire.
    http.expectNone('/users');
    expect(users.isFetching()).toBe(false);
    expect(users.response()).toEqual([]);

    driven.release();
    await settle();

    // Released exactly once, and the `refetchOnMount` decision is made *after* the hold: the seed
    // that landed in between is what decides whether this fetch happens at all.
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(users.fetchCount()).toBe(1);

    users.destroy();
  });

  it('holds the first fetch of a key the snapshot does not carry, which is the stated trade', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const people = create(() =>
      createRequest<User[]>('/people', { key: () => ['people'], initialValue: [] }),
    );
    await settle();
    http.expectNone('/people');

    driven.release();
    await settle();

    // Delayed by one storage read, not skipped: with no seed for this key the entry is empty and
    // stale, so the mount fetch runs exactly as it would have.
    http.expectOne('/people').flush([{ id: 2, name: 'Grace' }]);
    await settle();
    expect(people.response()).toEqual([{ id: 2, name: 'Grace' }]);
    people.destroy();
  });

  it('skips the released fetch when the seed landed fresh, and refetches when it landed stale', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const fresh = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        staleTime: Number.POSITIVE_INFINITY,
        initialValue: [],
      }),
    );
    await settle();

    // The restore lands: this is what `/persist` does when its read resolves, and the timestamps are
    // what the released effect then reads.
    cache().seed(['users'], [{ id: 1, name: 'Ada' }], Date.now());
    driven.release();
    await settle();

    http.expectNone('/users');
    expect(fresh.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(fresh.fetchCount()).toBe(0);

    // Same mechanism, stale seed: the release is what turns "held" into "fetched", so a restore that
    // is too old still ends in a request rather than in an empty screen.
    driven.hold();
    const stale = create(() =>
      createRequest<User[]>('/people', { key: () => ['people'], initialValue: [] }),
    );
    await settle();
    cache().seed(['people'], [{ id: 2, name: 'Grace' }], 1);
    driven.release();
    await settle();

    http.expectOne('/people').flush([{ id: 3, name: 'Hopper' }]);
    await settle();
    expect(stale.response()).toEqual([{ id: 3, name: 'Hopper' }]);

    fresh.destroy();
    stale.destroy();
  });

  it('never fetches for a handle destroyed while it was held', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const users = keyed(create);
    await settle();
    users.destroy();
    await settle();

    driven.release();
    await settle();

    // The race the hold creates: the handle went away while the read was outstanding, and the
    // release must not resurrect a request nothing is subscribed to. The entry outlives the handle
    // for `gcTime`, which is the only reason it is still here to ask.
    http.expectNone('/users');
    expect(cache().peek(['users'])?.fetchCount()).toBe(0);
    expect(cache().peek(['users'])?.isFetching()).toBe(false);
  });
});

describe('waitForRestore: false', () => {
  it('is honoured per request, and the restore still lands afterwards', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        staleTime: Number.POSITIVE_INFINITY,
        waitForRestore: false,
        initialValue: [],
      }),
    );
    await settle();

    // Fetches straight away, which is the choice: a paint now rather than the stored value.
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();

    // And the late seed loses to it, because the network answer is newer by construction.
    cache().seed(['users'], [{ id: 2, name: 'Grace' }], 1);
    driven.release();
    await settle();

    expect(users.response()).toEqual([{ id: 1, name: 'Ada' }]);
    expect(users.fetchCount()).toBe(1);
    users.destroy();
  });

  it('is honoured globally, and a single request can opt back in', async () => {
    const driven = drivenGate();
    const { http, create } = setup([
      provideSignalRequest({ waitForRestore: false }),
      { provide: RESTORE_GATE, useValue: driven.gate },
    ]);

    driven.hold();
    const optsOut = keyed(create);
    const optsIn = create(() =>
      createRequest<User[]>('/people', {
        key: () => ['people'],
        waitForRestore: true,
        initialValue: [],
      }),
    );
    await settle();

    // The opt-out fetches in the same tick it mounted; the opt-in is held despite the global.
    http.expectNone('/people');
    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    await settle();
    expect(optsOut.response()).toEqual([{ id: 1, name: 'Ada' }]);

    driven.release();
    await settle();
    http.expectOne('/people').flush([{ id: 2, name: 'Grace' }]);
    await settle();
    expect(optsIn.response()).toEqual([{ id: 2, name: 'Grace' }]);

    optsOut.destroy();
    optsIn.destroy();
  });
});

describe('run() during a restore', () => {
  it('resolves after the restore and re-reads the plan, so it fetches the params as they are then', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);
    const id = signal(1);

    driven.hold();
    const user = create(() =>
      createRequest<User>(() => `/users/${id()}`, {
        key: () => ['user', id()],
        lazy: true,
        initialValue: { id: 0, name: '' },
      }),
    );
    await settle();

    const run = user.run();
    await settle();
    // Waiting, not racing: a fetch started here would be for the params of the moment of the call.
    http.expectNone(() => true);

    // The call was made before the parameters moved, and the wait is what makes the difference.
    id.set(2);
    driven.release();
    await settle();

    http.expectOne('/users/2').flush({ id: 2, name: 'Grace' });
    await settle();
    expect(await run).toEqual({ id: 2, name: 'Grace' });
    user.destroy();
  });

  it('reports a cancelled request when the handle dies while waiting', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const users = create(() =>
      createRequest<User[]>('/users', { key: () => ['users'], lazy: true, initialValue: [] }),
    );
    await settle();

    const attempt = users.tryRun();
    await settle();
    users.destroy();

    driven.release();
    await settle();

    const outcome = await attempt;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error).toBeInstanceOf(RequestCancelledError);
    http.expectNone(() => true);
  });

  it('does not wait when the option is off', async () => {
    const driven = drivenGate();
    const { http, create } = setup([{ provide: RESTORE_GATE, useValue: driven.gate }]);

    driven.hold();
    const users = create(() =>
      createRequest<User[]>('/users', {
        key: () => ['users'],
        lazy: true,
        waitForRestore: false,
        initialValue: [],
      }),
    );
    await settle();

    const run = users.run();
    await settle();

    http.expectOne('/users').flush([{ id: 1, name: 'Ada' }]);
    expect(await run).toEqual([{ id: 1, name: 'Ada' }]);
    users.destroy();
  });
});
