import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { createRequest } from 'ng-signal-request';

interface SearchParams {
  q: string;
  perPage: number;
}

@Component({
  selector: 'demo-retry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2>3 · Debounce — <code>createRequest</code></h2>
      <p class="hint">
        Her tuş vuruşunda istek atılmıyor; yazma durduktan
        <strong>{{ 300 }}ms</strong> sonra tek istek gidiyor. Sayaç aynı kelime için kaç
        istek atıldığını gösteriyor.
      </p>

      <label class="block">
        Arama
        <input type="search" [value]="term()" (input)="onTerm($event)" placeholder="yazmaya başla…" />
      </label>

      <div class="status">
        <span class="badge" [class]="'badge ' + search.status()">{{ search.status() }}</span>
        <span class="badge" [class.ok]="search.success()">success: {{ search.success() }}</span>
        @if (search.retryAttempt() > 0) {
          <span class="badge warn">retry #{{ search.retryAttempt() }}</span>
        }
        <span class="badge">istek sayısı: {{ requestCount() }}</span>
      </div>

      @if (search.response().length > 0) {
        <ul class="list">
          @for (post of search.response().slice(0, 5); track post.id) {
            <li>
              <span class="id">#{{ post.id }}</span>
              <span class="title">{{ post.title }}</span>
            </li>
          }
        </ul>
      }
      <p class="hint">Not: JSONPlaceholder <code>q</code> parametresini gerçekten filtrelemez.</p>
    </section>

    <section class="card">
      <h2>Retry — <code>{{ '/api/flaky' }}</code></h2>
      <p class="hint">
        Demo interceptor'ı bu adrese ilk iki istekte <code>503</code> döndürüyor.
        <code>retry: 3</code> ile üçüncü denemede başarılı oluyor ve
        <code>retryAttempt()</code> sıfırlanıyor.
      </p>

      <div class="row">
        <button (click)="flaky.reload()">Flaky isteği tetikle</button>
        <button (click)="flaky.cancel()" [disabled]="!flaky.loading()">İptal</button>
      </div>

      <div class="status">
        <span class="badge" [class]="'badge ' + flaky.status()">{{ flaky.status() }}</span>
        @if (flaky.retryAttempt() > 0) {
          <span class="badge warn">retry #{{ flaky.retryAttempt() }}</span>
        }
        @if (flaky.loading()) {
          <span class="badge busy">loading</span>
        }
        @if (flaky.error(); as error) {
          <span class="badge err">{{ error.message }}</span>
        }
      </div>

      @if (flaky.response().length > 0) {
        <p class="hint">Başarılı: {{ flaky.response()[0].title }}</p>
      }
    </section>

    <section class="card">
      <h2>Polling — <code>pollInterval</code></h2>
      <p class="hint">
        Sayaç, <code>running()</code> true olduğu sürece 2 saniyede bir kendini yeniden
        çekiyor. Kapatınca polling de duruyor — aralık reaktif bir fonksiyon.
      </p>

      <div class="row">
        <button (click)="running.set(!running())">
          {{ running() ? 'Polling’i durdur' : 'Polling’i başlat' }}
        </button>
        <span class="badge">ticks: {{ tick.response()?.count ?? 0 }}</span>
        <span class="badge" [class]="'badge ' + tick.status()">{{ tick.status() }}</span>
      </div>
    </section>

    <section class="card">
      <h2>Yavaş istek — <code>cancel()</code></h2>
      <p class="hint">3 saniyelik isteği gönder, sonra iptal et.</p>
      <div class="row">
        <button (click)="slow.reload()">Gönder</button>
        <button (click)="slow.cancel()" [disabled]="!slow.loading()">İptal</button>
      </div>
      <div class="status">
        <span class="badge" [class]="'badge ' + slow.status()">{{ slow.status() }}</span>
        @if (slow.error(); as error) {
          <span class="badge err">{{ error.message }}</span>
        }
      </div>
    </section>

    <section class="card">
      <h2>Ham metin — <code>createRequest.text()</code></h2>
      <p class="hint">Gövde metin olarak okunuyor, JSON ayrıştırılmıyor.</p>
      <div class="row">
        <button (click)="raw.reload()" [disabled]="raw.status() === 'loading'">Yükle</button>
        <span class="badge">HTTP {{ raw.statusCode() ?? '—' }}</span>
        <span class="badge">type: {{ raw.response() ? 'string' : '—' }}</span>
      </div>
      @if (raw.response(); as text) {
        <pre class="code">{{ text.slice(0, 220) }}…</pre>
      }
    </section>
  `,
})
export class RetrySection {
  protected readonly term = signal('');
  protected readonly requestCount = signal(0);
  protected readonly running = signal(false);

  /** The very first request is never debounced, only source changes are. */
  protected readonly search = createRequest<{ id: number; title: string }[], SearchParams>(
    { url: '/posts' },
    {
      params: { q: '', perPage: 5 },
      debounce: 300,
      initialValue: [],
      onSettled: () => this.requestCount.update((n) => n + 1),
    },
  );

  /** Retries: the demo interceptor fails twice, so the third attempt succeeds. */
  protected readonly flaky = createRequest<{ id: number; title: string }[]>(
    { url: '/api/flaky' },
    {
      initialValue: [],
      retry: {
        count: 3,
        delay: (attempt) => attempt * 400,
        // Only transient errors are worth retrying.
        when: (error) => (error as { status?: number }).status !== 404,
      },
      debugName: 'demo:flaky',
    },
  );

  /** Reactive polling interval. */
  protected readonly tick = createRequest<{ count: number }>(
    { url: '/todos' },
    {
      parse: (raw) => ({ count: Array.isArray(raw) ? raw.length : 0 }),
      pollInterval: () => (this.running() ? 2000 : false),
      retry: 0,
      initialValue: undefined,
    },
  );

  /** 3s response, so `cancel()` has something real to abort. */
  protected readonly slow = createRequest<{ title: string }[]>(
    { url: '/api/slow' },
    { initialValue: [], retry: 0 },
  );

  protected readonly raw = createRequest<string>(
    { url: '/posts/1' },
    { lazy: true, retry: 0 },
  );

  protected onTerm(event: Event): void {
    const q = (event.target as HTMLInputElement).value;
    this.term.set(q);
    // One write; `debounce` collapses the rest.
    this.search.params.set({ ...this.search.params()!, q });
  }
}
