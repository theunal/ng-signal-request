import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { FormSection } from './sections/form-section';
import { ListSection } from './sections/list-section';
import { RetrySection } from './sections/retry-section';

type Tab = 'list' | 'form' | 'retry';

@Component({
  selector: 'demo-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ListSection, FormSection, RetrySection],
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

    <div class="notice">
      <strong>Demo API hakkında:</strong> JSONPlaceholder sahte bir API'dir.
      <ul>
        <li>Arama (<code>q</code>) sunucuda gerçekten filtrelemez — bu yüzden filtreleme demo'da yerelde yapılıyor.</li>
        <li>Yazma işlemleri (POST / PUT / DELETE) kabul edilir ama <strong>saklanmaz</strong>; <code>reload()</code> sonrası kayıtlar kaybolur.</li>
        <li>Gecikme ve 503 üretmek için <code>/api/*</code> adreslerini araya giren bir demo interceptor'ı var.</li>
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
      }
    </main>
  `,
})
export class AppComponent {
  protected readonly tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'list', label: 'Liste & params' },
    { id: 'form', label: 'Form & mutation' },
    { id: 'retry', label: 'Retry, debounce, polling' },
  ];

  protected readonly tab = signal<Tab>('list');
}
