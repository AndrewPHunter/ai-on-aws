// F4. Refusals, one row each. In each: nothing is written for that label, it is in the report with its reason,
// the other labels are fetched, and the exit is non-zero.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { sha256 } from '../src/files.ts'
import type { Reason } from '../src/reasons.ts'
import type { PinnedLabel } from '../src/schema.ts'
import {
  BENCHMARK,
  CAPS,
  benchmarkPin,
  folders,
  listFiles,
  manifestEntry,
  runFetch,
  serveCorpus,
  syntheticLabel,
  writeCorpus,
} from './support/fixture.ts'
import { splDocument } from './support/spl.ts'
import { StandIn, zipPath } from './support/standin.ts'
import { buildZip } from './support/zip.ts'

const BAD = 90
const bad = syntheticLabel(BAD, 4)
const good = syntheticLabel(1, 2)

type Row = {
  name: string
  reason: Reason
  // The zip the stand-in serves for the bad label; undefined means it answers 404.
  zip: Buffer | undefined
  // The bad label's manifest entry.
  entry: PinnedLabel
}

const xmlOf = (filler: string): string =>
  splDocument(
    { documentId: bad.documentId, setId: bad.setId, version: bad.version },
    `<component><section><text><paragraph>${filler}</paragraph></text></section></component>`,
  )

const rows: Row[] = [
  {
    name: 'the XML checksum differs from the manifest',
    reason: 'xml-checksum-mismatch',
    zip: bad.zip,
    entry: { ...manifestEntry(bad), xmlSha256: sha256(Buffer.from('a different XML')) },
  },
  {
    name: 'the version is no longer served',
    reason: 'version-not-served',
    zip: undefined,
    entry: manifestEntry(bad),
  },
  {
    name: 'the zip is truncated',
    reason: 'zip-unreadable',
    zip: bad.zip.subarray(0, bad.zip.length - 30),
    entry: manifestEntry(bad),
  },
  {
    name: 'the zip has no XML member',
    reason: 'zip-no-xml-member',
    zip: buildZip([{ name: 'figure-1.jpg', data: Buffer.alloc(100, 1) }]),
    entry: manifestEntry(bad),
  },
  {
    name: 'the zip has two XML members',
    reason: 'zip-several-xml-members',
    zip: buildZip([
      { name: 'one.xml', data: bad.xml },
      { name: 'two.XML', data: bad.xml },
    ]),
    entry: manifestEntry(bad),
  },
  {
    name: 'the download exceeds its cap',
    reason: 'zip-too-large',
    zip: buildZip([
      { name: 'label.xml', data: bad.xml },
      { name: 'figure.jpg', data: Buffer.alloc(CAPS.zipBytes + 1024, 7), stored: true },
    ]),
    entry: manifestEntry(bad),
  },
  {
    name: 'the XML exceeds its cap while the archive declares a small size',
    reason: 'xml-too-large',
    zip: buildZip([{ name: 'label.xml', data: xmlOf('x'.repeat(CAPS.xmlBytes * 2)), declaredSize: 200 }]),
    entry: { ...manifestEntry(bad), xmlSha256: sha256(Buffer.from(xmlOf('x'.repeat(CAPS.xmlBytes * 2)))) },
  },
]

for (const row of rows) {
  test(`F4. refused: ${row.name}`, async (t) => {
    const standIn = await StandIn.start(t)
    const where = await folders(t)
    serveCorpus(standIn, [good])
    if (row.zip !== undefined) standIn.on(zipPath(bad.setId, bad.version), { status: 200, body: row.zip })
    // The download cap must not hide the archive's own fault in the rows that are not about it.
    if (row.reason !== 'zip-too-large') assert.ok((row.zip?.length ?? 0) <= CAPS.zipBytes)
    await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), { labels: [manifestEntry(good), row.entry], notPinned: [] })

    const result = await runFetch(standIn, where)

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.report.refused, [{ setId: bad.setId, version: bad.version, reason: row.reason }])
    assert.deepEqual(result.report.verified, [{ setId: good.setId, version: good.version }])
    assert.ok(
      result.warnings.some((line) => line.includes(bad.setId) && line.includes(row.reason)),
      result.warnings.join('\n'),
    )
    const files = await listFiles(where.dataDir)
    assert.deepEqual(files.filter((file) => file.includes(bad.setId)), [], 'something was written for the refused label')
    assert.equal(sha256(await readFile(join(where.dataDir, 'labels', good.setId, '2.xml'))), sha256(good.xml))
  })
}
