// F3. Fetching writes each XML under the name built from set id and version, with matching checksums. A second
// run makes no request and changes no file.

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../src/files.ts'
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

test('F3. fetch writes every pinned XML by set id and version; a second run sends nothing and changes nothing', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const labels = [syntheticLabel(1, 3), syntheticLabel(2, 1), syntheticLabel(3, 12)]
  serveCorpus(standIn, labels)
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), { labels: labels.map((l) => manifestEntry(l)), notPinned: [] })

  const first = await runFetch(standIn, where)
  assert.equal(first.exitCode, 0)
  assert.deepEqual(first.warnings, [])
  for (const label of labels) {
    const xml = await readFile(join(where.dataDir, 'labels', label.setId, `${label.version}.xml`))
    assert.equal(sha256(xml), sha256(label.xml))
  }
  assert.equal(sha256(await readFile(join(where.dataDir, 'benchmark', 'labels.jsonl'))), sha256(BENCHMARK.labels))
  assert.equal(sha256(await readFile(join(where.dataDir, 'benchmark', 'qa.jsonl'))), sha256(BENCHMARK.qa))
  assert.deepEqual(first.report.counts, { labels: 3, verified: 3, repackaged: 0, refused: 0, benchmarkFiles: 2, benchmarkRefused: 0 })
  assert.deepEqual(
    first.report.verified,
    labels.map((l) => ({ setId: l.setId, version: l.version })),
  )

  const files = await listFiles(where.dataDir)
  const before = await Promise.all(
    files.map(async (file) => {
      const path = join(where.dataDir, file)
      return { file, bytes: sha256(await readFile(path)), modified: (await stat(path)).mtimeMs }
    }),
  )
  const requestsBefore = standIn.received.length

  const second = await runFetch(standIn, where)
  assert.equal(second.exitCode, 0)
  assert.equal(standIn.received.length, requestsBefore, 'the second run sent a request')
  assert.deepEqual(await listFiles(where.dataDir), files)
  const after = await Promise.all(
    files.map(async (file) => {
      const path = join(where.dataDir, file)
      return { file, bytes: sha256(await readFile(path)), modified: (await stat(path)).mtimeMs }
    }),
  )
  assert.deepEqual(after, before)
  assert.deepEqual(second.report, first.report)
})
