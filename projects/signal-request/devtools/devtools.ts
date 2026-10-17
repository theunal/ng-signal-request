/**
 * `ng-signal-request/devtools` — a separate entry point on purpose.
 *
 * Nothing in the primary entry point imports this file, and `sideEffects: false` plus the separate
 * bundle mean an application that never writes `import … from 'ng-signal-request/devtools'` ships
 * none of it. There is no "am I in production?" branch to get wrong: the code is not reachable.
 *
 * The panel is the reason it is a separate entry point and not an option. A devtools that costs
 * every consumer a bundle even when it is off is not a devtools, it is a tax.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { QueryCache, formatKey, type CacheEntry, type QueryKeyFilter } from 'ng-signal-request';

/**
 * What the panel shows for one entry.
 *
 * A plain record with no signals and no `CacheEntry` reference, so it is safe to `console.log`, to
 * hand to a template, and to assert on in a test.
 */
export interface DevtoolsEntry {
  /** Map key of the entry — `CacheEntry.hash`. */
  readonly hash: string;
  /** The caller's original key array. */
  readonly key: readonly unknown[];
  /** `key` rendered the same way the cache renders it, for a readable table column. */
  readonly label: string;
  /** The `debugName` of whichever handle created the entry. */
  readonly name: string | undefined;
  /** Coarse state, for colouring a row. See {@link DevtoolsStatus}. */
  readonly status: DevtoolsStatus;
  /** How many handles are subscribed. */
  readonly observers: number;
  /** How many times this entry has hit the network. */
  readonly fetchCount: number;
  /** 0 unless a retry is scheduled. */
  readonly retryAttempt: number;
  /**
   * ms since the data was last updated — or since the last attempt began, when there has never been
   * a successful one. `0` when neither has happened yet.
   *
   * This is the column that answers "is what I am looking at old?", so it tracks the data rather
   * than the last attempt: a failed refetch does not make good data look fresh.
   */
  readonly ageMs: number;
  /** Epoch ms of the last successful fetch, or `0`. */
  readonly dataUpdatedAt: number;
  /** Epoch ms when the last attempt **began**, or `0`. Set even if that attempt never settles. */
  readonly updatedAt: number;
  /** Set by an invalidation, cleared by the next successful fetch. */
  readonly invalidated: boolean;
  /** `true` while the value came from `set` / `update` rather than a fetch. */
  readonly local: boolean;
  /** Whether a fetch could even be started for this entry — see `CacheEntry.hasPlan`. */
  readonly hasPlan: boolean;
  /** Status code of the last fetch, if there was one. */
  readonly statusCode: number | undefined;
  /** `error().message`, if the last attempt failed. */
  readonly error: string | undefined;
}

/**
 * A coarse, display-only state.
 *
 * `'ready'` means "has data and nothing has invalidated it" — **not** "fresh". Real freshness also
 * depends on the `staleTime` of whichever handle is asking, which is a per-handle decision the
 * entry deliberately does not know about, so a panel that claimed to judge it would be guessing.
 */
export type DevtoolsStatus = 'empty' | 'loading' | 'error' | 'local' | 'ready' | 'invalidated';

/** Options for {@link snapshotEntries}. */
export interface SnapshotOptions {
  /** Restrict the snapshot, with the same filter `QueryClient.invalidate` takes. */
  readonly filter?: QueryKeyFilter;
  /**
   * The clock to measure `ageMs` against. Defaults to `Date.now()`; a test passes a fixed number
   * rather than mocking the clock.
   */
  readonly now?: number;
}

/**
 * Builds a display snapshot of the cache.
 *
 * Every entry signal is read, so calling this inside a `computed` makes the snapshot live. It is
 * a free function as well as the body of `QueryDevtools.entries()` so it can be tested — and used —
 * without the injectable.
 */
export function snapshotEntries(
  cache: QueryCache,
  options: SnapshotOptions = {},
): readonly DevtoolsEntry[] {
  const now = options.now ?? Date.now();
  const entries = options.filter === undefined ? cache.all() : cache.matching(options.filter);
  return entries.map((entry) => describe(entry, now));
}

function describe(entry: CacheEntry<unknown>, now: number): DevtoolsEntry {
  const error = entry.error();
  const data = entry.data();
  const local = entry.local();
  const invalidated = entry.invalidated();
  const dataUpdatedAt = entry.dataUpdatedAt();
  const updatedAt = entry.updatedAt();
  // Prefer the moment the data landed; fall back to when the attempt started, so a first load that
  // is still in flight is not reported as infinitely old.
  const since = dataUpdatedAt === 0 ? updatedAt : dataUpdatedAt;

  const status: DevtoolsStatus = error
    ? 'error'
    : entry.isFetching()
      ? 'loading'
      : local
        ? 'local'
        : invalidated
          ? 'invalidated'
          : data === undefined
            ? 'empty'
            : 'ready';

  return {
    hash: entry.hash,
    key: entry.raw,
    label: formatKey(entry.segments),
    name: entry.debugName,
    status,
    // `observerCount` and `hasPlan` are plain getters rather than signals, because subscription
    // bookkeeping is not something a template should be able to depend on. The consequence is a
    // column that can lag by one change-detection pass; everything else here is exact.
    observers: entry.observerCount,
    fetchCount: entry.fetchCount(),
    retryAttempt: entry.retryAttempt(),
    ageMs: since === 0 ? 0 : now - since,
    dataUpdatedAt,
    updatedAt,
    invalidated,
    local,
    hasPlan: entry.hasPlan,
    statusCode: entry.statusCode(),
    error: error?.message,
  };
}

/**
 * A live view of the cache, for debugging.
 *
 * ```ts
 * const devtools = inject(QueryDevtools);
 * devtools.toggle();
 * effect(() => console.table(devtools.entries()));
 * ```
 *
 * `entries()` is a `computed`, so it is only recomputed when something it reads actually changed —
 * the cache telling the service that an entry appeared or was collected, or any entry's own state
 * signals moving. There is no polling and no interval to forget to clear.
 *
 * `providedIn: 'root'`, so reaching for it is the whole setup. An application that never injects it
 * never constructs it.
 */
@Injectable({ providedIn: 'root' })
export class QueryDevtools {
  private readonly cache = inject(QueryCache);
  private readonly injector = inject(Injector);

  /** Bumped when the *set* of entries changes, which no entry signal can report. */
  private readonly version = signal(0);

  /** Whether a panel bound to this service should be showing. */
  readonly isOpen: WritableSignal<boolean> = signal(false);

  /** Set while a bump is queued, so a burst of changes costs one microtask rather than one each. */
  private bumpScheduled = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    const unsubscribe = this.cache.subscribeChanges(() => this.scheduleBump());
    destroyRef.onDestroy(unsubscribe);
  }

  /**
   * Queues a bump instead of writing `version` on the spot.
   *
   * The write *cannot* happen in the listener. `QueryCache.resolve` calls `notify()` synchronously
   * while a keyed handle is building its entry, and that builds from inside a `computed` — the
   * handle's key node. Writing a signal there is `NG0600: Writing to signals is not allowed in a
   * computed`, and it is not a corner case: it is what happens on the first keyed request of any
   * application that injects `QueryDevtools`. Deferring to a microtask puts the write outside any
   * evaluation, and the coalescing flag means a burst of entries costs one bump, not one each.
   *
   * The cost is that `entries()` can be one microtask behind for a moment. Nothing else in this
   * class polls, so a panel is at most one tick stale, which is the same thing every other signal
   * in the application is.
   */
  private scheduleBump(): void {
    if (this.bumpScheduled) return;
    this.bumpScheduled = true;
    queueMicrotask(() => {
      this.bumpScheduled = false;
      this.version.update((n) => n + 1);
    });
  }

  /** A live snapshot of every entry, in insertion order. */
  readonly entries: Signal<readonly DevtoolsEntry[]> = computed(() => {
    // Read first so a new or collected entry re-runs this; the snapshot itself then reads each
    // entry's signals, which is what makes state changes flow through without polling.
    this.version();
    return snapshotEntries(this.cache);
  });

  /** Total number of cached entries. */
  readonly count: Signal<number> = computed(() => this.entries().length);

  /**
   * The cache's effective cap, or `Infinity` when nothing configured one.
   *
   * A plain getter rather than a signal: a cap only changes when a keyed request is constructed, and
   * a panel re-reads it on every change-detection pass anyway.
   */
  get cap(): number {
    return this.cache.maxEntries;
  }

  /**
   * Values staged by persistence, waiting for their key to be asked for.
   *
   * They count toward the cap but have no entry to show, so the table cannot list them — this is
   * what keeps the "cache N / cap" label from quietly under-reporting when a snapshot has just been
   * restored. A plain getter for the same reason `cap` is one.
   */
  get staged(): number {
    return this.cache.pendingSeeds;
  }

  /** How far over its cap the cache is, or `0`. Staged values count, because the cap counts them. */
  get overCap(): number {
    return Math.max(0, this.count() + this.staged - this.cap);
  }

  /** Entries currently on the network. */
  readonly fetching: Signal<number> = computed(
    () => this.entries().filter((entry) => entry.status === 'loading').length,
  );

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    this.isOpen.update((open) => !open);
  }

  /** Prints the current snapshot as a table. One shot; nothing is subscribed. */
  log(): void {
    console.table(this.entries());
  }

  /**
   * Logs one line per cache change until the returned function is called.
   *
   * An `effect` rather than `subscribeChanges`: an entry updating its data does not change the set
   * of entries, so a subscription alone would miss every interesting event. Reading `entries()`
   * inside the effect is what makes the data changes visible.
   *
   * ```ts
   * const stop = inject(QueryDevtools).logChanges();
   * // later
   * stop();
   * ```
   */
  logChanges(): () => void {
    let previous: ReadonlyMap<string, DevtoolsEntry> = new Map();

    const ref = runInInjectionContext(this.injector, () =>
      effect(() => {
        const current = this.entries();
        const next = new Map(current.map((entry) => [entry.hash, entry]));

        for (const [hash, entry] of next) {
          const before = previous.get(hash);
          if (before === undefined) {
            console.log(`[ngsr] + ${entry.label}`);
          } else if (before.fetchCount !== entry.fetchCount) {
            const verdict = entry.status === 'error' ? ` failed: ${entry.error}` : '';
            console.log(`[ngsr] ~ ${entry.label} (fetch #${entry.fetchCount})${verdict}`);
          } else if (before.status !== entry.status) {
            console.log(`[ngsr] ~ ${entry.label} (${before.status} → ${entry.status})`);
          }
        }
        for (const [hash, entry] of previous) {
          if (!next.has(hash)) console.log(`[ngsr] - ${entry.label}`);
        }

        previous = next;
      }),
    );

    return () => ref.destroy();
  }
}

/**
 * A minimal table view of the cache, for the bottom of a dev screen.
 *
 * ```html
 * <ngsr-devtools />
 * ```
 *
 * Deliberately dependency-free and unstyled beyond the essentials: it is a debugging aid, and one
 * that fights an application's CSS is one nobody leaves switched on.
 */
@Component({
  selector: 'ngsr-devtools',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ngsr-devtools">
      <button type="button" (click)="devtools.toggle()">
        cache {{ devtools.count() }}{{ stagedLabel() }}{{ capLabel() }}
        @if (devtools.fetching(); as running) {
          <span class="busy">({{ running }} loading)</span>
        }
        @if (devtools.overCap > 0) {
          <span class="over-cap" title="every dropable entry is in use">(over cap)</span>
        }
      </button>

      @if (devtools.isOpen()) {
        <table>
          <thead>
            <tr>
              <th scope="col">key</th>
              <th scope="col">status</th>
              <th scope="col">obs</th>
              <th scope="col">fetches</th>
              <th scope="col">age</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of devtools.entries(); track entry.hash) {
              <tr [class.error]="entry.status === 'error'" [class.loading]="entry.status === 'loading'">
                <td [title]="entry.name ?? ''">{{ entry.label }}</td>
                <td>{{ entry.status }}</td>
                <td>{{ entry.observers }}</td>
                <td>{{ entry.fetchCount }}</td>
                <td>{{ formatAge(entry.ageMs) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5">no cached queries</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: `
    .ngsr-devtools {
      position: fixed;
      right: 0.5rem;
      bottom: 0.5rem;
      z-index: 9999;
      font: 12px/1.4 ui-monospace, monospace;
      background: #fff;
      color: #111;
      border: 1px solid #bbb;
      border-radius: 4px;
      max-width: 40rem;
      max-height: 50vh;
      overflow: auto;
    }
    .ngsr-devtools .busy {
      color: #b26a00;
    }
    .ngsr-devtools .over-cap {
      color: #b00020;
    }
    .ngsr-devtools table {
      border-collapse: collapse;
      width: 100%;
    }
    .ngsr-devtools th,
    .ngsr-devtools td {
      text-align: left;
      padding: 0.15rem 0.5rem;
      border-top: 1px solid #eee;
      white-space: nowrap;
    }
    .ngsr-devtools tr.loading td {
      color: #b26a00;
    }
    .ngsr-devtools tr.error td {
      color: #b00020;
    }
  `,
})
export class DevtoolsPanel {
  protected readonly devtools = inject(QueryDevtools);

  /** `" / 500"`, or nothing when the cache is unbounded. Templates have no `Infinity`. */
  protected capLabel(): string {
    const cap = this.devtools.cap;
    return Number.isFinite(cap) ? ` / ${cap}` : '';
  }

  /** `" + 12 staged"`, or nothing when no persisted value is waiting for its key. */
  protected stagedLabel(): string {
    const staged = this.devtools.staged;
    return staged > 0 ? ` + ${staged} staged` : '';
  }

  /** ms as something a human can scan. */
  protected formatAge(ms: number): string {
    if (ms === 0) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
  }
}
