import { HttpHeaders } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMutation, createRequest, provideSignalRequest } from '../public-api';
import { settle, setup } from '../../testing/testing';

describe('global headers', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('attaches the defaults to every request', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo', 'X-Api-Key': 'k' } })]);
    const r = s.create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.get('X-App')).toBe('demo');
    expect(req.request.headers.get('X-Api-Key')).toBe('k');
    req.flush(1);
    await settle();
    expect(r.response()).toBe(1);
  });

  it('lets a per-request header win over the global default', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-Env': 'prod' } })]);
    s.create(() => createRequest<number>('/n', { headers: { 'X-Env': 'dev' }, retry: 0 }));

    await settle();
    expect(s.http.expectOne('/n').request.headers.get('X-Env')).toBe('dev');
  });

  it('merges a per-request header instead of replacing the whole set', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo' } })]);
    s.create(() => createRequest<number>('/n', { headers: { 'X-Trace': 'abc' }, retry: 0 }));

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.get('X-App')).toBe('demo');
    expect(req.request.headers.get('X-Trace')).toBe('abc');
  });

  it('flattens an HttpHeaders instance instead of dropping it', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo' } })]);
    s.create(() =>
      createRequest<number>('/n', { headers: new HttpHeaders({ 'X-Trace': 'abc' }), retry: 0 }),
    );

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.get('X-App')).toBe('demo');
    expect(req.request.headers.get('X-Trace')).toBe('abc');
  });

  it('a function is re-read on every request', async () => {
    const token = signal('first');
    const s = setup([provideSignalRequest({ headers: () => ({ Authorization: `Bearer ${token()}` }) })]);
    const r = s.create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    const first = s.http.expectOne('/n');
    expect(first.request.headers.get('Authorization')).toBe('Bearer first');
    first.flush(1);
    await settle();
    expect(r.response()).toBe(1);

    token.set('second');
    r.reload();
    await settle();
    expect(s.http.expectOne('/n').request.headers.get('Authorization')).toBe('Bearer second');
  });

  it('changing the signal alone refetches every live request', async () => {
    // This is the behaviour an `HttpInterceptorFn` cannot give you: the interceptor only runs
    // when a request is already on its way out, so it cannot make a satisfied resource refetch.
    const token = signal('first');
    const s = setup([provideSignalRequest({ headers: () => ({ Authorization: `Bearer ${token()}` }) })]);
    const r = s.create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    const first = s.http.expectOne('/n');
    first.flush(1);
    await settle();
    expect(r.status()).toBe('resolved');
    expect(r.response()).toBe(1);

    // No reload() call anywhere — the token changing is enough.
    token.set('second');
    await settle();

    expect(r.status()).toBe('loading');
    const next = s.http.expectOne('/n');
    expect(next.request.headers.get('Authorization')).toBe('Bearer second');
    next.flush(2);
    await settle();
    expect(r.response()).toBe(2);
  });

  it('flattens [name, value] pairs from the source instead of dropping them', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo' } })]);
    s.create(() =>
      createRequest<number>({ url: '/n', headers: [['X-Trace', 'abc']] } as never),
    );

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.get('X-App')).toBe('demo');
    expect(req.request.headers.get('X-Trace')).toBe('abc');
  });

  it('keeps a multi-value HttpHeaders, joined the way HttpHeaders.get() reports it', async () => {
    const s = setup([provideSignalRequest({ headers: { 'X-App': 'demo' } })]);
    s.create(() =>
      createRequest<number>('/n', {
        headers: new HttpHeaders({ 'X-Tag': ['a', 'b'] }),
        retry: 0,
      }),
    );

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.get('X-App')).toBe('demo');
    // Flattening must not lose the second value; merging is semantically equivalent to
    // `HttpHeaders.get('X-Tag')` on the original instance.
    expect(req.request.headers.get('X-Tag')).toBe('a, b');
  });

  it('a plain object is a snapshot and does NOT refetch', async () => {
    // Documents the footgun: reading the token into an object freezes it.
    const token = signal('first');
    const s = setup([provideSignalRequest({ headers: { Authorization: `Bearer ${token()}` } })]);
    const r = s.create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    const first = s.http.expectOne('/n');
    expect(first.request.headers.get('Authorization')).toBe('Bearer first');
    first.flush(1);
    await settle();

    token.set('second');
    await settle();

    expect(r.status()).toBe('resolved');
    s.http.expectNone(() => true);
  });

  it('applies to mutations too, read at call time', async () => {
    const token = signal('first');
    const s = setup([provideSignalRequest({ headers: () => ({ Authorization: `Bearer ${token()}` }) })]);
    const save = s.create(() => createMutation<number>(() => '/save'));

    const p = save.run();
    const first = s.http.expectOne('/save');
    expect(first.request.headers.get('Authorization')).toBe('Bearer first');
    first.flush(7);
    await expect(p).resolves.toBe(7);

    token.set('second');
    const p2 = save.run();
    const second = s.http.expectOne('/save');
    expect(second.request.headers.get('Authorization')).toBe('Bearer second');
    second.flush(8);
    await expect(p2).resolves.toBe(8);
  });

  it('is a no-op when no headers are configured', async () => {
    const s = setup();
    const r = s.create(() => createRequest<number>('/n', { retry: 0 }));

    await settle();
    const req = s.http.expectOne('/n');
    expect(req.request.headers.has('X-App')).toBe(false);
    req.flush(1);
    await settle();
    expect(r.response()).toBe(1);
  });

  it('works with baseUrl and params together', async () => {
    const s = setup([
      provideSignalRequest({ baseUrl: 'https://api.test', headers: { 'X-App': 'demo' } }),
    ]);
    s.create(() =>
      createRequest<number[], { q: string }>({ url: '/search' }, { params: { q: 'x' }, retry: 0 }),
    );

    await settle();
    const req = s.http.expectOne('https://api.test/search?q=x');
    expect(req.request.headers.get('X-App')).toBe('demo');
  });
});
