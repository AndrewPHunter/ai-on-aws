// P2. The section tree: nesting, codes and ids; a title broken across lines is collapsed; section numbers in a
// new-format label only; the path skips an untitled section and still nests under it.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P2_NEW, P2_OLD } from './support/labels.ts'
import { parsedOk, sectionById, withCode } from './support/parsed.ts'

test('P2. a new-format label: nesting, ids, codes, collapsed titles, numbers and paths', () => {
  const { document, problems } = parsedOk(P2_NEW)
  assert.deepEqual(
    document.sections.map((s) => [s.id, s.code]),
    [['s1', '34067-9'], ['s5', '43685-7'], ['s17', '34076-0']],
  )
  const s1 = sectionById(document.sections, 's1')
  assert.equal(s1.title, '1 INDICATIONS AND USAGE')
  assert.equal(s1.number, '1')
  assert.deepEqual(s1.path, ['1 INDICATIONS AND USAGE'])

  const s5 = sectionById(document.sections, 's5')
  assert.deepEqual(s5.sections.map((s) => s.id), ['s51', 's-untitled'])
  const s51 = sectionById(document.sections, 's51')
  assert.equal(s51.number, '5.1')
  assert.equal(s51.code, '42229-5')
  assert.deepEqual(s51.path, ['5 WARNINGS AND PRECAUTIONS', '5.1 Invented risk'])

  const untitled = sectionById(document.sections, 's-untitled')
  assert.equal(untitled.title, null)
  assert.equal(untitled.number, null)
  assert.deepEqual(untitled.path, ['5 WARNINGS AND PRECAUTIONS'])
  assert.deepEqual(untitled.sections.map((s) => s.id), ['s-deep'])
  assert.deepEqual(sectionById(document.sections, 's-deep').path, ['5 WARNINGS AND PRECAUTIONS', 'Deep child'])

  assert.equal(sectionById(document.sections, 's17').number, '17')
  assert.deepEqual(withCode(problems, 'section-untitled').map((p) => p.sectionId), ['s-untitled'])
  assert.deepEqual(withCode(problems, 'section-unclassified').map((p) => p.sectionId), ['s51', 's-deep', 's-untitled'])
})

test('P2. an old-format label: numbering stays in the title and gives no number', () => {
  const { document } = parsedOk(P2_OLD)
  assert.equal(document.format, 'old')
  const o11 = sectionById(document.sections, 'o11')
  assert.equal(o11.title, '1. Invented disorders')
  assert.equal(o11.number, null)
  assert.equal(sectionById(document.sections, 'o12').number, null)
  assert.deepEqual(o11.path, ['INDICATIONS', '1. Invented disorders'])
})
