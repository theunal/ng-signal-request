import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { createMutation, createRequest, QueryClient } from 'ng-signal-request';

import type { Post } from '../models';

/** The one key this page is about. Written by the mutation, read from three places. */
const POSTS_KEY = ['demo', 'cache', 'posts'] as const;

/**
 * The second reader of the same key.
 *
 * A component of its own rather than the same handle read twice, because that is the claim being
 * made: two independent components, one cache entry, one request. `fetchCount` counts the entry's
 * round-trips and stays at 1 while both are on screen.
 */
@Component({
  selector: 'demo-cache-twin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="twin">
      <strong>ikinci bileşen</strong>
      <span class="badge" [class]="'badge ' + posts.status()">{{ posts.status() }}</span>
      <span class="hint">
        {{ posts.response().length }} kayıt · fetchCount {{ posts.fetchCount() }} · aynı kayıt
      </span>
    </div>
  `,
})
export class CacheTwinSection {
  protected readonly posts = createRequest<Post[]>('/posts?_limit=5', {
    key: () => [...POSTS_KEY],
    initialValue: [],
    staleTime: 30_000,
    debugName: 'demo:cache-twin',
  });
}

@Component({
  selector: 'demo-cache',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CacheTwinSection],
  template: `
    <section class="card">
      <h2>5 · Paylaşılan önbellek — <code>key</code> + <code>invalidate</code></h2>

      <p class="hint">
        Aşağıdaki iki bileşen <em>aynı</em> anahtarı okuyor:
        <code>['demo', 'cache', 'posts']</code>. İki istek gitmiyor — kayıt paylaşılıyor.
        <strong>fetchCount</strong> ağ isteği sayısıdır ve ikisinde de aynı sayıdır.
      </p>

      <div class="status">
        <span class="badge" [class]="'badge ' + posts.status()">bu bileşen: {{ posts.status() }}</span>
        <span class="badge">fetchCount: {{ posts.fetchCount() }}</span>
        <span class="badge">son veri: {{ updated() }}</span>
        @if (posts.loading()) {
          <span class="badge busy">ağda</span>
        }
      </div>

      <demo-cache-twin />

      <div class="row">
        <button (click)="invalidate()">invalidate(['demo','cache'])
          @if (invalidated(); as count) { <span>({{ count }} kayıt)</span> }
        </button>
        <button (click)="posts.reload()">reload() — yalnızca bu handle</button>
        <button (click)="renameFirst()" [disabled]="posts.response().length === 0">
          setData ile ilkini değiştir
        </button>
      </div>

      <p class="hint">
        <strong>invalidate</strong> anahtarı <em>işaretler</em>; açık olan kayıtları tazelemek
        <code>QueryClient</code>'ın işi. Önek eşleştiği için
        <code>invalidate(['demo'])</code> daha geniş, <code>['demo','cache','posts']</code> daha
        dar çalışır. <strong>setData</strong> ise yerel bir yazma: ağ isteği yok, durum
        <code>local</code> olur.
      </p>
    </section>

    <section class="card">
      <h2>Anahtarla optimistic yazma — ve otomatik rollback</h2>

      <p class="hint">
        <code>target</code> ve <code>invalidates</code> burada <strong>anahtar</strong> olarak
        veriliyor, handle olarak değil. Mutation elinde hiçbir handle tutmuyor: yazdığı yer,
        sonra tazelediği yer, ikisi de anahtar.
      </p>

      <div class="row">
        <input
          class="grow"
          placeholder="yeni başlık…"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)" />
        <button (click)="submit()" [disabled]="!draft().trim()">Ekle</button>
        <button (click)="addFailing()">Hata ile ekle</button>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + add.status()">add: {{ add.status() }}</span>
        <span class="badge" [class]="'badge ' + addRejecting.status()">
          reject: {{ addRejecting.status() }}
        </span>
        @if (writing()) {
          <span class="badge busy">isMutating: yazılıyor…</span>
        }
        @if (outcome(); as text) {
          <span class="badge ok">{{ text }}</span>
        }
      </div>

      <ul class="list">
        @for (post of posts.response(); track post.id) {
          <li>
            <span class="id">#{{ post.id }}</span>
            <span class="title">{{ post.title }}</span>
            @if (post.id === -1) {
              <span class="badge local">iyimser</span>
            }
          </li>
        } @empty {
          <li class="empty">Henüz yüklenmedi.</li>
        }
      </ul>

      <p class="hint">
        JSONPlaceholder yazmayı kabul eder ama <strong>saklamaz</strong>. Başarılı eklemeden sonra
        <code>invalidates</code> listeyi yeniden çektiği için iyimser kayıt kaybolur — bu
        sunucunun doğrusu, kaybolmuş bir iyimser değer değil. <strong>Hata ile ekle</strong>
        <code>/api/reject</code> adresine gider ve hep 500 döner, böylece geri alma gerçekten
        izlenebilir.
      </p>
    </section>
  `,
})
export class CacheSection {
  private readonly client = inject(QueryClient);

  protected readonly draft = signal('');
  protected readonly outcome = signal<string | null>(null);
  protected readonly invalidated = signal<number | null>(null);

  protected readonly posts = createRequest<Post[]>('/posts?_limit=5', {
    key: () => [...POSTS_KEY],
    initialValue: [],
    // Fresh for a while, so `invalidate()` is visibly the reason a refetch happens.
    staleTime: 30_000,
    debugName: 'demo:cache',
  });

  protected readonly updated = computed(() => {
    const at = this.posts.dataUpdatedAt();
    return at > 0 ? new Date(at).toLocaleTimeString() : '—';
  });

  /**
   * A group filter over in-flight mutations, not a handle count.
   *
   * Reading it here and the mutation registering `mutationKey` below are the only two halves: a
   * global spinner wants no key, a navigation guard wants one group, and neither holds references
   * to the mutations themselves.
   */
  protected readonly writing = this.client.isMutating(['demo', 'cache']);

  /** Optimistic append addressed by key, so no component has to hand over a handle. */
  protected readonly add = createMutation<Post[], string>(
    (title) => ({ url: '/posts', body: { title } }),
    {
      mutationKey: [...POSTS_KEY],
      target: [...POSTS_KEY],
      invalidates: [[...POSTS_KEY]],
      optimistic: (current, title) => [...(current ?? []), { userId: 1, id: -1, title, body: '' }],
      concurrency: 'exhaust',
      onSettled: () => this.outcome.set('sunucu yanıtladı — liste tazelendi'),
    },
  );

  /**
   * The same recipe against a url that always fails.
   *
   * Everything but the url is identical, which is the point: the undo is not something the caller
   * writes, it is part of the failed call.
   */
  protected readonly addRejecting = createMutation<Post[], string>(
    (title) => ({ url: '/api/reject', body: { title } }),
    {
      mutationKey: [...POSTS_KEY],
      target: [...POSTS_KEY],
      optimistic: (current, title) => [...(current ?? []), { userId: 1, id: -1, title, body: '' }],
      concurrency: 'exhaust',
      retry: false, // a deliberate 500 is not worth retrying
      onSettled: () => {
        const error = this.addRejecting.requestError();
        this.outcome.set(error ? `${error.message} — iyimser kayıt geri alındı` : null);
      },
    },
  );

  protected invalidate(): void {
    this.invalidated.set(this.client.invalidate(['demo', 'cache']));
  }

  protected renameFirst(): void {
    this.invalidated.set(null);
    this.client.setData<Post[]>([...POSTS_KEY], (current) => {
      const first = current?.[0];
      if (!first) return current;
      return [{ ...first, title: `${first.title} (düzenlendi)` }, ...current.slice(1)];
    });
  }

  protected submit(): void {
    const title = this.draft().trim();
    if (!title) return;
    this.outcome.set(null);
    void this.add.run(title);
    this.draft.set('');
  }

  protected addFailing(): void {
    this.outcome.set(null);
    void this.addRejecting.run('bu kayıt kaybolacak');
  }
}
