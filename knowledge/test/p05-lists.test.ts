// P5. Lists: ordered and unordered; a nested list sits inside its item; an item's caption is kept.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { List } from '../src/parse/model.ts'
import { P5_LISTS } from './support/labels.ts'
import { parsedOk, sectionById, tables } from './support/parsed.ts'

test('P5. lists, nested lists and item captions', () => {
  const { document } = parsedOk(P5_LISTS)
  const blocks = sectionById(document.sections, 'l1').blocks
  const lists = blocks.filter((block): block is List => block.type === 'list')
  const [ordered, unordered, captionInParagraph] = lists
  assert.ok(ordered && unordered && captionInParagraph)

  assert.equal(ordered.ordered, true)
  assert.deepEqual(ordered.items.map((item) => item.text), ['First invented step', 'Second invented step'])

  assert.equal(unordered.ordered, false)
  const [outer, captioned] = unordered.items
  assert.ok(outer && captioned)
  assert.equal(outer.text, 'Outer invented point')
  const [nested] = outer.blocks
  assert.ok(nested?.type === 'list')
  assert.deepEqual(nested.items.map((item) => item.text), ['Inner invented point'])
  assert.equal(captioned.caption, 'a.')
  assert.equal(captioned.text, 'Captioned invented point')
})

test('P5. a caption opening an item paragraph is the item caption, and never runs into the next word', () => {
  const { document } = parsedOk(P5_LISTS)
  const blocks = sectionById(document.sections, 'l1').blocks
  const lists = blocks.filter((block): block is List => block.type === 'list')
  const item = lists[2]?.items[0]
  assert.equal(item?.caption, 'o')
  assert.equal(item?.text, 'Invented males')
  // In a table cell the list becomes a line of the cell's text, its caption in front.
  assert.equal(tables(blocks)[0]?.rows[0]?.[0]?.text, 'o Invented females')
})
