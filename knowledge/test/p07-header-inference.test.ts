// P7. Tables with no thead: leading rows of th cells are an inferred header; leading rows whose cells are wholly
// bold are an inferred header; a first row bold in only some cells is not, and the header is none. Each row
// records whether it is wholly bold and how many of its cells have text.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P7_BOLD, P7_GROUPS, P7_PARTLY_BOLD, P7_TH } from './support/labels.ts'
import { onlyTable, parsedOk, withCode } from './support/parsed.ts'

const rows = [
  { name: 'a first row of th cells', label: P7_TH, section: 'p7a', source: 'inferred', headerRows: 1, warning: 'table-header-inferred' },
  { name: 'a first row of wholly bold cells', label: P7_BOLD, section: 'p7b', source: 'inferred', headerRows: 1, warning: 'table-header-inferred' },
  { name: 'a first row bold in only some cells', label: P7_PARTLY_BOLD, section: 'p7c', source: 'none', headerRows: 0, warning: 'table-header-none' },
] as const

for (const row of rows) {
  test(`P7. ${row.name}`, () => {
    const table = onlyTable(row.label, row.section)
    assert.equal(table.headerSource, row.source)
    assert.equal(table.headerRows, row.headerRows)
    assert.equal(table.rows.length, 2)
    assert.deepEqual(withCode(parsedOk(row.label).problems, row.warning).map((p) => [p.sectionId, p.table]), [[row.section, 0]])
  })
}

test('P7. each row records whether it is wholly bold and how many of its cells have text', () => {
  const table = onlyTable(P7_GROUPS, 'p7d')
  assert.deepEqual(table.rowFacts, [
    { wholeBold: true, filledCells: 2 },
    { wholeBold: false, filledCells: 2 },
    { wholeBold: true, filledCells: 1 },
    { wholeBold: false, filledCells: 2 },
  ])
  // Header inference is unchanged: only the leading bold row.
  assert.equal(table.headerSource, 'inferred')
  assert.equal(table.headerRows, 1)
})
