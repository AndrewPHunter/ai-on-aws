// Reciprocal rank fusion and the reranked order, as pure functions over ranked lists of chunk ids.
//
// A passage's fused score is the sum, over the lists it is in, of 1 / (60 + its rank in that list, from 1). Ties
// are broken by chunk id. The reranked order is by the reranker's score, ties by fused rank.

export const RRF_CONSTANT = 60;

export type Fused = { id: string; score: number; keywordRank: number | null; vectorRank: number | null; fusedRank: number };

export function fuse(keyword: readonly string[], vector: readonly string[]): Fused[] {
  const entries = new Map<string, { score: number; keywordRank: number | null; vectorRank: number | null }>();
  const add = (ids: readonly string[], which: 'keywordRank' | 'vectorRank'): void => {
    ids.forEach((id, at) => {
      const rank = at + 1;
      const entry = entries.get(id) ?? { score: 0, keywordRank: null, vectorRank: null };
      // A list holds each id once; a repeat keeps its first (best) rank and adds nothing.
      if (entry[which] !== null) return;
      entry[which] = rank;
      entry.score += 1 / (RRF_CONSTANT + rank);
      entries.set(id, entry);
    });
  };
  add(keyword, 'keywordRank');
  add(vector, 'vectorRank');
  return [...entries]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry, at) => ({ ...entry, fusedRank: at + 1 }));
}

export type Reranked<T> = { item: T; score: number; rerankedRank: number };

// Orders items (already in fused order) by the reranker's scores, given one per item in the same order. Ties keep
// the fused order.
export function rerankOrder<T>(items: readonly T[], scores: readonly number[]): Reranked<T>[] {
  if (items.length !== scores.length) throw new Error('one score per item is needed');
  return items
    .map((item, at) => ({ item, score: scores[at] ?? 0, at }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((entry, at) => ({ item: entry.item, score: entry.score, rerankedRank: at + 1 }));
}
