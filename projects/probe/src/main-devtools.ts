import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';
import { createRequest } from 'ng-signal-request';
import { DevtoolsPanel } from 'ng-signal-request/devtools';

/**
 * The positive control for the `/devtools` entry point.
 *
 * The production demo deliberately does not import it - that absence is what `check:dist` asserts -
 * so this tiny app is where the panel is compiled and retained. It is built with the other probes,
 * which makes "the panel fits its budget" a measurement rather than a claim.
 */
@Component({
  selector: 'probe-devtools-root',
  imports: [DevtoolsPanel],
  template: `
    <p>{{ rows.response().length }}</p>
    <ngsr-devtools />
  `,
})
class ProbeComponent {
  readonly rows = createRequest<unknown[]>('/probe', {
    key: () => ['probe'],
    debugName: 'rows',
    initialValue: [],
  });
}

void bootstrapApplication(ProbeComponent, {
  providers: [provideHttpClient()],
}).catch((error: unknown) => console.error(error));
