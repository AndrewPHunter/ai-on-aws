// U15. The command on a small folder: a chunk file per parsed label, none for a label with no parsed file, a
// report holding no label text, byte-identical output on a second run, and exit 0.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../src/files.ts'
import { runParse } from '../src/parse/run.ts'
import { command } from './support/command.ts'
import { folders, listFiles } from './support/fixture.ts'
import { writeLabels } from './support/folder.ts'
import { P4_TEXT, P6_TABLE, P8_CLASH } from './support/labels.ts'

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) strings(item, out)
  return out
}

test('U15. chunk files, the report, and a second run', async (t) => {
  const where = await folders(t)
  const labels = [P4_TEXT, P6_TABLE, P8_CLASH]
  await writeLabels(where, labels)
  await runParse({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {} })
  const argv = ['chunk', '--corpus', where.corpusDir, '--data', where.dataDir, '--text-limit', '300', '--table-limit', '300']

  const first = await command(argv)
  assert.equal(first.code, 0, first.err.join('\n'))
  const chunkFiles = (await listFiles(where.dataDir)).filter((file) => file.startsWith('chunks/'))
  assert.deepEqual(chunkFiles, [P4_TEXT, P6_TABLE].map((label) => `chunks/${label.setId}/1.jsonl`).sort())

  const text = await readFile(join(where.dataDir, 'chunk-report.json'), 'utf8')
  const report = JSON.parse(text) as { notChunked: { setId: string; reason: string }[]; labels: unknown[] }
  assert.deepEqual(report.notChunked.map((item) => [item.setId, item.reason]), [[P8_CLASH.setId, 'no-parsed-file']])
  assert.equal(report.labels.length, 3)
  // Identifiers and codes only: set ids, chunk ids, the report's own codes, and the sha256 of each chunk file.
  const codes = new Set(['text', 'table', 'table-rows', 'chunked', 'not-chunked', 'no-parsed-file', 'check-failed'])
  const strange = strings(report).filter(
    (value) =>
      !codes.has(value) && !/^[0-9a-f]{64}$/.test(value) && !labels.some((label) => value === label.setId || value.startsWith(`${label.setId}/`)),
  )
  assert.deepEqual(strange, [])
  assert.ok(!text.includes('Invented'))

  const files = await listFiles(where.dataDir)
  const before = await Promise.all(files.map(async (file) => sha256(await readFile(join(where.dataDir, file)))))
  const second = await command(argv)
  assert.equal(second.code, 0)
  const after = await Promise.all(files.map(async (file) => sha256(await readFile(join(where.dataDir, file)))))
  assert.deepEqual(after, before)
})
