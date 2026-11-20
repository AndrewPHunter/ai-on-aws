import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diskVerdict, type DiskInput } from '../lib/disk.ts'

const BASE: DiskInput = {
  weightsPresent: false,
  cacheFreeMiB: 50000,
  downloadMiB: 11000,
  imagePresent: false,
  dockerFreeMiB: 50000,
  imageDiskMiB: 37000,
}

function short(input: Partial<DiskInput>): string[] {
  const verdict = diskVerdict({ ...BASE, ...input })
  return verdict.ok ? [] : verdict.shortfalls.map((s) => `${s.what} ${s.needMiB} ${s.freeMiB} ${s.shortfallMiB}`)
}

test('17. disk verdict demands space only for what is absent', () => {
  // weights absent, too little cache space: refused, naming the weights with need, free and shortfall
  assert.deepEqual(short({ cacheFreeMiB: 10999 }), ['weights 11000 10999 1'])
  assert.deepEqual(short({ cacheFreeMiB: 11000 }), [])
  // weights present: no cache space needed
  assert.deepEqual(short({ weightsPresent: true, cacheFreeMiB: 0 }), [])
  // image absent, too little Docker space: refused, naming the image
  assert.deepEqual(short({ dockerFreeMiB: 36999 }), ['image 37000 36999 1'])
  assert.deepEqual(short({ dockerFreeMiB: 37000 }), [])
  // image present: no Docker space needed
  assert.deepEqual(short({ imagePresent: true, dockerFreeMiB: 0 }), [])
  // both short: both named
  assert.deepEqual(short({ cacheFreeMiB: 100, dockerFreeMiB: 200 }), ['weights 11000 100 10900', 'image 37000 200 36800'])
  const verdict = diskVerdict({ ...BASE, cacheFreeMiB: 100 })
  if (verdict.ok) throw new Error('expected a refusal')
  for (const figure of ['11000', '100', '10900']) assert.ok(verdict.shortfalls[0].message.includes(figure), verdict.shortfalls[0].message)
})
