import { computed, type Signal, type ValueEqualityFn } from '@angular/core';

/**
 * Builds the memoized projection shared by every handle's `select()`.
 *
 * Kept out of the builders (`create-request.ts`, `create-cached-request.ts`,
 * `create-infinite-request.ts`) because the behaviour is identical in all of them: what differs is
 * how `response()` is *produced*, not how it is projected. The reasoning for `select` being a
 * method rather than an option lives on `RequestBase.select` — briefly, TypeScript has no partial
 * type-argument inference, so a selector's return type cannot be inferred at any call site that
 * also names the data type.
 */
export function projectFrom<T, S>(
  source: Signal<T>,
  selector: (data: T) => S,
  equal: ValueEqualityFn<S> | undefined,
): Signal<S> {
  if (equal === undefined) return computed(() => selector(source()));
  return computed(() => selector(source()), { equal });
}

/**
 * `projectFrom` for a response that may be empty.
 *
 * The selector is only ever called with real data — `undefined` in, `undefined` out — so no
 * selector has to write the same "is there anything yet" guard.
 */
export function selectFrom<T, S>(
  response: Signal<T | undefined>,
  selector: (data: T) => S,
  equal: ValueEqualityFn<S> | undefined,
): Signal<S | undefined> {
  /**
   * `equal` is typed for `S`, but this signal also carries `undefined`, so the two cannot be
   * passed through unwrapped. Widening it here keeps every caller's `equal` free of a "no data
   * yet" branch it would otherwise repeat.
   */
  const widened =
    equal === undefined
      ? undefined
      : (a: S | undefined, b: S | undefined): boolean =>
          a === undefined || b === undefined ? a === b : equal(a, b);

  return projectFrom<T | undefined, S | undefined>(
    response,
    (data) => (data === undefined ? undefined : selector(data)),
    widened,
  );
}
