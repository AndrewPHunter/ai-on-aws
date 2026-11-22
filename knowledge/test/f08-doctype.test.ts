// F8. A label XML with a DOCTYPE that declares an external entity is refused and not expanded.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { Refusal } from '../src/reasons.ts'
import { parseLabel } from '../src/spl.ts'
import {
  BENCHMARK,
  benchmarkPin,
  folders,
  listFiles,
  manifestEntry,
  runFetch,
  serveCorpus,
  syntheticLabel,
  writeCorpus,
} from './support/fixture.ts'
import { StandIn } from './support/standin.ts'

const MARKER = 'EXTERNAL-ENTITY-CONTENT-MUST-NOT-APPEAR'

test('F8. a DOCTYPE declaring an external entity is refused, and the entity is not expanded', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const target = join(where.root, 'entity-target.txt')
  await writeFile(target, MARKER)
  const prolog = `<!DOCTYPE document [<!ENTITY outside SYSTEM "${pathToFileURL(target).href}">]>`
  const body = '<component><section><text><paragraph>before &outside; after</paragraph></text></section></component>'
  const hostile = syntheticLabel(1, 1, { prolog, body })
  const good = syntheticLabel(2, 1)

  // The parser alone: refused with the code, and nothing of the entity's target in what it throws.
  assert.throws(
    () => parseLabel(hostile.xml),
    (error: unknown) =>
      error instanceof Refusal && error.reason === 'xml-doctype-declares-entities' && !error.message.includes(MARKER),
  )

  // Through fetch, with a manifest whose checksum matches the hostile XML, so only the DOCTYPE can refuse it.
  serveCorpus(standIn, [hostile, good])
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), {
    labels: [manifestEntry(hostile), manifestEntry(good)],
    notPinned: [],
  })
  const result = await runFetch(standIn, where)

  assert.equal(result.exitCode, 1)
  assert.deepEqual(result.report.refused, [{ setId: hostile.setId, version: 1, reason: 'xml-doctype-declares-entities' }])
  assert.deepEqual(result.report.verified, [{ setId: good.setId, version: 1 }])
  const files = await listFiles(where.dataDir)
  assert.deepEqual(files.filter((file) => file.includes(hostile.setId)), [])
  for (const file of files) {
    assert.ok(!(await readFile(join(where.dataDir, file), 'utf8')).includes(MARKER), `${file} holds the entity's content`)
  }
  assert.ok(!result.warnings.join('\n').includes(MARKER))
})
