// U6. A section with child sections and no blocks of its own makes no chunk; the children's chunks carry the full
// title path; an untitled section's chunks carry the path of its titled ancestors.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U6_UNTITLED, chunk, ofSection } from './support/chunking.ts'
import { P2_NEW } from './support/labels.ts'

const SETTINGS = { textLimit: 300, tableLimit: 300 }

test('U6. sections without blocks, title paths, untitled sections', () => {
  const { chunks } = chunk(P2_NEW, SETTINGS)
  assert.deepEqual(ofSection(chunks, 's5'), [])
  assert.deepEqual(ofSection(chunks, 's-untitled'), [])
  assert.deepEqual(ofSection(chunks, 's51')[0]?.section.path, ['5 WARNINGS AND PRECAUTIONS', '5.1 Invented risk'])
  assert.deepEqual(ofSection(chunks, 's-deep')[0]?.section.path, ['5 WARNINGS AND PRECAUTIONS', 'Deep child'])

  const untitled = ofSection(chunk(U6_UNTITLED, SETTINGS).chunks, 'u6-untitled')
  assert.equal(untitled.length, 1)
  assert.equal(untitled[0]?.section.title, null)
  assert.deepEqual(untitled[0]?.section.path, ['Parent title'])
  assert.match(untitled[0]?.context ?? '', /: Parent title$/)
})
