// Pinning: run once, and its two output files are committed.
//
// Downloads the benchmark's two files at the pinned revision and records their checksums. For each set id in
// the labels file, asks DailyMed for its history, takes the highest version, downloads it, reads it safely,
// and records its manifest entry. A label that cannot be pinned for a reason of its own (no history, the
// version not served, an archive or XML that is refused) is listed with that reason. A request that fails
// after every attempt fails the whole run, and nothing is written to the corpus folder: a passing network
// fault must never be recorded as a fact about a label.

import { join } from 'node:path'

import { parseLabelRecords } from './benchmark.ts'
import { fetchHistory } from './dailymed.ts'
import { benchmarkPath, sha256, writeAtomic } from './files.ts'
import type { PoliteClient } from './http.ts'
import { downloadLabel } from './label.ts'
import type { Caps } from './label.ts'
import { runPool } from './pool.ts'
import { Refusal } from './reasons.ts'
import {
  isGuid,
  serialiseBenchmarkPin,
  serialiseManifest,
  validateBenchmarkPin,
  validateManifest,
} from './schema.ts'
import type { BenchmarkPin, Manifest, NotPinned, PinnedLabel } from './schema.ts'

export type BenchmarkSource = {
  // https://github.com/<owner>/<name>
  repository: string
  revision: string
  licence: string
  labelsPath: string
  qaPath: string
  // Where raw files are served: https://raw.githubusercontent.com, or a stand-in in tests.
  rawBase: string
  maxBytes: number
}

export type PinOptions = {
  corpusDir: string
  dataDir: string
  benchmark: BenchmarkSource
  dailymedBase: string
  caps: Caps
  dailymed: PoliteClient
  github: PoliteClient
  // Labels worked on at once. The DailyMed client's own cap still bounds the requests in flight.
  workers: number
  log: (line: string) => void
}

export type PinResult = { benchmark: BenchmarkPin; manifest: Manifest }

export function rawUrl(source: { repository: string; rawBase: string }, revision: string, path: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(source.repository)
  if (!match?.[1] || !match[2]) throw new Error(`not a GitHub repository URL: ${source.repository}`)
  return `${source.rawBase}/${match[1]}/${match[2]}/${revision}/${path}`
}

async function downloadBenchmarkFile(options: PinOptions, path: string): Promise<Buffer> {
  const url = rawUrl(options.benchmark, options.benchmark.revision, path)
  const result = await options.github.get(url, options.benchmark.maxBytes, new Error(`${url} is larger than its cap`))
  if (result.status === 'not-found') throw new Error(`${url} answered 404`)
  return result.body
}

type Outcome = { pinned: PinnedLabel } | { notPinned: NotPinned }

async function pinOne(options: PinOptions, setId: string, drugId: string): Promise<Outcome> {
  const history = await fetchHistory(options.dailymed, options.dailymedBase, setId)
  if (history.length === 0) return { notPinned: { setId, drugId, reason: 'no-history' } }
  const highest = history.reduce((best, entry) => (entry.version > best.version ? entry : best))
  try {
    const label = await downloadLabel(options.dailymed, options.dailymedBase, setId, highest.version, options.caps)
    return {
      pinned: {
        setId,
        version: highest.version,
        documentId: label.identity.documentId,
        effectiveTime: label.identity.effectiveTime,
        publishedDate: highest.publishedDate,
        documentTypeCode: label.identity.documentTypeCode,
        zipSha256: sha256(label.zip),
        xmlSha256: sha256(label.xml),
        xmlBytes: label.xml.length,
      },
    }
  } catch (error) {
    if (error instanceof Refusal && error.reason !== 'download-failed') {
      return { notPinned: { setId, drugId, reason: error.reason } }
    }
    throw error
  }
}

export async function pin(options: PinOptions): Promise<PinResult> {
  const { benchmark } = options
  const labelsBytes = await downloadBenchmarkFile(options, benchmark.labelsPath)
  const qaBytes = await downloadBenchmarkFile(options, benchmark.qaPath)
  options.log(`benchmark files downloaded: labels ${labelsBytes.length} bytes, questions ${qaBytes.length} bytes`)

  const benchmarkPin: BenchmarkPin = {
    repository: benchmark.repository,
    revision: benchmark.revision,
    licence: benchmark.licence,
    files: {
      labels: { path: benchmark.labelsPath, sha256: sha256(labelsBytes), bytes: labelsBytes.length },
      qa: { path: benchmark.qaPath, sha256: sha256(qaBytes), bytes: qaBytes.length },
    },
  }

  const records = parseLabelRecords(labelsBytes)
  const notPinned: NotPinned[] = []
  const toPin: { setId: string; drugId: string }[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!isGuid(record.set_id)) {
      notPinned.push({ setId: record.set_id, drugId: record.drug_id, reason: 'set-id-not-a-guid' })
    } else if (seen.has(record.set_id)) {
      notPinned.push({ setId: record.set_id, drugId: record.drug_id, reason: 'duplicate-set-id' })
    } else {
      seen.add(record.set_id)
      toPin.push({ setId: record.set_id, drugId: record.drug_id })
    }
  }
  options.log(`${records.length} benchmark records: ${toPin.length} set ids to pin, ${notPinned.length} not pinnable`)

  const labels: PinnedLabel[] = []
  const failures: string[] = []
  let done = 0
  await runPool(toPin, options.workers, async ({ setId, drugId }) => {
    try {
      const outcome = await pinOne(options, setId, drugId)
      if ('pinned' in outcome) labels.push(outcome.pinned)
      else {
        notPinned.push(outcome.notPinned)
        options.log(`not pinned: ${setId} (${outcome.notPinned.reason})`)
      }
    } catch (error) {
      failures.push(`${setId}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
    done++
    if (done % 50 === 0) options.log(`${done} of ${toPin.length} set ids done`)
  })

  if (failures.length > 0) {
    for (const failure of failures) options.log(`failed: ${failure}`)
    throw new Error(`${failures.length} set ids could not be pinned because a request failed; nothing was written to the corpus folder`)
  }

  const manifest: Manifest = { labels, notPinned }
  const manifestText = serialiseManifest(manifest)
  const benchmarkText = serialiseBenchmarkPin(benchmarkPin)
  // What is written must pass the schema the fetch reads it with.
  const checkManifest = validateManifest(JSON.parse(manifestText))
  const checkBenchmark = validateBenchmarkPin(JSON.parse(benchmarkText))
  if (!checkManifest.ok) throw new Error(`the manifest built would not validate: ${checkManifest.problems.join('; ')}`)
  if (!checkBenchmark.ok) throw new Error(`the benchmark pin built would not validate: ${checkBenchmark.problems.join('; ')}`)

  await writeAtomic(benchmarkPath(options.dataDir, 'labels'), labelsBytes)
  await writeAtomic(benchmarkPath(options.dataDir, 'qa'), qaBytes)
  await writeAtomic(join(options.corpusDir, 'benchmark.json'), benchmarkText)
  await writeAtomic(join(options.corpusDir, 'manifest.json'), manifestText)
  return { benchmark: checkBenchmark.value, manifest: checkManifest.value }
}
