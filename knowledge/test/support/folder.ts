// A data folder and manifest holding synthetic labels, for the parse command's tests.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sha256 } from '../../src/files.ts'
import { serialiseManifest } from '../../src/schema.ts'
import type { Folders } from './fixture.ts'
import type { Fixture } from './labels.ts'

export async function writeLabels(where: Folders, labels: readonly Fixture[]): Promise<void> {
  for (const label of labels) {
    await mkdir(join(where.dataDir, 'labels', label.setId), { recursive: true })
    await writeFile(join(where.dataDir, 'labels', label.setId, `${label.version}.xml`), label.xml)
  }
  await writeFile(
    join(where.corpusDir, 'manifest.json'),
    serialiseManifest({
      labels: labels.map((label) => ({
        setId: label.setId,
        version: label.version,
        documentId: label.documentId,
        effectiveTime: '20240102',
        publishedDate: '2024-01-02',
        documentTypeCode: label.typeCode,
        zipSha256: sha256(Buffer.concat([Buffer.from('zip of '), label.xml])),
        xmlSha256: sha256(label.xml),
        xmlBytes: label.xml.length,
      })),
      notPinned: [],
    }),
  )
}
