/* Probe B: a keyed request plus `QueryClient` - the shared cache and its imperative API. */
import { Component, inject } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { createRequest, QueryClient } from 'ng-signal-request';

@Component({
  selector: 'probe-root',
  template: '<p>{{ request.status() }} {{ client.isFetching() }}</p>',
})
class ProbeComponent {
  readonly client = inject(QueryClient);
  readonly request = createRequest('/probe', { key: () => ['probe'] });
}

void bootstrapApplication(ProbeComponent, { providers: [provideHttpClient()] }).catch(
  (error: unknown) => console.error(error),
);
