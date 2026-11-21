// U5. Footnotes of a paragraph are written after it in the same chunk.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunk, ofSection } from './support/chunking.ts'
import { P10_FOOTNOTES } from './support/labels.ts'

test('U5. a paragraph footnote follows its paragraph in the same chunk', () => {
  const { chunks } = chunk(P10_FOOTNOTES, { textLimit: 300, tableLimit: 300 })
  const [text] = ofSection(chunks, 'p10').filter((c) => c.type === 'text')
  assert.equal(text?.text, 'Invented claim[^1] continues.\n[^1] Invented paragraph note.')
})
