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
import {
  QueryCache,
  QueryClient,
  RESTORE_GATE,
  formatKey,
  type CacheEntry,
  type FetchAttempt,
  type QueryKeyFilter,
  type RetryEvent,
} from 'ng-signal-request';
import { OnlineManager } from 'ng-signal-request';

/** How much of a value the expanded row shows before the preview is cut. */
const PREVIEW_LIMIT = 200;

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
  /**
   * Whether this entry is waiting for a connection.
   *
   * Its own column rather than a {@link DevtoolsStatus}: `paused` is orthogonal to the set of states
   * the panel colours by — a paused entry with data is still `ready`, it is just not going to refresh
   * until the connection comes back.
   */
  readonly paused: boolean;
  /** Which factory registered the stored plan, or `undefined` before the first registration. */
  readonly kind: 'http' | 'query' | undefined;
  /** Whether the current value came from a seed / transfer rather than a fetch or local write. */
  readonly seeded: boolean;
  /** One entry per subscribed handle: its `debugName`, or `'anonymous'`. */
  readonly observerNames: readonly string[];
  /** The last settled fetches, newest first. */
  readonly attempts: readonly FetchAttempt[];
  /** The last scheduled retries, newest first. */
  readonly retries: readonly RetryEvent[];
  /**
   * The current value, by reference. The panel turns this into a preview only when the row is
   * expanded; carrying the reference is free, stringifying it is not.
   */
  readonly data: unknown;
  /** A size-capped rendering of {@link data}, only when {@link SnapshotOptions.preview} is set. */
  readonly preview: string | undefined;
  /** JSON character count of {@link data}, or `undefined` when it cannot be serialized. */
  readonly size: number | undefined;
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
  /**
   * Serialize each value into a size-capped preview. Off by default: a large payload should not be
   * stringified just because a panel is closed, and the panel asks for this only while it is open.
   */
  readonly preview?: boolean;
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
  return entries.map((entry) => describe(entry, now, options.preview === true));
}

function describe(entry: CacheEntry, now: number, withPreview: boolean): DevtoolsEntry {
  const error = entry.error();
  const data = entry.data();
  const local = entry.local();
  const invalidated = entry.invalidated();
  const dataUpdatedAt = entry.dataUpdatedAt();
  const updatedAt = entry.updatedAt();
  // Prefer the moment the data landed; fall back to when the attempt started, so a first load that
  // is still in flight is not reported as infinitely old.
  const since = dataUpdatedAt === 0 ? updatedAt : dataUpdatedAt;
  const preview = withPreview ? previewOf(data) : undefined;

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
    paused: entry.paused(),
    kind: entry.planKind,
    seeded: entry.seeded,
    observerNames: entry.observerNames,
    // Newest first is what a panel reads: the last attempt is the interesting one. The entry keeps
    // the history oldest-first so the cap can drop from the front without moving the array.
    attempts: [...entry.fetchHistory].reverse(),
    retries: [...entry.retryHistory].reverse(),
    data,
    preview: preview?.text,
    size: preview?.size,
  };
}

/**
 * A preview that never throws and never grows without a bound.
 *
 * `JSON.stringify` is the cost this function exists to defer. A circular payload, or one with a
 * getter that throws, is a normal thing to find in a cache, so both become a label rather than an
 * exception escaping a debugging tool.
 */
function previewOf(
  value: unknown,
): { readonly text: string; readonly size: number | undefined } | undefined {
  if (value === undefined) return undefined;

  let text: string;
  try {
    // `JSON.stringify` types its result as `string`, but returns `undefined` for a function or a
    // symbol at runtime. Keep the cast honest instead of calling `String()` on an object.
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) return { text: '[unserializable]', size: undefined };
    text = json;
  } catch {
    return { text: '[unserializable]', size: undefined };
  }

  return {
    text: text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text,
    size: text.length,
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
  private readonly client = inject(QueryClient);
  private readonly injector = inject(Injector);

  /**
   * Whether persistence is still restoring.
   *
   * Read through `RESTORE_GATE`, the same seam the core uses to hold a fetch, so the marker cannot
   * disagree with the ordering it is describing.
   */
  readonly isRestoring: Signal<boolean> = inject(RESTORE_GATE).isRestoring;

  /**
   * The library's view of connectivity.
   *
   * Read through the same `OnlineManager` every request uses, so the panel cannot disagree with the
   * library about whether a request would be started — the whole point of routing them both through
   * one source. Present on the server too, where it is always `true`.
   */
  readonly online: Signal<boolean> = inject(OnlineManager).online;

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
    // Serialization is the one cost that scales with the payload, so it is paid only while somebody
    // is looking at the table. Reading `isOpen` also makes opening the panel recompute the snapshot.
    return snapshotEntries(this.cache, { preview: this.isOpen() });
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

  /**
   * Marks the entry's key — and its children, like `QueryClient.invalidate` — stale and refetches
   * the entries that are currently watched. Returns how many entries matched.
   */
  invalidate(entry: DevtoolsEntry): number {
    return this.client.invalidate(entry.key);
  }

  /** Refetches the entry's key and children without marking them stale. */
  refetch(entry: DevtoolsEntry): number {
    return this.client.refetch(entry.key);
  }

  /** Aborts whatever is in flight for the entry's key and children. */
  cancel(entry: DevtoolsEntry): number {
    return this.client.cancel(entry.key);
  }

  /**
   * Marks **this row's entry** stale without touching its children and without sending a request.
   * The next observer that mounts will fetch it.
   */
  markStale(entry: DevtoolsEntry): void {
    this.cache.peek(entry.key)?.markInvalidated();
  }

  /**
   * Removes **this row's entry**, not every entry under its prefix.
   *
   * Returns whether the entry was still there when the click landed, which is the honest answer for
   * a row that may already have been collected.
   */
  remove(entry: DevtoolsEntry): boolean {
    return this.cache.removeExact(entry.key);
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
        @if (!devtools.online()) {
          <span class="offline" title="the browser reports no connection">(offline)</span>
        }
        @if (devtools.isRestoring()) {
          <span class="restoring" title="a persisted snapshot is still being restored"
            >(restoring)</span
          >
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
              <th scope="col">actions</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of devtools.entries(); track entry.hash) {
              <tr
                [class.error]="entry.status === 'error'"
                [class.loading]="entry.status === 'loading'"
              >
                <td [title]="entry.name ?? ''">{{ entry.label }}</td>
                <td>
                  {{ entry.status }}
                  @if (entry.paused) {
                    <span class="paused" title="waiting for a connection">paused</span>
                  }
                </td>
                <td>{{ entry.observers }}</td>
                <td>{{ entry.fetchCount }}</td>
                <td>{{ formatAge(entry.ageMs) }}</td>
                <td class="actions">
                  <button
                    type="button"
                    (click)="toggleDetails(entry.hash)"
                    [attr.aria-expanded]="isExpanded(entry.hash)"
                  >
                    {{ isExpanded(entry.hash) ? 'hide' : 'details' }}
                  </button>
                  <button type="button" (click)="devtools.invalidate(entry)">invalidate</button>
                  <button
                    type="button"
                    (click)="devtools.refetch(entry)"
                    [disabled]="!entry.hasPlan"
                  >
                    refetch
                  </button>
                  <button
                    type="button"
                    (click)="devtools.cancel(entry)"
                    [disabled]="entry.status !== 'loading'"
                  >
                    cancel
                  </button>
                  <button type="button" (click)="devtools.markStale(entry)">stale</button>
                  <button type="button" (click)="devtools.remove(entry)">remove</button>
                </td>
              </tr>
              @if (isExpanded(entry.hash)) {
                <tr class="details">
                  <td colspan="6">
                    <div class="meta">
                      plan {{ entry.kind ?? '—' }} · seeded {{ entry.seeded ? 'yes' : 'no' }} ·
                      observers
                      {{ entry.observerNames.length > 0 ? entry.observerNames.join(', ') : 'none' }}
                    </div>
                    @if (entry.preview !== undefined) {
                      <pre class="preview">{{ entry.preview }}</pre>
                      @if (entry.size !== undefined) {
                        <div class="size">{{ entry.size }} chars</div>
                      }
                    } @else {
                      <div class="muted">no value</div>
                    }
                    @if (entry.attempts.length > 0) {
                      <div class="history">
                        <strong>attempts</strong>
                        <ol>
                          @for (attempt of entry.attempts; track $index) {
                            <li>
                              {{ formatTime(attempt.startedAt) }} · {{ attempt.durationMs }}ms ·
                              {{ attempt.outcome }}
                            </li>
                          }
                        </ol>
                      </div>
                    }
                    @if (entry.retries.length > 0) {
                      <div class="history">
                        <strong>retries</strong>
                        <ol>
                          @for (retry of entry.retries; track $index) {
                            <li>attempt {{ retry.attempt }} · {{ formatTime(retry.at) }}</li>
                          }
                        </ol>
                      </div>
                    }
                  </td>
                </tr>
              }
            } @empty {
              <tr>
                <td colspan="6">no cached queries</td>
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
      font:
        12px/1.4 ui-monospace,
        monospace;
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
    .ngsr-devtools .offline {
      color: #b00020;
    }
    .ngsr-devtools .restoring {
      margin-left: 0.35rem;
      color: #0b5fa5;
    }
    .ngsr-devtools .paused {
      margin-left: 0.35rem;
      color: #0b5fa5;
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
    .ngsr-devtools .actions button {
      margin-right: 0.2rem;
      font: inherit;
    }
    .ngsr-devtools tr.details td {
      white-space: normal;
      background: #fafafa;
    }
    .ngsr-devtools .meta,
    .ngsr-devtools .size,
    .ngsr-devtools .muted {
      color: #555;
    }
    .ngsr-devtools .preview {
      margin: 0.25rem 0 0;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .ngsr-devtools .history {
      margin-top: 0.35rem;
    }
    .ngsr-devtools .history ol {
      margin: 0.1rem 0 0;
      padding-left: 1.4rem;
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

  /** Which rows are showing their details. A local UI concern, so it stays out of the service. */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set<string>());

  protected isExpanded(hash: string): boolean {
    return this.expanded().has(hash);
  }

  protected toggleDetails(hash: string): void {
    this.expanded.update((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

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

  /** A wall-clock time without a locale-dependent date, so the panel reads the same everywhere. */
  protected formatTime(at: number): string {
    const date = new Date(at);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}
