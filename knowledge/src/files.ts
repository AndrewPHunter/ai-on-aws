// Checksums, and the only way files are written: under a folder given by the caller, at paths built here.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isGuid } from './schema.ts'

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

// Where a label's XML lives under the data folder. Built from the manifest's set id and version only.
export function labelXmlPath(dataDir: string, setId: string, version: number): string {
  if (!isGuid(setId)) throw new Error(`refusing to build a path from a set id that is not a GUID: ${JSON.stringify(setId)}`)
  if (!Number.isInteger(version) || version < 1) throw new Error(`refusing to build a path from version ${version}`)
  return join(dataDir, 'labels', setId, `${version}.xml`)
}

// Beside the XML: the checksums of the download it came from, so a later run knows whether it was repackaged.
export const labelRecordPath = (dataDir: string, setId: string, version: number): string =>
  labelXmlPath(dataDir, setId, version).replace(/\.xml$/, '.download.json')

export const benchmarkPath = (dataDir: string, role: 'labels' | 'qa'): string => join(dataDir, 'benchmark', `${role}.jsonl`)

// Writes beside the target and renames, so a reader never sees half a file.
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staged = `${path}.${randomBytes(6).toString('hex')}.partial`
  try {
    await writeFile(staged, content)
    await rename(staged, path)
  } catch (error) {
    await rm(staged, { force: true })
    throw error
  }
}

// Writes only if the content differs from what is there, so a run that changes nothing leaves the file alone.
export async function writeIfChanged(path: string, content: string): Promise<void> {
  const present = await readIfPresent(path)
  if (present !== undefined && present.equals(Buffer.from(content, 'utf8'))) return
  await writeAtomic(path, content)
}

// The file's bytes, or undefined if there is none.
export async function readIfPresent(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
