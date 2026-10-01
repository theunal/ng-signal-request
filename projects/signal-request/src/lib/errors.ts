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

/**
 * Normalizes an arbitrary thrown value into a `RequestError`.
 *
 * Exported so a hand-written loader or your own `resource` can produce the same shape.
 */
export function toRequestError(
  cause: unknown,
  context: RequestErrorContext = {},
): RequestError {
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
): () => RequestError | undefined {
  return () => {
    const cause = error();
    return cause === undefined ? undefined : toRequestError(cause, context());
  };
}
