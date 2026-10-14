import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { createMutation, createRequest } from 'ng-signal-request';

import type { Post } from '../models';

/** The params bag. `page` / `perPage` become the query string; the library routes them there. */
interface PageQuery {
  page: number;
  perPage: number;
}

const PER_PAGE = 10;
/** JSONPlaceholder serves 100 posts, so pages 1..10 exist. */
const LAST_PAGE = 10;

@Component({
  selector: 'demo-infinite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>4 · Sonsuz liste — <code>params</code> + <code>update</code></h2>

      <p class="hint">
        Ayrı bir <code>createInfiniteRequest</code> primitifi yok. Üç parça bir araya geliyor:
        <code>params</code> hangi sayfanın istendiğini tutuyor, <code>keepPreviousValue</code>
        yeni sayfa gelene kadar eskiyi ekranda bırakıyor, <code>update()</code> biriktiriyor.
      </p>

      <div class="row">
        <button (click)="loadMore()" [disabled]="!hasMore() || feed.loading()">Daha fazla</button>
        <button (click)="restart()" [disabled]="feed.loading()">Baştan başlat</button>
        <span class="hint">
          {{ rows().length }} kayıt · sayfa {{ page() }}{{ hasMore() ? '' : ' (son sayfa)' }}
        </span>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + feed.status()">{{ feed.status() }}</span>
        @if (feed.loading()) {
          <span class="badge busy">sayfa {{ page() }} yükleniyor</span>
        }
        @if (feed.requestError(); as error) {
          <span class="badge err">
            {{ error.http() ? 'HTTP ' + error.http()!.status : error.message }}
          </span>
        }
      </div>

      <ul class="list">
        @for (post of rows(); track post.id) {
          <li>
            <span class="id">#{{ post.id }}</span>
            <span class="title">{{ post.title }}</span>
          </li>
        } @empty {
          <li class="empty">Henüz yüklenmedi.</li>
        }
      </ul>
    </section>

    <section class="card">
      <h2>Optimistic + otomatik rollback — <code>createMutation</code></h2>
      <p class="hint">
        <code>optimistic</code> listeye anında yazıyor, <code>target</code> bunun nereye
        yazılacağını söylüyor. İstek başarısız olunca liste <em>otomatik</em> geri alınıyor — elle
        bir <code>undo</code> yazmana gerek yok.
      </p>

      <div class="row">
        <input
          class="grow"
          placeholder="yeni başlık…"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)" />
        <button (click)="add()">Ekle</button>
        <button (click)="addFailing()">Hata ile ekle (rollback)</button>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + addPost.status()">add: {{ addPost.status() }}</span>
        <span class="badge" [class]="'badge ' + addRejecting.status()">
          reject: {{ addRejecting.status() }}
        </span>
        @if (outcome(); as text) {
          <span class="badge ok">{{ text }}</span>
        }
      </div>

      <p class="hint">
        JSONPlaceholder yazmaları kabul eder ama <strong>saklamaz</strong>. Başarılı eklemeden
        sonra <code>invalidates</code> listeyi yeniden çektiği için kayıt kaybolur — bu doğru davranış.
        <strong>Hata ile ekle</strong> düğmesi ise <code>/api/reject</code> adresine gider ve hep 500
        döner, yani iyimser kaydın geri alındığını gerçekten izleyebilirsin.
      </p>
    </section>
  `,
})
export class InfiniteSection {
  /** Which page the source is being asked for. */
  protected readonly page = signal(1);
  protected readonly draft = signal('');
  protected readonly outcome = signal<string | null>(null);

  /**
   * One page of the feed, which doubles as the accumulated list.
   *
   * `update()` writes into `response()`, so there is no second signal to keep in sync — and
   * `keepPreviousValue` is what makes that safe: while the next page loads, `response()` would
   * otherwise drop back to `initialValue` and the whole list would blink out.
   */
  protected readonly feed = createRequest<Post[], PageQuery>(
    { url: '/posts' },
    {
      params: { page: 1, perPage: PER_PAGE },
      initialValue: [],
      keepPreviousValue: true,
      onSuccess: (incoming) => this.append(incoming),
      debugName: 'demo:infinite-feed',
    },
  );

  protected rows(): Post[] {
    return this.feed.response();
  }

  /**
   * Which page was appended last, so re-running that page cannot duplicate it.
   *
   * This guard is the honest cost of having no `useInfiniteQuery` "replace page N" semantics:
   * `onSuccess` fires on every settle, including reloads.
   */
  private appendedPage = 0;

  private append(incoming: Post[]): void {
    if (this.appendedPage === this.page()) return;
    this.appendedPage = this.page();
    this.feed.update((accumulated) => [...accumulated, ...incoming]);
  }

  protected hasMore(): boolean {
    return this.page() < LAST_PAGE;
  }

  protected loadMore(): void {
    if (!this.hasMore()) return;
    this.page.update((p) => p + 1);
    // Writing `params` is what fires the request; the source turns the bag into the url.
    this.feed.params.set({ page: this.page(), perPage: PER_PAGE });
  }

  protected restart(): void {
    this.page.set(1);
    this.appendedPage = 0;
    this.feed.update(() => []);
    this.feed.params.set({ page: 1, perPage: PER_PAGE });
  }

  /**
   * Optimistic append with an automatic rollback, against the real API.
   *
   * `target` is the feed itself, so the row is on screen before the request goes out. The demo API
   * accepts the write but does not store it, so `invalidates` refetches and the row disappears —
   * which is the server's truth, not a lost optimistic value.
   */
  protected readonly addPost = createMutation<Post[], string>(
    (title) => ({ url: '/posts', body: { title } }),
    {
      optimistic: (current, title) => [...(current ?? []), { id: -1, userId: 1, title, body: '' }],
      target: this.feed,
      concurrency: 'exhaust',
      invalidates: () => [this.feed],
      onSettled: () => this.outcome.set('sunucu listeyi yeniden çekti'),
    },
  );

  /**
   * The same recipe against a url that always answers 500, so the rollback is observable.
   *
   * Everything except the url is identical — that is the point: the undo is not something the
   * caller writes, it is part of the failed call.
   */
  protected readonly addRejecting = createMutation<Post[], string>(
    (title) => ({ url: '/api/reject', body: { title } }),
    {
      optimistic: (current, title) => [...(current ?? []), { id: -1, userId: 1, title, body: '' }],
      target: this.feed,
      concurrency: 'exhaust',
      retry: false, // a deliberate 500 is not worth retrying
      onSettled: () => {
        const error = this.addRejecting.requestError();
        this.outcome.set(error ? `${error.message} — iyimser kayıt geri alındı` : null);
      },
    },
  );

  protected add(): void {
    const title = this.draft().trim();
    if (!title) return;
    this.outcome.set(null);
    void this.addPost.run(title);
    this.draft.set('');
  }

  protected addFailing(): void {
    this.outcome.set(null);
    void this.addRejecting.run('bu kayıt kaybolacak');
  }
}