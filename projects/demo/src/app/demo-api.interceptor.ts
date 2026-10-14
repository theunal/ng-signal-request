import { HttpErrorResponse, HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { delay, of, switchMap, throwError } from 'rxjs';

/**
 * Demo-only interceptor. It does two things the real JSONPlaceholder API cannot:
 *
 *  1. `/api/flaky` fails with a 503 on the first two attempts per url, so `retry` is
 *     actually observable instead of being theoretical.
 *  2. `/api/slow` adds a visible delay, so `cancel()` has something to cancel.
 *  3. `/api/reject` always fails with a 500, so the optimistic-rollback path of
 *     `createMutation` can be watched rather than taken on faith.
 *
 * Everything else is passed straight through to the real API.
 */
export const demoApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith('/api/reject')) {
    return of(null).pipe(
      delay(900), // long enough that the optimistic row is visibly on screen first
      switchMap(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 500,
              statusText: 'Internal Server Error',
              url: req.url,
              error: { message: 'demo: bu istek her zaman reddedilir' },
            }),
        ),
      ),
    );
  }

  if (req.url.startsWith('/api/flaky')) {
    const key = req.urlWithParams;
    const attempts = (flakyCounters.get(key) ?? 0) + 1;
    flakyCounters.set(key, attempts);

    // First two hits fail with a 503 (which `retry` treats as transient).
    if (attempts <= 2) {
      return of(null).pipe(
        delay(250),
        switchMap(() =>
          throwError(
            () =>
              new HttpErrorResponse({
                status: 503,
                statusText: 'Service Unavailable',
                url: req.url,
                error: { message: `demo: planlı hata (deneme ${attempts})` },
              }),
          ),
        ),
      );
    }

    return of(
      new HttpResponse({
        status: 200,
        url: req.url,
        body: [
          { userId: 1, id: attempts, title: `demo kaydı #${attempts}`, body: 'Geçici olarak üretildi.' },
        ],
      }),
    ).pipe(delay(200));
  }

  if (req.url.startsWith('/api/slow')) {
    return of(
      new HttpResponse({
        status: 200,
        url: req.url,
        body: [
          { userId: 1, id: 1, title: 'yavaş cevap', body: 'Bu istek 3 saniye sürüyor, iptal edebilirsin.' },
        ],
      }),
    ).pipe(delay(3000));
  }

  return next(req);
};

/** Attempt counter per url, so `/api/flaky` fails twice then succeeds. */
const flakyCounters = new Map<string, number>();
