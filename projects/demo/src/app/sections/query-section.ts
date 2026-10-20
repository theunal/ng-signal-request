import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, PLATFORM_ID, signal } from '@angular/core';
import { createQuery, createRequest } from 'ng-signal-request';
import { map, timer } from 'rxjs';

import type { LocalPost } from '../models';

/** Where the non-HTTP source reads and writes. */
const DRAFT_KEY = 'ngsr:demo:draft';

/** The one key an HTTP request and a query deliberately share on this page. */
const SHARED_KEY = ['demo', 'query', 'shared'] as const;

/**
 * `createQuery`: the same cache and handle, with a source that is not `HttpClient`.
 *
 * Two sources that `httpResource` cannot express — a `localStorage` read and an Observable
 * timer — and one entry shared with a keyed `createRequest`, which is the property that made
 * `createQuery` part of the cache rather than a second primitive.
 *
 * The shared key is used by two different factories on purpose, to show the dedup. Real
 * applications should pick one factory per key: dev mode warns about the type disagreement,
 * because the library can only see the two plans at runtime.
 */
@Component({
  selector: 'demo-query',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card">
      <h2><code>createQuery</code> — HTTP olmayan kaynaklar</h2>
      <p class="hint">
        Aynı önbellek, aynı handle, aynı <code>staleTime</code> / <code>gcTime</code> / devtools.
        Kaynak <code>(params, ctx) =&gt; Promise&lt;T&gt; | Observable&lt;T&gt;</code>; iptal
        <code>ctx.signal</code> üzerinden yürür.
      </p>

      <h3>localStorage — Promise kaynağı</h3>
      <div class="row">
        <label class="grow">
          taslak
          <textarea
            data-testid="draft"
            [value]="draft.response()"
            (input)="draftText.set($any($event.target).value)"
            placeholder="tarayıcıya yaz"
          ></textarea>
        </label>
      </div>
      <div class="row">
        <button type="button" data-testid="save-draft" (click)="saveDraft()">Kaydet</button>
        <button type="button" (click)="draft.reload()">Diskten yeniden oku</button>
        <span class="hint">
          durum: <code>{{ draft.status() }}</code> · fetchCount
          <span data-testid="draft-count">{{ draft.fetchCount() }}</span>
        </span>
      </div>

      <h3>Observable — ilk emission değerdir</h3>
      <p class="hint">
        Saat her saniye <code>next</code> üretir; önbellek ilk değeri alır ve abonelikten çıkar.
        Akış (streaming) 0.2.0'ın kapsamında değil — "Known limitations".
      </p>
      <div class="row">
        <span class="badge resolved" data-testid="clock">{{ clock.response() }}</span>
        <button type="button" (click)="clock.reload()">Yeniden başlat</button>
      </div>

      <h3>Aynı anahtar, <code>createRequest</code> ile paylaşım</h3>
      <p class="hint">
        Aşağıdaki HTTP isteği ve <code>createQuery</code> aynı anahtarı kullanıyor: tek giriş, tek
        uçuştaki çağrı. İki fabrika aynı anahtarda yalnızca paylaşımı göstermek için kullanılıyor;
        gerçek uygulamada anahtar başına tek fabrika seçin.
      </p>
      <p class="hint" data-testid="shared-state">
        kayıt: <b>{{ sharedRequest.response().length }}</b> · HTTP fetchCount
        <span data-testid="shared-http">{{ sharedRequest.fetchCount() }}</span> · query fetchCount
        <span data-testid="shared-query">{{ sharedQuery.fetchCount() }}</span>
      </p>
      <button type="button" (click)="sharedRequest.reload()">HTTP ile yenile</button>
    </section>
  `,
})
export class QuerySection {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Kept separate from the query so typing does not write storage on every keystroke. */
  protected readonly draftText = signal('');

  protected readonly draft = createQuery<string>(
    () => Promise.resolve(this.isBrowser ? (localStorage.getItem(DRAFT_KEY) ?? '') : ''),
    { key: () => ['demo', 'query', 'draft'], initialValue: '' },
  );

  protected readonly clock = createQuery<string>(
    () => timer(0, 1000).pipe(map(() => new Date().toLocaleTimeString())),
    { key: () => ['demo', 'query', 'clock'], initialValue: '' },
  );

  /**
   * Joins the request's entry instead of fetching: `lazy` keeps this handle from starting a call,
   * and the request below already put one in flight. The source exists for a cache-driven refetch,
   * which is the one case where this plan (registered last) runs.
   */
  protected readonly sharedQuery = createQuery<LocalPost[]>(
    () => Promise.resolve(this.sharedRequest.response()),
    { key: () => [...SHARED_KEY], lazy: true, initialValue: [] },
  );

  protected readonly sharedRequest = createRequest<LocalPost[]>('/posts?_limit=5', {
    key: () => [...SHARED_KEY],
    initialValue: [],
    debugName: 'demo:query-shared',
  });

  protected saveDraft(): void {
    if (this.isBrowser) localStorage.setItem(DRAFT_KEY, this.draftText());
    void this.draft.reload();
  }
}
