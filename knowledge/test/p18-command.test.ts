// P18. The command against a small folder of synthetic labels: a parsed file for each label without an error,
// none for a label with one, a report entry for every label in the manifest, and exit 0.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { command } from './support/command.ts'
import { folders, listFiles } from './support/fixture.ts'
import { writeLabels } from './support/folder.ts'
import { P1_OTC, P1_PRESCRIPTION, P6_TABLE, P8_CLASH } from './support/labels.ts'

test('P18. parse writes a file per clean label, none for one with an error, and reports every label', async (t) => {
  const where = await folders(t)
  const labels = [P1_PRESCRIPTION, P1_OTC, P6_TABLE, P8_CLASH]
  await writeLabels(where, labels)

  const result = await command(['parse', '--corpus', where.corpusDir, '--data', where.dataDir])

  assert.equal(result.code, 0, result.err.join('\n'))
  const parsed = (await listFiles(where.dataDir)).filter((file) => file.startsWith('parsed/'))
  assert.deepEqual(parsed, [P1_PRESCRIPTION, P1_OTC, P6_TABLE].map((label) => `parsed/${label.setId}/${label.version}.json`).sort())

  const report = JSON.parse(await readFile(join(where.dataDir, 'parse-report.json'), 'utf8')) as {
    counts: unknown
    labels: { setId: string; status: string }[]
  }
  assert.deepEqual(report.counts, { labels: 4, parsed: 3, excluded: 1 })
  assert.deepEqual(
    report.labels.map((entry) => [entry.setId, entry.status]),
    labels.map((label) => [label.setId, label === P8_CLASH ? 'excluded' : 'parsed']).sort(),
  )
})
