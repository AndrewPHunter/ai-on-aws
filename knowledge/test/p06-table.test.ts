// P6. A table with thead, tbody and tfoot: header rows from thead, body rows, and the footnote attached.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P6_TABLE } from './support/labels.ts'
import { onlyTable } from './support/parsed.ts'

test('P6. thead, tbody and tfoot', () => {
  const table = onlyTable(P6_TABLE, 'tb1')
  assert.equal(table.headerSource, 'thead')
  assert.equal(table.headerRows, 1)
  assert.deepEqual(table.rows.map((row) => row.map((cell) => [cell.text, cell.header])), [
    [['Invented dose', true], ['Invented effect', true]],
    [['Low', false], ['Mild rash*', false]],
    [['High', false], ['Severe', false]],
  ])
  assert.equal(table.columns, 2)
  assert.deepEqual(table.footnotes, [{ mark: '*', text: '* Invented table footnote.', source: 'tfoot', cells: [[1, 1]] }])
})
