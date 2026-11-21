import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { Gpu } from '../lib/probe.ts'
import { selectTier } from '../lib/select.ts'
import { validateTiers, type Tiers } from '../lib/tiers.ts'

function shippedTiers(): Tiers {
  const result = validateTiers(JSON.parse(readFileSync(new URL('../../tiers.json', import.meta.url), 'utf8')))
  if (!result.ok) throw new Error(`shipped tiers invalid: ${result.errors.join('; ')}`)
  return result.tiers
}

function gpu(fields: Partial<Gpu> = {}): Gpu {
  return {
    index: 0,
    name: 'Test GPU',
    memoryTotalMiB: 24564,
    memoryUsedMiB: 0,
    driverVersion: '595.91.07',
    computeCapability: '8.6',
    ...fields,
  }
}

const freeGpu = (free: number): Gpu => gpu({ memoryTotalMiB: free + 300, memoryUsedMiB: 300 })

function selected(gpus: Gpu[], tierName: string | null = null): string {
  const result = selectTier(gpus, shippedTiers(), tierName)
  return result.ok ? result.tier.name : `refused:${result.reason}`
}

test('5. free memory exactly at each need selects that tier; one MiB below selects the next tier down', () => {
  const cases: [number, string][] = [
    [21492, 'large'],
    [21491, 'medium'],
    [16138, 'medium'],
    [16137, 'small'],
    [14590, 'small'],
    [14589, 'refused:insufficient_memory'],
  ]
  for (const [free, expected] of cases) assert.equal(selected([freeGpu(free)]), expected, `free ${free} MiB`)
})

test('6. a GPU with large total memory but high used memory gets the tier that fits its free memory', () => {
  assert.equal(selected([gpu({ memoryTotalMiB: 24564, memoryUsedMiB: 4000 })]), 'medium') // 20,564 free
  assert.equal(selected([gpu({ memoryTotalMiB: 49152, memoryUsedMiB: 34000 })]), 'small') // 15,152 free
  assert.equal(selected([gpu({ memoryTotalMiB: 81920, memoryUsedMiB: 75000 })]), 'refused:insufficient_memory') // 6,920 free
})

test('7. free memory below the smallest need is refused with the exact need, free and shortfall', () => {
  const result = selectTier([gpu({ memoryTotalMiB: 12288, memoryUsedMiB: 2288 })], shippedTiers(), null)
  assert.equal(result.ok, false)
  if (result.ok || result.reason !== 'insufficient_memory') throw new Error(`wrong result: ${JSON.stringify(result)}`)
  assert.equal(result.tier, 'small')
  assert.equal(result.needMiB, 14590)
  assert.equal(result.freeMiB, 10000)
  assert.equal(result.shortfallMiB, 4590)
  for (const figure of ['14590', '10000', '4590']) assert.ok(result.message.includes(figure), result.message)
})

test('8. refusals come in order, with boundaries accepted and capabilities compared as numbers', () => {
  const old = { driverVersion: '579.99', computeCapability: '7.0', memoryUsedMiB: 24000 }
  const cases: [Gpu[], string][] = [
    [[], 'refused:no_gpu'],
    [[gpu(old), gpu({ ...old, index: 1 })], 'refused:multiple_gpus'],
    [[gpu(old)], 'refused:driver_too_old'],
    [[gpu({ driverVersion: '579.99.01' })], 'refused:driver_too_old'],
    [[gpu({ computeCapability: '7.4', memoryUsedMiB: 24000 })], 'refused:gpu_too_old'],
    [[gpu({ computeCapability: '6.1' })], 'refused:gpu_too_old'],
    [[gpu({ driverVersion: '580', computeCapability: '7.5' })], 'large'],
    [[gpu({ driverVersion: '580.65.06', computeCapability: '7.5' })], 'large'],
    [[gpu({ computeCapability: '10.0' })], 'large'],
    [[gpu({ computeCapability: '12.0' })], 'large'],
    [[gpu({ memoryUsedMiB: 24000 })], 'refused:insufficient_memory'],
  ]
  for (const [gpus, expected] of cases) assert.equal(selected(gpus), expected, JSON.stringify(gpus))
})

test('9. a named tier is used when it fits, and refused by name, never replaced, when it does not', () => {
  assert.equal(selected([freeGpu(24000)], 'small'), 'small')
  assert.equal(selected([freeGpu(24000)], 'medium'), 'medium')
  const result = selectTier([freeGpu(15000)], shippedTiers(), 'large')
  assert.equal(result.ok, false)
  if (result.ok || result.reason !== 'insufficient_memory') throw new Error(`wrong result: ${JSON.stringify(result)}`)
  assert.equal(result.tier, 'large')
  assert.equal(result.needMiB, 21492)
  assert.equal(result.freeMiB, 15000)
  assert.equal(result.shortfallMiB, 6492)
  assert.ok(result.message.includes('large'), result.message)
})

test('M2. selection uses the need with the embedding and reranker servers: 20,000 MiB free gets medium, 14,000 gets nothing', () => {
  assert.equal(selected([freeGpu(20000)]), 'medium')
  const result = selectTier([freeGpu(14000)], shippedTiers(), null)
  if (result.ok || result.reason !== 'insufficient_memory') throw new Error(`wrong result: ${JSON.stringify(result)}`)
  assert.equal(result.tier, 'small')
  assert.equal(result.needMiB, 14590)
  assert.equal(result.shortfallMiB, 590)
  assert.ok(result.message.includes('small'), result.message)
})
