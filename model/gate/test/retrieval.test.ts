import assert from 'node:assert/strict'
import { test } from 'node:test'

import { passagesOf, RETRIEVAL_CASES } from '../retrieval-cases.ts'
import {
  answeredFirst,
  cosine,
  embeddingVerdict,
  isUnitLength,
  norm,
  rerankerVerdict,
  type EmbeddingEvidence,
  type RerankerEvidence,
} from '../retrieval.ts'

const KEYS_OK = { missingKeyStatus: 401, wrongKeyStatus: 401, validKeyStatus: 200 }

const EMBEDDING: EmbeddingEvidence = {
  keys: KEYS_OK,
  modelListed: true,
  vectors: { count: 178, wrongDimensions: 0, notUnitLength: 0 },
  ranking: { cases: 10, answeredFirst: 10 },
  overLimitStatus: 400,
  concurrent: { requests: 4, answered: 4 },
}

const RERANKER: RerankerEvidence = {
  keys: KEYS_OK,
  modelListed: true,
  ranking: { cases: 10, answeredFirst: 10 },
  overLimit: { withoutLimitStatus: 400, withLimitStatus: 200 },
  concurrent: { requests: 4, answered: 4 },
}

test("M12a. cosine and unit length: exact values, and refusals of vectors that have no cosine", () => {
  assert.equal(norm([3, 4]), 5)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 2, 3], [2, 4, 6]), 1)
  assert.equal(cosine([1, 0], [-1, 0]), -1)
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12)
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /different lengths/)
  assert.throws(() => cosine([], []), /empty/)
  assert.throws(() => cosine([0, 0], [1, 0]), /zeros/)

  assert.equal(isUnitLength([0.6, 0.8], 0), true)
  assert.equal(isUnitLength([0.6, 0.8008], 0.001), true) // length about 1.00064
  assert.equal(isUnitLength([0.6, 0.802], 0.001), false) // length about 1.0016
  assert.equal(isUnitLength([0.6, 0.798], 0.001), false) // length about 0.9984
  assert.equal(isUnitLength([3, 4], 0.001), false)

  assert.equal(answeredFirst([0.2, 0.9, 0.1], 1), true)
  assert.equal(answeredFirst([0.2, 0.9, 0.1], 0), false)
  assert.equal(answeredFirst([0.9, 0.9, 0.1], 0), false) // a tie is not a win
})

test('M12b. the embedding verdict at, just under and just over its threshold, and each other check alone', () => {
  const at = (answered: number): string[] => embeddingVerdict({ ...EMBEDDING, ranking: { cases: 10, answeredFirst: answered } }, { minAnsweredFirstRate: 0.9 })
  assert.deepEqual(at(9), []) // at: 0.9
  assert.deepEqual(at(8), ['ranking']) // just under: 0.8
  assert.deepEqual(at(10), []) // just over: 1.0
  assert.deepEqual(embeddingVerdict({ ...EMBEDDING, ranking: { cases: 20, answeredFirst: 19 } }, { minAnsweredFirstRate: 0.95 }), [])
  assert.deepEqual(embeddingVerdict({ ...EMBEDDING, ranking: { cases: 20, answeredFirst: 18 } }, { minAnsweredFirstRate: 0.95 }), ['ranking'])
  assert.deepEqual(embeddingVerdict({ ...EMBEDDING, ranking: { cases: 0, answeredFirst: 0 } }, { minAnsweredFirstRate: 0 }), ['ranking'])

  const alone: [Partial<EmbeddingEvidence>, string][] = [
    [{ keys: { ...KEYS_OK, missingKeyStatus: 200 } }, 'key'],
    [{ keys: { ...KEYS_OK, wrongKeyStatus: 403 } }, 'key'],
    [{ keys: { ...KEYS_OK, validKeyStatus: null } }, 'key'],
    [{ modelListed: false }, 'model not listed'],
    [{ vectors: { count: 178, wrongDimensions: 1, notUnitLength: 0 } }, 'vectors'],
    [{ vectors: { count: 178, wrongDimensions: 0, notUnitLength: 1 } }, 'vectors'],
    [{ vectors: { count: 0, wrongDimensions: 0, notUnitLength: 0 } }, 'vectors'],
    [{ overLimitStatus: 200 }, 'input over the limit'],
    [{ overLimitStatus: null }, 'input over the limit'],
    [{ concurrent: { requests: 4, answered: 3 } }, 'concurrency'],
    [{ concurrent: { requests: 0, answered: 0 } }, 'concurrency'],
  ]
  for (const [change, failure] of alone) {
    assert.deepEqual(embeddingVerdict({ ...EMBEDDING, ...change }, { minAnsweredFirstRate: 0.9 }), [failure], JSON.stringify(change))
  }
})

test('M12c. the reranker verdict at, just under and just over its threshold, and each other check alone', () => {
  const at = (answered: number): string[] => rerankerVerdict({ ...RERANKER, ranking: { cases: 10, answeredFirst: answered } }, { minAnsweredFirstRate: 0.9 })
  assert.deepEqual(at(9), [])
  assert.deepEqual(at(8), ['ranking'])
  assert.deepEqual(at(10), [])

  const alone: [Partial<RerankerEvidence>, string][] = [
    [{ keys: { ...KEYS_OK, wrongKeyStatus: 200 } }, 'key'],
    [{ modelListed: false }, 'model not listed'],
    [{ overLimit: { withoutLimitStatus: 200, withLimitStatus: 200 } }, 'document over the limit'],
    [{ overLimit: { withoutLimitStatus: 400, withLimitStatus: 400 } }, 'document over the limit with max_tokens_per_doc'],
    [{ overLimit: { withoutLimitStatus: 400, withLimitStatus: null } }, 'document over the limit with max_tokens_per_doc'],
    [{ concurrent: { requests: 4, answered: 0 } }, 'concurrency'],
  ]
  for (const [change, failure] of alone) {
    assert.deepEqual(rerankerVerdict({ ...RERANKER, ...change }, { minAnsweredFirstRate: 0.9 }), [failure], JSON.stringify(change))
  }
})

test("M15. the gate's fixed set puts each answer where passagesOf says, at a position that moves from case to case", () => {
  // If every answer sat at one position, a server that favoured that position would pass the ranking checks.
  const positions = new Set<number>()
  for (const [caseIndex, entry] of RETRIEVAL_CASES.entries()) {
    const { passages, answerIndex } = passagesOf(entry, caseIndex)
    assert.equal(passages[answerIndex], entry.answer)
    assert.deepEqual(
      passages.filter((_, index) => index !== answerIndex),
      entry.others,
    )
    positions.add(answerIndex)
  }
  assert.equal(positions.size, (RETRIEVAL_CASES[0]?.others.length ?? 0) + 1, `answers only at positions ${[...positions].join(', ')}`)
})
