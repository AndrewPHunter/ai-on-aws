// U18. A table inside a list item is written in the list's text chunk in the plain table form, with every row and
// cell present, and the check passes on it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkChunks } from '../src/chunk/check.ts'
import { U18_TABLE_IN_ITEM, chunk } from './support/chunking.ts'

test('U18. a table in a list item is written in the list text chunk', () => {
  const { chunks, document } = chunk(U18_TABLE_IN_ITEM, { textLimit: 300, tableLimit: 300 })
  assert.deepEqual(chunks.map((c) => [c.type, c.text]), [['text', ['Intro words', '  c1 | c2', '  c3 | c4', 'Closing item'].join('\n')]])
  assert.deepEqual(checkChunks(document, chunks), { missing: 0, extra: 0 })
})
