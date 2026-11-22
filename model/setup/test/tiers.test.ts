import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

import { readEnv } from '../lib/envfile.ts'
import { needMiB, validateTiers } from '../lib/tiers.ts'

const modelFile = (relative: string): URL => new URL(`../../${relative}`, import.meta.url)

function validTiers(): Record<string, any> {
  return {
    requirements: { minDriverMajor: 580, minComputeCapability: '7.5' },
    marginMiB: 512,
    embeddingPeakMiB: 2964,
    rerankerPeakMiB: 1882,
    imageDiskMiB: 37000,
    embeddingDownloadMiB: 1200,
    rerankerDownloadMiB: 2300,
    tiers: [
      { name: 'large', profile: 'qwen3.5-9b-w4a16', measuredPeakMiB: 16134, downloadMiB: 11000 },
      { name: 'small', profile: 'qwen3.5-4b-w4a16-20k', measuredPeakMiB: 9232, downloadMiB: 5400 },
    ],
  }
}

test('10. each rule of a valid tiers file, broken alone, is reported by its own message', () => {
  assert.deepEqual(validateTiers(validTiers()).ok, true)
  const driver = 'requirements.minDriverMajor must be a positive integer'
  const capability = 'requirements.minComputeCapability must be a string of the form <major>.<minor>'
  const name = 'tiers[0].name must be non-empty and made only of letters, digits, ".", "-" and "_"'
  const profile = 'tiers[0].profile must be non-empty and made only of letters, digits, ".", "-" and "_"'
  const cases: [string, (t: Record<string, any>) => void, string][] = [
    ['driver zero', (t) => (t.requirements.minDriverMajor = 0), driver],
    ['driver fractional', (t) => (t.requirements.minDriverMajor = 580.5), driver],
    ['driver as text', (t) => (t.requirements.minDriverMajor = '580'), driver],
    ['capability as number', (t) => (t.requirements.minComputeCapability = 7.5), capability],
    ['capability without minor', (t) => (t.requirements.minComputeCapability = '7'), capability],
    ['margin negative', (t) => (t.marginMiB = -1), 'marginMiB must be a non-negative integer'],
    ['image disk missing', (t) => delete t.imageDiskMiB, 'imageDiskMiB must be a non-negative integer'],
    ['tiers empty', (t) => (t.tiers = []), 'tiers must be a non-empty array'],
    ['tiers not an array', (t) => (t.tiers = { large: {} }), 'tiers must be a non-empty array'],
    ['name empty', (t) => (t.tiers[0].name = ''), name],
    ['name with a space', (t) => (t.tiers[0].name = 'big one'), name],
    ['profile with a slash', (t) => (t.tiers[0].profile = '../secrets'), profile],
    ['profile empty', (t) => (t.tiers[0].profile = ''), profile],
    ['peak zero', (t) => (t.tiers[0].measuredPeakMiB = 0), 'tiers[0].measuredPeakMiB must be a positive integer'],
    ['download negative', (t) => (t.tiers[0].downloadMiB = -5), 'tiers[0].downloadMiB must be a positive integer'],
    ['names repeated', (t) => (t.tiers[1].name = 'large'), 'tier names must be unique: large appears more than once'],
  ]
  for (const [label, breakIt, message] of cases) {
    const tiers = validTiers()
    breakIt(tiers)
    assert.deepEqual(validateTiers(tiers), { ok: false, errors: [message] }, label)
  }
})

test('11. the shipped tiers file is valid, its profiles define what compose.yaml requires, and the needs are as agreed', () => {
  const result = validateTiers(JSON.parse(readFileSync(modelFile('tiers.json'), 'utf8')))
  if (!result.ok) throw new Error(result.errors.join('; '))

  const compose = readFileSync(modelFile('compose.yaml'), 'utf8')
  // ${NAME:?...} must be defined with a value; ${NAME?...} must be defined and may be empty.
  const uses = [...compose.matchAll(/\$\{(CHAT_[A-Z0-9_]+|MODEL_ID)(:?)\?/g)]
  const nonEmpty = [...new Set(uses.filter((match) => match[2] === ':').map((match) => match[1]))]
  const defined = [...new Set(uses.filter((match) => match[2] === '').map((match) => match[1]))]
  assert.ok(nonEmpty.every((name) => name !== undefined), 'a ${NAME:?} use has no name')
  assert.ok(defined.every((name) => name !== undefined), 'a ${NAME?} use has no name')
  assert.ok(nonEmpty.includes('MODEL_ID') && nonEmpty.includes('CHAT_MODEL_REPO'), nonEmpty.join(','))
  assert.ok(defined.includes('CHAT_EXTRA_ARGS'), defined.join(','))

  for (const tier of result.tiers.tiers) {
    const path = modelFile(`profiles/${tier.profile}.env`)
    assert.ok(existsSync(path), `profiles/${tier.profile}.env does not exist`)
    const read = readEnv(readFileSync(path, 'utf8'), nonEmpty)
    assert.ok(read.ok, `profiles/${tier.profile}.env: ${read.ok ? '' : read.message}`)
    for (const name of defined) assert.ok(read.ok && read.values.has(name), `profiles/${tier.profile}.env does not define ${name}`)
  }

  assert.deepEqual(
    result.tiers.tiers.map((tier) => [tier.name, needMiB(result.tiers, tier)]),
    [
      ['large', 21492],
      ['medium', 16138],
      ['small', 14590],
    ],
  )
})

test("M1. a tier's need is chat peak + embedding peak + reranker peak + margin; a missing or negative peak is refused", () => {
  const tiers = validTiers()
  tiers.marginMiB = 100
  tiers.embeddingPeakMiB = 20
  tiers.rerankerPeakMiB = 3
  const result = validateTiers(tiers)
  if (!result.ok) throw new Error(result.errors.join('; '))
  const large = result.tiers.tiers[0]
  if (large === undefined) throw new Error('the fixture has no first tier')
  assert.equal(needMiB(result.tiers, large), 16134 + 20 + 3 + 100)

  const shipped = validateTiers(JSON.parse(readFileSync(modelFile('tiers.json'), 'utf8')))
  if (!shipped.ok) throw new Error(shipped.errors.join('; '))
  assert.equal(shipped.tiers.embeddingPeakMiB, 2964)
  assert.equal(shipped.tiers.rerankerPeakMiB, 1882)
  assert.equal(shipped.tiers.marginMiB, 512)

  for (const key of ['embeddingPeakMiB', 'rerankerPeakMiB']) {
    for (const [label, breakIt] of [
      ['missing', (t: Record<string, any>) => delete t[key]],
      ['negative', (t: Record<string, any>) => (t[key] = -1)],
    ] as const) {
      const broken = validTiers()
      breakIt(broken)
      assert.deepEqual(validateTiers(broken), { ok: false, errors: [`${key} must be a positive integer`] }, `${key} ${label}`)
    }
  }
})

test('M13. every tier\'s profile gives the chat server an explicit start-up fraction; without it the chat server cannot restart beside the other two', () => {
  // vLLM refuses to start unless --gpu-memory-utilization times the card is free, 0.92 by default. With the
  // embedding and reranker servers running that much never is, so a chat server restarted on its own exits.
  const result = validateTiers(JSON.parse(readFileSync(modelFile('tiers.json'), 'utf8')))
  if (!result.ok) throw new Error(result.errors.join('; '))
  for (const tier of result.tiers.tiers) {
    const read = readEnv(readFileSync(modelFile(`profiles/${tier.profile}.env`), 'utf8'), ['CHAT_EXTRA_ARGS'])
    if (!read.ok) throw new Error(`profiles/${tier.profile}.env: ${read.message}`)
    const extra = read.values.get('CHAT_EXTRA_ARGS') ?? ''
    assert.match(extra, /(^|\s)--gpu-memory-utilization (0\.[0-9]*[1-9][0-9]*|1)(\s|$)/, `profiles/${tier.profile}.env: CHAT_EXTRA_ARGS=${extra}`)
  }
})
