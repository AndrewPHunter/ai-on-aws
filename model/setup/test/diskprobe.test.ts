import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDiskProbe } from '../lib/disk.ts'

const GOOD =
  'owner 1000 1001\n' +
  'cache /dev/nvme0n1p2      1906751 1203511    606355      67% /c\n' +
  'docker overlay           937838  512034    378130      58% /\n' +
  'weights present\n' +
  'embed-weights present\n' +
  'rerank-weights absent\n'

test('20. the disk probe output parses to the exact figures; malformed output is an error', () => {
  assert.deepEqual(parseDiskProbe(GOOD), {
    ok: true,
    probe: { ownerUid: 1000, ownerGid: 1001, cacheFreeMiB: 606355, dockerFreeMiB: 378130, weightsPresent: true, embedWeightsPresent: true, rerankWeightsPresent: false },
  })
  assert.deepEqual(parseDiskProbe(GOOD.replace('weights present', 'weights absent')), {
    ok: true,
    probe: { ownerUid: 1000, ownerGid: 1001, cacheFreeMiB: 606355, dockerFreeMiB: 378130, weightsPresent: false, embedWeightsPresent: true, rerankWeightsPresent: false },
  })
  const malformed = [
    '', // nothing
    GOOD.replace('weights present\n', ''), // a line missing
    `${GOOD}weights absent\n`, // a line twice
    GOOD.replace('owner 1000 1001', 'owner 1000'), // owner without gid
    GOOD.replace('owner 1000 1001', 'owner alice 1001'), // owner not numeric
    GOOD.replace('606355', 'lots'), // free space not numeric
    GOOD.replace('docker overlay           937838  512034    378130      58% /', 'docker overlay 378130'), // not a df -P line
    GOOD.replace('weights present', 'weights maybe'), // unknown weights state
    `${GOOD}extra line\n`, // unexpected line
  ]
  for (const output of malformed) assert.equal(parseDiskProbe(output).ok, false, JSON.stringify(output))
})
