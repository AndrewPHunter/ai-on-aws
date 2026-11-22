// P9. Captions: a caption element; a first row that is one cell across every column gives an inferred caption
// and is not also a body row; a first row that spans only some columns does not.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P9_CAPTION, P9_INFERRED, P9_PARTIAL } from './support/labels.ts'
import { onlyTable, parsedOk, withCode } from './support/parsed.ts'

test('P9. a caption element', () => {
  const table = onlyTable(P9_CAPTION, 'p9a')
  assert.equal(table.caption, 'Table 1: Invented caption')
  assert.equal(table.captionSource, 'element')
})

test('P9. a first row of one cell across every column is an inferred caption, not a body row', () => {
  const table = onlyTable(P9_INFERRED, 'p9b')
  assert.equal(table.caption, 'Table 2: Invented title row')
  assert.equal(table.captionSource, 'inferred')
  assert.deepEqual(table.rows.map((row) => row.map((cell) => cell.text)), [['One', 'Two', 'Three'], ['Four', 'Five', 'Six']])
  assert.deepEqual(withCode(parsedOk(P9_INFERRED).problems, 'table-caption-inferred').map((p) => [p.sectionId, p.table]), [['p9b', 0]])
})

test('P9. a first row spanning only some columns is not a caption', () => {
  const table = onlyTable(P9_PARTIAL, 'p9c')
  assert.equal(table.caption, null)
  assert.equal(table.captionSource, 'none')
  assert.equal(table.rows.length, 2)
  assert.equal(table.rows[0]?.[0]?.text, 'Wide but not across')
})
