// U1. A chunk carries every field, with the label, drug and section values taken from the document; two runs give
// the same ids; no two chunks in a label share an id.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chunk } from './support/chunking.ts'
import { P1_PRESCRIPTION, P2_NEW } from './support/labels.ts'

const SETTINGS = { textLimit: 300, tableLimit: 300 }

test('U1. every field of a chunk', () => {
  const { chunks } = chunk(P1_PRESCRIPTION, SETTINGS)
  assert.deepEqual(chunks, [
    {
      id: `${P1_PRESCRIPTION.setId}/1/s-wp/body/1`,
      setId: P1_PRESCRIPTION.setId,
      version: 1,
      effectiveTime: '20240102',
      kind: 'prescription',
      format: 'new',
      documentTypeCode: '34391-3',
      // Without duplicates, compared without case.
      drug: ['Examplamab', 'examplamab sodium', 'Examplamab Plus', 'TESTAZOLE'],
      section: { id: 's-wp', code: '43685-7', number: '5', title: '5 WARNINGS AND PRECAUTIONS', path: ['5 WARNINGS AND PRECAUTIONS'] },
      part: 'body',
      type: 'text',
      position: { ordinal: 1 },
      text: 'Invented warning.',
      repeated: [],
      context: 'Examplamab, examplamab sodium, Examplamab Plus, TESTAZOLE: 5 WARNINGS AND PRECAUTIONS',
      words: 2,
      source: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${P1_PRESCRIPTION.setId}&version=1`,
    },
  ])
})

test('U1. ids are stable across runs and unique within a label', () => {
  const first = chunk(P2_NEW, SETTINGS).chunks.map((c) => c.id)
  const second = chunk(P2_NEW, SETTINGS).chunks.map((c) => c.id)
  assert.deepEqual(second, first)
  assert.equal(new Set(first).size, first.length)
  assert.ok(first.length >= 4)
})
