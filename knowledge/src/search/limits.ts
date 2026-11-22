// The retrieval service's time limits, one copy. A whole search (search_label or find_labels) has SEARCH_LIMIT_MS
// from the moment it starts; every request it makes gets the smaller of its own limit and what is left, so a search
// answers inside an agent's 10 s tool limit whatever its strategy.
//
// When a request runs out of time, why is decided by arithmetic, never by which timer fired first: if what the
// request was given was the search's remainder (less than its own limit), the search as a whole ran out; otherwise
// the request's own limit did.

export const SEARCH_LIMIT_MS = 8_000;
export const ENGINE_REQUEST_MS = 5_000;
export const EMBEDDING_REQUEST_MS = 3_000;
export const RERANK_REQUEST_MS = 5_000;

export type RequestKind = 'engine' | 'embedding' | 'rerank';

// A search's limit and the clock it is measured by (milliseconds, any origin), and each kind of request's own limit
// (the constants above unless given). Injected, so a test can shorten them.
export type SearchLimit = { ms: number; now: () => number; requestMs?: Partial<Record<RequestKind, number>> };

export const DEFAULT_SEARCH_LIMIT: SearchLimit = { ms: SEARCH_LIMIT_MS, now: () => performance.now() };

const OWN_LIMITS: Record<RequestKind, number> = { engine: ENGINE_REQUEST_MS, embedding: EMBEDDING_REQUEST_MS, rerank: RERANK_REQUEST_MS };

// What one request is given: a signal that ends it, and whether that was the search's remainder (true) or the
// request's own limit (false). Decided once, before the request is sent.
export type Allotment = { signal: AbortSignal; ms: number; bySearch: boolean };

// What is left of one search's time.
export class SearchBudget {
  readonly limitMs: number;
  private readonly endsAt: number;
  private readonly now: () => number;
  private readonly own: Record<RequestKind, number>;

  constructor(limit: SearchLimit) {
    this.limitMs = limit.ms;
    this.now = limit.now;
    this.endsAt = limit.now() + limit.ms;
    this.own = { ...OWN_LIMITS, ...limit.requestMs };
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - this.now());
  }

  spent(): boolean {
    return this.remainingMs() === 0;
  }

  // The time one request of this kind is given: the smaller of its own limit and what is left of the search.
  allot(kind: RequestKind): Allotment {
    const own = this.own[kind];
    const remaining = this.remainingMs();
    const bySearch = remaining < own;
    const ms = bySearch ? remaining : own;
    return { signal: AbortSignal.timeout(Math.max(1, Math.ceil(ms))), ms, bySearch };
  }
}
