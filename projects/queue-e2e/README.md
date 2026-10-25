# Durable-queue e2e app

A three-file Angular app that exists to be driven by `e2e/queue.spec.ts`. It is not
a demo and there is nothing to browse: the screen is a form, the rows it produced,
and the queue's own signals.

```bash
pnpm build:e2e-queue   # production build -> dist/queue-e2e
pnpm test:e2e          # builds both apps, then runs Playwright
```

## Why it is not a tab in `projects/demo`

`pnpm check:dist` asserts that the production demo contains none of the
`/persist/queue` markers, which is how the "a demo that does not import it ships
none of it" claim is measured. Importing the provider there would delete that
assertion. A separate app keeps both: the demo stays the tree-shaking control, and
the queue gets a real browser.

## What it takes from production

- **No `storage` option**, so the default is the one under test: IndexedDB, with
  `localStorage` as the fallback. jsdom has neither, which is the whole reason this
  app exists.
- **`eager: [TodoStore]`**, so the handler for `e2e.todos.add` is registered before
  automatic replay inspects the hydrated entries after a reload.
- **A same-origin API** (`/api/todos`), so the Playwright route mock counts exactly
  the POSTs. The demo's cross-origin mock has to subtract CORS preflights; this one
  does not.

The optimistic row is a plain signal rather than a `target` cache key on purpose: a
`/persist` restore of a cached list would be indistinguishable from the queue's own
`onRestore`, and the e2e is about the latter.
