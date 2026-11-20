import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseProbe } from '../lib/probe.ts'

test('3. probe output for one GPU, two GPUs and none parses to the exact values', () => {
  assert.deepEqual(parseProbe('0, NVIDIA GeForce RTX 3090 Ti, 24564, 18402, 595.91.07, 8.6\n'), {
    ok: true,
    gpus: [
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 3090 Ti',
        memoryTotalMiB: 24564,
        memoryUsedMiB: 18402,
        driverVersion: '595.91.07',
        computeCapability: '8.6',
      },
    ],
  })
  assert.deepEqual(parseProbe('0, NVIDIA RTX A4000, 16376, 3, 580.65.06, 8.6\n1, Tesla T4, 15360, 120, 580.65.06, 7.5\n'), {
    ok: true,
    gpus: [
      { index: 0, name: 'NVIDIA RTX A4000', memoryTotalMiB: 16376, memoryUsedMiB: 3, driverVersion: '580.65.06', computeCapability: '8.6' },
      { index: 1, name: 'Tesla T4', memoryTotalMiB: 15360, memoryUsedMiB: 120, driverVersion: '580.65.06', computeCapability: '7.5' },
    ],
  })
  assert.deepEqual(parseProbe(''), { ok: true, gpus: [] })
  assert.deepEqual(parseProbe('\n'), { ok: true, gpus: [] })
})

test('4. malformed probe output is an error', () => {
  const malformed = [
    '0, NVIDIA GeForce RTX 3090 Ti, 24564, 18402, 595.91.07', // missing field
    '0, NVIDIA GeForce RTX 3090 Ti, 24564 MiB, 18402 MiB, 595.91.07, 8.6', // units not stripped
    '0, NVIDIA GeForce RTX 3090 Ti, [N/A], 18402, 595.91.07, 8.6', // non-numeric total memory
    '0, NVIDIA GeForce RTX 3090 Ti, 24564, unknown, 595.91.07, 8.6', // non-numeric used memory
    '0, NVIDIA GeForce RTX 3090 Ti, 24564, 18402, 595.91.07, 8.6, extra', // extra field
    '0, NVIDIA GeForce RTX 3090 Ti, 24564, 18402, 595.91.07, 8.6\n1, Tesla T4, 15360, 120, 580.65.06', // one good, one bad
  ]
  for (const output of malformed) {
    assert.equal(parseProbe(output).ok, false, output)
  }
})
