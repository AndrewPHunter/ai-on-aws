// P12. Images: an image block carries the object's id and its descriptive text; a section holding only images
// gives the warning.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { P12_IMAGES } from './support/labels.ts'
import { parsedOk, sectionById, withCode } from './support/parsed.ts'

test('P12. image blocks, and a section of images only', () => {
  const { document, problems } = parsedOk(P12_IMAGES)
  const described = sectionById(document.sections, 'p12').blocks
  assert.deepEqual(described.map((block) => block.type), ['paragraph', 'image'])
  assert.deepEqual(described[1], { type: 'image', objectId: 'MM1', text: 'Invented figure description', caption: null })

  assert.deepEqual(sectionById(document.sections, 'p12-only').blocks, [
    { type: 'image', objectId: 'MM2', text: 'Invented carton picture', caption: null },
  ])
  assert.deepEqual(withCode(problems, 'section-images-only').map((p) => p.sectionId), ['p12-only'])
})
