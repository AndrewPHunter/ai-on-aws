// The retrieval service's time limits, one copy. A whole search (search_label or find_labels) has SEARCH_LIMIT_MS
// from the moment it starts; every request it makes gets the smaller of its own limit and what is left, so a search
// answers inside an agent's 10 s tool limit whatever its strategy.

export const SEARCH_LIMIT_MS = 8_000;
export const ENGINE_REQUEST_MS = 5_000;
export const EMBEDDING_REQUEST_MS = 3_000;
export const RERANK_REQUEST_MS = 5_000;

// A search's limit and the clock it is measured by (milliseconds, any origin). Injected, so a test can shorten it.
export type SearchLimit = { ms: number; now: () => number };

export const DEFAULT_SEARCH_LIMIT: SearchLimit = { ms: SEARCH_LIMIT_MS, now: () => performance.now() };

// What is left of one search's time.
export class SearchBudget {
  readonly limitMs: number;
  private readonly endsAt: number;
  private readonly now: () => number;

  constructor(limit: SearchLimit) {
    this.limitMs = limit.ms;
    this.now = limit.now;
    this.endsAt = limit.now() + limit.ms;
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - this.now());
  }

  spent(): boolean {
    return this.remainingMs() === 0;
  }

  // A signal that ends a request when the search's time is up.
  signal(): AbortSignal {
    return AbortSignal.timeout(Math.max(1, Math.ceil(this.remainingMs())));
  }
}
