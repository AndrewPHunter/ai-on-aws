// F2. Pinning: each entry has the highest version from the history, both checksums, the document id, effective
// time, published date and type. A label with no history, and one whose file is missing, are listed as not
// pinned with their reasons. Two runs give byte-identical output.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'

import { sha256 } from '../src/files.ts'
import { pin } from '../src/pin.ts'
import { CAPS, REPOSITORY, REVISION, folders, guid, jsonl, syntheticLabel, testClient } from './support/fixture.ts'
import { StandIn, historyPage, historyPath, rawPath, zipPath } from './support/standin.ts'

const labelsFile = jsonl([
  { set_id: guid(3), drug_name: 'Examplazine', drug_id: 'examplazine', label_raw: '', chunks: [] },
  { set_id: '', drug_name: 'Placeholder', drug_id: 'tmp_placeholder', label_raw: '', chunks: [] },
  { set_id: guid(1), drug_name: 'Testarol', drug_id: 'testarol', label_raw: '', chunks: [] },
  { set_id: guid(5), drug_name: 'Missingfile', drug_id: 'missingfile', label_raw: '', chunks: [] },
  { set_id: guid(4), drug_name: 'Nohistory', drug_id: 'nohistory', label_raw: '', chunks: [] },
  { set_id: guid(2), drug_name: 'Sampleprin', drug_id: 'sampleprin', label_raw: '', chunks: [] },
])
const qaFile = jsonl([{ qid: 'q1', task: 'factual', source: 'highlights', set_id: guid(1), question: 'q', answer: 'a', context: [] }])

const a3 = syntheticLabel(1, 3)
const b1 = syntheticLabel(2, 1)
const c5 = syntheticLabel(3, 5)

function serve(standIn: StandIn): void {
  standIn.on(rawPath(REVISION, 'data/labels/labels.jsonl'), { status: 200, body: labelsFile })
  standIn.on(rawPath(REVISION, 'data/qa/qa.jsonl'), { status: 200, body: qaFile })
  // Label 1's history spans two pages; its highest version is on the first.
  standIn.on(historyPath(guid(1), 1), { status: 200, body: historyPage([{ version: 1, published: 'Jan 5, 2020' }, { version: 3, published: 'Mar 4, 2024' }], 1, 2) })
  standIn.on(historyPath(guid(1), 2), { status: 200, body: historyPage([{ version: 2, published: 'Jul 9, 2022' }], 2, 2) })
  standIn.on(zipPath(guid(1), 3), { status: 200, body: a3.zip })
  standIn.on(historyPath(guid(2), 1), { status: 200, body: historyPage([{ version: 1, published: 'Dec 31, 2019' }]) })
  standIn.on(zipPath(guid(2), 1), { status: 200, body: b1.zip })
  // Label 3's highest version is on the second page.
  standIn.on(historyPath(guid(3), 1), { status: 200, body: historyPage([{ version: 4, published: 'Feb 1, 2023' }], 1, 2) })
  standIn.on(historyPath(guid(3), 2), { status: 200, body: historyPage([{ version: 5, published: 'Nov 15, 2025' }], 2, 2) })
  standIn.on(zipPath(guid(3), 5), { status: 200, body: c5.zip })
  // No history: DailyMed answers 200 with an empty list.
  standIn.on(historyPath(guid(4), 1), { status: 200, body: historyPage([]) })
  // A history whose highest version's file is not served.
  standIn.on(historyPath(guid(5), 1), { status: 200, body: historyPage([{ version: 2, published: 'Apr 2, 2021' }]) })
}

async function runPin(t: TestContext, standIn: StandIn): Promise<{ manifest: string; benchmark: string }> {
  const { corpusDir, dataDir } = await folders(t)
  await pin({
    corpusDir,
    dataDir,
    benchmark: {
      repository: REPOSITORY,
      revision: REVISION,
      licence: 'Apache-2.0',
      labelsPath: 'data/labels/labels.jsonl',
      qaPath: 'data/qa/qa.jsonl',
      rawBase: standIn.rawBase,
      maxBytes: 1024 * 1024,
    },
    dailymedBase: standIn.dailymedBase,
    caps: CAPS,
    dailymed: testClient().client,
    github: testClient({ maxConcurrent: 1 }).client,
    workers: 4,
    log: () => {},
  })
  return {
    manifest: await readFile(join(corpusDir, 'manifest.json'), 'utf8'),
    benchmark: await readFile(join(corpusDir, 'benchmark.json'), 'utf8'),
  }
}

test('F2. pinning records the highest version of each label, and lists the ones it cannot pin', async (t) => {
  const standIn = await StandIn.start(t)
  serve(standIn)
  const first = await runPin(t, standIn)
  const manifest: unknown = JSON.parse(first.manifest)

  assert.deepEqual(manifest, {
    labels: [
      {
        setId: guid(1),
        version: 3,
        documentId: a3.documentId,
        effectiveTime: '20240102',
        publishedDate: '2024-03-04',
        documentTypeCode: '34391-3',
        zipSha256: sha256(a3.zip),
        xmlSha256: sha256(a3.xml),
        xmlBytes: a3.xml.length,
      },
      {
        setId: guid(2),
        version: 1,
        documentId: b1.documentId,
        effectiveTime: '20240102',
        publishedDate: '2019-12-31',
        documentTypeCode: '34391-3',
        zipSha256: sha256(b1.zip),
        xmlSha256: sha256(b1.xml),
        xmlBytes: b1.xml.length,
      },
      {
        setId: guid(3),
        version: 5,
        documentId: c5.documentId,
        effectiveTime: '20240102',
        publishedDate: '2025-11-15',
        documentTypeCode: '34391-3',
        zipSha256: sha256(c5.zip),
        xmlSha256: sha256(c5.xml),
        xmlBytes: c5.xml.length,
      },
    ],
    notPinned: [
      { setId: '', drugId: 'tmp_placeholder', reason: 'set-id-not-a-guid' },
      { setId: guid(4), drugId: 'nohistory', reason: 'no-history' },
      { setId: guid(5), drugId: 'missingfile', reason: 'version-not-served' },
    ],
  })

  assert.deepEqual(JSON.parse(first.benchmark), {
    repository: REPOSITORY,
    revision: REVISION,
    licence: 'Apache-2.0',
    files: {
      labels: { path: 'data/labels/labels.jsonl', sha256: sha256(labelsFile), bytes: labelsFile.length },
      qa: { path: 'data/qa/qa.jsonl', sha256: sha256(qaFile), bytes: qaFile.length },
    },
  })

  // Only the highest version's file was asked for.
  assert.equal(standIn.requestsTo('/dailymed/getFile.cfm'), 4)

  const second = await runPin(t, standIn)
  assert.equal(second.manifest, first.manifest)
  assert.equal(second.benchmark, first.benchmark)
})
