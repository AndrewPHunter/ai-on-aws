// Fetching: reads only the two tracked files, and downloads the benchmark files and every pinned label version
// into the data folder.
//
// - A file already present whose checksum matches is not downloaded again.
// - The XML's SHA-256 is what must match. A zip whose bytes differ while its XML matches is accepted and
//   reported as repackaged.
// - A label that is refused is not written; the run carries on, lists it, and exits non-zero.
// - The report states what is in the data folder after the run, not what this run did, so a second run on
//   complete data writes the same report. Beside each XML, a small record keeps the checksums of the download
//   it came from, which is how a later run still knows a label was repackaged.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  benchmarkPath,
  labelRecordPath,
  labelXmlPath,
  readIfPresent,
  sha256,
  writeAtomic,
  writeIfChanged,
} from './files.ts'
import { TransportError } from './http.ts'
import type { PoliteClient } from './http.ts'
import { downloadLabel } from './label.ts'
import type { Caps } from './label.ts'
import { rawUrl } from './pin.ts'
import { runPool } from './pool.ts'
import { Refusal } from './reasons.ts'
import type { Reason } from './reasons.ts'
import { validateBenchmarkPin, validateManifest } from './schema.ts'
import type { BenchmarkPin, Manifest, PinnedLabel } from './schema.ts'

export type FetchOptions = {
  corpusDir: string
  dataDir: string
  rawBase: string
  dailymedBase: string
  caps: Caps
  benchmarkMaxBytes: number
  dailymed: PoliteClient
  github: PoliteClient
  workers: number
  log: (line: string) => void
  warn: (line: string) => void
}

type LabelRef = { setId: string; version: number }

export type FetchReport = {
  counts: {
    labels: number
    verified: number
    repackaged: number
    refused: number
    benchmarkFiles: number
    benchmarkRefused: number
  }
  benchmark: { role: 'labels' | 'qa'; state: 'verified' | 'refused'; reason?: Reason }[]
  verified: LabelRef[]
  repackaged: LabelRef[]
  refused: (LabelRef & { reason: Reason })[]
}

// The tracked files could not be read or did not pass the schema. Nothing was fetched.
export class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

async function readTracked<T>(
  path: string,
  validate: (input: unknown) => { ok: true; value: T } | { ok: false; problems: string[] },
): Promise<T> {
  let input: unknown
  try {
    input = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new InputError(`${path} could not be read as JSON`)
  }
  const result = validate(input)
  if (!result.ok) throw new InputError(`${path} does not pass the schema: ${result.problems.join('; ')}`)
  return result.value
}

export const readManifest = (corpusDir: string): Promise<Manifest> =>
  readTracked(join(corpusDir, 'manifest.json'), validateManifest)
export const readBenchmarkPin = (corpusDir: string): Promise<BenchmarkPin> =>
  readTracked(join(corpusDir, 'benchmark.json'), validateBenchmarkPin)

type DownloadRecord = { zipSha256: string; xmlSha256: string }

function parseRecord(bytes: Buffer | undefined): DownloadRecord | undefined {
  if (bytes === undefined) return undefined
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const zip: unknown = Reflect.get(value, 'zipSha256')
    const xml: unknown = Reflect.get(value, 'xmlSha256')
    if (typeof zip !== 'string' || typeof xml !== 'string') return undefined
    return { zipSha256: zip, xmlSha256: xml }
  } catch {
    return undefined
  }
}

type LabelState = { state: 'verified' | 'repackaged' } | { state: 'refused'; reason: Reason }

async function fetchLabel(options: FetchOptions, label: PinnedLabel): Promise<LabelState> {
  const xmlPath = labelXmlPath(options.dataDir, label.setId, label.version)
  const recordPath = labelRecordPath(options.dataDir, label.setId, label.version)
  const present = await readIfPresent(xmlPath)
  const record = parseRecord(await readIfPresent(recordPath))
  if (present !== undefined && sha256(present) === label.xmlSha256 && record?.xmlSha256 === label.xmlSha256) {
    return { state: record.zipSha256 === label.zipSha256 ? 'verified' : 'repackaged' }
  }
  // Whatever is there does not match the manifest: it goes, so the folder never holds a wrong label.
  await rm(xmlPath, { force: true })
  await rm(recordPath, { force: true })

  let downloaded
  try {
    downloaded = await downloadLabel(options.dailymed, options.dailymedBase, label.setId, label.version, options.caps)
  } catch (error) {
    if (error instanceof Refusal) return { state: 'refused', reason: error.reason }
    if (error instanceof TransportError) return { state: 'refused', reason: 'download-failed' }
    throw error
  }
  if (sha256(downloaded.xml) !== label.xmlSha256) return { state: 'refused', reason: 'xml-checksum-mismatch' }
  const zipSha256 = sha256(downloaded.zip)
  await writeAtomic(xmlPath, downloaded.xml)
  await writeAtomic(recordPath, `${JSON.stringify({ zipSha256, xmlSha256: label.xmlSha256 })}\n`)
  return { state: zipSha256 === label.zipSha256 ? 'verified' : 'repackaged' }
}

async function fetchBenchmarkFile(
  options: FetchOptions,
  pin: BenchmarkPin,
  role: 'labels' | 'qa',
): Promise<FetchReport['benchmark'][number]> {
  const expected = pin.files[role]
  const path = benchmarkPath(options.dataDir, role)
  const present = await readIfPresent(path)
  if (present !== undefined && sha256(present) === expected.sha256) return { role, state: 'verified' }
  await rm(path, { force: true })
  const url = rawUrl({ repository: pin.repository, rawBase: options.rawBase }, pin.revision, expected.path)
  let body: Buffer
  try {
    const result = await options.github.get(url, options.benchmarkMaxBytes, new Refusal('download-failed'))
    if (result.status === 'not-found') return { role, state: 'refused', reason: 'download-failed' }
    body = result.body
  } catch (error) {
    if (error instanceof Refusal || error instanceof TransportError) return { role, state: 'refused', reason: 'download-failed' }
    throw error
  }
  if (sha256(body) !== expected.sha256) return { role, state: 'refused', reason: 'benchmark-checksum-mismatch' }
  await writeAtomic(path, body)
  return { role, state: 'verified' }
}

const bySetId = (a: LabelRef, b: LabelRef): number => (a.setId < b.setId ? -1 : a.setId > b.setId ? 1 : a.version - b.version)

export async function fetchCorpus(options: FetchOptions): Promise<{ report: FetchReport; exitCode: 0 | 1 }> {
  const pin = await readBenchmarkPin(options.corpusDir)
  const manifest = await readManifest(options.corpusDir)

  const benchmark = [await fetchBenchmarkFile(options, pin, 'labels'), await fetchBenchmarkFile(options, pin, 'qa')]

  const verified: LabelRef[] = []
  const repackaged: LabelRef[] = []
  const refused: FetchReport['refused'] = []
  await runPool(manifest.labels, options.workers, async (label) => {
    const outcome = await fetchLabel(options, label)
    const ref = { setId: label.setId, version: label.version }
    if (outcome.state === 'refused') refused.push({ ...ref, reason: outcome.reason })
    else if (outcome.state === 'verified') verified.push(ref)
    else repackaged.push(ref)
  })
  verified.sort(bySetId)
  repackaged.sort(bySetId)
  refused.sort(bySetId)

  const benchmarkRefused = benchmark.filter((file) => file.state === 'refused').length
  const report: FetchReport = {
    counts: {
      labels: manifest.labels.length,
      verified: verified.length,
      repackaged: repackaged.length,
      refused: refused.length,
      benchmarkFiles: benchmark.length,
      benchmarkRefused,
    },
    benchmark,
    verified,
    repackaged,
    refused,
  }
  await writeIfChanged(join(options.dataDir, 'fetch-report.json'), `${JSON.stringify(report, null, 2)}\n`)

  for (const file of benchmark) {
    if (file.state === 'refused') options.warn(`refused: benchmark ${file.role} file (${file.reason ?? ''})`)
  }
  for (const label of refused) options.warn(`refused: ${label.setId} version ${label.version} (${label.reason})`)
  for (const label of repackaged) options.log(`repackaged: ${label.setId} version ${label.version}`)
  options.log(
    `labels: ${report.counts.labels}; verified ${verified.length}, repackaged ${repackaged.length}, refused ${refused.length}. ` +
      `Benchmark files: ${benchmark.length - benchmarkRefused} verified, ${benchmarkRefused} refused.`,
  )
  return { report, exitCode: refused.length === 0 && benchmarkRefused === 0 ? 0 : 1 }
}
