// P13. A table inside a cell is kept as a nested table and gives the warning.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P13_NESTED } from './support/labels.ts'
import { parsedOk, sectionById, tables, withCode } from './support/parsed.ts'

test('P13. a table in a cell, directly or through a list, is a nested table', () => {
  const { document, problems } = parsedOk(P13_NESTED)
  const [first, second] = tables(sectionById(document.sections, 'p13').blocks)
  assert.ok(first && second)

  const outerCell = first.rows[0]?.[1]
  assert.equal(outerCell?.text, '')
  const [inner] = tables(outerCell?.blocks ?? [])
  assert.deepEqual(inner?.rows.map((row) => row.map((cell) => cell.text)), [['Inner one', 'Inner two']])

  const listCell = second.rows[0]?.[1]
  assert.equal(listCell?.text, 'Listed')
  assert.deepEqual(tables(listCell?.blocks ?? [])[0]?.rows.map((row) => row.map((cell) => cell.text)), [['Deep one']])

  // Tables are numbered in document order within the section, nested ones counted.
  assert.deepEqual(withCode(problems, 'table-nested').map((p) => [p.sectionId, p.table]), [['p13', 1], ['p13', 3]])
})
