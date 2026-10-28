import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRequest, provideSignalRequest } from '../public-api';
import { resetDevWarningsForTests } from './utils';
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
 * The one trap that survived the 0.3.0 `retryTimeouts` flip: a write-shaped `createRequest`.
 *
 * It is a *combination* of options rather than a call, so it is not visible at the call site and
 * cannot be a type error without splitting an API in two. That is why it is a dev-mode console
 * warning. The timeout-and-retry warning that used to live next to it was retired with the flip:
 * the default it warned about is now the opt-in behaviour.
 *
 * Every message is printed at most once per session (`warnDevOnce`), which means **the tests below
 * have to use inputs that produce distinct messages** — two assertions about the same warning in one
 * file would otherwise be one assertion and one silence.
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
