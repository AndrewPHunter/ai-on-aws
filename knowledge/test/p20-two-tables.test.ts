// P20. The same footnote mark used in two tables of one section links, in each table, only to that table's own
// footnote and cells.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P20_TWO_TABLES } from './support/labels.ts'
import { parsedOk, sectionById, tables, withCode } from './support/parsed.ts'

test('P20. a mark shared by two tables links each table only to its own cells', () => {
  const { document, problems } = parsedOk(P20_TWO_TABLES)
  const [first, second] = tables(sectionById(document.sections, 'p20').blocks)
  assert.ok(first && second)
  assert.deepEqual(first.footnotes, [{ mark: '*', text: '* Invented note.', source: 'tfoot', cells: [[0, 1]] }])
  assert.deepEqual(second.footnotes, [{ mark: '*', text: '* Invented note.', source: 'tfoot', cells: [[1, 0]] }])
  assert.deepEqual(withCode(problems, 'footnote-mark-unmatched'), [])
})
