import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { OnlineManager } from 'ng-signal-request';

import { CacheSection } from './sections/cache-section';
import { FormSection } from './sections/form-section';
import { InfiniteSection } from './sections/infinite-section';
import { ListSection } from './sections/list-section';
import { OfflineSection } from './sections/offline-section';
import { RetrySection } from './sections/retry-section';

type Tab = 'list' | 'form' | 'retry' | 'infinite' | 'cache' | 'offline';

@Component({
  selector: 'demo-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ListSection, FormSection, RetrySection, InfiniteSection, CacheSection, OfflineSection],
  template: `
    <header>
      <h1>ng-signal-request</h1>
      <p class="sub">
        Signal tabanlı HTTP katmanı · canlı demo · Angular 22 · veri kaynağı
        <a href="https://jsonplaceholder.typicode.com" target="_blank" rel="noreferrer">
          jsonplaceholder.typicode.com
        </a>
      </p>
    </header>

    @if (!online()) {
      <div class="offline-banner">
        <strong>Çevrimdışısın.</strong>
        <code>networkMode: 'online'</code> kullanan istekler duraklatıldı; mutation'lar kuyrukta
        bekliyor ve bağlantı gelince çağrı sırasıyla gönderilecek.
      </div>
    }

    <div class="notice">
      <strong>Demo API hakkında:</strong> JSONPlaceholder sahte bir API'dir.
      <ul>
        <li>
          Arama (<code>q</code>) sunucuda gerçekten filtrelemez — bu yüzden filtreleme demo'da
          yerelde yapılıyor.
        </li>
        <li>
          Yazma işlemleri (POST / PUT / DELETE) kabul edilir ama <strong>saklanmaz</strong>;
          <code>reload()</code> sonrası kayıtlar kaybolur.
        </li>
        <li>
          Gecikme ve 503 üretmek için <code>/api/*</code> adreslerini araya giren bir demo
          interceptor'ı var.
        </li>
      </ul>
    </div>

    <nav class="tabs">
      @for (item of tabs; track item.id) {
        <button [class.active]="tab() === item.id" (click)="tab.set(item.id)">
          {{ item.label }}
        </button>
      }
    </nav>

    <main>
      @switch (tab()) {
        @case ('list') {
          <demo-list />
        }
        @case ('form') {
          <demo-form />
        }
        @case ('retry') {
          <demo-retry />
        }
        @case ('infinite') {
          <demo-infinite />
        }
        @case ('cache') {
          <demo-cache />
        }
        @case ('offline') {
          <demo-offline />
        }
      }
    </main>
  `,
})
export class AppComponent {
  protected readonly tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'list', label: 'Liste & params' },
    { id: 'form', label: 'Form & mutation' },
    { id: 'retry', label: 'Retry, debounce, polling' },
    { id: 'infinite', label: 'Sonsuz liste' },
    { id: 'cache', label: 'Paylaşılan önbellek' },
    { id: 'offline', label: 'Çevrimdışı (offline)' },
  ];

  protected readonly tab = signal<Tab>('list');

  /** The banner reads the same signal the library acts on, not `navigator.onLine`. */
  protected readonly online = inject(OnlineManager).online;
}
