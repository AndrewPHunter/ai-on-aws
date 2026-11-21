// The chunk command: every label in the manifest, from its parsed document to a chunk file and one entry in the
// chunk report. The report holds numbers, codes and identifiers only. A label that fails the check gets no chunk
// file (one left by an earlier run is removed).

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { readManifest } from '../fetch.ts'
import { writeIfChanged } from '../files.ts'
import type { ParsedDocument } from '../parse/model.ts'
import { parsedPath } from '../parse/run.ts'
import { isGuid } from '../schema.ts'
import { checkChunks } from './check.ts'
import type { Chunk, ChunkSettings, SplitStats } from './model.ts'
import { splitDocument } from './split.ts'

export const chunkPath = (dataDir: string, setId: string, version: number): string => {
  if (!isGuid(setId) || !Number.isInteger(version) || version < 1) throw new Error('refusing to build a path from an invalid set id or version')
  return join(dataDir, 'chunks', setId, `${version}.jsonl`)
}

type Sizes = { count: number; min: number; median: number; p90: number; p99: number; max: number }

export type ChunkReport = {
  settings: ChunkSettings
  counts: { labels: number; chunked: number; notChunked: number }
  notChunked: { setId: string; version: number; reason: 'no-parsed-file' | 'check-failed'; missing?: number; extra?: number }[]
  chunks: {
    total: number
    byType: { text: number; table: number; 'table-rows': number }
    byPart: { body: number; highlights: number }
    over1000Words: number
    over4000Words: number
  }
  sizes: { text: Sizes; table: Sizes; 'table-rows': Sizes }
  tables: {
    total: number
    oneWithinLimit: number
    oneOversize: number
    split: number
    chunksFromSplits: number
    notSplittable: { total: number; headerNotThead: number; nestedTable: number; shortRow: number; boldRowNotGroupLabel: number }
    oversize: { chunkId: string; words: number }[]
  }
  splits: { paragraphsSplitAtSentences: number; sentencesSplitBetweenWords: number; listsSplitBetweenItems: number; itemsSplit: number }
  sectionsImageOnlySkipped: number
  largest: { id: string; type: Chunk['type']; words: number }[]
  labels: { setId: string; version: number; status: 'chunked' | 'not-chunked'; chunks: number }[]
}

// Nearest-rank percentiles of a list of sizes.
export function sizes(values: readonly number[]): Sizes {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => (sorted.length === 0 ? 0 : (sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0))
  return { count: sorted.length, min: sorted[0] ?? 0, median: at(50), p90: at(90), p99: at(99), max: sorted[sorted.length - 1] ?? 0 }
}

export type ChunkOptions = { corpusDir: string; dataDir: string; settings: ChunkSettings; log: (line: string) => void }

async function readParsed(path: string): Promise<ParsedDocument | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const value: unknown = JSON.parse(text)
  const document: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'document') : undefined
  if (typeof document !== 'object' || document === null) throw new Error(`${path} holds no parsed document`)
  return document as ParsedDocument
}

export async function runChunk(options: ChunkOptions): Promise<ChunkReport> {
  const manifest = await readManifest(options.corpusDir)
  const all: Chunk[] = []
  const stats: SplitStats[] = []
  const report: ChunkReport = {
    settings: { textLimit: options.settings.textLimit, tableLimit: options.settings.tableLimit },
    counts: { labels: manifest.labels.length, chunked: 0, notChunked: 0 },
    notChunked: [],
    chunks: { total: 0, byType: { text: 0, table: 0, 'table-rows': 0 }, byPart: { body: 0, highlights: 0 }, over1000Words: 0, over4000Words: 0 },
    sizes: { text: sizes([]), table: sizes([]), 'table-rows': sizes([]) },
    tables: {
      total: 0,
      oneWithinLimit: 0,
      oneOversize: 0,
      split: 0,
      chunksFromSplits: 0,
      notSplittable: { total: 0, headerNotThead: 0, nestedTable: 0, shortRow: 0, boldRowNotGroupLabel: 0 },
      oversize: [],
    },
    splits: { paragraphsSplitAtSentences: 0, sentencesSplitBetweenWords: 0, listsSplitBetweenItems: 0, itemsSplit: 0 },
    sectionsImageOnlySkipped: 0,
    largest: [],
    labels: [],
  }

  for (const entry of manifest.labels) {
    const target = chunkPath(options.dataDir, entry.setId, entry.version)
    const document = await readParsed(parsedPath(options.dataDir, entry.setId, entry.version))
    if (document === null) {
      await rm(target, { force: true })
      report.notChunked.push({ setId: entry.setId, version: entry.version, reason: 'no-parsed-file' })
      report.labels.push({ setId: entry.setId, version: entry.version, status: 'not-chunked', chunks: 0 })
      continue
    }
    const result = splitDocument(document, options.settings)
    const check = checkChunks(document, result.chunks)
    if (check.missing > 0 || check.extra > 0) {
      await rm(target, { force: true })
      report.notChunked.push({ setId: entry.setId, version: entry.version, reason: 'check-failed', missing: check.missing, extra: check.extra })
      report.labels.push({ setId: entry.setId, version: entry.version, status: 'not-chunked', chunks: 0 })
      continue
    }
    await writeIfChanged(target, result.chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''))
    all.push(...result.chunks)
    stats.push(result.stats)
    report.labels.push({ setId: entry.setId, version: entry.version, status: 'chunked', chunks: result.chunks.length })
  }

  report.counts.chunked = report.labels.filter((label) => label.status === 'chunked').length
  report.counts.notChunked = report.notChunked.length
  report.chunks.total = all.length
  for (const chunk of all) {
    report.chunks.byType[chunk.type]++
    report.chunks.byPart[chunk.part]++
    if (chunk.words > 1000) report.chunks.over1000Words++
    if (chunk.words > 4000) report.chunks.over4000Words++
  }
  for (const type of ['text', 'table', 'table-rows'] as const) {
    report.sizes[type] = sizes(all.filter((chunk) => chunk.type === type).map((chunk) => chunk.words))
  }
  for (const stat of stats) {
    report.splits.paragraphsSplitAtSentences += stat.paragraphsSplitAtSentences
    report.splits.sentencesSplitBetweenWords += stat.sentencesSplitBetweenWords
    report.splits.listsSplitBetweenItems += stat.listsSplitBetweenItems
    report.splits.itemsSplit += stat.itemsSplit
    report.sectionsImageOnlySkipped += stat.sectionsImageOnlySkipped
    for (const table of stat.tables) {
      report.tables.total++
      if (table.outcome === 'one-within-limit') report.tables.oneWithinLimit++
      if (table.outcome === 'one-oversize') {
        report.tables.oneOversize++
        report.tables.oversize.push({ chunkId: table.chunkId, words: table.words })
      }
      if (table.outcome === 'split') {
        report.tables.split++
        report.tables.chunksFromSplits += table.chunks
      }
      if (table.notSplittable !== null) {
        const counts = report.tables.notSplittable
        counts.total++
        if (table.notSplittable.headerNotThead) counts.headerNotThead++
        if (table.notSplittable.nestedTable) counts.nestedTable++
        if (table.notSplittable.shortRow) counts.shortRow++
        if (table.notSplittable.boldRowNotGroupLabel) counts.boldRowNotGroupLabel++
      }
    }
  }
  report.largest = [...all]
    .sort((a, b) => b.words - a.words || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 10)
    .map((chunk) => ({ id: chunk.id, type: chunk.type, words: chunk.words }))

  await writeIfChanged(join(options.dataDir, 'chunk-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  options.log(`labels: ${report.counts.labels}; chunked ${report.counts.chunked}, not chunked ${report.counts.notChunked}`)
  options.log(`chunks: ${report.chunks.total} (text ${report.chunks.byType.text}, table ${report.chunks.byType.table}, table-rows ${report.chunks.byType['table-rows']})`)
  for (const item of report.notChunked) options.log(`  not chunked: ${item.setId} version ${item.version} (${item.reason})`)
  return report
}
