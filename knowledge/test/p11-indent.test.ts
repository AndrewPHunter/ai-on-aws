// P11. Indent: leading non-breaking spaces in a cell and in a paragraph give an indent level and are not in the
// text.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P11_INDENT } from './support/labels.ts'
import { paragraphs, parsedOk, sectionById, tables } from './support/parsed.ts'

test('P11. leading non-breaking spaces become an indent', () => {
  const { document } = parsedOk(P11_INDENT)
  const blocks = sectionById(document.sections, 'p11').blocks
  const [paragraph] = paragraphs(blocks)
  assert.equal(paragraph?.text, 'Indented invented paragraph')
  assert.equal(paragraph?.indent, 2)
  const cell = tables(blocks)[0]?.rows[1]?.[0]
  assert.equal(cell?.text, 'Invented subgroup')
  assert.equal(cell?.indent, 3)
  assert.equal(tables(blocks)[0]?.rows[1]?.[1]?.indent, 0)
})
