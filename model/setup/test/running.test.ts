import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runningVerdict } from '../lib/running.ts'

test('M7. the running-server guard refuses when any one of the three servers is running, and names it', () => {
  assert.deepEqual(runningVerdict(''), { ok: true })
  assert.deepEqual(runningVerdict('\n'), { ok: true })
  // A one-off download container of the same project is not a server.
  assert.deepEqual(runningVerdict('download-embed\n'), { ok: true })

  for (const service of ['chat', 'embed', 'rerank']) {
    const verdict = runningVerdict(`${service}\n`)
    if (verdict.ok) throw new Error(`${service} running was accepted`)
    assert.deepEqual(verdict.running, [service])
    assert.ok(verdict.message.includes(service), verdict.message)
  }
  const two = runningVerdict('rerank\ndownload\nchat\n')
  if (two.ok) throw new Error('chat and rerank running was accepted')
  assert.deepEqual(two.running, ['chat', 'rerank'])
  for (const service of ['chat', 'rerank']) assert.ok(two.message.includes(service), two.message)
})
