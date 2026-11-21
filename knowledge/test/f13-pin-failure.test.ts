// F13. A pin run in which a request still fails after every attempt writes nothing to the corpus folder (a
// manifest that existed before is left byte for byte as it was) and exits non-zero naming the set ids that failed.

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { command, pinArgs } from './support/command.ts'
import { REVISION, folders, guid, jsonl, listFiles, syntheticLabel } from './support/fixture.ts'
import { StandIn, historyPage, historyPath, rawPath, zipPath } from './support/standin.ts'

test('F13. a request that fails after every attempt leaves the corpus folder as it was and names the set ids', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const before = { manifest: '{"labels": [], "notPinned": []}\n', benchmark: '{"earlier": true}\n' }
  await writeFile(join(where.corpusDir, 'manifest.json'), before.manifest)
  await writeFile(join(where.corpusDir, 'benchmark.json'), before.benchmark)

  const ok = syntheticLabel(1, 1)
  standIn.on(rawPath(REVISION, 'data/labels/labels.jsonl'), {
    status: 200,
    body: jsonl([1, 2, 3].map((n) => ({ set_id: guid(n), drug_name: `Drug ${n}`, drug_id: `drug_${n}`, label_raw: '', chunks: [] }))),
  })
  standIn.on(rawPath(REVISION, 'data/qa/qa.jsonl'), { status: 200, body: jsonl([]) })
  standIn.on(historyPath(guid(1)), { status: 200, body: historyPage([{ version: 1, published: 'Jan 2, 2024' }]) })
  standIn.on(zipPath(guid(1), 1), { status: 200, body: ok.zip })
  // Label 2's history never answers well; label 3's file fails every time.
  standIn.on(historyPath(guid(2)), { status: 503 }, 'drop', { status: 500 })
  standIn.on(historyPath(guid(3)), { status: 200, body: historyPage([{ version: 4, published: 'Jan 2, 2024' }]) })
  standIn.on(zipPath(guid(3), 4), { status: 503 })

  const result = await command(pinArgs(where, standIn))

  assert.notEqual(result.code, 0)
  const stderr = result.err.join('\n')
  assert.ok(stderr.includes(guid(2)), stderr)
  assert.ok(stderr.includes(guid(3)), stderr)
  assert.ok(!stderr.includes(`failed: ${guid(1)}`), stderr)
  assert.equal(standIn.requestsTo(historyPath(guid(2))), 3)
  assert.equal(standIn.requestsTo(zipPath(guid(3), 4)), 3)
  assert.deepEqual(await listFiles(where.corpusDir), ['benchmark.json', 'manifest.json'])
  assert.equal(await readFile(join(where.corpusDir, 'manifest.json'), 'utf8'), before.manifest)
  assert.equal(await readFile(join(where.corpusDir, 'benchmark.json'), 'utf8'), before.benchmark)
})
