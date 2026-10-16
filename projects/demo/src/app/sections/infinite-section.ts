import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { createInfiniteRequest } from 'ng-signal-request';

import type { Post } from '../models';

const PER_PAGE = 10;
/** JSONPlaceholder serves 100 posts, so `_page` 1..10 exist. */
const LAST_PAGE = 10;

@Component({
  selector: 'demo-infinite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>4 · Sonsuz liste — <code>createInfiniteRequest</code></h2>

      <p class="hint">
        Her sayfa <strong>ayrı bir önbellek kaydı</strong>: anahtar
        <code>['demo', 'feed', çalıştırma, sayfa]</code>. Bunun iki sonucu var — bir sayfa
        başka bir bileşenle paylaşılabiliyor, ve <code>invalidate(['demo', 'feed'])</code>
        önek eşleşmesiyle yüklü bütün sayfaları birden tazeliyor.
      </p>

      <div class="row">
        <button
          (click)="feed.fetchNextPage()"
          [disabled]="!feed.hasNextPage() || feed.isFetchingNextPage()">
          {{ feed.isFetchingNextPage() ? 'sayfa yükleniyor…' : 'Daha fazla' }}
        </button>
        <button (click)="feed.reload()" [disabled]="feed.isFetching()">Tümünü tazele</button>
        <button (click)="restart()">Baştan başlat</button>
        <span class="hint">
          {{ feed.response().length }} kayıt · {{ feed.pageParams().length }} sayfa yüklü
        </span>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + feed.status()">{{ feed.status() }}</span>
        @if (feed.isFetching()) {
          <span class="badge busy">ağda</span>
        }
        @if (feed.hasNextPage()) {
          <span class="badge">sonraki sayfa var</span>
        } @else {
          <span class="badge">son sayfa</span>
        }
        @if (feed.requestError(); as error) {
          <span class="badge err">
            {{ error.http() ? 'HTTP ' + error.http()!.status : error.message }}
          </span>
        }
      </div>

      <ul class="list">
        @for (post of feed.response(); track post.id) {
          <li>
            <span class="id">#{{ post.id }}</span>
            <span class="title">{{ post.title }}</span>
          </li>
        } @empty {
          <li class="empty">Henüz yüklenmedi.</li>
        }
      </ul>

      <p class="hint">
        <strong>Baştan başlat</strong> yeni bir anahtar üretiyor:
        <code>key</code> içindeki çalıştırma sayacı artıyor, birikim sıfırlanıyor ve ilk sayfa
        yeniden isteniyor. Eski kayıtlar önbellekte <code>gcTime</code> boyunca kalıyor — bir
        sayfa numarasına geri dönersen ağ isteği olmadan gelir.
      </p>
    </section>
  `,
})
export class InfiniteSection {
  /**
   * Bumped to start over.
   *
   * A reset is a **key change**, not an imperative "clear then fetch": the base key is part of the
   * accumulation's identity, so a new run id makes `pageParams()` derive back to the initial page
   * with no signal write and no ordering to get wrong.
   */
  private readonly run = signal(0);

  protected readonly feed = createInfiniteRequest<Post[], number>(
    (page) => ({ url: '/posts', params: { _page: page, _limit: PER_PAGE } }),
    {
      key: () => ['demo', 'feed', this.run()],
      initialPageParam: 1,
      // The API says "that was the last full page" by returning fewer rows than asked for.
      getNextPageParam: (last, _all, page) =>
        last && last.length === PER_PAGE && page < LAST_PAGE ? page + 1 : undefined,
      debugName: 'demo:feed',
    },
  );

  protected restart(): void {
    this.run.update((n) => n + 1);
  }
}
