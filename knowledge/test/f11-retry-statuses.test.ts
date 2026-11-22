// F11. A status of 408 and a status of 429 are each tried again and then succeed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { testClient } from './support/fixture.ts'
import { StandIn } from './support/standin.ts'

for (const status of [408, 429]) {
  test(`F11. a ${status} is tried again and then succeeds`, async (t) => {
    const standIn = await StandIn.start(t)
    standIn.on(`/dailymed/s${status}`, { status }, { status }, { status: 200, body: 'answered' })
    const { client, waits } = testClient()

    const result = await client.get(`${standIn.dailymedBase}/s${status}`, 1024, new Error('too large'))

    assert.equal(result.status, 'ok')
    if (result.status === 'ok') assert.equal(result.body.toString(), 'answered')
    assert.equal(standIn.requestsTo(`/dailymed/s${status}`), 3)
    assert.deepEqual(waits, [100, 400])
  })
}
