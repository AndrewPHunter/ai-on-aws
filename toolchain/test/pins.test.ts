import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
const digests = (text: string): string[] => [...text.matchAll(/node@sha256:([0-9a-f]{64})/g)].map((match) => match[0])

test('T1. toolchain/Dockerfile pins Node by the one digest that model/gate/compose.yaml uses', () => {
  const inDockerfile = digests(read('toolchain/Dockerfile'))
  const inGate = digests(read('model/gate/compose.yaml'))

  assert.ok(inDockerfile.length >= 1, 'toolchain/Dockerfile has no node@sha256:<64 hex> reference')
  assert.equal(new Set(inDockerfile).size, 1, `toolchain/Dockerfile names more than one digest: ${inDockerfile.join(', ')}`)
  assert.equal(inGate.length, 1, `model/gate/compose.yaml must name exactly one digest: ${inGate.join(', ')}`)
  assert.deepEqual([...new Set(inDockerfile)], inGate)
})
