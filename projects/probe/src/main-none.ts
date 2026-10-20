/* The control: an Angular application with the same Angular surface (HTTP included) but no
   library import. Every probe provides `provideHttpClient`, so the delta against this app is the
   library rather than Angular's HTTP runtime. */
import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { bootstrapApplication } from '@angular/platform-browser';

@Component({
  selector: 'probe-root',
  template: '<p>{{ label }}</p>',
})
class ProbeComponent {
  readonly label = 'no library';
}

void bootstrapApplication(ProbeComponent, { providers: [provideHttpClient()] }).catch(
  (error: unknown) => console.error(error),
);
