import { HttpErrorResponse } from '@angular/common/http';

/**
 * Used to reject `run()` promises when a request was aborted on purpose:
 * `cancel()`, `destroy()`, a newer call in `switch` mode, or the source turning `undefined`
 * while a `run()` was waiting.
 */
export class RequestCancelledError extends Error {
  override readonly name = 'RequestCancelledError';
  constructor(message = 'The request was cancelled.') {
    super(message);
  }
}

/**
 * `HttpErrorResponse` implements the `Error` interface but is not `instanceof Error`
 * (Angular itself uses the same duck-typing), so we must not wrap it.
 */
function isErrorLike(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

export function toError(value: unknown): Error {
  if (isErrorLike(value)) return value;
  return new Error(typeof value === 'string' ? value : 'Unknown request error', { cause: value });
}

/* -------------------------------------------------------------------------- */
/*  Normalized request errors                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A request failure, narrowed to a discriminated union.
 *
 * Angular's `error` signal is `Error | undefined`, which cannot tell a 404 from a
 * `TypeError: Failed to fetch` without `instanceof` checks at every call site — and
 * `HttpErrorResponse` is not even `instanceof Error`. This type is what
 * `SignalRequest.requestError` / `SignalMutation.requestError` expose; the raw
 * `error` signal is left untouched.
 */
export type RequestError =
  /** The request was aborted (component destroyed, `cancel()`, source changed). */
  | { readonly kind: 'aborted' }
  /** The `timeout` elapsed. */
  | { readonly kind: 'timeout'; readonly ms: number }
  /** The server answered with an HTTP status. */
  | {
    readonly kind: 'http';
    readonly status: number;
    readonly statusText: string;
    readonly url: string | null;
    readonly body: unknown;
  }
  /**
   * The server could not be reached at all (DNS, CORS, offline).
   *
   * `HttpClient` reports "no response" as `status: 0`, which covers both a network
   * failure and a cancellation. An abort is only recognized when the reason names
   * itself `AbortError`/`TimeoutError`; an opaque `status: 0` lands here.
   */
  | { readonly kind: 'network'; readonly cause: unknown }
  /** Not classifiable. */
  | { readonly kind: 'unknown'; readonly cause: unknown };

/** Classification context, used to tell a deliberate timeout from a plain abort. */
export interface RequestErrorContext {
  /**
   * When set, an abort-like failure is reported as `{ kind: 'timeout' }` instead of
   * `{ kind: 'aborted' }`. Angular's fetch backend aborts with
   * `DOMException('signal timed out', 'TimeoutError')`, which is otherwise
   * indistinguishable from a user-initiated cancellation.
   */
  readonly timeout?: number;
}

/** Names used by `AbortController.abort()` and by Angular's fetch-backend timeout. */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/**
 * `HttpClient` reports an abort as `status: 0` carrying the abort reason, while the
 * fetch backend may hand the `TimeoutError` DOMException over directly. Look at both.
 */
function isAbortLike(cause: unknown): boolean {
  const candidate = cause instanceof HttpErrorResponse ? cause.error : cause;

  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'name' in candidate &&
    ABORT_ERROR_NAMES.has((candidate as { name: unknown }).name as string)
  );
}

/** The five classifications, for narrowing without matching on the literal. */
export type RequestErrorKind = RequestError['kind'];

/** The member of {@link RequestError} with kind `K`. */
export type RequestErrorOf<K extends RequestErrorKind> = Extract<RequestError, { kind: K }>;

/**
 * A `RequestError` plus the helpers a template actually wants.
 *
 * `kind` and the payload fields are unchanged, so every existing use — including the
 * compiler-checked `if (e.kind === 'http') e.status` narrowing — keeps working. What is new is
 * that a template no longer has to spell out a `@switch`:
 *
 * ```html
 * @if (error.http(); as http) { error: {{ http.status }} }
 * @else if (error.network()) { no connection }
 * @else if (error.timeout()) { timed out }}
 * @else { {{ error.message }} }
 * ```
 *
 * Each predicate returns the error itself when that is its kind, and `undefined` otherwise — so
 * the `@if ... ; as` alias is typed as the exact union member, with no new payload types to learn.
 */
export type RequestErrorView = RequestError & {
  /**
   * A one-line English summary: `HTTP 404 Not Found`, `Timed out after 5000ms`, `No connection`.
   *
   * Best-effort presentation copy for a badge, a tooltip or a log line. Branch on `kind`, not on
   * this string — it is not a stable contract and it is not localizable.
   */
  readonly message: string;
  readonly aborted: () => RequestErrorOf<'aborted'> | undefined;
  readonly timeout: () => RequestErrorOf<'timeout'> | undefined;
  readonly http: () => RequestErrorOf<'http'> | undefined;
  readonly network: () => RequestErrorOf<'network'> | undefined;
  readonly unknown: () => RequestErrorOf<'unknown'> | undefined;
};

/**
 * One-line summaries, all in one place so they are easy to review and change.
 *
 * `network` and `aborted` are separate classifications even though both arrive as `status: 0` —
 * see the `RequestError` docs — and they read differently to a user, so they get their own copy.
 */
function summarize(error: RequestError): string {
  switch (error.kind) {
    case 'http':
      return `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`;
    case 'timeout':
      return `Timed out after ${error.ms}ms`;
    case 'network':
      return 'No connection';
    case 'aborted':
      return 'Request cancelled';
    case 'unknown': {
      const cause: unknown = error.cause;
      if (typeof cause === 'string' && cause) return cause;
      if (typeof cause === 'object' && cause !== null) {
        const message = (cause as { message?: unknown }).message;
        if (typeof message === 'string' && message) return message;
      }
      return 'Unknown error';
    }
  }
}

/**
 * The helpers live on a shared prototype rather than on the error instance.
 *
 * That is what keeps them out of `Object.keys`, `JSON.stringify`, spread and — the reason this is
 * worth the indirection — Vitest's `toEqual`, which compares own enumerable keys. So
 * `expect(requestError()).toEqual({ kind: 'timeout', ms: 30 })` keeps passing, and an error still
 * serializes as plain data. It also means one allocation per failure instead of six, and a
 * predicate call is a string comparison rather than a reactive-graph lookup.
 *
 * `message` is a prototype *getter* for the same reason: it has to read like `error.message` in a
 * template without becoming a field.
 */
const viewPrototype: object = {
  get message(): string {
    return summarize(this as unknown as RequestError);
  },
  aborted(this: RequestErrorView) {
    return this.kind === 'aborted' ? (this as RequestErrorOf<'aborted'>) : undefined;
  },
  timeout(this: RequestErrorView) {
    return this.kind === 'timeout' ? (this as RequestErrorOf<'timeout'>) : undefined;
  },
  http(this: RequestErrorView) {
    return this.kind === 'http' ? (this as RequestErrorOf<'http'>) : undefined;
  },
  network(this: RequestErrorView) {
    return this.kind === 'network' ? (this as RequestErrorOf<'network'>) : undefined;
  },
  unknown(this: RequestErrorView) {
    return this.kind === 'unknown' ? (this as RequestErrorOf<'unknown'>) : undefined;
  },
};

function asView(error: RequestError): RequestErrorView {
  return Object.assign(Object.create(viewPrototype), error) as RequestErrorView;
}

/** Normalizes an arbitrary thrown value into a `RequestError` view. */
export function toRequestError(
  cause: unknown,
  context: RequestErrorContext = {},
): RequestErrorView {
  return asView(classify(cause, context));
}

function classify(cause: unknown, context: RequestErrorContext): RequestError {
  if (isAbortLike(cause)) {
    return context.timeout === undefined
      ? { kind: 'aborted' }
      : { kind: 'timeout', ms: context.timeout };
  }

  if (cause instanceof HttpErrorResponse) {
    return cause.status === 0
      ? { kind: 'network', cause }
      : {
        kind: 'http',
        status: cause.status,
        statusText: cause.statusText,
        url: cause.url ?? null,
        body: cause.error ?? null,
      };
  }

  // The fetch backend rejects a raw `TypeError` for network failures when it is not
  // wrapped in an `HttpErrorResponse`.
  if (cause instanceof TypeError) {
    return { kind: 'network', cause };
  }

  return { kind: 'unknown', cause };
}

/** Builds the `requestError` signal that sits next to a raw `error` signal. */
export function requestErrorOf(
  error: () => Error | undefined,
  context: () => RequestErrorContext,
): () => RequestErrorView | undefined {
  return () => {
    const cause = error();
    return cause === undefined ? undefined : toRequestError(cause, context());
  };
}
