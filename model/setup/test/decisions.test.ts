// Invariants of docs/architecture/model-server.md that setup's decisions show, one test each, at the pure
// functions setup.sh asks through tool.ts. Every input is a value; the tiers and logs are synthetic.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { parseArgs } from '../lib/args.ts'
import { capacityVerdict, embedCapacityVerdict, parseCapacity } from '../lib/capacity.ts'
import { diskVerdict, type DiskInput } from '../lib/disk.ts'
import type { Gpu } from '../lib/probe.ts'
import { readProfile } from '../lib/profile.ts'
import { readRetrieval } from '../lib/retrieval.ts'
import { runningVerdict } from '../lib/running.ts'
import { selectTier } from '../lib/select.ts'
import type { Tier, Tiers } from '../lib/tiers.ts'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

function tiersOf(list: [name: string, peakMiB: number][], extra: Partial<Tiers> = {}): Tiers {
  const tiers: Tier[] = list.map(([name, measuredPeakMiB]) => ({ name, profile: name, measuredPeakMiB, downloadMiB: 1 }))
  return {
    requirements: { minDriverMajor: 1, minComputeCapability: '1.0' },
    marginMiB: 0,
    embeddingPeakMiB: 0,
    rerankerPeakMiB: 0,
    imageDiskMiB: 1,
    embeddingDownloadMiB: 1,
    rerankerDownloadMiB: 1,
    tiers,
    ...extra,
  }
}

const gpu = (totalMiB: number, usedMiB = 0): Gpu => ({
  index: 0,
  name: 'Synthetic GPU',
  memoryTotalMiB: totalMiB,
  memoryUsedMiB: usedMiB,
  driverVersion: '600.1',
  computeCapability: '9.0',
})

test('4. a profile or the retrieval settings naming a revision that is not a commit hash is refused', () => {
  const profile = read('profiles/qwen3.5-4b-w4a16-20k.env')
  const retrieval = read('retrieval.env')
  const unpinned = (text: string, name: string): string => text.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=main`)
  const rows: [string, boolean, boolean][] = [
    ['shipped profile', readProfile(profile).ok, true],
    ['profile at a branch', readProfile(unpinned(profile, 'CHAT_MODEL_REVISION')).ok, false],
    ['shipped retrieval settings', readRetrieval(retrieval).ok, true],
    ['retrieval settings at a branch', readRetrieval(unpinned(retrieval, 'EMBED_MODEL_REVISION')).ok, false],
  ]
  for (const [label, ok, expected] of rows) assert.equal(ok, expected, label)
})

test('8. a tier needs its chat peak plus both retrieval peaks plus the margin, and the disk check counts what is not already there', () => {
  const selection = selectTier([gpu(100000)], tiersOf([['only', 1000]], { embeddingPeakMiB: 100, rerankerPeakMiB: 10, marginMiB: 1 }), null)
  assert.equal(selection.ok && selection.needMiB, 1111)

  const disk = (present: boolean): DiskInput => ({
    imagePresent: present,
    imageDiskMiB: 1,
    weightsPresent: present,
    downloadMiB: 2,
    embedWeightsPresent: present,
    embedDownloadMiB: 4,
    rerankWeightsPresent: present,
    rerankDownloadMiB: 8,
    cacheFreeMiB: 100000,
    dockerFreeMiB: 100000,
  })
  assert.deepEqual(diskVerdict(disk(false)), { ok: true, weightsNeedMiB: 14, imageNeedMiB: 1 })
  assert.deepEqual(diskVerdict(disk(true)), { ok: true, weightsNeedMiB: 0, imageNeedMiB: 0 })
  assert.equal(diskVerdict({ ...disk(false), cacheFreeMiB: 13 }).ok, false)
})

test('9. setup selects the largest tier that fits the free memory and never another than the one named', () => {
  // Listed out of order of need, so that neither the first nor the last listed is the largest.
  const tiers = tiersOf([['mid', 2000], ['big', 3000], ['small', 1000]])
  const pick = (card: Gpu, name: string | null = null): string => {
    const result = selectTier([card], tiers, name)
    return result.ok ? result.tier.name : `${result.reason} ${result.reason === 'insufficient_memory' ? result.tier : ''}`
  }
  const rows: [string, string, string][] = [
    ['free exactly the largest need', pick(gpu(3000)), 'big'],
    ['one MiB short of the largest', pick(gpu(2999)), 'mid'],
    ['a large card mostly in use', pick(gpu(10000, 7500)), 'mid'],
    ['below every need', pick(gpu(999)), 'insufficient_memory small'],
    ['a smaller tier named', pick(gpu(3000), 'small'), 'small'],
    ['a tier named that does not fit', pick(gpu(2500), 'big'), 'insufficient_memory big'],
  ]
  for (const [label, got, expected] of rows) assert.equal(got, expected, label)
})

test('12. two equal ports are refused', () => {
  const rows: [string, string[], boolean][] = [
    ['the three defaults', [], true],
    ['chat on the embedding default', ['--port', '8001'], false],
    ['embedding equals reranker', ['--embed-port', '9000', '--rerank-port', '9000'], false],
    ['reranker on the chat default', ['--rerank-port', '8000'], false],
  ]
  for (const [label, flags, ok] of rows) assert.equal(parseArgs(['--cache-dir', '/srv/models', ...flags], ['t']).ok, ok, label)
})

const line = (tokens: string, context: string, concurrency: string): string =>
  `(EngineCore pid=1) INFO [kv_cache_utils.py:1] GPU KV cache size: ${tokens} tokens, Maximum concurrency for ${context} tokens per request: ${concurrency}x`

test("14. setup accepts a server only when its start-up log confirms room for the profile's requests or one longest input", () => {
  // The chat profile: requests of 20,480 tokens, 4 at once. The embedding server: inputs of 8,192 tokens.
  const chat = (log: string): boolean => {
    const parsed = parseCapacity(log)
    return parsed.ok && capacityVerdict(parsed.capacity, 20480, 4).ok
  }
  const embed = (log: string): boolean => {
    const parsed = parseCapacity(log)
    return parsed.ok && embedCapacityVerdict(parsed.capacity, 8192).ok
  }
  const rows: [string, boolean, boolean][] = [
    ['chat: room for the profile', chat(`starting\n${line('82,895', '20,480', '4.05')}\nready`), true],
    ['chat: room for fewer', chat(line('78,019', '20,480', '3.81')), false],
    ['chat: sized for another context', chat(line('133,152', '32,768', '4.06')), false],
    ['chat: no capacity line', chat('INFO Application startup complete.'), false],
    ['chat: a later start with less room', chat(`${line('82,895', '20,480', '4.05')}\n${line('78,019', '20,480', '3.81')}`), false],
    ['embedding: room for one input', embed(line('9,344', '8,192', '1.14')), true],
    ['embedding: room for less than one', embed(line('8,110', '8,192', '0.99')), false],
    ['embedding: sized for another context', embed(line('9,344', '4,096', '2.28')), false],
  ]
  for (const [label, ok, expected] of rows) assert.equal(ok, expected, label)
})

test('15. setup refuses while any of the three servers is running, and only then', () => {
  const rows: [string, string, string[]][] = [
    ['nothing running', '', []],
    ['the chat server', 'chat\n', ['chat']],
    ['the embedding server', 'embed\n', ['embed']],
    ['the reranker server', 'rerank\n', ['rerank']],
    ['only download containers', 'download\ndownload-embed\n', []],
  ]
  for (const [label, ps, running] of rows) {
    const verdict = runningVerdict(ps)
    assert.deepEqual(verdict.ok ? [] : verdict.running, running, label)
    assert.equal(verdict.ok, running.length === 0, label)
  }
})
