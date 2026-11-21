// P3. Highlights: an excerpt's text is in the section's Highlights blocks and not in its own blocks, and the
// section's own text is not in its Highlights.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P3_HIGHLIGHTS } from './support/labels.ts'
import { paragraphs, parsedOk, sectionById } from './support/parsed.ts'

test('P3. Highlights are kept apart from the section own text', () => {
  const { document } = parsedOk(P3_HIGHLIGHTS)
  const section = sectionById(document.sections, 'h1')
  assert.deepEqual(paragraphs(section.highlights).map((p) => p.text), ['Invented highlight summary.'])
  assert.deepEqual(paragraphs(section.blocks).map((p) => p.text), ['Invented full warning text.'])
  assert.equal(section.highlights.length, 1)
  assert.equal(section.blocks.length, 1)
})
