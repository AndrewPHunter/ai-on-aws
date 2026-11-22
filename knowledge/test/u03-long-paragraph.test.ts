// U3. A long paragraph is split at sentence ends; a single sentence over the limit is split between words; each is
// counted.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U3_LONG, chunk, ofSection } from './support/chunking.ts'

test('U3. sentence ends first, then between words', () => {
  const { chunks, stats } = chunk(U3_LONG, { textLimit: 6, tableLimit: 300 })
  assert.deepEqual(ofSection(chunks, 'u3a').map((c) => c.text), ['One two three. Four five six.', 'Seven eight.'])
  assert.deepEqual(ofSection(chunks, 'u3b').map((c) => c.text), ['w1 w2 w3 w4 w5 w6', 'w7 w8 w9 w10 w11 w12.'])
  assert.equal(stats.paragraphsSplitAtSentences, 2)
  assert.equal(stats.sentencesSplitBetweenWords, 1)
})
