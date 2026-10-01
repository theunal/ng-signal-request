import { HttpHeaders, HttpParams, type HttpResourceRequest } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { toError } from './errors';
import { resolveRequest, withGlobalHeaders } from './utils';

/**
 * Direct tests for the pure request-building helpers.
 *
 * Most behaviour is covered end-to-end through `createRequest`, but these branches are awkward to
 * reach from the outside: they need an `HttpHeaders` whose `getAll()` returns `null`, or a params
 * bag whose array is entirely dropped. Testing them here is cheaper and more precise than bending
 * a TestBed test around it — and it documents the helper's contract on its own terms.
 */

/** `HttpHeaders` returns `null` from `getAll()` for a key it does not hold. */
function headersWithGhostKey(): HttpHeaders {
  // `keys()` reports the key, but `getAll()` is stubbed to null: the only way to hit the
  // `if (!all) continue` guard, which protects against a header object whose two views disagree.
  const real = new HttpHeaders({ 'X-Real': 'a' });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'keys') return () => ['X-Ghost', 'X-Real'];
      if (prop === 'getAll') return (key: string) => (key === 'X-Ghost' ? null : target.getAll(key));
      return Reflect.get(target, prop, receiver);
    },
  }) as HttpHeaders;
}

describe('resolveRequest – query params', () => {
  it('drops null entries from an array but keeps the surviving ones', () => {
    const request = resolveRequest({ url: '/q', params: { tags: ['a', null, 'b'] } }, 'GET');
    expect(request?.params).toEqual({ tags: ['a', 'b'] });
  });

  it('removes a key whose array is empty after filtering', () => {
    // An all-null array must not leave a bare `?tags=` behind — the key is deleted instead.
    // (An already-empty array takes the same path, so both are covered here.)
    const request = resolveRequest({ url: '/q', params: { tags: [null, null], keep: 'y' } }, 'GET');
    expect(request?.params).toEqual({ keep: 'y' });
  });

  it('removes a bag array that is empty after filtering, and keeps the rest', () => {
    // Same rule as the source-side array, reached through the `params` bag this time: an array of
    // only nullish entries disappears entirely instead of leaving `?tags=` on the wire.
    const dropped = resolveRequest({ url: '/q' }, 'GET', undefined, { tags: [null, undefined], keep: 'y' });
    expect(dropped?.params).toEqual({ keep: 'y' });

    const kept = resolveRequest({ url: '/q' }, 'GET', undefined, { tags: ['a', null] });
    expect(kept?.params).toEqual({ tags: ['a'] });
  });

  it('lets the bag delete a source param with null', () => {
    const source = { url: '/q', params: { gone: 'x', kept: 'y' } };
    const request = resolveRequest(source, 'GET', undefined, { gone: null });
    expect(request?.params).toEqual({ kept: 'y' });
  });

  it('lets the bag delete a source param with undefined', () => {
    // `splitParams` drops undefined keys, so an explicit `undefined` means "not provided" — and the
    // source's own value for that key therefore survives untouched.
    const source = { url: '/q', params: { gone: 'x' } };
    const request = resolveRequest(source, 'GET', undefined, { gone: undefined });
    expect(request?.params).toEqual({ gone: 'x' });
  });

  it('flattens an HttpParams source into a plain record, keeping repeated values', () => {
    // `mergeQuery` normalises through `fromHttpParams` before cleaning, so the outgoing params are
    // a record rather than the instance. The repeated value survives as an array, which is what
    // makes `?a=1&a=2` reach the server intact.
    const params = new HttpParams().append('a', '1').append('a', '2').append('b', '3');
    const request = resolveRequest({ url: '/q', params }, 'GET');
    expect(request?.params).toEqual({ a: ['1', '2'], b: '3' });
  });

  it('tolerates a non-object params bag', () => {
    // A caller can smuggle a primitive through `as never`; it is treated as "no bag" rather than
    // throwing inside the reactive chain.
    expect(resolveRequest('/q', 'GET', undefined, 'nonsense')?.params).toEqual({});
    expect(resolveRequest('/q', 'GET', undefined, null)?.params).toEqual({});
    expect(resolveRequest('/q', 'GET', undefined, 42)?.params).toEqual({});
  });

  it('omits params entirely when there is nothing to send', () => {
    const request = resolveRequest('/q', 'GET');
    expect(request?.params).toEqual({});
  });
});

describe('withGlobalHeaders', () => {
  it('skips malformed entries in a [name, value] header list', () => {
    // Angular's own type is a tuple pair, but the list arrives from user code and is merged with a
    // loop rather than a validator. A short or non-array entry is ignored instead of writing
    // `undefined` into the header record, which Angular would send as the string "undefined".
    const malformed = [
      ['X-Ok', 'yes'],
      ['X-Short'],
      'not-a-pair',
    ] as unknown as HttpResourceRequest['headers'];
    const out = withGlobalHeaders({ url: '/n', headers: malformed }, { 'X-App': 'd' });
    expect(out.headers).toEqual({ 'X-App': 'd', 'X-Ok': 'yes' });
  });

  it('skips merging when the global header function returns nothing', () => {
    // An empty bag is common while a token is still being resolved. Rebuilding the request object
    // for no reason would churn the reactive graph, so it returns the original untouched.
    const request: HttpResourceRequest = { url: '/n', method: 'GET' };
    const out = withGlobalHeaders(request, () => ({}));
    expect(out).toBe(request);
  });

  it('skips merging when the static global header object is empty', () => {
    const request: HttpResourceRequest = { url: '/n', method: 'GET' };
    expect(withGlobalHeaders(request, {})).toBe(request);
  });

  it('drops a header key whose getAll() returns null instead of writing undefined', () => {
    // Without the guard, `merged[key] = all[0]` would put `undefined` in the header record, which
    // Angular would then send as the literal string "undefined".
    const out = withGlobalHeaders({ url: '/n', headers: headersWithGhostKey() }, { 'X-App': 'd' });
    expect(out.headers).toEqual({ 'X-App': 'd', 'X-Real': 'a' });
  });
});

describe('toError', () => {
  it('describes a non-Error rejection without losing the cause', () => {
    // `HttpClient` can reject with a plain object or a number. The result is always a real `Error`
    // so `tryRun().error` keeps its type, and `cause` keeps the original for debugging.
    const err = toError({ status: 418 });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Unknown request error');
    expect(err.cause).toEqual({ status: 418 });
  });

  it('passes an error-like object through untouched', () => {
    // `HttpErrorResponse` is not `instanceof Error`, so this duck-typing check is what keeps the
    // library from wrapping it and losing `status`.
    const duck = { message: 'teapot', status: 418 } as unknown as Error;
    expect(toError(duck)).toBe(duck);
  });

  it('uses a string rejection as the message', () => {
    expect(toError('plain string').message).toBe('plain string');
  });
});
