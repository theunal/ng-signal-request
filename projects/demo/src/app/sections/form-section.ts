import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { createMutation, createRequest } from 'ng-signal-request';

import type { LocalPost, Post } from '../models';

/**
 * `args` behaves like a params bag: `path` fills the url, `body` becomes the request body.
 * The HTTP method is not in the builder, but in the variant you call (`createMutation.put` /
 * `.delete`).
 */
interface PostArgs {
  path: { id: number };
  body: Partial<Pick<Post, 'title' | 'body' | 'userId'>>;
}

@Component({
  selector: 'demo-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>2 · Form — <code>createMutation</code></h2>
      <p class="hint">
        Aynı form iki mutation kullanıyor: <code>exhaust</code> (çift tıklama koruması) ve
        <code>parallel</code>. <code>invalidates</code> sayesinde kaydettikten sonra liste
        otomatik yenileniyor.
      </p>

      <form (submit)="create($event)">
        <div class="row">
          <label class="grow">
            Başlık
            <input name="title" [value]="title()" (input)="title.set($any($event.target).value)" required />
          </label>
          <label>
            Kullanıcı
            <input type="number" name="userId" [value]="userId()" (input)="userId.set(+$any($event.target).value)" />
          </label>
        </div>
        <label class="block">
          Gövde
          <textarea name="body" rows="3" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
        </label>

        <div class="row">
          <button type="submit" [disabled]="createBusy()">Kaydet (exhaust)</button>
          <button type="button" (click)="createParallel($event)" [disabled]="parallelBusy()">
            Hızlı tıklama (parallel)
          </button>
        </div>
      </form>

      <div class="status">
        <span class="badge" [class]="'badge ' + save.status()">exhaust: {{ save.status() }}</span>
        <span class="badge" [class]="'badge ' + rapid.status()">parallel: {{ rapid.status() }}</span>
        @if (save.loading() || rapid.loading()) {
          <span class="badge busy">loading</span>
        }
        @if (save.error(); as error) {
          <span class="badge err">{{ error.message }}</span>
        }
      </div>

      @if (parallelHits() > 1) {
        <p class="hint">
          parallel: {{ parallelHits() }} istek uçtu. exhaust ise yalnızca 1 tanesini
          kabul edip diğerlerinde aynı promise'ı döndürür.
        </p>
      }

      @if (lastSaved(); as saved) {
        <p class="hint">Son cevap: <strong>#{{ saved.id }}</strong> — {{ saved.title }}</p>
      }
    </section>

    <section class="card">
      <h2>Yazma işlemleri — kalıcı değil</h2>
      <div class="row">
        <button (click)="remove()">İlk kaydı sil (DELETE)</button>
        <button (click)="updateFirst()">İlkini güncelle (PUT)</button>
      </div>
      <p class="hint">
        JSONPlaceholder yazma işlemlerini kabul eder (201 / 200 döner) ama saklamaz. Bu
        yüzden kayıtlar bir <code>reload()</code> sonrası kaybolur — demo bunu gizlemek
        yerine gösteriyor. <code>invalidates</code> tetikleyicisi çalıştığını bu sayede
        izleyebilirsin.
      </p>
    </section>
  `,
})
export class FormSection {
  protected readonly title = signal('Yeni kayıt');
  protected readonly body = signal('Demo formundan gelen gövde.');
  protected readonly userId = signal(1);

  protected readonly lastSaved = signal<LocalPost | null>(null);
  protected readonly parallelHits = signal(0);

  /** The list this section invalidates after a successful write. */
  // Note: no explicit `SignalRequest<...>` annotation here. Writing the type by hand would
  // discard the narrowing that `initialValue: []` buys us (`response()` would go back to
  // `LocalPost[] | undefined`).
  private readonly posts = createRequest<LocalPost[]>({ url: '/posts' }, { initialValue: [], retry: 0 });

  /**
   * The builder stays a bare url: `args` carries `path` and `body`, and the library routes
   * them into the request. `concurrency: 'exhaust'` returns the in-flight promise instead
   * of firing again, which is double-click protection.
   */
  protected readonly save = createMutation<Post, PostArgs>(
    () => '/posts',
    {
      concurrency: 'exhaust',
      invalidates: () => [this.posts],
      onSuccess: (post) => this.lastSaved.set({ ...post, local: true }),
      onError: (error) => console.warn('kaydetme hatası:', error.message),
    },
  );

  /** Same endpoint, but every call goes out. */
  protected readonly rapid = createMutation<Post, PostArgs>(() => '/posts', {
    concurrency: 'parallel',
    retry: 0,
  });

  protected createBusy(): boolean {
    return this.save.loading();
  }

  protected parallelBusy(): boolean {
    return this.rapid.loading();
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.title().trim()) return;

    const result = await this.save.tryRun({
      path: { id: 0 },
      body: { title: this.title(), body: this.body(), userId: this.userId() },
    });

    if (!result.ok) {
      console.warn('kaydedilemedi:', result.error.message);
      return;
    }
    this.lastSaved.set({ ...result.response, local: true });
  }

  protected async createParallel(event: Event): Promise<void> {
    event.preventDefault();
    this.parallelHits.update((n) => n + 1);
    await this.rapid.tryRun({
      path: { id: 0 },
      body: { title: this.title(), body: this.body(), userId: this.userId() },
    });
  }

  private readonly deletePost = createMutation.delete<unknown, { path: { id: number } }>(() => ({
    url: '/posts/:id',
  }), { invalidates: () => [this.posts] });

  private readonly updatePost = createMutation.put<Post, PostArgs>(
    () => ({ url: '/posts/:id' }),
    { invalidates: () => [this.posts] },
  );

  protected async remove(): Promise<void> {
    const first = this.posts.response()[0];
    if (!first) return;
    const result = await this.deletePost.tryRun({ path: { id: first.id } });
    console.log('DELETE sonucu:', result.ok ? '200 OK' : result.error.message);
  }

  protected async updateFirst(): Promise<void> {
    const first = this.posts.response()[0];
    if (!first) return;
    const result = await this.updatePost.tryRun({
      path: { id: first.id },
      body: { ...first, title: `${first.title} (PUT)` },
    });
    console.log('PUT sonucu:', result.ok ? result.response.id : result.error.message);
  }
}
