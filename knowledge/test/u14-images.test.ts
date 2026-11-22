// U14. An image with text contributes it; a section of images with no text makes no chunk and is counted.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U14_IMAGES, chunk, ofSection } from './support/chunking.ts'

test('U14. image text, and a section of images with no text', () => {
  const { chunks, stats } = chunk(U14_IMAGES, { textLimit: 300, tableLimit: 300 })
  assert.deepEqual(ofSection(chunks, 'u14').map((c) => c.text), ['Invented structure picture'])
  assert.deepEqual(ofSection(chunks, 'u14-bare'), [])
  assert.equal(stats.sectionsImageOnlySkipped, 1)
})
