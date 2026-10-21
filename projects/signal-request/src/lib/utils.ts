import { HttpHeaders, HttpParams, type HttpResourceRequest } from '@angular/common/http';
import { effect, isDevMode, signal, untracked, type Signal } from '@angular/core';
import { isAbortLike } from './errors';
import type {
  PathParams,
  QueryParams,
  RequestConfig,
  RequestValue,
  RetryConfig,
  SignalRequestConfig,
} from './types';

/* ------------------------------ request building ------------------------------ */

type ParamPrimitive = string | number | boolean;
type ParamRecord = Record<string, ParamPrimitive | ReadonlyArray<ParamPrimitive>>;

const ABSOLUTE_URL = /^([a-z][a-z\d+.-]*:)?\/\//i;
const PLACEHOLDER = /:([A-Za-z_]\w*)/g;

/**
 * Keys of a `params` object that shape the request instead of the query string.
 *
 * `method` is deliberately absent: the verb is chosen by the function you call
 * (`createRequest.post`, `createMutation.put`, …), never by a params bag. A `method`
 * key there is just a query value like any other.
 */
export const RESERVED_PARAM_KEYS = ['body', 'path', 'headers'] as const;

/** A `params` bag, split into the request-shaping keys and the leftover query values. */
export interface SplitParams {
  readonly body: unknown;
  readonly path: PathParams | undefined;
  readonly headers: HttpResourceRequest['headers'];
  readonly query: Record<string, unknown>;
}

/**
 * Splits a `params` object into the request-shaping keys (`body`, `path`, `headers`)
 * and everything else, which becomes the query string.
 *
 * An explicit `undefined` is treated as "not provided" so a partial update can leave a key alone.
 */
export function splitParams(params: unknown): SplitParams {
  const empty: SplitParams = {
    body: undefined,
    path: undefined,
    headers: undefined,
    query: {},
  };

  if (params === null || typeof params !== 'object') return empty;

  let body: unknown;
  let path: PathParams | undefined;
  let headers: HttpResourceRequest['headers'];
  const query: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined) continue;

    switch (key) {
      case 'body':
        body = value;
        break;
      case 'path':
        path = value as PathParams;
        break;
      case 'headers':
        headers = value as HttpResourceRequest['headers'];
        break;
      default:
        query[key] = value;
    }
  }

  return { body, path, headers, query };
}

/** Flattens an `HttpParams` instance into a plain record so it can be merged with plain values. */
function fromHttpParams(params: HttpParams): ParamRecord {
  const out: ParamRecord = {};
  // No null check on `getAll`: `HttpParams.keys()` is `Array.from(this.map.keys())` and
  // `getAll(k)` is `this.map.get(k) || null`, so a key from `keys()` always resolves to a non-empty
  // array. `HttpParams` is immutable, so the map cannot change underneath the loop either.
  for (const key of params.keys()) {
    const values = params.getAll(key) as ParamPrimitive[];
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/** Merges the leftover `params` values over the source's own query params (params wins). */
function mergeQuery(
  source: RequestConfig['params'] | undefined,
  extra: Record<string, unknown>,
): HttpResourceRequest['params'] | undefined {
  const base: ParamRecord =
    source instanceof HttpParams
      ? fromHttpParams(source)
      : source === undefined
        ? {}
        : { ...(source as ParamRecord) };

  for (const [key, raw] of Object.entries(extra)) {
    if (raw === null || raw === undefined) {
      // `delete base[key]` on a computed key is banned by the lint config; this is the same
      // operation without the deoptimization the rule is guarding against.
      Reflect.deleteProperty(base, key);
      continue;
    }
    if (Array.isArray(raw)) {
      // Nullish entries are dropped rather than sent as a literal "null". An array that ends up
      // empty is removed instead of leaving a bare `?key=` behind.
      const items = raw.map(toPrimitive).filter((v): v is ParamPrimitive => v !== undefined);
      if (items.length > 0) base[key] = items;
      else Reflect.deleteProperty(base, key);
    } else {
      // `toPrimitive` only returns `undefined` for nullish input, which the branch above already
      // caught, so a non-array value always normalises to something.
      base[key] = toPrimitive(raw) as ParamPrimitive;
    }
  }

  return cleanParams(base);
}

function toPrimitive(value: unknown): ParamPrimitive | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value as ParamPrimitive;
}

/**
 * Drops nullish values and flattens dates, so Angular receives a clean record.
 *
 * Takes a `ParamRecord` rather than `RequestConfig['params']`: `mergeQuery` has already flattened any
 * `HttpParams` via `fromHttpParams`, so an instance cannot reach this point.
 */
function cleanParams(params: ParamRecord): ParamRecord {
  const out: ParamRecord = {};
  for (const [key, raw] of Object.entries(params as QueryParams)) {
    if (Array.isArray(raw)) {
      const items = raw.map(toPrimitive).filter((v): v is ParamPrimitive => v !== undefined);
      if (items.length > 0) out[key] = items;
    } else {
      const value = toPrimitive(raw);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/**
 * Fills `:placeholder`s in the url.
 *
 * Returns `undefined` (=> request disabled) when a placeholder referenced by the url has no
 * value, whether that is because `path` was omitted entirely or because the key is missing /
 * `null`. Sending `/users/:id` to a server is never what the caller meant.
 */
function fillPath(url: string, path: RequestConfig['path']): string | undefined {
  // Collected in an array rather than a `let missing = false` flag: the flag is only ever set from
  // inside the `replace` callback, and the type checker cannot see that the callback ran, so it
  // narrows the flag to `false` and calls the guard below dead code. The array has the same
  // lifetime and no such blind spot.
  const unresolved: string[] = [];
  const filled = url.replace(PLACEHOLDER, (_match, key: string) => {
    const value = path === undefined ? undefined : path[key];
    if (value === null || value === undefined) {
      unresolved.push(key);
      return '';
    }
    return encodeURIComponent(String(value));
  });
  return unresolved.length === 0 ? filled : undefined;
}

function withBase(url: string, baseUrl: string | undefined): string {
  if (!baseUrl || ABSOLUTE_URL.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Turns anything a user may return from a source into a plain `HttpResourceRequest`
 * (or `undefined` = disabled).
 *
 * When a `params` bag is given, its `body` / `path` / `headers` keys fill the matching
 * request slots — **overriding** whatever the source put there — and the remaining keys
 * are merged into the query string. `body: null` clears the source's body; `body:
 * undefined` leaves it alone.
 *
 * `method` is applied last and unconditionally: it comes from the variant you called
 * (`createRequest.post`, `createMutation.put`, …) and nothing can override it.
 */
export function resolveRequest(
  value: RequestValue,
  method: string,
  baseUrl?: string,
  params?: unknown,
): HttpResourceRequest | undefined {
  if (value === null || value === undefined || value === false) return undefined;

  const config: RequestConfig = typeof value === 'string' ? { url: value } : value;
  const split = params === undefined ? undefined : splitParams(params);

  const path = split?.path !== undefined ? split.path : config.path;
  const filled = fillPath(config.url, path);
  if (filled === undefined) return undefined;

  // `path` is ours, not Angular's, and `params` is normalized below — keep both out of the spread
  // so the wider `QueryParams` type never leaks into the `HttpResourceRequest` we return.
  const { path: _path, params: sourceParams, ...rest } = config;
  const request: HttpResourceRequest = { ...rest, url: withBase(filled, baseUrl), method };

  if (split?.headers !== undefined) request.headers = split.headers;
  if (split?.body !== undefined) {
    request.body = split.body === null ? undefined : split.body;
  }

  const query = mergeQuery(sourceParams, split?.query ?? {});
  if (query !== undefined) request.params = query;

  return request;
}

/**
 * Merges the global header defaults from `provideSignalRequest` under the request's own
 * headers, so a per-request value always wins.
 *
 * `HttpResourceRequest.headers` may be an `HttpHeaders` instance, a plain record, or a list of
 * `[name, value]` pairs; all three are flattened first so nothing is silently dropped.
 *
 * When `global` is a function it is called here — that is deliberate: this runs inside the
 * request's reactive chain, so signals read by the function become dependencies of the request
 * and every live query refetches when they change.
 */
export function withGlobalHeaders(
  request: HttpResourceRequest,
  global: SignalRequestConfig['headers'],
): HttpResourceRequest {
  if (global === undefined) return request;

  const defaults = typeof global === 'function' ? global() : global;
  if (Object.keys(defaults).length === 0) return request;

  const merged: Record<string, string> = { ...defaults };

  const own = request.headers;
  if (own instanceof HttpHeaders) {
    for (const key of own.keys()) {
      const all = own.getAll(key);
      if (!all) continue;
      // Repeated header values are joined the way `HttpHeaders.get()` reports them, rather than
      // dropped — losing `X-Tag: a, b` would be a silent difference from `HttpClient`.
      merged[key] = all.length > 1 ? all.join(', ') : all[0];
    }
  } else if (Array.isArray(own)) {
    for (const entry of own) {
      if (Array.isArray(entry) && entry.length === 2) {
        merged[entry[0] as string] = entry[1] as string;
      }
    }
  } else if (own !== undefined) {
    Object.assign(merged, own);
  }

  return { ...request, headers: merged };
}

/* ---------------------------------- retry ------------------------------------ */

export interface NormalizedRetry {
  count: number;
  delay: (attempt: number, error: Error) => number;
  when: (error: Error, attempt: number) => boolean;
}

function isTransient(error: Error, retryTimeouts: boolean): boolean {
  // A timeout arrives as an abort carrying `status: 0`, which by status alone is indistinguishable
  // from a dropped socket — so it is identified with the same rule the classifier uses, rather than a
  // second copy of it. `retryTimeouts` decides this case and only this case: a genuine network failure
  // stays transient whichever way it is set.
  if (isAbortLike(error)) return retryTimeouts;

  const status = (error as { status?: unknown }).status;
  if (typeof status !== 'number') return false; // parse / programming errors are not worth retrying
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

const defaultDelay = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 30_000);

/** What the caller knows that the retry config does not. */
export interface RetryDefaults {
  /** The call's own `timeout`, used only for the dev-mode warning below. */
  readonly timeout?: number;
  /**
   * `retryTimeouts` from the request, or from the global config if the request did not set it.
   *
   * `false` takes a timeout out of what the *default* predicate considers transient. An explicit
   * `when` always wins, because it is an answer to the same question.
   */
  readonly timeouts?: boolean;
}

/**
 * Dev-mode nudge for the one combination 0.2.0 kept but changed the meaning of.
 *
 * Before 0.2.0 a timeout was retried together with the network failures, silently: `timeout: 5000`
 * with `retry: 2` could spend about 15s before reporting `{ kind: 'timeout' }`. 0.2.0 keeps that as
 * the default so no existing application changes behaviour, which means an application that never
 * asked for it is now told it is happening and how to stop it.
 *
 * Deduplicated per message, so this costs one line in the console rather than one per request.
 */
function warnIfTimeoutRetried(
  timeout: number | undefined,
  retryTimeouts: boolean,
  when: ((error: Error, attempt: number) => boolean) | undefined,
): void {
  if (timeout === undefined || !retryTimeouts || when !== undefined) return;

  warnDevOnce(
    `ng-signal-request: \`timeout: ${timeout}\` is retried like a network failure. ` +
      `Pass \`retryTimeouts: false\` or \`retry: { when }\` to change that.`,
  );
}

export function normalizeRetry(
  config: RetryConfig | undefined,
  defaults: RetryDefaults = {},
): NormalizedRetry | undefined {
  if (config === undefined || config === false) return undefined;
  const options = typeof config === 'number' ? { count: config } : config;
  if (!(options.count > 0)) return undefined;
  const retryTimeouts = defaults.timeouts !== false;
  warnIfTimeoutRetried(defaults.timeout, retryTimeouts, options.when);
  const { delay } = options;
  return {
    count: options.count,
    delay: typeof delay === 'function' ? delay : () => (typeof delay === 'number' ? delay : NaN),
    when: options.when ?? ((error) => isTransient(error, retryTimeouts)),
  };
}

/** Delay for the next retry or `undefined` if no (more) retries should happen. */
export function nextRetryDelay(
  retry: NormalizedRetry | undefined,
  attempt: number,
  error: Error,
): number | undefined {
  if (!retry || attempt > retry.count || !retry.when(error, attempt)) return undefined;
  const delay = retry.delay(attempt, error);
  return Number.isFinite(delay) && delay >= 0 ? delay : defaultDelay(attempt);
}

export const noop = (): void => {};

/* --------------------------------- dev warnings -------------------------------- */

/**
 * Messages already printed, so a warning about a *static* combination of options is printed once.
 *
 * These warnings describe something the developer cannot see from the call itself (a timeout being
 * retried, a `POST` that re-fires) and the natural place to detect it is when the handle is built —
 * which happens once per component instance. A message that repeats on every navigation is a message
 * that gets filtered, and a filtered warning helps nobody. So: per message, per page load.
 *
 * Module state, therefore also shared by tests in one file — a test that wants to observe a warning
 * should use inputs that produce a *distinct* message.
 */
const warnedOnce = new Set<string>();

/** Logs `message` once per session, in dev mode only. */
function warnDevOnce(message: string): void {
  if (!isDevMode() || warnedOnce.has(message)) return;
  warnedOnce.add(message);
  console.warn(message);
}

/**
 * Test-only: forget which warnings have already been printed.
 *
 * `warnedOnce` is module state, so a spec that asserts on `console.warn` sees any message an
 * earlier spec in the same worker already printed. Starting the spec from an empty ledger keeps
 * that assertion about the warning, not about test-file ordering. Not re-exported from the public
 * API and not called by production code, so the application build tree-shakes it.
 */
export function resetDevWarningsForTests(): void {
  warnedOnce.clear();
}

/**
 * Dev-mode warning for a write-shaped `createRequest`.
 *
 * `createRequest.post` and friends are **reactive** exactly like the `GET` form: the request re-fires
 * whenever a signal read by its source changes, which for a write means a second `POST` nobody asked
 * for. The trap is that this is invisible — the call looks like a mutation and behaves like a query.
 *
 * A warning rather than a throw, and a warning rather than a type error: the behaviour is legitimate
 * (`lazy: true` is a real way to use these verbs, and so is a re-firing write), and splitting the
 * verbs into "queries" and "writes" at the type level would break every existing call.
 */
export function warnIfNonGetQuery(method: string, lazy: boolean, caller: () => void): void {
  if (method === 'GET' || lazy) return;

  const name = caller.name || 'createRequest';
  warnDevOnce(
    `ng-signal-request: ${name} is not \`lazy\`, so this ${method} re-fires on signal changes. ` +
      `Use \`createMutation\` for writes, or \`lazy: true\` for a query.`,
  );
}

/* ------------------------------ shared primitives ------------------------------ */

/** Which `HttpClient` body reader a call uses, chosen by the verb variant you called. */
export type Kind = 'json' | 'text' | 'blob' | 'arrayBuffer';

/**
 * `Kind` mapped onto `HttpClient`'s `responseType`.
 *
 * The two vocabularies differ only in the casing of `arraybuffer`, and the mapping lives here so
 * the cached and uncached paths cannot drift on it.
 */
export const RESPONSE_TYPE: Record<Kind, 'json' | 'text' | 'blob' | 'arraybuffer'> = {
  json: 'json',
  text: 'text',
  blob: 'blob',
  arrayBuffer: 'arraybuffer',
};

/**
 * Trailing-edge debounce for a signal. Skips the very first value.
 *
 * Shared by both request paths so `debounce` behaves identically whether or not the request is
 * cached — which matters, because a cached request that debounced differently would still fire a
 * network call on every keystroke, defeating the cache it opted into.
 */
export function debouncedSignal<V>(source: Signal<V>, ms: number): Signal<V> {
  const out = signal<V>(untracked(source));
  effect((onCleanup) => {
    const value = source();
    if (Object.is(value, untracked(out))) return;
    const timer = setTimeout(() => out.set(value), ms);
    onCleanup(() => clearTimeout(timer));
  });
  return out.asReadonly();
}
