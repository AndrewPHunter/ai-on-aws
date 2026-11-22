// P17. The same input gives byte-identical output on two runs, and the report holds no label text: every string
// in it is an identifier, a code from the fixed lists, or an element name.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../src/files.ts'
import { ERROR_CODES, WARNING_CODES } from '../src/parse/model.ts'
import { runParse } from '../src/parse/run.ts'
import { REASONS } from '../src/reasons.ts'
import { folders, listFiles } from './support/fixture.ts'
import { writeLabels } from './support/folder.ts'
import { FIXTURES, P16_NO_SECTIONS, P16_UNREADABLE } from './support/labels.ts'

const all = [...Object.values(FIXTURES), P16_NO_SECTIONS, P16_UNREADABLE]

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) strings(item, out)
  return out
}

test('P17. two runs write byte-identical files, and the report holds identifiers and codes only', async (t) => {
  const where = await folders(t)
  await writeLabels(where, all)
  await runParse({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {} })
  const files = await listFiles(where.dataDir)
  const first = await Promise.all(files.map(async (file) => sha256(await readFile(join(where.dataDir, file)))))
  await runParse({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {} })
  assert.deepEqual(await listFiles(where.dataDir), files)
  const second = await Promise.all(files.map(async (file) => sha256(await readFile(join(where.dataDir, file)))))
  assert.deepEqual(second, first)

  const text = await readFile(join(where.dataDir, 'parse-report.json'), 'utf8')
  const sectionIds = new Set<string>()
  for (const label of all) for (const match of label.xml.toString('utf8').matchAll(/<section><id root="([^"]+)"/g)) if (match[1]) sectionIds.add(match[1])
  const allowed = new Set<string>([
    ...all.map((label) => label.setId),
    ...sectionIds,
    ...ERROR_CODES,
    ...WARNING_CODES,
    ...REASONS,
    'missing',
    'checksum-mismatch',
    'error',
    'warning',
    'parsed',
    'excluded',
    'prescription',
    'otc',
    'other',
    'new',
    'old',
    'unknown',
    'madeUpElement',
  ])
  const strange = strings(JSON.parse(text)).filter((value) => !allowed.has(value))
  assert.deepEqual(strange, [])
  assert.ok(!text.includes('Invented'))
})
