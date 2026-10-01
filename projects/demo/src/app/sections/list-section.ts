import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { createRequest } from 'ng-signal-request';

import type { Comment, LocalPost, Post } from '../models';

/**
 * The `params` bag: `page` / `perPage` go to the query string, `path` fills the `:id`
 * placeholder in the url, `headers` are attached to the request. The library routes them.
 */
interface ListParams {
  page: number;
  perPage: number;
  path: { userId: number };
  headers: Record<string, string>;
}

@Component({
  selector: 'demo-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>1 · Liste — <code>createRequest</code></h2>

      <div class="row">
        <label>
          Sayfa
          <input type="number" min="1" max="10" [value]="page()" (input)="changePage($event)" />
        </label>
        <label>
          Sayfa başına
          <select [value]="perPage()" (change)="changePerPage($event)">
            <option [value]="5">5</option>
            <option [value]="10">10</option>
          </select>
        </label>
        <label class="grow">
          Yerel filtre
          <input type="search" placeholder="başlıkta ara…" [value]="term()" (input)="term.set($any($event.target).value)" />
        </label>
      </div>

      <div class="row">
        <button (click)="list.reload()">Yenile</button>
        <button (click)="list.cancel()" [disabled]="!list.loading()">İptal</button>
        <button (click)="loadLazy()">Lazy yükle (run)</button>
        <button (click)="disable()" [disabled]="!params()">params = undefined</button>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + list.status()">{{ list.status() }}</span>
        <span class="badge" [class.ok]="list.success()">success: {{ list.success() }}</span>
        @if (list.initialLoading()) {
          <span class="badge busy">initialLoading</span>
        } @else if (list.loading()) {
          <span class="badge busy">loading</span>
        }
        @if (list.retryAttempt() > 0) {
          <span class="badge warn">retry #{{ list.retryAttempt() }}</span>
        }
        <span class="badge">HTTP {{ list.statusCode() ?? '—' }}</span>
        @if (list.error(); as error) {
          <span class="badge err">{{ error.message }}</span>
        }
      </div>

      @if (list.loading() && filtered().length > 0) {
        <p class="hint">keepPreviousValue: sayfa değişti, eski liste ekranda kaldı.</p>
      }

      <ul class="list">
        @for (post of filtered(); track post.id) {
          <li>
            <span class="id">#{{ post.id }}</span>
            <span class="title">{{ post.title }}</span>
            @if (post.local) {
              <span class="badge local">sadece tarayıcıda</span>
            }
            <button class="link" (click)="openComments(post)">yorumlar →</button>
          </li>
        } @empty {
          <li class="empty">Sonuç yok.</li>
        }
      </ul>

      <div class="row">
        <span class="hint">{{ filtered().length }} / {{ list.response().length }} kayıt</span>
        <button (click)="addLocal()">Optimistic ekle (update)</button>
        <button (click)="renameFirst()" [disabled]="list.response().length === 0">
          İlkini değiştir (set)
        </button>
        <button (click)="list.destroy()">destroy</button>
      </div>
    </section>

    <section class="card">
      <h2>Bağımlı istek — <code>ctx.chain</code></h2>
      @if (selectedId() === null) {
        <p class="hint">Bir başlığa tıkla; yorum isteği, önce o postu bekler.</p>
      } @else {
        <div class="status">
          <span class="badge" [class]="'badge ' + detail.status()">post: {{ detail.status() }}</span>
          <span class="badge" [class]="'badge ' + comments.status()">
            yorumlar: {{ comments.status() }}
          </span>
          <span class="badge">post #{{ selectedId() }}</span>
        </div>

        @if (detail.response(); as post) {
          <p class="hint"><strong>{{ post.title }}</strong></p>
        }

        <ul class="list">
          @for (comment of comments.response(); track comment.id) {
            <li>
              <span class="title">{{ comment.name }}</span>
              <span class="hint">{{ comment.body }}</span>
            </li>
          } @empty {
            <li class="empty">Yorum yok.</li>
          }
        </ul>
        <button (click)="selectedId.set(null)">Kapat</button>
      }
    </section>
  `,
})
export class ListSection {
  protected readonly page = signal(1);
  protected readonly perPage = signal(10);
  protected readonly term = signal('');
  protected readonly selectedId = signal<number | null>(null);

  /**
   * The main query. The library built `params` from the second type argument, so
   * `params.set()` is all it takes to re-fire it.
   */
  protected readonly list = createRequest<LocalPost[], ListParams>(
    {
      url: '/posts',
    },
    {
      params: {
        page: 1, perPage: 10,
        path: {
          userId: 1
        },
        headers: {
          'x-demo': 'list'
        }
      },
      keepPreviousValue: true,
      initialValue: [],
      retry: 2,
      debugName: 'demo:posts',
    },
  );

  /** Lazy: nothing is sent until `run()` is called. */
  private readonly lazyList = createRequest<LocalPost[]>(
    { url: '/posts' },
    { lazy: true, retry: 0 },
  );

  /** Upstream of the chain. */
  private readonly detail = createRequest<Post, { postId: number }>(
    { url: '/posts/:id' },
    { params: { postId: 1 } },
  );

  /**
   * `ctx.chain` — this request parks in `loading` until `detail` resolves, then builds its
   * url from the resolved post. No second round-trip for the post, no `undefined` in the url.
   */
  protected readonly comments = createRequest<Comment[], { postId: number }>(
    (params, ctx) => ({
      // `!` is only needed for the type system: `detail.resource` is `Post | undefined`
      // because it has no `initialValue`. At runtime chain() resolves exactly when the value
      // IS there, and parks us in `loading` otherwise.
      url: `/posts/${ctx.chain(this.detail.resource)!.id}/comments`,
      params,
    }),
    { params: { postId: 1 }, initialValue: [] },
  );

  /** JSONPlaceholder does not filter server-side, so the visible filter is local. */
  protected readonly filtered = computed(() => {
    const term = this.term().trim().toLowerCase();
    const all = this.list.response();
    return term ? all.filter((p) => p.title.toLowerCase().includes(term)) : all;
  });

  protected params(): ListParams | undefined {
    return this.list.params();
  }

  protected changePage(event: Event): void {
    const page = Math.max(1, Number((event.target as HTMLInputElement).value) || 1);
    this.page.set(page);
    this.list.params.set({ ...this.list.params()!, page });
  }

  protected changePerPage(event: Event): void {
    const perPage = Number((event.target as HTMLSelectElement).value) || 10;
    this.perPage.set(perPage);
    this.list.params.set({ ...this.list.params()!, perPage });
  }

  /** `undefined` disables the request entirely. */
  protected disable(): void {
    this.list.params.set(undefined);
  }

  protected async loadLazy(): Promise<void> {
    const result = await this.lazyList.tryRun();
    if (!result.ok) {
      console.warn('lazy istek başarısız:', result.error.message);
      return;
    }
    console.log('lazy istek döndü:', result.response.length, 'kayıt');
  }

  /** `update()` writes a local value: status becomes 'local', no request is sent. */
  protected addLocal(): void {
    const next: LocalPost = {
      userId: 1,
      id: Date.now(),
      title: `yerel kayıt ${new Date().toLocaleTimeString()}`,
      body: 'Sadece bu tarayıcıda var.',
      local: true,
    };
    this.list.update((current) => [next, ...current]);
  }

  /** `set()` overwrites the whole value. */
  protected renameFirst(): void {
    const all = this.list.response();
    const first = all[0];
    if (!first) return;
    this.list.set([{ ...first, title: `${first.title} (düzenlendi)` }, ...all.slice(1)]);
  }

  protected openComments(post: LocalPost): void {
    this.selectedId.set(post.id);
    this.detail.params.set({ postId: post.id });
  }
}
