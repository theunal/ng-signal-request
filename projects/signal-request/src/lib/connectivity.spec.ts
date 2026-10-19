import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS_ONLINE, OnlineManager } from './connectivity';
import { setup } from '../../testing/testing';

/* `readInitialOnline` reads a global, and `onLine` is a getter on `Navigator.prototype` in jsdom, so
 * an own property on the instance is the only way to change it. Same technique as `errors.spec.ts`. */
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');

function setOnLine(onLine: unknown): void {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: onLine });
}

function removeNavigator(): void {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
}

afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  const current: { onLine?: unknown } = globalThis.navigator;
  if (onLineDescriptor) Object.defineProperty(current, 'onLine', onLineDescriptor);
  else delete current.onLine;
});

/** One turn of the microtask queue; `apply` announces through a microtask. */
const turn = (): Promise<void> => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('OnlineManager', () => {
  it('starts online when `navigator` makes no report', () => {
    setup();
    setOnLine(undefined);

    expect(TestBed.inject(OnlineManager).online()).toBe(true);
  });

  it('starts online when `navigator` itself is absent', () => {
    setup();
    removeNavigator();

    expect(TestBed.inject(OnlineManager).online()).toBe(true);
  });

  it('starts offline when the browser says so', () => {
    setup();
    setOnLine(false);

    expect(TestBed.inject(OnlineManager).online()).toBe(false);
  });

  it('tracks the window offline and online events', async () => {
    setup();
    const manager = TestBed.inject(OnlineManager);

    window.dispatchEvent(new Event('offline'));
    expect(manager.online()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(manager.online()).toBe(true);
    await turn();
  });

  it('coalesces a burst of reconnects into one notification', async () => {
    setup();
    const manager = TestBed.inject(OnlineManager);
    const listener = vi.fn();
    manager.onReconnect(listener);

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    expect(listener).not.toHaveBeenCalled();

    await turn();
    expect(listener).toHaveBeenCalledTimes(1);

    // A later reconnect is a new notification, not a swallowed one.
    window.dispatchEvent(new Event('online'));
    await turn();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('announces a reconnect from `setOnline(true)` but never from `setOnline(false)`', async () => {
    setup();
    const manager = TestBed.inject(OnlineManager);
    const listener = vi.fn();
    manager.onReconnect(listener);

    manager.setOnline(false);
    await turn();
    expect(manager.online()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    manager.setOnline(true);
    await turn();
    expect(manager.online()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    setup();
    const manager = TestBed.inject(OnlineManager);
    const listener = vi.fn();
    const detach = manager.onReconnect(listener);
    detach();

    manager.setOnline(true);
    await turn();

    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates a listener that unsubscribes itself while being notified', async () => {
    setup();
    const manager = TestBed.inject(OnlineManager);
    const second = vi.fn();
    const detach = manager.onReconnect(() => detach());
    manager.onReconnect(second);

    manager.setOnline(true);
    await turn();

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('registers no timer and no window listener on the server', () => {
    setup([{ provide: PLATFORM_ID, useValue: 'server' }]);
    const add = vi.spyOn(window, 'addEventListener');
    vi.useFakeTimers();
    try {
      const manager = TestBed.inject(OnlineManager);

      expect(manager.online()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(add.mock.calls.filter(([type]) => type === 'online' || type === 'offline')).toEqual(
        [],
      );

      // Nothing is listening, and the seam cannot pretend otherwise: a render is always online.
      window.dispatchEvent(new Event('offline'));
      manager.setOnline(false);
      expect(manager.online()).toBe(true);
    } finally {
      add.mockRestore();
      vi.useRealTimers();
    }
  });

  it('removes its window listeners when the injector is destroyed', () => {
    setup();
    TestBed.inject(OnlineManager);
    const remove = vi.spyOn(window, 'removeEventListener');

    TestBed.resetTestingModule();

    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(['offline', 'online']);
    remove.mockRestore();
  });
});

describe('ALWAYS_ONLINE', () => {
  it('is always online and has nobody to notify', () => {
    expect(ALWAYS_ONLINE.online()).toBe(true);

    const listener = vi.fn();
    const detach = ALWAYS_ONLINE.onReconnect(listener);
    detach();
    expect(listener).not.toHaveBeenCalled();
  });
});
