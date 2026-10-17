import { computed, Injectable, signal, type Signal } from '@angular/core';
import { matchesFilter, normalizeKey, type QueryKey, type QueryKeyFilter } from './key';

/**
 * How many mutations are in flight, and under which keys.
 *
 * A counter rather than a set of handles: the question being asked is "is *anything* being
 * written right now?", and the answer is a number. Handles are the wrong granularity — a global
 * spinner wants every mutation, a navigation guard wants one group, and neither holds references.
 *
 * Registration is a plain increment/decrement around the call rather than a registry of live
 * mutations, so nothing keeps a handle alive after it settles.
 */
@Injectable({ providedIn: 'root' })
export class MutationRegistry {
  /** Total in flight, across every key. */
  private readonly total = signal(0);

  /** In-flight counts per normalized mutation key. */
  private readonly byKey = signal<ReadonlyMap<string, number>>(new Map());

  private readonly segments = new Map<string, readonly string[]>();

  /** How many mutations are in flight right now. Reactive. */
  readonly count: Signal<number> = computed(() => this.total());

  /** Whether anything is in flight. Reactive. */
  readonly isMutating: Signal<boolean> = computed(() => this.total() > 0);

  /** Called when a call goes out. */
  begin(mutationKey: QueryKey | undefined): void {
    this.total.update((n) => n + 1);
    if (!mutationKey) return;
    const normalized = normalizeKey(mutationKey);
    if (!this.segments.has(normalized.hash))
      this.segments.set(normalized.hash, normalized.segments);
    this.byKey.update((current) => {
      const next = new Map(current);
      next.set(normalized.hash, (next.get(normalized.hash) ?? 0) + 1);
      return next;
    });
  }

  /** Called when a call settles, whether it succeeded, failed or was cancelled. */
  end(mutationKey: QueryKey | undefined): void {
    this.total.update((n) => Math.max(0, n - 1));
    if (!mutationKey) return;
    const normalized = normalizeKey(mutationKey);
    this.byKey.update((current) => {
      const count = (current.get(normalized.hash) ?? 0) - 1;
      if (count <= 0) {
        // Dropped rather than left at zero: an app that has used a thousand distinct keys should
        // not carry a thousand entries for the rest of its life.
        this.segments.delete(normalized.hash);
        const next = new Map(current);
        next.delete(normalized.hash);
        return next;
      }
      const next = new Map(current);
      next.set(normalized.hash, count);
      return next;
    });
  }

  /** How many mutations matching a filter are in flight. Reactive. */
  countMatching(filter: QueryKeyFilter): Signal<number> {
    return computed(() => {
      // Read `byKey` so the computed re-evaluates when the map changes.
      const current = this.byKey();
      let total = 0;
      for (const [hash, count] of current) {
        const segments = this.segments.get(hash);
        if (!segments) continue;
        if (matchesFilter({ hash, segments, raw: segments }, filter)) total += count;
      }
      return total;
    });
  }

  /** Forgets every count. Test-only escape hatch; a live app never needs it. */
  reset(): void {
    this.total.set(0);
    this.byKey.set(new Map());
    this.segments.clear();
  }
}
