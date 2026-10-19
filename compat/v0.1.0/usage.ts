/**
 * The 0.1.0 type-compatibility fixture.
 *
 * This file is written against the **0.1.0 public API only**, the way the 0.1.0 README showed it:
 * the four entry points, the documented options, and the annotations a caller would have written by
 * hand. `pnpm check:types-compat` compiles it against the **built** declarations in
 * `dist/signal-request`, in strict mode, and `pnpm verify` runs that check.
 *
 * It is not documentation. It is the claim "code written against 0.1.0 still compiles", and it
 * fails the build when the claim stops being true.
 *
 * ## The two outcomes for a 0.1.0 spelling that stops compiling
 *
 * 1. It is **restored**, and the fixture uses it plainly.
 * 2. It is an **accepted break**. Then it is written here behind a `// @ts-expect-error` whose
 *    comment says why and which change owns it. The directive is deliberately load-bearing: if a
 *    later change makes the line compile again, the directive becomes *unused* and the check fails.
 *    That is the prompt to delete the directive and the accepted break together.
 *
 * See `docs/design-0.2.md`, "Step A", for each decision.
 *
 * Nothing here is executed. It is compiled, which is the whole point.
 */

/* -------------------------------------------------------------------------- */
/*  ng-signal-request (core)                                                   */
/* -------------------------------------------------------------------------- */

import {
  combine,
  createInfiniteRequest,
  createMutation,
  createRequest,
  createRequests,
  defaultStructuralSharing,
  formatKey,
  matchesFilter,
  MutationRegistry,
  normalizeKey,
  provideSignalRequest,
  QueryCache,
  QueryClient,
  RequestCancelledError,
  requestErrorOf,
  resolveStructuralSharing,
  SIGNAL_REQUEST_CONFIG,
  startsWith,
  toError,
  toRequestError,
} from 'ng-signal-request';
import type {
  CacheChangeListener,
  CacheEntry,
  CacheOptions,
  CachedRequest,
  CachedRequestOptions,
  Combinable,
  Combined,
  CreateInfiniteRequest,
  CreateInfiniteRequestFn,
  CreateMutation,
  CreateRequest,
  CreateRequestFn,
  FetchPlan,
  FlattenedPages,
  InfiniteRequest,
  InfiniteRequestOptions,
  InvalidationTarget,
  MutationOptions,
  MutationStatus,
  NormalizedKey,
  OptimisticTarget,
  ParamsOption,
  PathParams,
  QueryKey,
  QueryKeyFactory,
  QueryKeyFilter,
  QueryKeyPredicate,
  QueryParams,
  QueryPrimitive,
  QueryValue,
  RefetchOnMount,
  Reloadable,
  RequestBase,
  RequestConfig,
  RequestError,
  RequestErrorContext,
  RequestErrorKind,
  RequestErrorOf,
  RequestErrorView,
  RequestOptions,
  RequestSet,
  RequestSource,
  RequestStatus,
  RequestValue,
  ResponsesOf,
  RestoreGate,
  RetryConfig,
  RetryOptions,
  RunResult,
  SeedValue,
  SelectOptions,
  SettleOutcome,
  SignalMutation,
  SignalRequest,
  SignalRequestConfig,
  StructuralSharingFn,
  Updater,
} from 'ng-signal-request';
import { inject, type EnvironmentProviders, type Signal, type WritableSignal } from '@angular/core';

/** The payload the fixture uses everywhere, so a change to it is visible. */
interface Row {
  readonly id: number;
  readonly name: string;
}

/** `provideSignalRequest` takes a plain object or a factory, as 0.1.0 documented. */
export function globalConfig(): EnvironmentProviders[] {
  const plain: EnvironmentProviders = provideSignalRequest({
    baseUrl: 'https://api.example.com',
    retry: 2,
    staleTime: 30_000,
    gcTime: 60_000,
    headers: () => ({ Authorization: 'Bearer token' }),
    onError: (error, request) => {
      const kind: RequestErrorKind = toRequestError(error).kind;
      void kind;
      void request.url;
      void request.method;
    },
  });

  const factory: EnvironmentProviders = provideSignalRequest(() => {
    const configured: SignalRequestConfig = inject(SIGNAL_REQUEST_CONFIG);
    return { baseUrl: configured.baseUrl ?? 'https://api.example.com' };
  });

  const config: SignalRequestConfig = {
    baseUrl: 'https://api.example.com',
    retry: { count: 3, delay: 250 },
  };
  void config;
  return [plain, factory];
}

/** The uncached path: `createRequest` on top of `httpResource`. */
export function uncachedRequests(): void {
  const plain: SignalRequest<Row[]> = createRequest<Row[]>('/rows');
  void plain;

  const bare: CreateRequest = createRequest;
  const bound: CreateRequestFn = createRequest.get;
  void [bare, bound];

  const reactive = createRequest<Row[], { page: number }>(
    (p) => ({ url: '/rows', params: { page: p.page } }),
    {
      params: { page: 1 },
      initialValue: [],
      keepPreviousValue: true,
      lazy: true,
      debounce: 100,
      pollInterval: 1000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: { count: 2, delay: 100 },
      timeout: 5000,
      headers: { 'X-Test': '1' },
      parse: (raw) => raw as Row[],
      equal: (a, b) => a.length === b.length,
      onSuccess: (rows) => void rows.length,
      onError: (error) => void error.message,
      onSettled: () => void 0,
    },
  );

  const params: WritableSignal<{ page: number } | undefined> = reactive.params;
  params.set({ page: 2 });

  const selectOptions: SelectOptions<number> = { equal: (a, b) => a === b };
  const count: Signal<number | undefined> = reactive.select((rows) => rows.length, selectOptions);

  const status: RequestStatus = reactive.status();
  const loading: boolean = reactive.loading();
  const initialLoading: boolean = reactive.initialLoading();
  const success: boolean = reactive.success();
  const error: Error | undefined = reactive.error();
  const requestError: RequestErrorView | undefined = reactive.requestError();
  const attempt: number = reactive.retryAttempt();
  const response: Row[] | undefined = reactive.response();
  const retry: RetryConfig = 3;
  const retryOptions: RetryOptions = { count: 1, delay: 50 };
  void [status, loading, initialLoading, success, error, requestError, attempt, response, retry, retryOptions, count];

  const runResult: Promise<RunResult<Row[]>> = reactive.tryRun();
  const reload: boolean = reactive.reload();
  reactive.cancel();
  reactive.set([]);
  reactive.update((current) => current);
  void [runResult, reload];

  const verbs: CreateRequestFn[] = [
    createRequest.get,
    createRequest.post,
    createRequest.put,
    createRequest.patch,
    createRequest.delete,
  ];
  void verbs;

  const text: Signal<string | undefined> = createRequest.get.text<string>('/rows').response;
  const blob: Signal<Blob | undefined> = createRequest.get.blob('/rows').response;
  const buffer: Signal<ArrayBuffer | undefined> = createRequest.get.arrayBuffer('/rows').response;
  void [text, blob, buffer];
}

/** The cached path, which is where `key` and the cache types live. */
export function cachedRequests(): void {
  const options: CachedRequestOptions<Row[], { page: number }> = {
    key: () => ['rows', 'page'],
    params: { page: 1 },
    refetchOnMount: 'always' satisfies RefetchOnMount,
    staleTime: 1000,
    gcTime: 2000,
    maxEntries: 50,
    structuralSharing: resolveStructuralSharing<Row[]>(undefined, undefined),
  };
  const cacheOptions: CacheOptions<Row[]> = { key: () => ['rows'] };
  void [options, cacheOptions];

  const handle: CachedRequest<Row[], Row[] | undefined, { page: number }> = createRequest<
    Row[],
    { page: number }
  >(() => ({ url: '/rows' }), {
    key: () => ['rows', 1],
    params: { page: 1 },
  });

  const base: RequestBase<Row[], Row[] | undefined, { page: number }> = handle;
  const isStale: boolean = handle.isStale();
  const isFetching: boolean = handle.isFetching();
  const fetchCount: number = handle.fetchCount();
  const dataUpdatedAt: number = handle.dataUpdatedAt();
  const reloadable: Reloadable = handle;
  void [base, isStale, isFetching, fetchCount, dataUpdatedAt, reloadable];
  void handle.initialLoading();

  const keyFactory: QueryKeyFactory = () => ['rows'];
  const queryKey: QueryKey = keyFactory();
  void queryKey;
}

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export function mutations(): void {
  const bare: CreateMutation = createMutation;
  void bare;

  const options: MutationOptions<Row[], Row, { attemptedAt: number }> = {
    onMutate: (draft) => ({ attemptedAt: draft.id }),
    onSuccess: (response, args, context) => void [response.length, args.id, context?.attemptedAt],
    onError: (error, args, context) => void [error.message, args.id, context?.attemptedAt],
    onSettled: (args, context) => void [args.id, context?.attemptedAt],
    optimistic: (current, draft) => [...(current ?? []), draft],
    target: ['rows'],
    invalidates: () => [['rows']],
    mutationKey: ['rows'],
    concurrency: 'exhaust',
    responseType: 'json',
    retry: 2,
    timeout: 5000,
  };
  void options;

  const mutation: SignalMutation<Row[], Row, { attemptedAt: number }> = createMutation<
    Row[],
    Row,
    { attemptedAt: number }
  >((draft) => ({ url: '/rows', body: draft }), {
    onMutate: (draft) => ({ attemptedAt: draft.id }),
  });

  const status: MutationStatus = mutation.status();
  const loading: boolean = mutation.loading();
  const response: Row[] | undefined = mutation.response();
  const error: Error | undefined = mutation.error();
  const requestError: RequestErrorView | undefined = mutation.requestError();
  const args: Row | undefined = mutation.args();
  const context: { attemptedAt: number } | undefined = mutation.context();
  const progress = mutation.progress();
  void [status, loading, response, error, requestError, args, context, progress];

  const ran: Promise<Row[]> = mutation.run({ id: 1, name: 'Ada' });
  const tried: Promise<RunResult<Row[]>> = mutation.tryRun({ id: 1, name: 'Ada' });
  mutation.cancel();
  mutation.reset();
  mutation.destroy();
  void [ran, tried];

  const target: OptimisticTarget<Row[]> = {
    response: mutation.response,
    set: () => void 0,
  };
  const invalidation: InvalidationTarget = ['rows'];
  void [target, invalidation];

  const verbs: CreateMutation = createMutation;
  void [
    verbs.post,
    verbs.put,
    verbs.patch,
    verbs.delete,
    createMutation.post,
    createMutation.put,
    createMutation.patch,
    createMutation.delete,
  ];

  const upload: SignalMutation<string, { body: Blob }> = createMutation.post<string, { body: Blob }>(
    () => '/upload',
    { responseType: 'text' },
  );
  void upload;
}

/* -------------------------------------------------------------------------- */
/*  Infinite, combine, createRequests                                          */
/* -------------------------------------------------------------------------- */

export function aggregation(): void {
  const infiniteOptions: InfiniteRequestOptions<Row[], number> = {
    key: () => ['rows'],
    initialPageParam: 1,
    getNextPageParam: (last) => (last && last.length > 0 ? 1 : undefined),
    maxPages: 5,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  };
  const source = (page: number): RequestValue => ({ url: `/rows/${page}` });
  const infinite: InfiniteRequest<Row[], number> = createInfiniteRequest(source, infiniteOptions);
  const pages: Signal<readonly Row[][]> = infinite.pages;
  const flattened: Signal<FlattenedPages<Row[]>> = infinite.response;
  const pageParams: Signal<readonly number[]> = infinite.pageParams;
  const hasNext: boolean = infinite.hasNextPage();
  const hasPrevious: boolean = infinite.hasPreviousPage();
  const next: Promise<void> = infinite.fetchNextPage();
  const previous: Promise<void> = infinite.fetchPreviousPage();
  const entry: CacheEntry<Row[]> | undefined = infinite.entryFor(1);
  void [pages, flattened, pageParams, hasNext, hasPrevious, next, previous, entry];

  const withVerbs: CreateInfiniteRequest = createInfiniteRequest;
  const bare: CreateInfiniteRequestFn = createInfiniteRequest;
  void [withVerbs, bare, createInfiniteRequest.get.text<string>];

  const a: SignalRequest<Row[]> = createRequest<Row[]>('/a');
  const b: SignalRequest<Row[]> = createRequest<Row[]>('/b');
  const combinable: Combinable<Row[]> = a;
  const combined: Combined<{ a: Row[] | undefined; b: Row[] | undefined }> = combine({ a, b });
  const responses: ResponsesOf<{ a: SignalRequest<Row[]> }> = { a: a.response() };
  void [combinable, responses, combined.loading];

  const set: RequestSet<Row> = createRequests(
    () => [{ id: 1, name: 'Ada' }],
    () => createRequest<Row>(() => ({ url: '/rows/1' })),
    { key: (item) => item.id },
  );
  const handles: Signal<readonly Combinable<Row>[]> = set.handles;
  void [handles, set.reload()];
  set.destroy();

  const positional: Combined<readonly (Row[] | undefined)[]> = combine([a, b]);
  void positional;
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

export function errorHandling(): void {
  const context: RequestErrorContext = { timeout: 5000 };
  const view: RequestErrorView = toRequestError(new Error('nope'), context);
  const error: RequestError = view;
  const kind: RequestErrorKind = error.kind;
  const ofKind: RequestErrorOf<'http'> | undefined = view.http();
  const message: string = view.message;
  void [kind, ofKind, message];

  const normalized: Error = toError('boom');
  void normalized;

  const cancelled: Error = new RequestCancelledError('cancelled');
  void cancelled;

  const read: () => RequestErrorView | undefined = requestErrorOf(
    () => undefined,
    () => ({}),
  );
  void read;
}

/* -------------------------------------------------------------------------- */
/*  The cache, imperatively                                                    */
/* -------------------------------------------------------------------------- */

export function cacheApi(): void {
  const client = inject(QueryClient);
  const cache = inject(QueryCache);
  const mutations = inject(MutationRegistry);

  client.invalidate(['rows']);
  client.invalidate((segment) => segment === 'rows');
  client.refetch(['rows']);
  client.cancel(['rows']);
  const data: Row | undefined = client.getData<Row>(['row', 1]);
  const written: Row | undefined = client.setData<Row>(['row', 1], (previous) => previous);
  const updater: Updater<Row> = (previous) => previous;
  const removed: number = client.remove(['rows']);
  const fetching: boolean = client.isFetching();
  const fetchingFiltered: boolean = client.isFetching(['rows']);
  const count: number = client.count(['rows']);
  const mutating: Signal<boolean> = client.isMutating();
  const mutatingFiltered: Signal<boolean> = client.isMutating(['rows']);
  const mutatingCount: Signal<number> = client.mutatingCount();
  client.clear();
  void [data, written, updater, removed, fetching, fetchingFiltered, count, mutating, mutatingFiltered, mutatingCount];

  const entry: CacheEntry<Row> | undefined = cache.peek<Row>(['row', 1]);
  const resolved: CacheEntry<Row> = cache.resolve<Row>(['row', 1], 'row');
  const all: readonly CacheEntry[] = cache.all();
  const matching: CacheEntry[] = cache.matching(['rows']);
  const resolvedCount: number = cache.resolve<Row>(['row', 1]).fetchCount();
  cache.seed(['row', 1], { id: 1, name: 'Ada' }, Date.now());
  const invalidated: number = cache.markInvalidated(['rows']);
  const gone: number = cache.remove(['rows']);
  const unsubscribeChanges: () => void = cache.subscribeChanges(() => void 0);
  cache.clear();
  void [entry, resolved, all, matching, resolvedCount, invalidated, gone, unsubscribeChanges];

  const listener: CacheChangeListener = () => void 0;
  void listener;

  const normalized: NormalizedKey = normalizeKey(['rows', { page: 1 }]);
  const hash: string = normalized.hash;
  const raw: readonly unknown[] = normalized.raw;
  const segments: readonly string[] = normalized.segments;
  const predicate: QueryKeyPredicate = (segment) => segment === 'rows';
  const filter: QueryKeyFilter = predicate;
  const matches: boolean = matchesFilter(normalized, filter);
  const starts: boolean = startsWith(normalized.segments, ['"rows"']);
  const formatted: string = formatKey(normalized.segments);
  void [hash, raw, matches, starts, formatted];

  const seed: SeedValue<Row> = { value: { id: 1, name: 'Ada' }, dataUpdatedAt: Date.now() };
  const plan: FetchPlan<Row> = {
    request: { url: '/rows/1' },
    structuralSharing: resolveStructuralSharing<Row>(undefined, undefined),
    retry: undefined,
    parse: undefined,
    responseType: 'json',
  };
  const outcome: SettleOutcome<Row> = { ok: true, value: { id: 1, name: 'Ada' } };
  const sharing: StructuralSharingFn<Row> = resolveStructuralSharing<Row>(undefined, undefined);
  void [seed, plan, outcome, sharing];
  void outcome.ok;

  const total: Signal<number> = mutations.count;
  const isMutating: Signal<boolean> = mutations.isMutating;
  void [total, isMutating];

  const value: RequestValue = 'https://api.example.com';
  const paramsOption: ParamsOption<{ page: number }> = { params: { page: 1 } };
  const queryParams: QueryParams = { page: 1, tags: ['a', 'b'] };
  const queryValue: QueryValue = new Date();
  const primitive: QueryPrimitive = 1;
  const pathParams: PathParams = { id: 1 };
  const requestConfig: RequestConfig = { url: '/rows/:id', path: pathParams };
  const requestOptions: RequestOptions<Row[]> = { initialValue: [] };
  const requestSource: RequestSource = '/rows';
  void [value, paramsOption, queryParams, queryValue, primitive, requestConfig, requestOptions, requestSource];
}

/* -------------------------------------------------------------------------- */
/*  ng-signal-request/persist                                                  */
/* -------------------------------------------------------------------------- */

import {
  CACHE_PERSISTER,
  CACHE_TRANSFER_KEY,
  createPersister,
  dateRevivingCodec,
  dehydrate,
  hydrate,
  prefetch,
  provideCacheTransfer,
  providePersistedCache,
  SNAPSHOT_VERSION,
} from 'ng-signal-request/persist';
import type {
  CacheSnapshot,
  CacheSnapshotEntry,
  CacheStorage,
  CacheTransferOptions,
  DehydrateOptions,
  HydrateOptions,
  PersistOptions,
  Persister,
  Prefetchable,
  PrefetchReport,
  SnapshotCodec,
  SnapshotFilterOptions,
} from 'ng-signal-request/persist';

export function persistence(): void {
  const codec: SnapshotCodec = { serialize: (v) => v, deserialize: (v) => v };
  const filters: SnapshotFilterOptions = { include: ['rows'], exclude: ['rows', 'secret'] };
  const dehydrateOptions: DehydrateOptions = { codec, now: Date.now() };
  const hydrateOptions: HydrateOptions = { codec, maxAge: 1000 };

  const cache = inject(QueryCache);
  const snapshot: CacheSnapshot = dehydrate(cache, dehydrateOptions);
  const version: number = SNAPSHOT_VERSION;
  const restored: number = hydrate(cache, snapshot, hydrateOptions);
  const first: CacheSnapshotEntry | undefined = snapshot.entries[0];
  void [filters, version, restored, first];

  const storage: CacheStorage = localStorage;
  const options: PersistOptions = {
    storage,
    key: 'rows',
    codec,
    include: ['rows'],
    maxAge: 1000,
    debounce: 0,
  };
  void options;

  // An in-memory 0.1.0-style storage is still a `CacheStorage`: the async halves are a widening.
  const memory: CacheStorage = {
    getItem: () => null,
    setItem: () => void 0,
    removeItem: () => void 0,
  };
  void memory;

  // The restored spelling: the storage's own type selects the return type, exactly as in 0.1.0.
  const inferred = createPersister({ storage: localStorage });
  const inferredCount: number = inferred.hydrate();
  const inferredDefault = createPersister();
  const inferredDefaultCount: number = inferredDefault.hydrate();
  void [inferredCount, inferredDefaultCount];

  const enabled: Signal<boolean> = inferred.enabled;
  const key: string = inferred.storageKey;
  inferred.persist();
  inferred.clear();
  inferred.destroy();
  void [enabled, key];
  void dateRevivingCodec;

  // The persister is a restore gate: assigning it to the core interface must compile.
  const gate: RestoreGate = inferred;
  void gate.isRestoring();

  const annotated: Persister = createPersister({ storage: localStorage });
  // @ts-expect-error accepted break: annotating the **interface** rather than letting the storage
  // select the return type. A non-generic `Persister` cannot mean both `number` and
  // `Promise<number>`, so it keeps the union. 0.2.0 `Persister.hydrate()` widening; see
  // docs/design-0.2.md, "Step A".
  const annotatedCount: number = annotated.hydrate();
  void annotatedCount;

  // The same widening, reached through the DI token, which cannot carry a type parameter at all.
  // @ts-expect-error accepted break: `Persister.hydrate()` widening; see docs/design-0.2.md, "Step A".
  const tokenCount: number = inject(CACHE_PERSISTER).hydrate();
  void tokenCount;

  const transferOptions: CacheTransferOptions = { include: ['rows'] };
  const transfer: EnvironmentProviders = provideCacheTransfer(transferOptions);
  const persisted: EnvironmentProviders = providePersistedCache({
    storage: localStorage,
    debounce: 0,
  });
  void [transfer, persisted, CACHE_TRANSFER_KEY];
}

export function prefetching(): Promise<PrefetchReport> {
  const handle: Prefetchable = createRequest<Row[]>('/rows');
  return prefetch([handle]);
}

/* -------------------------------------------------------------------------- */
/*  ng-signal-request/devtools                                                 */
/* -------------------------------------------------------------------------- */

import { DevtoolsPanel, QueryDevtools, snapshotEntries } from 'ng-signal-request/devtools';
import type { DevtoolsEntry, DevtoolsStatus, SnapshotOptions } from 'ng-signal-request/devtools';

export function devtools(): void {
  const service = inject(QueryDevtools);
  const entries: Signal<readonly DevtoolsEntry[]> = service.entries;
  const options: SnapshotOptions = { filter: ['rows'], now: Date.now() };
  const snapshot: readonly DevtoolsEntry[] = snapshotEntries(inject(QueryCache), options);
  const first: DevtoolsEntry | undefined = snapshot[0];
  const status: DevtoolsStatus | undefined = first?.status;
  const panel: typeof DevtoolsPanel = DevtoolsPanel;
  const count: Signal<number> = service.count;
  void [entries, status, panel, count];
}

/* -------------------------------------------------------------------------- */
/*  ng-signal-request/testing                                                  */
/* -------------------------------------------------------------------------- */

import {
  advanceClock,
  cache as testingCache,
  fail,
  isHttpError,
  respond,
  settle,
  setup,
} from 'ng-signal-request/testing';
import type { ChildScope, TestSetup } from 'ng-signal-request/testing';
import type { HttpTestingController } from '@angular/common/http/testing';
import type { HttpErrorResponse } from '@angular/common/http';

export async function testing(): Promise<void> {
  const harness: TestSetup = setup();
  const http: HttpTestingController = harness.http;
  const child: ChildScope = harness.createChild();
  const handle: SignalRequest<Row[]> = harness.create(() => createRequest<Row[]>('/rows'));
  const other: SignalRequest<Row[]> = child.create(() => createRequest<Row[]>('/other'));

  await settle();
  advanceClock(1000);
  await respond(http, '/rows', []);
  await fail(http, '/rows', 500);
  child.destroy();
  void [handle, other, child.isDestroyed, child.injector, testingCache()];

  const check = (value: unknown): value is HttpErrorResponse => isHttpError(value);
  void check;
}
