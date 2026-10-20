import { Component, inject } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  combine,
  createInfiniteRequest,
  createMutation,
  createRequest,
  QueryClient,
} from 'ng-signal-request';
import { QueryDevtools } from 'ng-signal-request/devtools';
import { provideCacheTransfer } from 'ng-signal-request/persist';

@Component({
  selector: 'probe-root',
  template: '<p>{{ all.response().length }} {{ mutation.status() }}</p>',
})
class ProbeComponent {
  readonly client = inject(QueryClient);
  readonly list = createRequest<unknown>('/probe', { key: () => ['probe'] });
  readonly detail = createRequest<unknown>('/detail', { key: () => ['detail'] });
  readonly infinite = createInfiniteRequest<unknown, number>((page) => `/pages?page=${page}`, {
    key: () => ['pages'],
    initialPageParam: 1,
    getNextPageParam: () => undefined,
  });
  readonly mutation = createMutation<unknown, { name: string }>((body) => ({
    url: '/probe',
    body,
  }));
  readonly all = combine([this.list, this.detail]);
  readonly devtools = QueryDevtools;
}

void bootstrapApplication(ProbeComponent, {
  providers: [provideHttpClient(), provideCacheTransfer()],
}).catch((error: unknown) => console.error(error));
