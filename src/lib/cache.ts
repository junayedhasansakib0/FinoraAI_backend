/**
 * A minimal in-memory TTL cache for external integrations (R-E3, R-E6). The hot path reads
 * `fresh`; when a re-fetch fails, callers fall back to `stale` so one upstream hiccup serves the
 * last good answer instead of breaking the page (ARCHITECTURE.md §9).
 *
 * Time is read through `Date.now()`, which tests freeze, so TTL behaviour is deterministic (R-T6).
 * The store is process-local: it is never shared across instances and holds only public market
 * data, never user rows, so there is nothing here to scope by `userId`.
 */

interface CacheEntry<TValue> {
  value: TValue;
  storedAt: number;
}

export class TtlCache<TValue> {
  private readonly entries = new Map<string, CacheEntry<TValue>>();

  /**
   * @param freshMs How long an entry is served before a re-fetch is attempted.
   * @param staleMs How long past `freshMs` an entry may still be served when a re-fetch fails.
   */
  constructor(
    private readonly freshMs: number,
    private readonly staleMs: number,
  ) {}

  /** The value while it is still within its fresh window, otherwise `undefined`. */
  fresh(key: string): TValue | undefined {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    return Date.now() - entry.storedAt <= this.freshMs ? entry.value : undefined;
  }

  /** The value while it is still within the fresh + stale window — the upstream-down fallback. */
  stale(key: string): TValue | undefined {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return undefined;
    }

    return Date.now() - entry.storedAt <= this.freshMs + this.staleMs ? entry.value : undefined;
  }

  set(key: string, value: TValue): void {
    this.entries.set(key, { value, storedAt: Date.now() });
  }

  /** Drops every entry. Only used to isolate tests (R-T6). */
  clear(): void {
    this.entries.clear();
  }
}
