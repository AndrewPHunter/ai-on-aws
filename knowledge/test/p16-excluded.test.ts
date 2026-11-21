// P16. A label with no section that has text gives no-sections; a label whose XML is refused gives unreadable;
// neither gets a parsed file.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runParse } from '../src/parse/run.ts'
import { folders, listFiles } from './support/fixture.ts'
import { writeLabels } from './support/folder.ts'
import { P16_NO_SECTIONS, P16_UNREADABLE, P4_TEXT, parse } from './support/labels.ts'
import { errors } from './support/parsed.ts'

test('P16. no sections with text, and unreadable XML, are errors', () => {
  assert.deepEqual(errors(parse(P16_NO_SECTIONS).problems), [{ code: 'no-sections', severity: 'error' }])
  const unreadable = parse(P16_UNREADABLE)
  assert.equal(unreadable.document, null)
  assert.deepEqual(unreadable.problems, [{ code: 'unreadable', severity: 'error', reason: 'xml-doctype-declares-entities' }])
})

test('P16. neither gets a parsed file', async (t) => {
  const where = await folders(t)
  await writeLabels(where, [P16_NO_SECTIONS, P16_UNREADABLE, P4_TEXT])
  const report = await runParse({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {} })
  const parsed = (await listFiles(where.dataDir)).filter((file) => file.startsWith('parsed/'))
  assert.deepEqual(parsed, [`parsed/${P4_TEXT.setId}/1.json`])
  const byId = new Map(report.labels.map((entry) => [entry.setId, entry]))
  assert.equal(byId.get(P16_NO_SECTIONS.setId)?.status, 'excluded')
  assert.equal(byId.get(P16_UNREADABLE.setId)?.status, 'excluded')
  assert.deepEqual(report.excludedBy, { 'no-sections': 1, 'table-not-rectangular': 0, 'text-not-conserved': 0, unreadable: 1 })
})
