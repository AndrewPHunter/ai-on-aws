import assert from 'node:assert/strict'
import { test } from 'node:test'

import { healthVerdict } from '../lib/health.ts'

test('22. health verdict: starting waits under the limit, healthy is ready, every failure has its own reason', () => {
  assert.deepEqual(healthVerdict('running starting', 0), { verdict: 'wait' })
  assert.deepEqual(healthVerdict('running starting', 890), { verdict: 'wait' })
  assert.deepEqual(healthVerdict('running healthy', 30), { verdict: 'ready' })
  assert.deepEqual(healthVerdict('running healthy\n', 900), { verdict: 'ready' })

  const failures: [string | null, number][] = [
    ['exited unhealthy', 120],
    ['running unhealthy', 120],
    [null, 120],
    ['running starting', 900],
  ]
  const reasons = failures.map(([state, seconds]) => {
    const verdict = healthVerdict(state, seconds)
    assert.equal(verdict.verdict, 'failed', `${String(state)} at ${seconds}s`)
    return verdict.verdict === 'failed' ? verdict.reason : ''
  })
  assert.equal(new Set(reasons).size, failures.length, `reasons are not distinct: ${reasons.join(' | ')}`)
  assert.ok(reasons[0].includes('exited'), reasons[0])
  assert.ok(reasons[1].includes('unhealthy'), reasons[1])
  assert.ok(reasons[2].includes('could not be read'), reasons[2])
  assert.ok(reasons[3].includes('900'), reasons[3])
})
