import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

test('19. the Node image is pinned to the same digest in setup.sh, run-tests.sh and gate/compose.yaml', () => {
  const pins = (relative: string): string[] => [...new Set(read(relative).match(/node@sha256:[0-9a-f]{64}/g) ?? [])]
  const inGate = pins('gate/compose.yaml')
  assert.equal(inGate.length, 1, `gate/compose.yaml pins: ${inGate.join(', ')}`)
  assert.deepEqual(pins('setup.sh'), inGate, 'setup.sh')
  assert.deepEqual(pins('setup/run-tests.sh'), inGate, 'setup/run-tests.sh')
})

test('M10. compose.yaml names exactly one server image, pinned by digest, for all of its services', () => {
  const images = [...read('compose.yaml').matchAll(/^\s*image:\s*(\S+)/gm)].map((match) => match[1])
  assert.equal(images.length, 1, `compose.yaml image lines: ${images.join(', ')}`)
  assert.match(images[0] ?? '', /^vllm\/vllm-openai@sha256:[0-9a-f]{64}$/)
})
