// U2. Packing: blocks are packed in order up to the limit; a block that would pass it starts the next chunk; a
// chunk exactly at the limit is not split; there is no overlap.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U2_PACK, chunk } from './support/chunking.ts'

test('U2. paragraphs of 4, 4, 2 and 3 words with a limit of 10', () => {
  const { chunks } = chunk(U2_PACK, { textLimit: 10, tableLimit: 300 })
  assert.deepEqual(
    chunks.map((c) => [c.text, c.words]),
    [
      ['alpha beta gamma delta\nepsilon zeta eta theta\niota kappa', 10],
      ['lambda mu nu', 3],
    ],
  )
  // No overlap: every paragraph appears once, in order.
  assert.equal(chunks.map((c) => c.text).join('\n'), 'alpha beta gamma delta\nepsilon zeta eta theta\niota kappa\nlambda mu nu')
})
