import { ChangeDetectionStrategy, Component, inject, Injectable, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createMutation, createRequest, type QueryParams } from '../public-api';
import { settle, setup } from '../../testing/testing';

/** The shape from the original draft: request factories live in a service ... */
@Injectable({ providedIn: 'root' })
class UserApi {
  list = (filter: () => QueryParams) =>
    createRequest<{ id: number }[]>(() => ({ url: '/users', params: filter() }), {
      initialValue: [],
      keepPreviousValue: true,
    });

  remove = () => createMutation.delete<void, number>((id) => ({ url: '/users/:id', path: { id } }));
}

/** ... and are instantiated from the component, so they live and die with it. */
@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (users.loading()) {
      <p id="state">loading</p>
    } @else if (users.error()) {
      <p id="state">error</p>
    } @else {
      <p id="state">count:{{ users.response().length }}</p>
    }
    <button id="reload" (click)="users.run()">reload</button>
  `,
})
class UsersComponent {
  private readonly api = inject(UserApi);
  readonly filter = signal<QueryParams>({ role: 'admin' });
  readonly users = this.api.list(() => this.filter());
  readonly removal = this.api.remove();
}

describe('component integration (OnPush, service-made requests)', () => {
  it('renders loading -> data, reacts to signal changes and lives with the component', async () => {
    const { http } = setup();
    const fixture = TestBed.createComponent(UsersComponent);
    const el: HTMLElement = fixture.nativeElement;
    const text = () => el.querySelector('#state')?.textContent;

    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(text()).toBe('loading');

    http.expectOne('/users?role=admin').flush([{ id: 1 }, { id: 2 }]);
    await settle();
    fixture.detectChanges();
    expect(text()).toBe('count:2');

    fixture.componentInstance.filter.set({ role: 'guest' });
    await settle();
    fixture.detectChanges();
    expect(text()).toBe('loading');
    const inflight = http.expectOne('/users?role=guest');

    (el.querySelector('#reload') as HTMLButtonElement).click(); // run() while in flight joins the request
    await settle();
    http.expectNone('/users?role=guest');

    inflight.flush([{ id: 3 }]);
    await settle();
    fixture.detectChanges();
    expect(text()).toBe('count:1');

    fixture.destroy();
    http.verify();
  });

  it('aborts the in-flight request when the component is destroyed', async () => {
    const { http } = setup();
    const fixture = TestBed.createComponent(UsersComponent);
    fixture.detectChanges();
    await settle();
    const req = http.expectOne('/users?role=admin');
    fixture.destroy();
    await settle();
    expect(req.cancelled).toBe(true);
  });
});
