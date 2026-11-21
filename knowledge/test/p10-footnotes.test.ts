// P10. Footnotes: one in a paragraph leaves its mark in the text and its text on the block; one inside a table
// cell is attached to the table with the cells that refer to it; a reference with no footnote gives the warning.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P10_FOOTNOTES } from './support/labels.ts'
import { paragraphs, parsedOk, sectionById, tables, withCode } from './support/parsed.ts'

test('P10. footnotes in a paragraph and in a table cell, and a reference to nothing', () => {
  const { document, problems } = parsedOk(P10_FOOTNOTES)
  const blocks = sectionById(document.sections, 'p10').blocks
  const [paragraph] = paragraphs(blocks)
  assert.deepEqual(paragraph, {
    type: 'paragraph',
    text: 'Invented claim[^1] continues.',
    indent: 0,
    marks: ['[^1]'],
    footnotes: [{ mark: '[^1]', text: 'Invented paragraph note.' }],
  })

  const [table] = tables(blocks)
  assert.ok(table)
  assert.equal(table.rows[0]?.[0]?.text, 'Rate[^2]')
  assert.equal(table.rows[0]?.[1]?.text, 'Other rate[^2]')
  assert.deepEqual(table.footnotes, [{ mark: '[^2]', text: 'Invented cell note.', source: 'cell', cells: [[0, 0], [0, 1]] }])

  assert.equal(table.rows[1]?.[1]?.text, 'Lost reference[^?]')
  assert.deepEqual(withCode(problems, 'footnote-reference-unmatched'), [
    { code: 'footnote-reference-unmatched', severity: 'warning', sectionId: 'p10' },
  ])
})
