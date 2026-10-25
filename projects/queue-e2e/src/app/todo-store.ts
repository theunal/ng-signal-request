import { Injectable, signal } from '@angular/core';
import { createMutation, type MutationPersistenceOptions } from 'ng-signal-request';

/** A row on screen. `state` is the display half of the queue's entry state, not a copy of it. */
export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly state: 'pending' | 'saved';
}

/**
 * The application half of the durable queue.
 *
 * It is a root service rather than a component field because the provider constructs it from
 * `eager: [TodoStore]`: the handler a hydrated entry needs must exist before automatic replay
 * looks at the queue, and a component is created after that point.
 *
 * The optimistic row lives in a plain signal instead of a `target` cache key on purpose. The
 * cache is not what this app is testing, and a cached list would let a restore from
 * `/persist` hide the queue's own `onRestore` - the thing the e2e is about.
 */
@Injectable({ providedIn: 'root' })
export class TodoStore {
  readonly todos = signal<readonly Todo[]>([]);

  private readonly persistence: MutationPersistenceOptions<string> = {
    key: 'e2e.todos.add',
    // Runs after hydration and before replay, so the row the user saw offline is on screen
    // again while the write is still pending. It never runs for a `failed` entry.
    onRestore: (title, entry) => {
      this.upsert({ id: entry.id, title, state: 'pending' });
    },
  };

  readonly add = createMutation<Todo, string>((title) => ({ url: '/api/todos', body: { title } }), {
    networkMode: 'online',
    persistence: this.persistence,
    onSuccess: (_todo, title) => {
      this.replace(title, 'saved');
    },
    // A permanent failure rolls the optimistic row back, exactly as it does without persistence.
    onError: (_error, title) => {
      this.remove(title);
    },
  });

  /** The optimistic write, before the queue has even answered. */
  submit(title: string): void {
    this.upsert({ id: `local:${title}`, title, state: 'pending' });
    void this.add.run(title).catch(() => undefined);
  }

  private upsert(todo: Todo): void {
    this.todos.update((current) => [
      ...current.filter((candidate) => candidate.title !== todo.title),
      todo,
    ]);
  }

  private replace(title: string, state: Todo['state']): void {
    this.todos.update((current) =>
      current.map((candidate) => (candidate.title === title ? { ...candidate, state } : candidate)),
    );
  }

  private remove(title: string): void {
    this.todos.update((current) => current.filter((candidate) => candidate.title !== title));
  }
}
