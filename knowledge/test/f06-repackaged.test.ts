// F6. A zip whose bytes differ from the manifest but whose XML matches: accepted, and reported as repackaged.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../src/files.ts'
import {
  BENCHMARK,
  benchmarkPin,
  folders,
  manifestEntry,
  runFetch,
  serveCorpus,
  syntheticLabel,
  writeCorpus,
} from './support/fixture.ts'
import { StandIn } from './support/standin.ts'

test('F6. a repackaged zip with the same XML is accepted and reported as repackaged, on later runs too', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const original = syntheticLabel(1, 2)
  // The same XML, packed with an image added: different zip bytes.
  const repacked = syntheticLabel(1, 2, { extraMembers: [{ name: 'figure.jpg', data: Buffer.alloc(80, 5) }] })
  assert.equal(sha256(repacked.xml), sha256(original.xml))
  assert.notEqual(sha256(repacked.zip), sha256(original.zip))
  const plain = syntheticLabel(2, 1)
  serveCorpus(standIn, [repacked, plain])
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), {
    labels: [manifestEntry(original), manifestEntry(plain)],
    notPinned: [],
  })

  const result = await runFetch(standIn, where)

  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.report.repackaged, [{ setId: original.setId, version: 2 }])
  assert.deepEqual(result.report.verified, [{ setId: plain.setId, version: 1 }])
  assert.deepEqual(result.report.refused, [])
  assert.equal(sha256(await readFile(join(where.dataDir, 'labels', original.setId, '2.xml'))), sha256(original.xml))

  const again = await runFetch(standIn, where)
  assert.deepEqual(again.report, result.report)
})
