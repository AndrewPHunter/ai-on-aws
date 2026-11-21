// U12. Footnotes in a split table: a chunk carries the footnotes its own cells refer to and every footnote no cell
// refers to, and not a footnote that only another chunk's cells refer to. A footnote a header cell refers to goes
// with every chunk, since the header does (a defect the first real run showed: such footnotes were dropped).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { U12_FOOTNOTES, chunk } from './support/chunking.ts'

test('U12. each run carries its own footnotes, the unreferenced ones, and the header ones', () => {
  const { chunks } = chunk(U12_FOOTNOTES, { textLimit: 300, tableLimit: 14 })
  const header = 'Name[^1] | Value'
  const headerNote = '[^1] Invented header note.'
  assert.deepEqual(
    chunks.map((c) => [c.text, c.repeated]),
    [
      [[header, 'x1 | 1*', 'x2 | 2', headerNote, '* Star note.', '‡ Orphan note.'].join('\n'), []],
      [[header, 'x3 | 3†', 'x4 | 4', headerNote, '† Dagger note.', '‡ Orphan note.'].join('\n'), [header, headerNote, '‡ Orphan note.']],
    ],
  )
})
