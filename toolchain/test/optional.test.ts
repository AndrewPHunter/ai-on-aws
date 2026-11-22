import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

const flag = (entry: unknown, name: string): boolean =>
  typeof entry === 'object' && entry !== null && new Map(Object.entries(entry)).get(name) === true

test('T5. a piece\'s run-time install omits dev and optional packages, and no package in the lockfile is optional without also being dev', () => {
  const lock: unknown = JSON.parse(read('package-lock.json'))
  const packages: unknown = typeof lock === 'object' && lock !== null ? new Map(Object.entries(lock)).get('packages') : undefined
  if (typeof packages !== 'object' || packages === null) throw new Error('package-lock.json has no packages')
  // Omitting optional packages at run time must never drop one a piece needs: every optional package is dev too.
  const optionalOnly = Object.entries(packages)
    .filter(([path, entry]) => path !== '' && flag(entry, 'optional') && !flag(entry, 'dev') && !flag(entry, 'devOptional'))
    .map(([path]) => path)
  assert.deepEqual(optionalOnly, [], `optional packages a piece could need at run time: ${optionalOnly.join(', ')}`)

  const dockerfile = read('toolchain/Dockerfile')
  const stage = /^FROM\s+\S+\s+AS\s+run-deps\s*$([\s\S]*?)(?=^FROM\s)/m.exec(dockerfile)?.[1] ?? ''
  const installs = stage.split('\n').filter((line) => /^RUN\s+npm\s+ci\b/.test(line))
  assert.equal(installs.length, 1, 'the run-deps stage must have exactly one npm ci')
  assert.match(installs[0] ?? '', /\s--omit=dev(\s|$)/, 'the run-deps install must omit dev packages')
  assert.match(installs[0] ?? '', /\s--omit=optional(\s|$)/, 'the run-deps install must omit optional packages')
})
