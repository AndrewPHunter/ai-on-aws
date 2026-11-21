// P19. A tfoot footnote whose mark is a symbol, and one whose mark is a superscript, each link to exactly the
// cells that carry that mark; a tfoot mark that no cell carries gives a footnote with no cells and a warning.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P19_MARKS } from './support/labels.ts'
import { onlyTable, parsedOk, withCode } from './support/parsed.ts'

test('P19. tfoot marks link to exactly the cells that carry them', () => {
  const table = onlyTable(P19_MARKS, 'p19')
  assert.deepEqual(table.rows.map((row) => row.map((cell) => cell.text)), [['Rate*', 'Double**'], ['Value^{a}', 'Plain']])
  assert.deepEqual(table.footnotes, [
    // A cell marked ** does not carry *.
    { mark: '*', text: '* Invented star note.', source: 'tfoot', cells: [[0, 0]] },
    { mark: 'a', text: '^{a} Invented letter note.', source: 'tfoot', cells: [[1, 0]] },
    { mark: '†', text: '† Invented dagger note.', source: 'tfoot', cells: [] },
  ])
  assert.deepEqual(withCode(parsedOk(P19_MARKS).problems, 'footnote-mark-unmatched'), [
    { code: 'footnote-mark-unmatched', severity: 'warning', sectionId: 'p19', table: 0 },
  ])
})
