import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// An exact semantic version: no range operator, wildcard, tag, URL, path or workspace protocol.
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const versions = (field: string): [string, unknown][] => {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('package.json is not a JSON object')
  const section: unknown = new Map(Object.entries(manifest)).get(field)
  if (section === undefined) return []
  if (typeof section !== 'object' || section === null) throw new Error(`package.json ${field} is not an object`)
  return Object.entries(section)
}

test('T2. every dependency and devDependency in the root package.json is an exact version', () => {
  const entries = [...versions('dependencies'), ...versions('devDependencies')]
  const loose = entries.filter(([, version]) => typeof version !== 'string' || !EXACT.test(version))
  assert.deepEqual(loose, [], `not exact versions: ${JSON.stringify(loose)}`)
})
