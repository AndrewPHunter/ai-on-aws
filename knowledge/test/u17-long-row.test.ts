// U17. A single body row larger than the table limit makes a chunk of that one row with the caption and header
// rows, and the rows around it are in their own chunks.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U17_LONG_ROW, chunk } from './support/chunking.ts'

test('U17. a row over the limit is a chunk of its own, with the caption and header', () => {
  const { chunks } = chunk(U17_LONG_ROW, { textLimit: 300, tableLimit: 8 })
  const caption = 'Table 5: Invented'
  const header = 'Name | Value'
  const long = `${Array.from({ length: 20 }, (_, i) => `word${i + 1}`).join(' ')} | 2`
  assert.deepEqual(
    chunks.map((c) => [c.text, c.repeated, c.position.firstRow, c.position.lastRow]),
    [
      [[caption, header, 'a | 1'].join('\n'), [], 1, 1],
      [[caption, header, long].join('\n'), [caption, header], 2, 2],
      [[caption, header, 'c | 3'].join('\n'), [caption, header], 3, 3],
    ],
  )
  assert.ok((chunks[1]?.words ?? 0) > 8)
})
