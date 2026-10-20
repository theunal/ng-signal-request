/* Probe A: one uncached `createRequest` - the smallest useful use of the library. */
import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { createRequest } from 'ng-signal-request';

@Component({
  selector: 'probe-root',
  template: '<p>{{ request.status() }}</p>',
})
class ProbeComponent {
  readonly request = createRequest('/probe');
}

void bootstrapApplication(ProbeComponent, { providers: [provideHttpClient()] }).catch(
  (error: unknown) => console.error(error),
);
