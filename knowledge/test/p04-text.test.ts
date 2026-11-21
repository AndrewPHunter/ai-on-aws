// P4. Text rules: white space is collapsed; a line break is kept; superscripts and subscripts are kept and
// marked; bold and italic leave the text unchanged.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P4_TEXT } from './support/labels.ts'
import { paragraphs, parsedOk, sectionById } from './support/parsed.ts'

test('P4. text rules', () => {
  const { document } = parsedOk(P4_TEXT)
  assert.deepEqual(paragraphs(sectionById(document.sections, 't1').blocks).map((p) => p.text), [
    'Dose is ten units\nper day',
    'Area of 1.5 m^{2} exactly',
    'Count of 10^{6} cells',
    'Formula H_{2}O here',
    'Bold and italic words',
  ])
})
