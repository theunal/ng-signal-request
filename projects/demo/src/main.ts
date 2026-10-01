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
      // Global error hook: fires once per request, after retries are exhausted.
      onError: (error, { url, method }) => {
        console.warn(`[global onError] ${method} ${url} -> ${error.message}`);
      },
    }),
  ],
}).catch((e) => console.error(e));
