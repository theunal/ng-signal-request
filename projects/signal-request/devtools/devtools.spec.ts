import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { inject } from '@angular/core';
import { createRequest, provideSignalRequest, QueryClient } from 'ng-signal-request';
import {
  DevtoolsPanel,
  QueryDevtools,
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

describe('snapshotEntries() — the snapshot', () => {
  it('describes an entry that has not fetched yet', async () => {
    const { create } = setup();
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
    const { http, create } = setup();
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
    const { http, create } = setup();
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
    const { http, create } = setup();
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
    const { create } = setup();
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
    const { create } = setup();
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
    const { create } = setup();
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
    const { http, create } = setup();
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
    const { create } = setup();
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
    const { create } = setup();
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
    const { http, create } = setup();
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

describe('DevtoolsPanel — the table', () => {
  function mount(): ComponentFixture<DevtoolsPanel> {
    setup();
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
    const { create } = setup();
    const handle = keyed<Row[]>(create, ['rows']);
    await settle();
    // Pin the clock so the age column has one right answer rather than a race with the test runner.
    advanceClock(4000);

    const fixture = TestBed.createComponent(DevtoolsPanel);
    TestBed.inject(QueryDevtools).open();
    fixture.detectChanges();

    const cells = [...fixture.nativeElement.querySelectorAll('tbody td')].map((cell: Element) =>
      cell.textContent?.trim(),
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
    const { create } = setup([provideSignalRequest({ maxEntries: 1 })]);
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
    setup([provideSignalRequest({ maxEntries: 2 })]);
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
