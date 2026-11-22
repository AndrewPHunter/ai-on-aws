// U10. A splittable table within the limit is one chunk; one over it is split into chunks of consecutive rows,
// each holding the caption and every header row. The first holds them in their place; every later one lists them
// in repeated.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U10_SPLITTABLE, chunk } from './support/chunking.ts'

test('U10. within the limit: one chunk', () => {
  const { chunks, stats } = chunk(U10_SPLITTABLE, { textLimit: 300, tableLimit: 300 })
  assert.deepEqual(chunks.map((c) => c.type), ['table'])
  assert.equal(stats.tables[0]?.outcome, 'one-within-limit')
})

test('U10. over the limit: runs of rows; the first holds the caption and header in place, each later one repeats them and lists them in repeated', () => {
  const { chunks, stats } = chunk(U10_SPLITTABLE, { textLimit: 300, tableLimit: 12 })
  const caption = 'Table 1: Invented'
  const header = 'Col A | Col B'
  assert.deepEqual(
    chunks.map((c) => [c.type, c.text, c.repeated, c.position]),
    [
      ['table-rows', [caption, header, 'row1 | value1', 'row2 | value2'].join('\n'), [], { ordinal: 1, firstRow: 1, lastRow: 2, rowCount: 7 }],
      ['table-rows', [caption, header, 'row3 | value3', 'row4 | value4'].join('\n'), [caption, header], { ordinal: 2, firstRow: 3, lastRow: 4, rowCount: 7 }],
      ['table-rows', [caption, header, 'row5 | value5', 'row6 | value6'].join('\n'), [caption, header], { ordinal: 3, firstRow: 5, lastRow: 6, rowCount: 7 }],
    ],
  )
  assert.deepEqual(stats.tables.map((t) => [t.outcome, t.chunks]), [['split', 3]])
})
