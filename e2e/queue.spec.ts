import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The durable mutation queue, against a real browser.
 *
 * jsdom has neither IndexedDB nor Web Locks, so the unit suite can only prove the state machine
 * with a memory `CacheStorage` and a stubbed lock manager. This file proves the parts that only
 * exist in Chromium: the default storage really is IndexedDB, the Web Lock is really acquired, a
 * write really survives the page that created it, and it really replays exactly once.
 *
 * The app under test is `projects/queue-e2e`, not the demo: `check:dist` requires the production
 * demo to contain none of the `/persist/queue` markers. Its API is same-origin (`/api/todos`), so
 * the route mock counts exactly the POSTs and there is no CORS preflight to subtract - the demo's
 * cross-origin mock has that complication, this one does not need it.
 */

const API_PATH = '/api/todos';

interface Post {
  readonly key: string | null;
  readonly body: unknown;
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

/**
 * Mocks the app's write endpoint and records every POST.
 *
 * `gate` is what makes the replay observable: the request is recorded and then held, so a test can
 * assert the restored row and the pending entry *before* the response settles.
 */
async function mockApi(
  context: BrowserContext,
  posts: Post[],
  reply: () => Reply,
  gate?: Promise<void>,
): Promise<void> {
  await context.route(`**${API_PATH}`, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.fulfill({ status: 200, json: [] });
      return;
    }
    const headers: Record<string, string | undefined> = request.headers();
    posts.push({
      key: headers['idempotency-key'] ?? null,
      body: request.postDataJSON(),
    });
    if (gate !== undefined) await gate;
    await route.fulfill({ ...reply() });
  });
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  // The queue is only enabled once storage and the Web Lock are ready, so this is also the
  // assertion that the real browser APIs are the ones being used.
  await expect(page.getByTestId('enabled')).toHaveText('true');
  await expect(page.getByTestId('owner')).toHaveText('true');
}

async function submit(page: Page, title: string): Promise<void> {
  await page.getByTestId('draft').fill(title);
  await page.getByTestId('submit').click();
}

test('a write made offline survives the page and replays once', async ({ page, context }) => {
  const posts: Post[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockApi(context, posts, () => ({ status: 201, json: { id: 1, title: 'alpha' } }), gate);

  await open(page);

  await context.setOffline(true);
  await expect(page.getByTestId('online')).toHaveText('no');

  await submit(page, 'alpha');
  // The optimistic row and the durable entry, with nothing on the wire.
  await expect(page.getByTestId('todo')).toHaveCount(1);
  await expect(page.getByTestId('todo')).toHaveAttribute('data-state', 'pending');
  await expect(page.getByTestId('pending')).toHaveText('1');
  expect(posts).toHaveLength(0);

  // A reload cannot fetch the shell while the context is offline, so the page is closed and a new
  // one is opened. That is the stronger case anyway: nothing at all survives in memory.
  await page.close();
  await context.setOffline(false);

  const next = await context.newPage();
  await next.goto('/');

  // Hydrated from IndexedDB: `onRestore` put the row back while the write is still the queue's.
  await expect(next.getByTestId('todo')).toHaveCount(1);
  await expect(next.getByTestId('todo')).toHaveAttribute('data-state', 'pending');
  await expect(next.getByTestId('pending')).toHaveText('1');

  // Replay reached the server, and the key was minted before the first attempt - the entry is the
  // same one, so the header is the same one it would have sent on the first page.
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect((posts[0].body as { title?: string }).title).toBe('alpha');

  release();
  await expect(next.getByTestId('pending')).toHaveText('0');
  await expect(next.getByTestId('todo')).toHaveAttribute('data-state', 'saved');
  // The entry is gone from the snapshot, not merely marked.
  await expect(next.getByTestId('entries')).not.toContainText('e2e.todos.add');
});

test('a write that reached the server is not replayed after a reload', async ({
  page,
  context,
}) => {
  const posts: Post[] = [];
  await mockApi(context, posts, () => ({ status: 201, json: { id: 2, title: 'beta' } }));

  await open(page);
  await submit(page, 'beta');
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.getByTestId('pending')).toHaveText('0');
  await expect(page.getByTestId('todo')).toHaveAttribute('data-state', 'saved');

  await page.reload();
  await expect(page.getByTestId('enabled')).toHaveText('true');

  // Nothing to restore and nothing to replay: the row is gone because the app keeps no cache, and
  // the POST count does not move. A reconnect is not a licence to resend history.
  await expect(page.getByTestId('todo')).toHaveCount(0);
  await expect(page.getByTestId('pending')).toHaveText('0');
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);
});

test('a waiting tab takes the queue over when the owner goes away', async ({ context }) => {
  const posts: Post[] = [];
  await mockApi(context, posts, () => ({ status: 201, json: { id: 3, title: 'handover' } }));

  const owner = await context.newPage();
  await owner.goto('/');
  await expect(owner.getByTestId('owner')).toHaveText('true');

  // The second tab is a non-owner, but it is queued behind the lock rather than merely refused.
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByTestId('owner')).toHaveText('false');
  await expect(second.getByTestId('enabled')).toHaveText('false');

  await context.setOffline(true);
  await submit(owner, 'handover');
  await expect(owner.getByTestId('pending')).toHaveText('1');
  expect(posts).toHaveLength(0);

  // The owner goes away. The browser grants the queued request, so delivery moves to this tab
  // instead of waiting for a page that will never come back.
  await owner.close();
  await context.setOffline(false);
  await second.bringToFront();

  await expect(second.getByTestId('owner')).toHaveText('true');
  await expect(second.getByTestId('enabled')).toHaveText('true');
  await expect(second.getByTestId('todo')).toHaveCount(1);
  await expect.poll(() => posts.length).toBe(1);
  await expect(second.getByTestId('pending')).toHaveText('0');
  await expect(second.getByTestId('todo')).toHaveAttribute('data-state', 'saved');
});

test('a permanent failure keeps the entry and does not resurrect the row', async ({
  page,
  context,
}) => {
  const posts: Post[] = [];
  await mockApi(context, posts, () => ({ status: 400, json: { message: 'nope' } }));

  await open(page);
  await submit(page, 'gamma');

  // The optimistic row is rolled back, and the failure is a durable state, not a lost call.
  await expect(page.getByTestId('todo')).toHaveCount(0);
  await expect(page.getByTestId('failed')).toHaveText('1');
  await expect(page.getByTestId('entry')).toHaveAttribute('data-state', 'failed');
  expect(posts).toHaveLength(1);

  await page.reload();
  await expect(page.getByTestId('failed')).toHaveText('1');
  await expect(page.getByTestId('entry')).toHaveAttribute('data-state', 'failed');
  // `onRestore` is a pending-entry hook: a failed entry must not put its row back.
  await expect(page.getByTestId('todo')).toHaveCount(0);
  expect(posts).toHaveLength(1);
});
