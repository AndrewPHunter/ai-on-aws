// P8. Spans: a cell with a row span and one with a column span each cover the right positions in the grid; a
// short row is kept, with empty positions at its end and a warning; cells that claim one position, or an empty
// position before a covered one, give table-not-rectangular.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P8_CLASH, P8_GAP, P8_RAGGED, P8_SPANS, parse } from './support/labels.ts'
import { errors, onlyTable, withCode } from './support/parsed.ts'

test('P8. row and column spans cover the right positions', () => {
  const table = onlyTable(P8_SPANS, 'p8')
  assert.equal(table.columns, 3)
  assert.deepEqual(table.grid, [
    [[0, 0], [0, 1], [0, 1]],
    [[0, 0], [1, 0], [1, 1]],
    [[2, 0], [2, 1], [2, 2]],
  ])
  assert.deepEqual(errors(parse(P8_SPANS).problems), [])
  assert.deepEqual(withCode(parse(P8_SPANS).problems, 'table-row-short'), [])
})

test('P8. a short row is kept, empty at its end, with a warning and no exclusion', () => {
  const table = onlyTable(P8_RAGGED, 'p8r')
  assert.equal(table.columns, 2)
  assert.deepEqual(table.grid, [
    [[0, 0], [0, 1]],
    [[1, 0], null],
  ])
  const { problems } = parse(P8_RAGGED)
  assert.deepEqual(errors(problems), [])
  assert.deepEqual(withCode(problems, 'table-row-short'), [
    { code: 'table-row-short', severity: 'warning', sectionId: 'p8r', table: 0, count: 1 },
  ])
})

for (const [name, label, section] of [
  ['two cells that claim one position', P8_CLASH, 'p8c'],
  ['an empty position before a covered one', P8_GAP, 'p8g'],
] as const) {
  test(`P8. ${name} gives table-not-rectangular`, () => {
    assert.deepEqual(errors(parse(label).problems), [
      { code: 'table-not-rectangular', severity: 'error', sectionId: section, table: 0 },
    ])
  })
}
