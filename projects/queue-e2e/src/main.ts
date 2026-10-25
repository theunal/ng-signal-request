import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { providePersistedMutationQueue } from 'ng-signal-request/persist/queue';

import { AppComponent } from './app/app.component';
import { TodoStore } from './app/todo-store';

/**
 * No `storage` option: the app takes the production default (IndexedDB, `localStorage` fallback),
 * which is the part the unit suite cannot exercise because jsdom has no IndexedDB.
 *
 * `eager: [TodoStore]` is what makes the first page after a reload work: the store registers the
 * handler for `e2e.todos.add` before automatic replay inspects the hydrated entries.
 */
bootstrapApplication(AppComponent, {
  providers: [provideHttpClient(), providePersistedMutationQueue({ eager: [TodoStore] })],
}).catch((error: unknown) => console.error(error));
