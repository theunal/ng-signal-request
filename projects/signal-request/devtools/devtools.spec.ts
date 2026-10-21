import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { inject, signal } from '@angular/core';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import {
  ALWAYS_ONLINE,
  CacheEntry,
  createRequest,
  normalizeKey,
  OnlineManager,
  provideSignalRequest,
  QueryClient,
  RESTORE_GATE,
} from 'ng-signal-request';
import {
  DevtoolsHistory,
  DevtoolsPanel,
  QueryDevtools,
  provideDevtoolsHistory,
  snapshotEntries,
  type DevtoolsEntry,
  type DevtoolsStatus,
} from './devtools';
import { advanceClock, cache, settle, setup } from '../testing/testing';

interface Row {
  id: number;
}

/** Builds a keyed handle in the testing injector and returns it. */
function keyed<T>(create: <U>(fn: () => U) => U, key: readonly unknown[]) {
  return create(() =>
    createRequest<T>(() => ({ url: '/rows' }), { key: () => key, debugName: 'rows' }),
  );
}

function statusOf(entries: readonly DevtoolsEntry[], key: string): DevtoolsStatus | undefined {
  return entries.find((entry) => entry.label.includes(key))?.status;
}

/** Every devtools test opts into history; reading an empty sink is not what these tests cover. */
function setupDevtools(providers: Parameters<typeof setup>[0] = []) {
  return setup([provideDevtoolsHistory(), ...providers]);
}

/**
 * Forces a collection in the Node process the unit tests run in.
 *
 * `--expose-gc` is normally a launch flag, and the Angular test builder controls the process. The
 * V8 flag plus a fresh context is the standard way to get a callable `gc` after startup; it is only
 * used by the one test that proves the sink's `WeakMap` does not retain an entry.
 */
function forceGc(): void {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as (options?: { type: string }) => void;
  gc({ type: 'major' });
}

describe('snapshotEntries() — the snapshot', () => {
  it('describes an entry that has not fetched yet', async () => {
    const { create } = setupDevtools();
    // `refetchOnMount: false`, so the entry exists with nothing in flight. That is the only way to
    // see `'empty'` rather than `'loading'` — a mounting handle fetches, which is the point of it.
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        refetchOnMount: false,
        debugName: 'rows',
      }),
    );

    await settle();

    const entries = snapshotEntries(cache(), { now: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('["rows"]');
    expect(entries[0].name).toBe('rows');
    expect(entries[0].status).toBe('empty');
    expect(entries[0].observers).toBe(1);
    expect(entries[0].fetchCount).toBe(0);
    expect(entries[0].ageMs).toBe(0);
    expect(entries[0].hasPlan).toBe(true);
    expect(entries[0].error).toBeUndefined();

    handle.destroy();
  });

  it('is loading while the request is in flight, ready once it lands', async () => {
    const { http, create } = setupDevtools();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    expect(statusOf(snapshotEntries(cache(), { now: 0 }), 'rows')).toBe('loading');

    // A fixed clock, rather than mocking `Date.now` — the age is the only thing that needs it.
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    const entries = snapshotEntries(cache(), { now: 5000 });
    expect(entries[0].status).toBe('ready');
    expect(entries[0].fetchCount).toBe(1);
    expect(entries[0].statusCode).toBe(200);
    expect(entries[0].dataUpdatedAt).toBeGreaterThan(0);
    expect(entries[0].ageMs).toBe(5000 - entries[0].dataUpdatedAt);

    handle.destroy();
  });

  it('reports invalidation, local writes and failures distinctly', async () => {
    const { http, create } = setupDevtools();
    const client = create(() => inject(QueryClient));
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    client.invalidate(['rows']);
    await settle();
    // An invalidated entry *with* a live observer refetches at once, so the row reads as loading.
    // The flag is what says why it is loading — a refetch and a first load otherwise look alike.
    const invalidating = snapshotEntries(cache())[0];
    expect(invalidating.status).toBe('loading');
    expect(invalidating.invalidated).toBe(true);

    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();
    expect(snapshotEntries(cache())[0].invalidated).toBe(false);

    handle.set([{ id: 2 }]);
    await settle();
    expect(statusOf(snapshotEntries(cache()), 'rows')).toBe('local');

    // `reload()` clears the local flag and goes back on the wire.
    handle.reload();
    await settle();
    http.expectOne('/rows').flush({ message: 'boom' }, { status: 500, statusText: 'Error' });
    await settle();

    const failed = snapshotEntries(cache())[0];
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('500');

    handle.destroy();
  });

  it('shows invalidation on its own when nobody is watching', async () => {
    const { http, create } = setupDevtools();
    const client = create(() => inject(QueryClient));
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    // No observer, so an invalidation has nothing to refetch for and the state stands alone —
    // which is the only way `'invalidated'` is ever the reported status.
    handle.destroy();
    await settle();
    client.invalidate(['rows']);
    await settle();

    const entry = snapshotEntries(cache())[0];
    expect(entry.status).toBe('invalidated');
    expect(entry.observers).toBe(0);
    expect(entry.fetchCount).toBe(1);
    http.expectNone(() => true);
  });

  it('carries the raw key, not just its rendering', async () => {
    const { create } = setupDevtools();
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), { key: () => ['rows', { page: 2 }] }),
    );
    await settle();

    const entry = snapshotEntries(cache())[0];
    expect(entry.key).toEqual(['rows', { page: 2 }]);
    expectTypeOf(entry.key).toEqualTypeOf<readonly unknown[]>();
    expect(entry.label).toContain('page');

    handle.destroy();
  });

  it('honours a filter, the same one the client takes', async () => {
    const { create } = setupDevtools();
    const users = create(() =>
      createRequest<Row[]>(() => ({ url: '/users' }), { key: () => ['users'] }),
    );
    const posts = create(() =>
      createRequest<Row[]>(() => ({ url: '/posts' }), { key: () => ['posts'] }),
    );
    await settle();

    expect(snapshotEntries(cache())).toHaveLength(2);
    expect(snapshotEntries(cache(), { filter: ['users'] })).toHaveLength(1);
    expect(snapshotEntries(cache(), { filter: ['users'] })[0].label).toBe('["users"]');

    users.destroy();
    posts.destroy();
  });
});

describe('QueryDevtools — the live view', () => {
  it('tracks entries as they are created and collected', async () => {
    const { create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));

    expect(devtools.entries()).toEqual([]);
    expect(devtools.count()).toBe(0);

    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    expect(devtools.count()).toBe(1);
    expect(devtools.fetching()).toBe(1);

    handle.destroy();
    // The handle released its subscription, but the entry is still cached — `gcTime` has not run.
    expect(devtools.count()).toBe(1);

    cache().remove(['rows']);
    await settle();
    expect(devtools.count()).toBe(0);
    expect(devtools.fetching()).toBe(0);
  });

  it('reflects state changes without polling', async () => {
    const { http, create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    expect(devtools.entries()[0].status).toBe('loading');

    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();
    expect(devtools.entries()[0].status).toBe('ready');
    expect(devtools.entries()[0].fetchCount).toBe(1);

    handle.destroy();
  });

  it('opens and closes', () => {
    const { create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));

    expect(devtools.isOpen()).toBe(false);
    devtools.open();
    expect(devtools.isOpen()).toBe(true);
    devtools.close();
    expect(devtools.isOpen()).toBe(false);
    devtools.toggle();
    expect(devtools.isOpen()).toBe(true);
  });

  it('log() prints a table of the current snapshot', async () => {
    const { create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const table = vi.spyOn(console, 'table').mockImplementation(() => {});
    try {
      devtools.log();
      expect(table).toHaveBeenCalledOnce();
      expect(table.mock.calls[0][0]).toEqual([]);

      const handle = keyed<Row[]>(create, ['rows']);
      await settle();
      devtools.log();
      expect(table.mock.calls[1][0]).toHaveLength(1);

      handle.destroy();
    } finally {
      table.mockRestore();
    }
  });

  it('logChanges() reports what changed, and stops when told to', async () => {
    const { http, create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
      lines.push(String(message));
    });

    try {
      const stop = devtools.logChanges();
      await settle();

      const handle = keyed<Row[]>(create, ['rows']);
      await settle();
      expect(lines.some((line) => line.startsWith('[ngsr] +') && line.includes('rows'))).toBe(true);

      lines.length = 0;
      http.expectOne('/rows').flush([{ id: 1 }]);
      await settle();
      // A settle changes data, not the set of entries — the case a bare `subscribeChanges` misses.
      // The entry was already at fetch #1 when it appeared (a fetch counts as it starts), so what
      // moved here is the status, from the first load to having something to show.
      expect(lines.some((line) => line.includes('loading → ready'))).toBe(true);

      lines.length = 0;
      cache().remove(['rows']);
      await settle();
      expect(lines.some((line) => line.startsWith('[ngsr] -'))).toBe(true);

      stop();
      lines.length = 0;
      handle.destroy();
      cache().remove(['rows']);
      await settle();
      expect(lines).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('devtools — connectivity', () => {
  it('marks a paused entry in the snapshot without changing its status', async () => {
    const { create } = setupDevtools();
    TestBed.inject(OnlineManager).setOnline(false);
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        networkMode: 'online',
        debugName: 'rows',
      }),
    );
    await settle();

    const entry = snapshotEntries(cache(), { now: 0 })[0];
    // `paused` is a column of its own: it says why the entry will not refresh, not what state it is
    // in. A paused entry that never fetched is still `empty` — reporting `loading` would claim a
    // request is on the wire when there is none.
    expect(entry.paused).toBe(true);
    expect(entry.status).toBe('empty');

    handle.destroy();
  });

  it('exposes the same connectivity the library acts on', () => {
    const { create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const manager = TestBed.inject(OnlineManager);

    expect(devtools.online()).toBe(true);
    manager.setOnline(false);
    expect(devtools.online()).toBe(false);
    manager.setOnline(true);
    expect(devtools.online()).toBe(true);
  });

  it('shows the offline banner and the per-row paused marker', async () => {
    const { create } = setupDevtools();
    TestBed.inject(OnlineManager).setOnline(false);
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        networkMode: 'online',
        debugName: 'rows',
      }),
    );
    await settle();

    const fixture = TestBed.createComponent(DevtoolsPanel);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('(offline)');

    button.click();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    expect(row.textContent).toContain('paused');

    handle.destroy();
  });
});

describe('DevtoolsPanel — the table', () => {
  function mount(): ComponentFixture<DevtoolsPanel> {
    setupDevtools();
    const fixture = TestBed.createComponent(DevtoolsPanel);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the entry count and hides the table until it is opened', async () => {
    const fixture = mount();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('cache 0');
    expect(fixture.nativeElement.querySelector('table')).toBeNull();

    button.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('table')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('td')?.textContent).toContain('no cached queries');
  });

  it('renders a row per entry, with a formatted age', async () => {
    const { create } = setupDevtools();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    // Pin the clock so the age column has one right answer rather than a race with the test runner.
    advanceClock(4000);

    const fixture = TestBed.createComponent(DevtoolsPanel);
    TestBed.inject(QueryDevtools).open();
    fixture.detectChanges();

    const cells = [...fixture.nativeElement.querySelectorAll('tbody td')].map((cell: Element) =>
      cell.textContent.trim(),
    );
    expect(cells[0]).toBe('["rows"]');
    expect(cells[1]).toBe('loading');
    expect(cells[2]).toBe('1');
    expect(cells[3]).toBe('1');
    expect(cells[4]).toBe('4s');

    handle.destroy();
  });

  it('shows the entry count against the cap, and flags an overshoot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { create } = setupDevtools([provideSignalRequest({ maxEntries: 1 })]);
    // Two live handles against a cap of one: nothing may be taken, so the cache overshoots and the
    // panel says so rather than silently reporting a number that looks fine.
    const a = keyed<Row[]>(create, ['a']);
    const b = keyed<Row[]>(create, ['b']);
    await settle();

    const fixture = TestBed.createComponent(DevtoolsPanel);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('cache 2 / 1');
    expect(button.textContent).toContain('over cap');

    a.destroy();
    b.destroy();
    warn.mockRestore();
  });

  it('shows no cap when the cache is unbounded', async () => {
    const fixture = mount();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('cache 0');
    expect(button.textContent).not.toContain('/');
  });

  it('counts staged persisted values, which have no entry to show', () => {
    setupDevtools([provideSignalRequest({ maxEntries: 2 })]);
    // Staged by a persister: no entry exists, but they hold two of the cap's two places. The table
    // cannot list them, so the label has to account for them or the cap readout is a lie.
    cache().seed(['rows', 1], [{ id: 1 }], 1);
    cache().seed(['rows', 2], [{ id: 2 }], 2);

    const fixture = TestBed.createComponent(DevtoolsPanel);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;

    expect(button.textContent).toContain('cache 0 + 2 staged / 2');
    expect(button.textContent).not.toContain('over cap');
  });

  it('formats an age in ms, seconds and minutes', () => {
    const fixture = mount();
    const panel = fixture.componentInstance as unknown as { formatAge(ms: number): string };

    expect(panel.formatAge(0)).toBe('—');
    expect(panel.formatAge(999)).toBe('999ms');
    expect(panel.formatAge(2000)).toBe('2s');
    expect(panel.formatAge(120_000)).toBe('2m');
  });
});

describe('devtools — depth', () => {
  it('reports plan kind, seed origin, observer names and newest-first attempts', async () => {
    const { http, create } = setupDevtools();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();

    advanceClock(10);
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    advanceClock(20);
    handle.reload();
    await settle();
    advanceClock(30);
    http.expectOne('/rows').flush([{ id: 2 }]);
    await settle();

    const entry = snapshotEntries(cache()).at(-1)!;
    expect(entry.kind).toBe('http');
    expect(entry.seeded).toBe(false);
    expect(entry.observerNames).toEqual(['rows']);
    expect(entry.attempts).toHaveLength(2);
    expect(entry.attempts[0].startedAt).toBeGreaterThan(entry.attempts[1].startedAt);
    expect(entry.attempts[0].outcome).toBe('success');
    expect(entry.retries).toEqual([]);

    handle.destroy();
  });

  it('serializes a preview only when asked, and caps it', async () => {
    const { create } = setupDevtools();
    const handle = create(() =>
      createRequest<{ body: string }>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        refetchOnMount: false,
      }),
    );
    await settle();
    handle.set({ body: 'x'.repeat(400) });

    const closed = snapshotEntries(cache())[0];
    expect(closed.preview).toBeUndefined();
    expect(closed.size).toBeUndefined();

    const open = snapshotEntries(cache(), { preview: true })[0];
    expect(open.preview).toHaveLength(201);
    expect(open.preview?.endsWith('…')).toBe(true);
    expect(open.size).toBeGreaterThan(200);
    expect(open.data).toEqual({ body: 'x'.repeat(400) });

    handle.destroy();
  });

  it('turns an unserializable value into a label instead of throwing', async () => {
    const { create } = setupDevtools();
    const handle = create(() =>
      createRequest<unknown>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        refetchOnMount: false,
      }),
    );
    await settle();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    handle.set(circular);

    const entry = snapshotEntries(cache(), { preview: true })[0];
    expect(entry.preview).toBe('[unserializable]');
    expect(entry.size).toBeUndefined();

    // `JSON.stringify` returns `undefined` for a symbol rather than throwing; it is just as
    // unserializable from the panel's point of view.
    const symbol = create(() =>
      createRequest<unknown>(() => ({ url: '/symbol' }), {
        key: () => ['symbol'],
        refetchOnMount: false,
      }),
    );
    await settle();
    symbol.set(Symbol('x'));
    expect(snapshotEntries(cache(), { preview: true, filter: ['symbol'] })[0].preview).toBe(
      '[unserializable]',
    );

    symbol.destroy();
    handle.destroy();
  });

  it('isRestoring() follows the restore gate', () => {
    const restoring = signal(true);
    const { create } = setupDevtools([
      {
        provide: RESTORE_GATE,
        useValue: { isRestoring: restoring.asReadonly(), restored: () => Promise.resolve() },
      },
    ]);
    const devtools = create(() => inject(QueryDevtools));

    expect(devtools.isRestoring()).toBe(true);
    restoring.set(false);
    expect(devtools.isRestoring()).toBe(false);
  });

  it('runs the invalidation, refetch and stale actions against the service', async () => {
    const { http, create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    devtools.invalidate(devtools.entries()[0]);
    await settle();
    expect(devtools.entries()[0].invalidated).toBe(true);
    expect(devtools.entries()[0].status).toBe('loading');
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    devtools.refetch(devtools.entries()[0]);
    await settle();
    expect(devtools.entries()[0].fetchCount).toBe(3);
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();

    // Stale is deliberately not a refetch: it changes the answer to the next mount's question.
    devtools.markStale(devtools.entries()[0]);
    await settle();
    expect(devtools.entries()[0].invalidated).toBe(true);
    expect(devtools.entries()[0].fetchCount).toBe(3);

    handle.destroy();
  });

  it('cancels the in-flight request and removes exactly one row', async () => {
    const { http, create } = setupDevtools();
    const devtools = create(() => inject(QueryDevtools));
    const parent = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        refetchOnMount: false,
      }),
    );
    const child = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows/1' }), {
        key: () => ['rows', 1],
        refetchOnMount: false,
      }),
    );
    await settle();

    parent.reload();
    await settle();
    const request = http.expectOne('/rows');
    devtools.cancel(devtools.entries().find((entry) => entry.label === '["rows"]')!);
    expect(request.cancelled).toBe(true);
    await settle();

    const parentEntry = devtools.entries().find((entry) => entry.label === '["rows"]')!;
    expect(devtools.remove(parentEntry)).toBe(true);
    await settle();
    expect(devtools.entries().some((entry) => entry.label === '["rows"]')).toBe(false);
    expect(devtools.entries().some((entry) => entry.label.includes('"rows", 1'))).toBe(true);

    child.destroy();
    parent.destroy();
  });

  it('shows the restoring marker, actions and expandable details', async () => {
    const restoring = signal(true);
    const { http, create } = setupDevtools([
      {
        provide: RESTORE_GATE,
        useValue: { isRestoring: restoring.asReadonly(), restored: () => Promise.resolve() },
      },
    ]);
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    // The gate is busy, so the first fetch is held. Release it, let the request settle, then make
    // the gate busy again before mounting: the marker is what this test is about.
    restoring.set(false);
    await settle();
    http.expectOne('/rows').flush([{ id: 1 }]);
    await settle();
    restoring.set(true);

    const fixture = TestBed.createComponent(DevtoolsPanel);
    TestBed.inject(QueryDevtools).open();
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(header.textContent).toContain('(restoring)');

    const buttons = [
      ...fixture.nativeElement.querySelectorAll('tbody button'),
    ] as HTMLButtonElement[];
    const labels = buttons.map((button) => button.textContent.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['details', 'invalidate', 'refetch', 'cancel', 'stale', 'remove']),
    );

    buttons.find((button) => button.textContent.trim() === 'details')!.click();
    fixture.detectChanges();

    const details = fixture.nativeElement.querySelector('tr.details') as HTMLElement;
    expect(details.textContent).toContain('plan http');
    expect(details.textContent).toMatch(/observers\s+rows/);
    expect(details.textContent).toContain('attempts');
    expect(details.textContent).toContain('success');
    expect(details.querySelector('.preview')?.textContent).toContain('"id":1');

    // Closing is the other branch of the same toggle.
    ([...fixture.nativeElement.querySelectorAll('tbody button')] as HTMLButtonElement[])
      .find((button) => button.textContent.trim() === 'hide')!
      .click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('tr.details')).toBeNull();

    const click = (label: string): void => {
      const button = (
        [...fixture.nativeElement.querySelectorAll('tbody button')] as HTMLButtonElement[]
      ).find((candidate) => candidate.textContent.trim() === label);
      expect(button, label).toBeDefined();
      button!.click();
    };

    click('invalidate');
    await settle();
    fixture.detectChanges();
    const invalidatedRequest = http.expectOne('/rows');
    click('cancel');
    fixture.detectChanges();
    expect(invalidatedRequest.cancelled).toBe(true);
    await settle();
    fixture.detectChanges();

    click('refetch');
    await settle();
    fixture.detectChanges();
    http.expectOne('/rows').flush([{ id: 2 }]);
    await settle();
    fixture.detectChanges();

    click('stale');
    fixture.detectChanges();
    click('remove');
    await settle();
    fixture.detectChanges();
    expect(TestBed.inject(QueryDevtools).count()).toBe(0);

    handle.destroy();
  });

  it('expands an empty row to say there is no value', async () => {
    const { create } = setupDevtools();
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        refetchOnMount: false,
      }),
    );
    await settle();

    const fixture = TestBed.createComponent(DevtoolsPanel);
    TestBed.inject(QueryDevtools).open();
    fixture.detectChanges();

    const details = (
      [...fixture.nativeElement.querySelectorAll('tbody button')] as HTMLButtonElement[]
    ).find((button) => button.textContent.trim() === 'details')!;
    details.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('tr.details')?.textContent).toContain('no value');

    handle.destroy();
  });

  it('renders retry history in the details row', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { http, create } = setupDevtools();
    const handle = create(() =>
      createRequest<Row[]>(() => ({ url: '/rows' }), {
        key: () => ['rows'],
        retry: { count: 1, delay: 100 },
      }),
    );
    await settle();
    http.expectOne('/rows').flush({}, { status: 503, statusText: 'Unavailable' });
    await settle();

    const fixture = TestBed.createComponent(DevtoolsPanel);
    TestBed.inject(QueryDevtools).open();
    fixture.detectChanges();
    ([...fixture.nativeElement.querySelectorAll('tbody button')] as HTMLButtonElement[])
      .find((button) => button.textContent.trim() === 'details')!
      .click();
    fixture.detectChanges();

    const details = fixture.nativeElement.querySelector('tr.details') as HTMLElement;
    expect(details.textContent).toContain('retries');
    expect(details.textContent).toContain('attempt 1');

    handle.destroy();
    cache().remove(['rows']);
    vi.useRealTimers();
  });

  it('keeps the history cap at ten attempts and ten retries', () => {
    const history = new DevtoolsHistory();
    const entry = new CacheEntry(
      normalizeKey(['cap']),
      null as never,
      undefined,
      true,
      undefined,
      undefined,
      ALWAYS_ONLINE,
      history,
    );

    for (let attempt = 1; attempt <= 11; attempt++) {
      history.recordAttempt(entry, { startedAt: attempt, durationMs: 1, outcome: 'success' });
      history.recordRetry(entry, { at: attempt, attempt });
    }

    expect(history.attempts(entry)).toHaveLength(10);
    expect(history.retries(entry)).toHaveLength(10);
    // Oldest first, so the dropped row is attempt 1 and the newest is 11.
    expect(history.attempts(entry)[0]?.startedAt).toBe(2);
    expect(history.retries(entry).at(-1)?.attempt).toBe(11);
  });

  it('does not retain an entry after it leaves the cache', async () => {
    const history = new DevtoolsHistory();
    let entry: CacheEntry | undefined = new CacheEntry(
      normalizeKey(['gc']),
      null as never,
      undefined,
      true,
      undefined,
      undefined,
      ALWAYS_ONLINE,
      history,
    );
    history.recordAttempt(entry, { startedAt: 1, durationMs: 1, outcome: 'success' });
    expect(history.attempts(entry)).toHaveLength(1);

    const ref = new WeakRef(entry);
    entry = undefined;
    expect(entry).toBeUndefined();
    // A WeakRef target is kept alive until the end of the current job, so collect between turns.
    for (let round = 0; round < 2; round++) {
      forceGc();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(ref.deref()).toBeUndefined();
  });
});
