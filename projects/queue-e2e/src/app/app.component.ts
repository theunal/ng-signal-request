import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { OnlineManager } from 'ng-signal-request';
import { PersistedMutationQueue } from 'ng-signal-request/persist/queue';

import { TodoStore } from './todo-store';

/**
 * A deliberately small screen: one form, the rows it produced, and the queue's own signals.
 *
 * Every assertion the e2e makes reads either a `data-testid` here or the network, so the component
 * is the test's observability surface and nothing else. The online state is shown rather than
 * toggled - Playwright's `context.setOffline` drives the browser, and `OnlineManager` follows the
 * window events, which is the whole point of doing this in a browser.
 */
@Component({
  selector: 'queue-e2e-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>durable queue e2e</h1>

    <p>
      online: <span data-testid="online">{{ online() ? 'yes' : 'no' }}</span> · owner:
      <span data-testid="owner">{{ queue.owner() }}</span> · enabled:
      <span data-testid="enabled">{{ queue.enabled() }}</span> · replaying:
      <span data-testid="replaying">{{ queue.isReplaying() }}</span>
    </p>

    <form (submit)="submit($event)">
      <input
        name="title"
        data-testid="draft"
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        required
      />
      <button type="submit" data-testid="submit">Add</button>
    </form>

    <ul data-testid="todos">
      @for (todo of store.todos(); track todo.id) {
        <li data-testid="todo" [attr.data-state]="todo.state">{{ todo.title }}</li>
      }
    </ul>

    <p>
      pending: <span data-testid="pending">{{ queue.pendingCount() }}</span> · failed:
      <span data-testid="failed">{{ queue.failedCount() }}</span>
    </p>

    <ul data-testid="entries">
      @for (entry of queue.entries(); track entry.id) {
        <li data-testid="entry" [attr.data-state]="entry.state">
          {{ entry.key }} · {{ entry.state }} · attempts {{ entry.attempts }}
        </li>
      }
    </ul>
  `,
})
export class AppComponent {
  private readonly manager = inject(OnlineManager);
  protected readonly store = inject(TodoStore);
  protected readonly queue = inject(PersistedMutationQueue);
  protected readonly online = this.manager.online;
  protected readonly draft = signal('');

  protected submit(event: Event): void {
    event.preventDefault();
    const title = this.draft().trim();
    if (!title) return;
    this.store.submit(title);
    this.draft.set('');
  }
}
