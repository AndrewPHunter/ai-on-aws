// P21. A table shaped like the real ones (a caption row spanning every column, then rows of bold body cells, then
// plain rows) infers the caption and exactly the bold rows as the header.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P21_REAL_SHAPE } from './support/labels.ts'
import { onlyTable } from './support/parsed.ts'

test('P21. caption row, bold rows, plain rows', () => {
  const table = onlyTable(P21_REAL_SHAPE, 'p21')
  assert.equal(table.captionSource, 'inferred')
  assert.equal(table.caption, 'Table 3: Invented adverse reactions')
  assert.equal(table.headerSource, 'inferred')
  assert.equal(table.headerRows, 2)
  assert.deepEqual(table.rows.map((row) => row[0]?.text), ['', 'Reaction', 'Invented headache', 'Invented nausea'])
  assert.deepEqual(table.rowFacts.map((facts) => facts.wholeBold), [true, true, false, false])
})
