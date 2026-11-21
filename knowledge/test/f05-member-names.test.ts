// F5. A zip member named with "../" or an absolute path: the member's name is never used, and nothing is
// written outside the data folder.

import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
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

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

test('F5. member names with ../ or an absolute path never name a file, and nothing lands outside the data folder', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const absolute = join(where.root, 'absolute-escape.xml')
  const absoluteImage = join(where.root, 'absolute-escape.jpg')
  // The XML member itself is named to climb out of the data folder.
  const climbing = syntheticLabel(1, 1, { xmlName: '../../../climbing-escape.xml' })
  // The XML member has an absolute name.
  const rooted = syntheticLabel(2, 1, { xmlName: absolute })
  // The XML member is ordinary; an image beside it has an absolute name and another climbs out.
  const beside = syntheticLabel(3, 1, {
    extraMembers: [
      { name: absoluteImage, data: Buffer.alloc(50, 2) },
      { name: '../../beside-escape.jpg', data: Buffer.alloc(50, 3) },
    ],
  })
  const labels = [climbing, rooted, beside]
  serveCorpus(standIn, labels)
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), { labels: labels.map((l) => manifestEntry(l)), notPinned: [] })

  const result = await runFetch(standIn, where)

  assert.equal(result.exitCode, 0, result.warnings.join('\n'))
  for (const label of labels) {
    const xml = await readFile(join(where.dataDir, 'labels', label.setId, `${label.version}.xml`))
    assert.equal(sha256(xml), sha256(label.xml))
  }
  assert.equal(await exists(absolute), false)
  assert.equal(await exists(absoluteImage), false)
  // Everything in the test's root folder is either the tracked files or inside the data folder.
  const all = await listFiles(where.root)
  const outside = all.filter((file) => !file.startsWith('data/') && !file.startsWith('corpus/'))
  assert.deepEqual(outside, [])
  assert.deepEqual(all.filter((file) => file.includes('escape')), [])
})
