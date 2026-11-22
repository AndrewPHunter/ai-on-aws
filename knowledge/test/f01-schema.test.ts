// F1. The manifest and the benchmark pin are validated against a schema, and a refusal names where.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateBenchmarkPin, validateManifest } from '../src/schema.ts'
import { benchmarkPin, guid, jsonl, manifestEntry, syntheticLabel } from './support/fixture.ts'

const validManifest = () => ({
  labels: [manifestEntry(syntheticLabel(1, 2)), manifestEntry(syntheticLabel(2, 5))],
  notPinned: [{ setId: '', drugId: 'example_drug', reason: 'set-id-not-a-guid' }],
})

const validPin = () => benchmarkPin({ labels: jsonl([{ a: 1 }]), qa: jsonl([{ b: 2 }]) })

const problems = (result: { ok: true } | { ok: false; problems: string[] }): string[] => (result.ok ? [] : result.problems)

test('F1. a valid manifest and a valid benchmark pin pass', () => {
  assert.equal(validateManifest(validManifest()).ok, true)
  assert.equal(validateBenchmarkPin(validPin()).ok, true)
})

test('F1. a missing field is refused, naming where', () => {
  const manifest = validManifest()
  const { documentId: _dropped, ...withoutDocumentId } = manifest.labels[1] ?? manifestEntry(syntheticLabel(9, 1))
  const broken = { ...manifest, labels: [manifest.labels[0], withoutDocumentId] }
  const found = problems(validateManifest(broken))
  assert.ok(found.some((p) => p.startsWith('labels[1].documentId')), found.join('\n'))

  const pin = validPin()
  const { sha256: _gone, ...qaWithoutSha } = pin.files.qa
  const foundPin = problems(validateBenchmarkPin({ ...pin, files: { ...pin.files, qa: qaWithoutSha } }))
  assert.ok(foundPin.some((p) => p.startsWith('files.qa.sha256')), foundPin.join('\n'))
})

test('F1. a checksum that is not 64 hex characters is refused, naming where', () => {
  for (const bad of ['abc', 'g'.repeat(64), 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
    const manifest = validManifest()
    const [first, second] = manifest.labels
    assert.ok(first && second)
    const found = problems(validateManifest({ ...manifest, labels: [first, { ...second, zipSha256: bad }] }))
    assert.ok(found.some((p) => p.startsWith('labels[1].zipSha256')), `${bad}: ${found.join('\n')}`)

    const pin = validPin()
    const foundPin = problems(
      validateBenchmarkPin({ ...pin, files: { ...pin.files, labels: { ...pin.files.labels, sha256: bad } } }),
    )
    assert.ok(foundPin.some((p) => p.startsWith('files.labels.sha256')), `${bad}: ${foundPin.join('\n')}`)
  }
})

test('F1. a set id that is not a GUID is refused, naming where', () => {
  for (const bad of ['', 'not-a-guid', guid(0xabcdef).toUpperCase(), `${guid(1)}x`, `../${guid(1)}`]) {
    const manifest = validManifest()
    const [first, second] = manifest.labels
    assert.ok(first && second)
    const found = problems(validateManifest({ ...manifest, labels: [{ ...first, setId: bad }, second] }))
    assert.ok(found.some((p) => p.startsWith('labels[0].setId')), `${JSON.stringify(bad)}: ${found.join('\n')}`)
  }
})

test('F1. a duplicated set id is refused, naming where', () => {
  const manifest = validManifest()
  const [first, second] = manifest.labels
  assert.ok(first && second)
  const found = problems(validateManifest({ ...manifest, labels: [first, second, { ...second, version: 7 }] }))
  assert.ok(found.some((p) => p.startsWith('labels[2].setId') && p.includes('labels[1]')), found.join('\n'))
})
