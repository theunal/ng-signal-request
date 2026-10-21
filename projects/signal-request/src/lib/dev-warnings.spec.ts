import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRequest, provideSignalRequest } from '../public-api';
import { normalizeRetry, resetDevWarningsForTests } from './utils';
import { cache, settle, setup } from '../../testing/testing';

/** A spied `console.warn`, quiet, restored after every test in this file. */
function spyOnWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

/** `isDevMode()` reads a global, so the production branch is reachable and worth running. */
function withoutDevMode(fn: () => void): void {
  const scope = globalThis as { ngDevMode?: boolean };
  const previous = scope.ngDevMode;
  scope.ngDevMode = false;
  try {
    fn();
  } finally {
    if (previous === undefined) delete scope.ngDevMode;
    else scope.ngDevMode = previous;
  }
}

/**
 * The two traps 0.2.0 keeps (both are 0.1.x behaviour) but now says out loud.
 *
 * Both are *combinations* of options rather than calls: neither is visible at the call site, and
 * neither can be a type error without splitting an API in two. So each is a dev-mode console warning.
 *
 * Every message is printed at most once per session (`warnDevOnce`), which means **the tests below
 * have to use inputs that produce distinct messages** — two assertions about the same warning in one
 * file would otherwise be one assertion and one silence. That is why the timeout values are odd
 * numbers that exist only here.
 */
describe('dev warnings', () => {
  beforeEach(() => {
    // Spec files share this module in one worker, and `create-request.spec.ts` deliberately makes
    // POST/PATCH calls. Without this, the warning has already been printed before the spy exists
    // and the assertion depends on which file ran first.
    resetDevWarningsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timeout combined with retry', () => {
    it('warns once per message, with the way out', () => {
      const warn = spyOnWarn();
      normalizeRetry(2, { timeout: 1_234 });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('retryTimeouts');
      expect(warn.mock.calls[0][0]).toContain('timeout: 1234');

      // A second handle is not a second mistake — a component on a revisited route rebuilds this
      // every time, and a warning that repeats is a warning that gets filtered.
      normalizeRetry(3, { timeout: 1_234 });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('is quiet when `retryTimeouts: false` already answers it', () => {
      const warn = spyOnWarn();
      normalizeRetry(2, { timeout: 1_235, timeouts: false });
      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet when an explicit `when` already answers it', () => {
      const warn = spyOnWarn();
      normalizeRetry({ count: 2, when: () => true }, { timeout: 1_236 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet when nothing would be retried', () => {
      // A warning about a retry that cannot happen is noise, so the policy has to exist first.
      const warn = spyOnWarn();
      normalizeRetry(undefined, { timeout: 1_237 });
      normalizeRetry(false, { timeout: 1_238 });
      normalizeRetry(0, { timeout: 1_239 });
      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet without a timeout', () => {
      const warn = spyOnWarn();
      normalizeRetry(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet outside dev mode', () => {
      const warn = spyOnWarn();
      withoutDevMode(() => normalizeRetry(2, { timeout: 1_240 }));
      expect(warn).not.toHaveBeenCalled();
    });

    it('fires from a real request that sets both', async () => {
      // The wiring end to end: the builder is what passes the request's own `timeout` into the
      // policy, and the global config is what supplies the retry that makes it dangerous.
      const warn = spyOnWarn();
      const { create } = setup([provideSignalRequest({ retry: 1 })]);
      create(() => createRequest<number>('/slow', { timeout: 1_241 }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('timeout: 1241');
      await settle();
    });
  });

  describe('write-shaped createRequest', () => {
    it('warns about a non-lazy write, once', async () => {
      const warn = spyOnWarn();
      const { create } = setup();
      create(() => createRequest.post<number>(() => ({ url: '/save', body: {} })));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('createRequest.post');
      expect(warn.mock.calls[0][0]).toContain('createMutation');
      expect(warn.mock.calls[0][0]).toContain('lazy: true');

      create(() => createRequest.post<number>(() => ({ url: '/save', body: {} })));
      expect(warn).toHaveBeenCalledTimes(1);
      await settle();
    });

    it('is quiet for `lazy: true`, which is the documented way to do this', async () => {
      const warn = spyOnWarn();
      const { create } = setup();
      create(() => createRequest.put<number>(() => ({ url: '/save', body: {} }), { lazy: true }));
      await settle();

      expect(warn).not.toHaveBeenCalled();
    });

    it('is quiet for a GET, which is what createRequest is for', async () => {
      const warn = spyOnWarn();
      const { create } = setup();
      create(() => createRequest<number>('/items'));
      await settle();

      expect(warn).not.toHaveBeenCalled();
    });

    it('warns just the same for a cached write', async () => {
      // The cache does not make it safe: the handle still re-fires on every signal its source reads.
      const warn = spyOnWarn();
      const { create } = setup([provideSignalRequest({ gcTime: 60_000 })]);
      create(() =>
        createRequest.patch<number>(() => ({ url: '/save', body: {} }), { key: () => ['save'] }),
      );
      await settle();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('createRequest.patch');
      expect(cache().size).toBe(1);
    });

    it('is quiet outside dev mode', async () => {
      const warn = spyOnWarn();
      withoutDevMode(() => {
        const { create } = setup();
        create(() => createRequest.delete<number>('/item/1'));
      });
      await settle();

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
