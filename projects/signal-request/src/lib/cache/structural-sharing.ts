/**
 * Structural sharing.
 *
 * A 200 response for a 500-item list arrives as a brand new object graph, so
 * `Object.is` says "changed" and every consumer re-renders — including the rows
 * that did not change. Structural sharing walks the incoming value against the
 * previous one and **keeps the previous reference wherever the two are equal**,
 * so `signal` equality stops downstream work from propagating past the rows that
 * actually changed.
 *
 * It is what makes an explicit cache worth having over `httpResource` alone: with
 * per-consumer resources there is no previous value to share with.
 */

/**
 * Returns the value to store for `next`, possibly reusing parts of `previous`.
 *
 * A well-behaved implementation returns `previous` itself when nothing changed,
 * which is the signal that lets the entry skip the write entirely.
 */
export type StructuralSharingFn<T> = (previous: T | undefined, next: T) => T;

/**
 * Depth limit, not a cycle detector.
 *
 * Cached API payloads are trees; a cyclic one would recurse forever. At this
 * depth the data is already far past anything an API returns, so bailing out and
 * taking the incoming reference is the safe answer — the worst case is one lost
 * sharing opportunity, never a hang.
 */
const MAX_DEPTH = 100;

/**
 * Only plain objects and arrays are walked.
 *
 * A class instance (`Date`, `Map`, a domain model) is replaced wholesale. Its
 * identity *is* its data, and recursively rebuilding one would produce an object
 * of the wrong class — a far worse outcome than a missed optimization.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function share(previous: unknown, next: unknown, depth: number): unknown {
  if (Object.is(previous, next)) return previous;
  if (depth >= MAX_DEPTH) return next;

  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) return next;
    let changed = false;
    const merged: unknown[] = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      const item = share(previous[i], next[i], depth + 1);
      merged[i] = item;
      // Compared against `previous`, **not** `next`. An unchanged element comes back as the
      // previous *object*, which is a different reference from the next one — comparing against
      // `next` would report a change on every structurally equal payload and defeat the point.
      if (!Object.is(item, previous[i])) changed = true;
    }
    return changed ? merged : previous;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) return next;

    let changed = false;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const item = share(previous[key], next[key], depth + 1);
      merged[key] = item;
      if (!Object.is(item, previous[key])) changed = true;
    }
    return changed ? merged : previous;
  }

  return next;
}

/**
 * The default sharing function.
 *
 * Returns `previous` unchanged when nothing below the root differs, so the entry
 * can skip writing its data signal and no consumer is notified.
 */
export const defaultStructuralSharing: StructuralSharingFn<unknown> = (previous, next) =>
  previous === undefined ? next : share(previous, next, 0);

/**
 * Builds the sharing function for one request from its two options.
 *
 * `equal` and `structuralSharing` are the same idea at two levels: `equal` asks
 * "is this the same value?", `structuralSharing` asks "which parts of it are?".
 * Given only `equal`, it is used as a cheap short-circuit before the default
 * walk — that is the whole point of the existing `equal` option, and it composes
 * rather than conflicting.
 */
export function resolveStructuralSharing<T>(
  structuralSharing: StructuralSharingFn<T> | undefined,
  equal: ((a: T, b: T) => boolean) | undefined,
): StructuralSharingFn<T> {
  if (structuralSharing) return structuralSharing;
  if (!equal) return defaultStructuralSharing as StructuralSharingFn<T>;
  return (previous, next) => {
    if (previous !== undefined && equal(previous, next)) return previous;
    return defaultStructuralSharing(previous, next) as T;
  };
}
