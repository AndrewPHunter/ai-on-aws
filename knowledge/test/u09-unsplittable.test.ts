// U9. A table that is not splittable is one chunk even when far over the limit, and is counted as oversize.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U9_UNSPLITTABLE, chunk } from './support/chunking.ts'

const none = { headerNotThead: false, nestedTable: false, shortRow: false, boldRowNotGroupLabel: false }

test('U9. one chunk each, counted as oversize, with the condition each fails', () => {
  const { chunks, stats } = chunk(U9_UNSPLITTABLE, { textLimit: 300, tableLimit: 5 })
  assert.deepEqual(chunks.map((c) => c.type), ['table', 'table', 'table', 'table', 'table'])
  assert.ok(chunks.every((c) => c.words > 5))
  assert.deepEqual(
    stats.tables.map((t) => [t.outcome, t.chunks, t.notSplittable]),
    [
      ['one-oversize', 1, { ...none, headerNotThead: true }],
      ['one-oversize', 1, { ...none, headerNotThead: true }],
      ['one-oversize', 1, { ...none, nestedTable: true }],
      ['one-oversize', 1, { ...none, shortRow: true }],
      ['one-oversize', 1, { ...none, boldRowNotGroupLabel: true }],
    ],
  )
})
