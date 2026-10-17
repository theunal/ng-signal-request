import { describe, expect, it } from 'vitest';
import { formatKey, matchesFilter, normalizeKey, startsWith, type NormalizedKey } from './key';

describe('normalizeKey()', () => {
  it('compares object segments by value, so two call sites agree on one key', () => {
    // The property the whole cache rests on: identity comparison would make these two keys, and
    // nothing would ever be shared.
    const a = normalizeKey(['users', { page: 2, filter: 'active' }]);
    const b = normalizeKey(['users', { filter: 'active', page: 2 }]);

    expect(a.hash).toBe(b.hash);
  });

  it('sorts at every level, including inside arrays and nested objects', () => {
    const a = normalizeKey([{ outer: { b: 1, a: 2 }, list: [{ y: 2, x: 1 }] }]);
    const b = normalizeKey([{ list: [{ x: 1, y: 2 }], outer: { a: 2, b: 1 } }]);

    expect(a.hash).toBe(b.hash);
  });

  it('keeps distinct values distinct', () => {
    expect(normalizeKey(['users', 1]).hash).not.toBe(normalizeKey(['users', 2]).hash);
    // `null`, `undefined` and the string "null" are three different keys, not one.
    const nulls = [null, undefined, 'null', 'undefined'].map((v) => normalizeKey([v]).hash);
    expect(new Set(nulls).size).toBe(4);
  });

  it('turns a Date into its ISO string, so a key built from a date is readable and stable', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    expect(normalizeKey(['since', when]).hash).toBe(normalizeKey(['since', when]).hash);
    expect(formatKey(normalizeKey(['since', when]).segments)).toContain('2026-01-02T03:04:05.000Z');
  });

  it('handles a bigint, which JSON.stringify cannot', () => {
    expect(normalizeKey(['id', 10n]).hash).not.toBe(normalizeKey(['id', 11n]).hash);
  });

  it('gives NaN and -0 a stable form rather than letting them split one key in two', () => {
    // `String(NaN)` is 'NaN' and `JSON.stringify(NaN)` is 'null'. Picking the wrong one would make
    // two identical keys hash differently, and the cache would never hit.
    expect(normalizeKey(['x', Number.NaN]).hash).toBe(normalizeKey(['x', Number.NaN]).hash);
    // `-0` is the one number whose `String()` disagrees with its own identity, so it is special-cased.
    expect(normalizeKey(['x', -0]).hash).not.toBe(normalizeKey(['x', 0]).hash);
  });

  it('refuses a function or symbol segment, with a message that says what to do', () => {
    // A function in a key is a new function on every evaluation, so the entry would never be
    // reused: the cache would grow without ever hitting. Silence there is the worst outcome.
    expect(() => normalizeKey(['users', () => 1])).toThrow(
      /cannot be a function or symbol \(got function\)/,
    );
    expect(() => normalizeKey(['users', Symbol('id')])).toThrow(
      /cannot be a function or symbol \(got symbol\)/,
    );
  });

  it('keeps the caller array as written, for predicate filters', () => {
    const raw = ['users', { page: 2 }];
    const normalized = normalizeKey(raw);

    expect(normalized.raw).toEqual(raw);
    expect(normalized.raw).not.toBe(raw); // copied, so a caller cannot mutate the key later
    expect(normalized.segments).toHaveLength(2);
  });
});

describe('startsWith()', () => {
  const key = (raw: readonly unknown[]): NormalizedKey => normalizeKey(raw);

  it('matches segment for segment, so a prefix reaches everything under it', () => {
    expect(startsWith(key(['users', 1]).segments, key(['users']).segments)).toBe(true);
    expect(startsWith(key(['users']).segments, key(['users']).segments)).toBe(true);
  });

  it('does not match on a partial segment', () => {
    // `['users']` must not reach `['users-archive', 1]`: prefix matching is per segment, not on the
    // joined string, or a single-character key would drag in unrelated entries.
    expect(startsWith(key(['users-archive', 1]).segments, key(['users']).segments)).toBe(false);
  });

  it('an empty prefix matches everything, and a longer prefix matches nothing', () => {
    expect(startsWith(key(['users']).segments, [])).toBe(true);
    expect(startsWith(key(['users']).segments, key(['users', 1]).segments)).toBe(false);
  });
});

describe('matchesFilter()', () => {
  it('treats an array as a prefix', () => {
    const entry = normalizeKey(['users', { page: 2 }]);
    expect(matchesFilter(entry, ['users'])).toBe(true);
    expect(matchesFilter(entry, ['posts'])).toBe(false);
  });

  it('hands a predicate the original segments, with their index', () => {
    const entry = normalizeKey(['users', { userId: 7 }]);
    const seen: Array<[unknown, number]> = [];

    const matched = matchesFilter(entry, (segment, index) => {
      seen.push([segment, index]);
      return typeof segment === 'object' && segment !== null && 'userId' in segment;
    });

    expect(matched).toBe(true);
    // The object, not the stringified segment: a predicate exists so the caller can match on shape.
    // `some` short-circuits, so it is reached on the second segment.
    expect(seen[0][0]).toBe('users');
    expect(seen[1][0]).toEqual({ userId: 7 });
    expect(seen[1][1]).toBe(1);
  });

  it('a predicate that matches nothing returns false', () => {
    expect(matchesFilter(normalizeKey(['users']), () => false)).toBe(false);
  });
});

describe('formatKey()', () => {
  it('renders the normalized segments, so a log line shows exactly what is being matched', () => {
    expect(formatKey(normalizeKey(['users', { page: 2 }]).segments)).toBe('["users", {"page":2}]');
  });
});
