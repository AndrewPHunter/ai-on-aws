// U8. The plain form of a table: caption, rows with " | ", an empty position, a cell spanning columns written once,
// a line break in a cell, footnotes with marks, and no row of dashes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U8_TABLE, chunk } from './support/chunking.ts'

test('U8. the plain form', () => {
  const [table] = chunk(U8_TABLE, { textLimit: 300, tableLimit: 300 }).chunks.filter((c) => c.type === 'table')
  assert.equal(
    table?.text,
    [
      'Table 9: Invented',
      'Dose | Effect | Note',
      'A |  | B',
      'C | D / E | F*[^1]',
      'G |  | ',
      '[^1] Invented cell note.',
      '* Invented star.',
    ].join('\n'),
  )
  assert.doesNotMatch(table?.text ?? '', /---/)
})
