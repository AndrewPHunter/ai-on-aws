// Invariant 1 of docs/architecture/model-server.md, at the gate's verdicts on the embedding and reranker servers:
// a server that answers without the key, or with a wrong one, is not passed. (The chat server's key check is in
// gate.ts and is shown on hardware only.)

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { embeddingVerdict, rerankerVerdict, type EmbeddingEvidence, type KeyStatuses, type RerankerEvidence } from '../retrieval.ts'

const KEYS_OK: KeyStatuses = { missingKeyStatus: 401, wrongKeyStatus: 401, validKeyStatus: 200 }
const THRESHOLDS = { minAnsweredFirstRate: 0.9 }

const embedding = (keys: KeyStatuses): EmbeddingEvidence => ({
  keys,
  modelListed: true,
  vectors: { count: 10, wrongDimensions: 0, notUnitLength: 0 },
  ranking: { cases: 10, answeredFirst: 10 },
  overLimitStatus: 400,
  concurrent: { requests: 4, answered: 4 },
})

const reranker = (keys: KeyStatuses): RerankerEvidence => ({
  keys,
  modelListed: true,
  ranking: { cases: 10, answeredFirst: 10 },
  overLimit: { withoutLimitStatus: 400, withLimitStatus: 200 },
  concurrent: { requests: 4, answered: 4 },
})

test('1. the gate does not pass an embedding or reranker server that answers without the key or with a wrong one', () => {
  const rows: [string, string[], boolean][] = [
    ['both servers keep the key', [...embeddingVerdict(embedding(KEYS_OK), THRESHOLDS), ...rerankerVerdict(reranker(KEYS_OK), THRESHOLDS)], true],
    ['embedding answers without a key', embeddingVerdict(embedding({ ...KEYS_OK, missingKeyStatus: 200 }), THRESHOLDS), false],
    ['reranker answers a wrong key', rerankerVerdict(reranker({ ...KEYS_OK, wrongKeyStatus: 200 }), THRESHOLDS), false],
    ['embedding refuses the right key', embeddingVerdict(embedding({ ...KEYS_OK, validKeyStatus: 401 }), THRESHOLDS), false],
  ]
  for (const [label, failures, passes] of rows) assert.equal(failures.length === 0, passes, `${label}: ${failures.join(', ')}`)
})
