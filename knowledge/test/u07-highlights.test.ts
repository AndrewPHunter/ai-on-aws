// U7. Highlights blocks become chunks with part highlights, separate from the section's body chunks, and their text
// is not in a body chunk.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunk, ofSection } from './support/chunking.ts'
import { P3_HIGHLIGHTS } from './support/labels.ts'

test('U7. Highlights chunks are their own', () => {
  const chunks = ofSection(chunk(P3_HIGHLIGHTS, { textLimit: 300, tableLimit: 300 }).chunks, 'h1')
  assert.deepEqual(chunks.map((c) => [c.part, c.text]), [
    ['body', 'Invented full warning text.'],
    ['highlights', 'Invented highlight summary.'],
  ])
  assert.notEqual(chunks[0]?.id, chunks[1]?.id)
})
