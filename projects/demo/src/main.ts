import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideSignalRequest } from 'ng-signal-request';

import { AppComponent } from './app/app.component';
import { demoApiInterceptor } from './app/demo-api.interceptor';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptors([demoApiInterceptor])),
    provideSignalRequest({
      // Every relative url in the demo gets this prefix.
      baseUrl: 'https://jsonplaceholder.typicode.com',
      // Default retry for queries. The "retry" section shows a per-request override.
      retry: 1,
      // A space bound on the cache: at most 25 entries may sit around with nobody watching.
      // `gcTime` bounds it in time only. A small number on purpose, so the "maxEntries" demo has
      // something to show; 500 is a more realistic production value.
      maxEntries: 25,
      // Global error hook: fires once per request, after retries are exhausted.
      onError: (error, { url, method }) => {
        console.warn(`[global onError] ${method} ${url} -> ${error.message}`);
      },
    }),
  ],
}).catch((e) => console.error(e));
