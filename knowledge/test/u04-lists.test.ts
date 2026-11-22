// U4. Lists: a list that fits stays whole; one that does not is split between items; a nested list stays with its
// item; captions and indentation are written.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U4_LISTS, chunk, ofSection } from './support/chunking.ts'

test('U4. lists whole, and split between items', () => {
  const { chunks, stats } = chunk(U4_LISTS, { textLimit: 8, tableLimit: 300 })
  assert.deepEqual(ofSection(chunks, 'u4a').map((c) => c.text), ['First item\nSecond item'])
  assert.deepEqual(ofSection(chunks, 'u4b').map((c) => c.text), ['Alpha one two\nBeta three four\n  Gamma five', 'a. Delta six'])
  assert.equal(stats.listsSplitBetweenItems, 1)
  assert.equal(stats.itemsSplit, 0)
})
