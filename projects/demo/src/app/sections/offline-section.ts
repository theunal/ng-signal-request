import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { createMutation, createRequest, OnlineManager, QueryClient } from 'ng-signal-request';

import type { LocalPost } from '../models';

/** The one key this page is about: the request writes it, the mutation's optimistic write edits it. */
const POSTS_KEY = ['demo', 'offline', 'posts'] as const;

/**
 * Offline, end to end: a paused request, a queued mutation, and the state behind both.
 *
 * The toggle drives `OnlineManager.setOnline`, which is the same seam the tests use. A real
 * application never calls it: the manager follows the window's `online` / `offline` events, and
 * Chrome's "Offline" throttling fires them. The button exists so the behaviour can be seen without
 * leaving the demo, and the copy says so rather than pretending otherwise.
 */
@Component({
  selector: 'demo-offline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>Offline — <code>networkMode: 'online'</code></h2>
      <p class="hint">
        Tek doğruluk kaynağı <code>OnlineManager</code>. İstek çevrimdışıyken başlamaz, bağlantı
        gelince bir kez başlar; mutation kuyruğa girer ve çağrı sırasıyla oynatılır. İkisi de
        <code>'always'</code> varsayılanıyla aynı kodu kullanır — fark yalnızca bu seçenek.
      </p>

      <div class="row">
        <span class="badge" [class]="online() ? 'badge resolved' : 'badge warn'">
          {{ online() ? 'çevrimiçi' : 'çevrimdışı' }}
        </span>
        <button type="button" (click)="toggle()">
          {{ online() ? 'Bağlantıyı kes (simüle)' : 'Bağlantıyı geri ver' }}
        </button>
        <button type="button" (click)="reload()">Yeniden yükle</button>
      </div>

      <p class="hint">
        istek: <code>{{ posts.status() }}</code>
        @if (posts.paused()) {
          <span class="badge warn">paused</span>
        }
        · {{ posts.response().length }} kayıt · fetchCount {{ posts.fetchCount() }}
      </p>

      <ul class="list">
        @for (post of posts.response(); track post.id) {
          <li>
            <span class="badge" [class]="post.local ? 'badge local' : 'badge'">
              {{ post.local ? 'iyimser' : 'sunucu' }}
            </span>
            {{ post.title }}
          </li>
        }
      </ul>

      <form (submit)="submit($event)">
        <div class="row">
          <label class="grow">
            başlık
            <input
              name="title"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              placeholder="çevrimdışıyken yaz"
              required
            />
          </label>
          <button type="submit">Ekle</button>
          <button type="button" (click)="cancelQueued()" [disabled]="!add.paused()">
            Kuyruktakini iptal et
          </button>
        </div>
      </form>

      <p class="hint">
        mutation: <code>{{ add.status() }}</code>
        @if (add.paused()) {
          <span class="badge warn">kuyrukta</span>
        }
        @if (mutating()) {
          <span class="badge busy">isMutating</span>
        }
        @if (outcome(); as text) {
          · {{ text }}
        }
      </p>

      <p class="hint">
        İyimser satır <b>hemen</b> görünür ve yalnızca nihai hata ya da iptalde geri alınır.
        <code>onSuccess</code> oynatılan çağrı başarılı olduktan sonra çalışır. Kuyruk bellekte
        tutulur: sayfa yenilenirse bekleyen yazılar kaybolur (README → Known limitations).
      </p>
    </section>
  `,
})
export class OfflineSection {
  private readonly manager = inject(OnlineManager);
  private readonly client = inject(QueryClient);

  protected readonly online = this.manager.online;
  protected readonly draft = signal('');
  protected readonly outcome = signal<string | null>(null);

  /** `'online'`: çevrimdışıyken başlamaz; bağlantı gelince tek bir kez başlar. */
  protected readonly posts = createRequest<LocalPost[]>('/posts?_limit=5', {
    key: () => [...POSTS_KEY],
    networkMode: 'online',
    initialValue: [],
    debugName: 'demo:offline',
  });

  /**
   * `'online'` bir mutation: çağrı kuyruğa girer, `run()` sözü oynatılıp bitene kadar bekler.
   *
   * `invalidates` yok — JSONPlaceholder yazıyı saklamadığı için tazeleme iyimser satırı silerdi.
   * Gerçek bir API'de burada `invalidates` olurdu.
   */
  protected readonly add = createMutation<LocalPost[], string>(
    (title) => ({ url: '/posts', body: { title } }),
    {
      mutationKey: [...POSTS_KEY],
      target: [...POSTS_KEY],
      networkMode: 'online',
      optimistic: (current, title) => [
        ...(current ?? []),
        { userId: 1, id: -1, title, body: 'çevrimdışı eklendi', local: true },
      ],
      onSuccess: () => this.outcome.set('kuyruktaki çağrı sunucuya ulaştı'),
      onError: (error) => this.outcome.set(error.message),
    },
  );

  /** A signal, so the template can read it and a group filter narrows it to this page. */
  protected readonly mutating = this.client.isMutating(['demo', 'offline']);

  protected toggle(): void {
    this.manager.setOnline(!this.online());
  }

  protected reload(): void {
    this.outcome.set(null);
    void this.posts.run();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const title = this.draft().trim();
    if (!title) return;
    this.outcome.set(null);
    // The promise stays pending while offline; awaiting it here would only suspend the handler.
    void this.add.run(title);
    this.draft.set('');
  }

  protected cancelQueued(): void {
    this.add.cancel();
    this.outcome.set('kuyruktaki çağrı iptal edildi, iyimser satır geri alındı');
  }
}
