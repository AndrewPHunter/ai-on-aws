// P14. An element the parser does not know: its text is kept, its name is reported, and the label is not excluded.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P14_UNKNOWN, parse } from './support/labels.ts'
import { errors, paragraphs, sectionById, withCode } from './support/parsed.ts'

test('P14. an unknown element keeps its text and is reported by name', () => {
  const result = parse(P14_UNKNOWN)
  assert.ok(result.document)
  assert.deepEqual(paragraphs(sectionById(result.document.sections, 'p14').blocks).map((p) => p.text), ['Invented kept words here'])
  assert.deepEqual(withCode(result.problems, 'element-unknown'), [
    { code: 'element-unknown', severity: 'warning', element: 'madeUpElement', count: 1 },
  ])
  assert.deepEqual(errors(result.problems), [])
})
