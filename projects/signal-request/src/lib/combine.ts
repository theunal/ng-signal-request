import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { Combinable, Combined, RequestSet, RequestStatus, ResponsesOf } from './types';

/** A function whose `name` is shown by Angular in "must be called in an injection context" errors. */
function named(name: string): () => void {
  const fn = (): void => {};
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/**
 * The parts of an aggregate that do not depend on its shape.
 *
 * `combine` returns either an array or a record, so only the `response` differs between the two.
 * Everything else — "is any of these loading", "what failed first", "reload all of them" — is the
 * same question whatever the container is, so it is answered once here.
 *
 * `get` rather than a value because `createRequests` aggregates a list that changes: the sources
 * have to be re-read inside each computed, not captured.
 */
function aggregate<T>(get: () => readonly Combinable<T>[]): {
  loading: Signal<boolean>;
  status: Signal<RequestStatus>;
  error: Signal<Error | undefined>;
  reload: () => boolean;
  cancel: () => void;
} {
  const loading = computed(() => get().some((source) => source.loading()));

  const error = computed<Error | undefined>(() => {
    for (const source of get()) {
      const failure = source.error();
      if (failure !== undefined) return failure;
    }
    return undefined;
  });

  const status = computed<RequestStatus>(() => {
    if (error() !== undefined) return 'error';
    const sources = get();
    if (loading()) {
      // `'reloading'` only when nothing is *missing*: every source has something to show, so the
      // screen is complete and merely refreshing. One source still empty means the screen is not
      // ready, however much of it happens to be filled in.
      return sources.every((source) => source.response() !== undefined) ? 'reloading' : 'loading';
    }
    return sources.some((source) => source.response() !== undefined) ? 'resolved' : 'idle';
  });

  return {
    loading,
    status,
    error,
    reload: (): boolean => {
      let any = false;
      // Every source is asked, without short-circuiting: `some()` would stop at the first `true`
      // and leave the rest of the screen stale.
      for (const source of get()) any = source.reload() || any;
      return any;
    },
    cancel: (): void => {
      for (const source of get()) source.cancel();
    },
  };
}

/**
 * Combines several handles into one aggregate.
 *
 * ```ts
 * const user  = createRequest<User>('/me');
 * const posts = createRequest<Post[], { userId: string }>(…);
 *
 * readonly view = combine({ user, posts });
 * view.response();  // { user: User | undefined; posts: Post[] | undefined }
 * view.loading();   // any of them
 * view.error();     // the first failure
 * view.reload();    // both
 * ```
 *
 * An array is combined positionally:
 *
 * ```ts
 * const rows = combine(ids.map((id) => rowFor(id)));   // readonly (Row | undefined)[]
 * ```
 *
 * This is a one-line `computed` in the trivial case and stops being one as soon as you want the
 * aggregate's `loading` / `error` / `status`, which every caller would otherwise write by hand and
 * get subtly wrong — `some()` short-circuiting, an `error` that reports a stale failure, a
 * `reload` that stops after the first source.
 *
 * Ownership is the caller's: the handles' own injectors destroy them. Use `createRequests` when
 * you do not want to hold them individually.
 */
export function combine<T>(sources: readonly Combinable<T>[]): Combined<readonly (T | undefined)[]>;
export function combine<TSources extends Record<string, Combinable<unknown>>>(
  sources: TSources,
): Combined<ResponsesOf<TSources>>;
export function combine(sources: unknown): Combined<unknown> {
  const asRecord = !Array.isArray(sources);
  const entries = asRecord
    ? Object.entries(sources as Record<string, Combinable<unknown>>)
    : undefined;
  const list: readonly Combinable<unknown>[] = entries
    ? entries.map(([, source]) => source)
    : (sources as readonly Combinable<unknown>[]);

  const response = computed<unknown>(() =>
    entries
      ? Object.fromEntries(entries.map(([name, source]) => [name, source.response()]))
      : list.map((source) => source.response()),
  );

  return { response, ...aggregate(() => list) };
}

/**
 * One handle per item of a list that grows and shrinks — the `useQueries` of this library.
 *
 * ```ts
 * readonly rows = createRequests(
 *   () => this.selectedIds(),
 *   (id) => createRequest<Row[]>((params) => ({ url: `/rows/${id}`, params }), { key: () => ['rows', id] }),
 * );
 *
 * rows.response();  // readonly (Row[] | undefined)[], in item order
 * rows.handles();   // the per-item handles
 * rows.loading();   // any of them
 * ```
 *
 * ## Why it is not just `combine(items().map(build))`
 *
 * Because handles would then be created and destroyed on every change — every keystroke that
 * changes the id list would tear down and re-subscribe every entry, and a keyed entry would be
 * dropped to zero observers and immediately rejoined. Here a handle is built once per item
 * **identity** and reused, so adding one id to a list of twenty touches one handle, not twenty.
 *
 * Identity is `Object.is` on the item, which is right for the usual case of a list of ids. Pass
 * `key` when the items are objects, because two structurally equal objects are two identities.
 *
 * Items are read reactively; each handle is built inside the injection context `createRequests` was
 * called from, so `createRequest` inside `build` behaves exactly as it would inline.
 */
export function createRequests<T, TItem>(
  items: () => readonly TItem[],
  build: (item: TItem) => Combinable<T>,
  options?: { injector?: Injector; key?: (item: TItem) => unknown },
): RequestSet<T> {
  const caller = named('createRequests');
  const explicit = options?.injector;
  let injector = explicit;
  if (!injector) {
    assertInInjectionContext(caller);
    injector = inject(Injector);
  }
  return runInInjectionContext(injector, () =>
    buildRequestSet(items, build, injector, options?.key),
  );
}

function buildRequestSet<T, TItem>(
  items: () => readonly TItem[],
  build: (item: TItem) => Combinable<T>,
  injector: Injector,
  key: ((item: TItem) => unknown) | undefined,
): RequestSet<T> {
  const destroyRef = inject(DestroyRef);

  /** Handles by item identity, so a list change reuses instead of rebuilding. */
  const owned = new Map<unknown, Combinable<T>>();
  const handles = signal<readonly Combinable<T>[]>([]);
  let destroyed = false;

  const identityOf = (item: TItem): unknown => (key ? key(item) : item);

  effect(() => {
    const current = items();
    untracked(() => {
      if (destroyed) return;

      const next: Combinable<T>[] = [];
      const live = new Set<unknown>();
      for (const item of current) {
        const id = identityOf(item);
        live.add(id);
        let handle = owned.get(id);
        if (handle === undefined) {
          // Built here, inside the caller's injection context, even though this runs long after
          // `createRequests` returned — the effect is a different context otherwise.
          handle = runInInjectionContext(injector, () => build(item));
          owned.set(id, handle);
        }
        next.push(handle);
      }

      // Items that left the list release their handle. Without this a shrinking list would keep
      // every entry it had ever shown alive for the life of the injector.
      for (const [id, handle] of [...owned]) {
        if (live.has(id)) continue;
        owned.delete(id);
        handle.destroy();
      }

      handles.set(next);
    });
  });

  destroyRef.onDestroy(() => {
    destroyed = true;
    for (const handle of owned.values()) handle.destroy();
    owned.clear();
  });

  const response = computed<readonly (T | undefined)[]>(() =>
    handles().map((handle) => handle.response()),
  );

  return {
    handles: handles.asReadonly(),
    response,
    ...aggregate<T>(() => handles()),
    destroy: (): void => {
      if (destroyed) return;
      destroyed = true;
      for (const handle of owned.values()) handle.destroy();
      owned.clear();
      handles.set([]);
    },
  };
}
