import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The offline path, against a real browser.
 *
 * The unit suite drives a fake `OnlineManager`, which is the right seam for the queue's state
 * machine but says nothing about the thing the manager actually listens to. Here the browser is
 * taken offline by Playwright, so `navigator.onLine`, the window's `offline` / `online` events and
 * their ordering are all real. The API is mocked at the network layer so request counts are exact
 * and the check does not depend on jsonplaceholder being reachable.
 */

const API = 'https://jsonplaceholder.typicode.com';

const POSTS = [
  { userId: 1, id: 1, title: 'one', body: '' },
  { userId: 1, id: 2, title: 'two', body: '' },
  { userId: 1, id: 3, title: 'three', body: '' },
  { userId: 1, id: 4, title: 'four', body: '' },
  { userId: 1, id: 5, title: 'five', body: '' },
];

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly limit: string | null;
  readonly body: unknown;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/** Mocks the demo's API and records what actually left the page. */
async function mockApi(context: BrowserContext, seen: Seen[]): Promise<void> {
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    seen.push({
      method,
      path: url.pathname,
      limit: url.searchParams.get('_limit'),
      body: request.postDataJSON(),
    });

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (method === 'POST') {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      await route.fulfill({ status: 201, headers: CORS, json: { id: 99, ...body } });
      return;
    }
    await route.fulfill({ status: 200, headers: CORS, json: POSTS });
  });
}

/** The offline section's own list: the default tab asks for `/posts` without a limit. */
function offlineGets(seen: Seen[]): Seen[] {
  return seen.filter((entry) => entry.method === 'GET' && entry.limit === '5');
}

function postWrites(seen: Seen[]): Seen[] {
  return seen.filter((entry) => entry.method === 'POST' && entry.path === '/posts');
}

/** Loads the app, goes offline, then opens the offline tab so its request is created offline. */
async function openOfflineTab(page: Page, context: BrowserContext): Promise<void> {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('ng-signal-request');

  await context.setOffline(true);
  await expect(page.locator('.offline-banner')).toBeVisible();

  await page.getByRole('button', { name: 'Çevrimdışı (offline)' }).click();
  await expect(page.locator('demo-offline')).toBeVisible();
}

async function submit(page: Page, title: string): Promise<void> {
  await page.getByTestId('draft').fill(title);
  await page.getByTestId('submit').click();
}

test('the banner follows the browser and an online-only request waits for a connection', async ({
  page,
  context,
}) => {
  const seen: Seen[] = [];
  await mockApi(context, seen);
  await openOfflineTab(page, context);

  // It never started: `'online'` gates the request before it reaches the network.
  await expect(page.getByTestId('request-paused')).toBeVisible();
  await expect(page.getByTestId('request-state')).toContainText('istek: loading');
  expect(offlineGets(seen)).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.locator('.offline-banner')).toBeHidden();
  await expect(page.getByTestId('posts').getByTestId('post')).toHaveCount(5);
  await expect(page.getByTestId('request-paused')).toBeHidden();

  // One reconnect, one request - not one per `online` event.
  await expect.poll(() => offlineGets(seen).length).toBe(1);
  await expect(page.getByTestId('fetch-count')).toHaveText('1');
});

test('queued mutations replay once, in call order, on reconnect', async ({ page, context }) => {
  const seen: Seen[] = [];
  await mockApi(context, seen);
  await openOfflineTab(page, context);

  await submit(page, 'alpha');
  await submit(page, 'beta');

  // The optimistic writes are already on screen while both calls wait.
  await expect(page.getByTestId('posts').getByTestId('post')).toHaveCount(2);
  await expect(page.getByTestId('mutation-queued')).toBeVisible();
  await expect(page.getByTestId('mutation-state')).toContainText('kuyrukta');
  expect(postWrites(seen)).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByTestId('outcome')).toHaveText('kuyruktaki çağrı sunucuya ulaştı', {
    timeout: 10_000,
  });

  const writes = postWrites(seen);
  expect(writes.map((entry) => (entry.body as { title?: string }).title)).toEqual([
    'alpha',
    'beta',
  ]);
  await expect.poll(() => postWrites(seen).length).toBe(2);
});

test('flapping after the queue settled does not replay anything', async ({ page, context }) => {
  const seen: Seen[] = [];
  await mockApi(context, seen);
  await openOfflineTab(page, context);

  await submit(page, 'gamma');
  await context.setOffline(false);
  await expect(page.getByTestId('outcome')).toHaveText('kuyruktaki çağrı sunucuya ulaştı', {
    timeout: 10_000,
  });
  await expect.poll(() => offlineGets(seen).length).toBe(1);
  const writesBefore = postWrites(seen).length;
  expect(writesBefore).toBe(1);

  // Flap again with nothing waiting. A reconnect is an event, not a licence to resend history.
  for (let i = 0; i < 2; i++) {
    await context.setOffline(true);
    await expect(page.locator('.offline-banner')).toBeVisible();
    await context.setOffline(false);
    await expect(page.locator('.offline-banner')).toBeHidden();
  }

  await page.waitForTimeout(500);
  expect(postWrites(seen)).toHaveLength(writesBefore);
  expect(offlineGets(seen)).toHaveLength(1);
  await expect(page.getByTestId('mutation-queued')).toBeHidden();
  await expect(page.getByTestId('request-paused')).toBeHidden();
});
