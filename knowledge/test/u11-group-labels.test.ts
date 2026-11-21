// U11. Group labels in a splittable table: a chunk that starts below a group label carries it, listed in repeated;
// a label that falls inside a chunk appears once, in place, and is not in repeated; a group label is never the
// last row of a chunk.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U11_GROUPS, chunk } from './support/chunking.ts'

test('U11. group labels carried, kept in place, and never last', () => {
  const { chunks } = chunk(U11_GROUPS, { textLimit: 300, tableLimit: 8 })
  const header = 'Group | Value'
  const alpha = 'Alpha group | '
  const beta = 'Beta group | '
  assert.deepEqual(
    chunks.map((c) => [c.text, c.repeated, c.position.firstRow, c.position.lastRow]),
    [
      [[header, alpha, 'a1 | 1', 'a2 | 2'].join('\n'), [], 1, 3],
      [[header, alpha, 'a3 | 3'].join('\n'), [header, alpha], 4, 4],
      [[header, beta, 'b1 | 4', 'b2 | 5'].join('\n'), [header], 5, 7],
    ],
  )
  // Rows 1 and 5 are the group labels: no chunk ends on one.
  assert.ok(chunks.every((c) => c.position.lastRow !== 1 && c.position.lastRow !== 5))
})
