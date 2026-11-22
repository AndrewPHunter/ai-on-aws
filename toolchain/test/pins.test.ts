import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
const digests = (text: string): string[] => [...text.matchAll(/node@sha256:([0-9a-f]{64})/g)].map((match) => match[0])

// Every other tracked file that pins a Node image. Each must name the Dockerfile's digest and no other.
const OTHER_NODE_PINS = [
  'model/gate/compose.yaml',
  'model/setup.sh',
  'model/setup/run-tests.sh',
  'platform/identity/gate/compose.yaml',
  'platform/identity/setup.sh',
]

test('T1. the Node pin is one digest: toolchain/Dockerfile and every other file that pins Node name the same one', () => {
  const inDockerfile = [...new Set(digests(read('toolchain/Dockerfile')))]
  assert.equal(inDockerfile.length, 1, `toolchain/Dockerfile must name exactly one digest: ${inDockerfile.join(', ')}`)
  for (const file of OTHER_NODE_PINS) {
    assert.deepEqual([...new Set(digests(read(file)))], inDockerfile, `${file} does not pin Node by the Dockerfile's digest alone`)
  }
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
