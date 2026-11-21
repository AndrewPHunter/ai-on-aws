// Pure parts of the gate's checks of the embedding server and the reranker server: vector arithmetic and the
// verdicts. No input or output; gate.ts gathers the evidence and passes it in. Tested in test/retrieval.test.ts.

export function norm(vector: readonly number[]): number {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

// Cosine similarity of two vectors of the same, non-zero length, neither of them all zeros.
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`cosine: vectors of different lengths (${a.length} and ${b.length})`)
  if (a.length === 0) throw new Error('cosine: empty vectors')
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) throw new Error(`cosine: no element at index ${i}`)
    dot += x * y
  }
  const lengths = norm(a) * norm(b)
  if (lengths === 0) throw new Error('cosine: a vector of all zeros has no direction')
  return dot / lengths
}

// True when the vector's length differs from 1 by at most the tolerance.
export function isUnitLength(vector: readonly number[], tolerance: number): boolean {
  return Math.abs(norm(vector) - 1) <= tolerance
}

// True when the score at answerIndex is higher than every other score. A tie is not a win.
export function answeredFirst(scores: readonly number[], answerIndex: number): boolean {
  const answer = scores[answerIndex]
  if (answer === undefined) throw new Error(`answeredFirst: no score at index ${answerIndex}`)
  return scores.every((score, index) => index === answerIndex || score < answer)
}

export type KeyStatuses = { missingKeyStatus: number | null; wrongKeyStatus: number | null; validKeyStatus: number | null }

export function keysPass(statuses: KeyStatuses): boolean {
  return statuses.missingKeyStatus === 401 && statuses.wrongKeyStatus === 401 && statuses.validKeyStatus === 200
}

export type RankingEvidence = { cases: number; answeredFirst: number }

function rankingPasses(ranking: RankingEvidence, minRate: number): boolean {
  return ranking.cases > 0 && ranking.answeredFirst / ranking.cases >= minRate
}

export type EmbeddingEvidence = {
  keys: KeyStatuses
  modelListed: boolean
  // Every vector the checks received: how many, and how many had the wrong number of dimensions or a
  // length other than 1 within the tolerance.
  vectors: { count: number; wrongDimensions: number; notUnitLength: number }
  ranking: RankingEvidence
  // Status of a request holding one input longer than the limit; null when no response came.
  overLimitStatus: number | null
  concurrent: { requests: number; answered: number }
}

export type EmbeddingThresholds = { minAnsweredFirstRate: number }

// The checks that failed, by name; empty when the embedding server passes.
export function embeddingVerdict(evidence: EmbeddingEvidence, thresholds: EmbeddingThresholds): string[] {
  const failures: string[] = []
  if (!keysPass(evidence.keys)) failures.push('key')
  if (!evidence.modelListed) failures.push('model not listed')
  const { vectors } = evidence
  if (vectors.count === 0 || vectors.wrongDimensions > 0 || vectors.notUnitLength > 0) failures.push('vectors')
  if (!rankingPasses(evidence.ranking, thresholds.minAnsweredFirstRate)) failures.push('ranking')
  if (evidence.overLimitStatus !== 400) failures.push('input over the limit')
  if (evidence.concurrent.requests === 0 || evidence.concurrent.answered !== evidence.concurrent.requests) failures.push('concurrency')
  return failures
}

export type RerankerEvidence = {
  keys: KeyStatuses
  modelListed: boolean
  ranking: RankingEvidence
  // Status of a request holding one document longer than the limit, without and with max_tokens_per_doc.
  overLimit: { withoutLimitStatus: number | null; withLimitStatus: number | null }
  concurrent: { requests: number; answered: number }
}

export type RerankerThresholds = { minAnsweredFirstRate: number }

export function rerankerVerdict(evidence: RerankerEvidence, thresholds: RerankerThresholds): string[] {
  const failures: string[] = []
  if (!keysPass(evidence.keys)) failures.push('key')
  if (!evidence.modelListed) failures.push('model not listed')
  if (!rankingPasses(evidence.ranking, thresholds.minAnsweredFirstRate)) failures.push('ranking')
  if (evidence.overLimit.withoutLimitStatus !== 400) failures.push('document over the limit')
  if (evidence.overLimit.withLimitStatus !== 200) failures.push('document over the limit with max_tokens_per_doc')
  if (evidence.concurrent.requests === 0 || evidence.concurrent.answered !== evidence.concurrent.requests) failures.push('concurrency')
  return failures
}
