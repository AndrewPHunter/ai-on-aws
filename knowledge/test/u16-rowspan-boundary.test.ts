// U16. In a splittable table over the limit, a cell that spans rows is never cut from the rows it covers: no chunk
// boundary falls between two rows that a cell spans.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U16_ROWSPAN, chunk } from './support/chunking.ts'

test('U16. no chunk boundary falls inside a row span', () => {
  const { chunks } = chunk(U16_ROWSPAN, { textLimit: 300, tableLimit: 6 })
  assert.ok(chunks.every((c) => c.type === 'table-rows'))
  // The cell starting in row 2 spans row 3: the two stay in one chunk, though rows 1 and 2 alone would fit.
  assert.deepEqual(chunks.map((c) => [c.position.firstRow, c.position.lastRow]), [[1, 1], [2, 3], [4, 5]])
  assert.ok(chunks.every((c) => c.position.firstRow !== 3))
  assert.equal(chunks[1]?.text, ['A | B', 'spanning | 2', ' | 3'].join('\n'))
})
