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

test('T3. the check image is named per checkout, so two checkouts cannot run each other\'s image', () => {
  const compose = read('toolchain/compose.yaml')
  const script = read('toolchain/check.sh')

  const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1])
  assert.deepEqual(images.length, 1, 'toolchain/compose.yaml must name exactly one image')
  assert.match(images[0] ?? '', /^ai-on-aws-toolchain-check:\$\{CHECK_IMAGE_TAG:\?/, 'the check image must take its tag from CHECK_IMAGE_TAG, with no default')
  assert.match(script, /CHECK_IMAGE_TAG="checkout-\$checkout"/, 'check.sh must derive the tag from the checkout')
  assert.match(script, /docker compose -p "\$project"/, 'check.sh must run under a project name of its own')
})
