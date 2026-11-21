// U13. The check: it passes on every fixture; and, on chunks altered by hand, a dropped row, a doubled paragraph,
// and a header row missing from repeated each fail with the right counts.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkChunks } from '../src/chunk/check.ts'
import { CHUNK_FIXTURES, U10_SPLITTABLE, U2_PACK, chunk } from './support/chunking.ts'
import { FIXTURES } from './support/labels.ts'

test('U13. every fixture passes, at generous and at tight limits', () => {
  for (const [name, label] of Object.entries({ ...FIXTURES, ...CHUNK_FIXTURES })) {
    for (const settings of [{ textLimit: 300, tableLimit: 300 }, { textLimit: 3, tableLimit: 3 }]) {
      const { chunks, document } = chunk(label, settings)
      assert.deepEqual(checkChunks(document, chunks), { missing: 0, extra: 0 }, `${name} at ${settings.textLimit}`)
    }
  }
})

test('U13. a dropped row fails', () => {
  const { chunks, document } = chunk(U10_SPLITTABLE, { textLimit: 300, tableLimit: 12 })
  const altered = chunks.map((c, i) => (i === 1 ? { ...c, text: c.text.replace('\nrow4 | value4', '') } : c))
  assert.deepEqual(checkChunks(document, altered), { missing: 2, extra: 0 })
})

test('U13. a doubled paragraph fails', () => {
  const { chunks, document } = chunk(U2_PACK, { textLimit: 10, tableLimit: 300 })
  const altered = chunks.map((c, i) => (i === 1 ? { ...c, text: `${c.text}\nlambda mu nu` } : c))
  assert.deepEqual(checkChunks(document, altered), { missing: 0, extra: 3 })
})

test('U13. a header row missing from repeated fails', () => {
  const { chunks, document } = chunk(U10_SPLITTABLE, { textLimit: 300, tableLimit: 12 })
  const altered = chunks.map((c, i) => (i === 2 ? { ...c, repeated: c.repeated.filter((line) => line !== 'Col A | Col B') } : c))
  assert.deepEqual(checkChunks(document, altered), { missing: 0, extra: 4 })
})
