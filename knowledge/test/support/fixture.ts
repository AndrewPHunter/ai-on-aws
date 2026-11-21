// Shared test fixtures: temporary folders, clients pointed at the stand-in, and synthetic labels and corpora.

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { TestContext } from 'node:test'

import { fetchCorpus } from '../../src/fetch.ts'
import type { FetchReport } from '../../src/fetch.ts'
import { sha256 } from '../../src/files.ts'
import { PoliteClient } from '../../src/http.ts'
import type { HttpSettings } from '../../src/http.ts'
import type { Caps } from '../../src/label.ts'
import { serialiseBenchmarkPin, serialiseManifest } from '../../src/schema.ts'
import type { BenchmarkPin, Manifest, PinnedLabel } from '../../src/schema.ts'
import { splDocument } from './spl.ts'
import { rawPath, zipPath } from './standin.ts'
import type { StandIn } from './standin.ts'
import type { ZipMember } from './zip.ts'
import { buildZip } from './zip.ts'

export const USER_AGENT = 'label-corpus-fetch/1.0'
export const REVISION = '0123456789abcdef0123456789abcdef01234567'
export const REPOSITORY = 'https://github.com/example-owner/example-bench'
export const CAPS: Caps = { zipBytes: 64 * 1024, xmlBytes: 16 * 1024 }

// A lowercase GUID that differs only in its last digits.
export const guid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
export const documentGuid = (n: number): string => `11111111-2222-4333-8444-${n.toString(16).padStart(12, '0')}`

export type Folders = { root: string; corpusDir: string; dataDir: string }

export async function folders(t: TestContext): Promise<Folders> {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-test-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const corpusDir = join(root, 'corpus')
  const dataDir = join(root, 'data')
  await mkdir(corpusDir)
  await mkdir(dataDir)
  return { root, corpusDir, dataDir }
}

// A client whose waits are recorded and take no time.
export function testClient(overrides: Partial<HttpSettings> = {}): { client: PoliteClient; waits: number[] } {
  const waits: number[] = []
  const client = new PoliteClient({
    fetch: globalThis.fetch,
    userAgent: USER_AGENT,
    maxConcurrent: 4,
    attempts: 3,
    waitsMs: [100, 400],
    timeoutMs: 30_000,
    sleep: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  })
  return { client, waits }
}

export type SyntheticLabel = { setId: string; version: number; documentId: string; xml: Buffer; zip: Buffer }

export function syntheticLabel(
  n: number,
  version: number,
  options: { body?: string; prolog?: string; extraMembers?: ZipMember[]; xmlName?: string } = {},
): SyntheticLabel {
  const setId = guid(n)
  const documentId = documentGuid(n * 100 + version)
  const xml = Buffer.from(splDocument({ documentId, setId, version }, options.body, options.prolog), 'utf8')
  const zip = buildZip([{ name: options.xmlName ?? `${documentId}.xml`, data: xml }, ...(options.extraMembers ?? [])])
  return { setId, version, documentId, xml, zip }
}

export function manifestEntry(label: SyntheticLabel, publishedDate = '2024-01-02'): PinnedLabel {
  return {
    setId: label.setId,
    version: label.version,
    documentId: label.documentId,
    effectiveTime: '20240102',
    publishedDate,
    documentTypeCode: '34391-3',
    zipSha256: sha256(label.zip),
    xmlSha256: sha256(label.xml),
    xmlBytes: label.xml.length,
  }
}

export type BenchmarkFiles = { labels: Buffer; qa: Buffer }

export const jsonl = (rows: readonly unknown[]): Buffer => Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

export function benchmarkPin(files: BenchmarkFiles): BenchmarkPin {
  return {
    repository: REPOSITORY,
    revision: REVISION,
    licence: 'Apache-2.0',
    files: {
      labels: { path: 'data/labels/labels.jsonl', sha256: sha256(files.labels), bytes: files.labels.length },
      qa: { path: 'data/qa/qa.jsonl', sha256: sha256(files.qa), bytes: files.qa.length },
    },
  }
}

export async function writeCorpus(corpusDir: string, pin: BenchmarkPin, manifest: Manifest): Promise<void> {
  await writeFile(join(corpusDir, 'benchmark.json'), serialiseBenchmarkPin(pin))
  await writeFile(join(corpusDir, 'manifest.json'), serialiseManifest(manifest))
}

export const BENCHMARK = { labels: jsonl([{ set_id: '', drug_name: '', drug_id: 'x', chunks: [] }]), qa: jsonl([]) }

// Registers the benchmark files and each label's zip with the stand-in.
export function serveCorpus(standIn: StandIn, labels: readonly SyntheticLabel[], files: BenchmarkFiles = BENCHMARK): void {
  standIn.on(rawPath(REVISION, 'data/labels/labels.jsonl'), { status: 200, body: files.labels })
  standIn.on(rawPath(REVISION, 'data/qa/qa.jsonl'), { status: 200, body: files.qa })
  for (const label of labels) standIn.on(zipPath(label.setId, label.version), { status: 200, body: label.zip })
}

export async function runFetch(
  standIn: StandIn,
  where: Folders,
  caps: Caps = CAPS,
): Promise<{ report: FetchReport; exitCode: 0 | 1; warnings: string[] }> {
  const warnings: string[] = []
  const result = await fetchCorpus({
    corpusDir: where.corpusDir,
    dataDir: where.dataDir,
    rawBase: standIn.rawBase,
    dailymedBase: standIn.dailymedBase,
    caps,
    benchmarkMaxBytes: 1024 * 1024,
    dailymed: testClient().client,
    github: testClient({ maxConcurrent: 1 }).client,
    workers: 4,
    log: () => {},
    warn: (line) => warnings.push(line),
  })
  return { ...result, warnings }
}

// Every file under `dir`, as paths relative to it, sorted.
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}
