// F7. Requests: never more than 4 at once; a 503 and a dropped connection are tried again and then succeed; a
// 404 is not tried again; three failures in a row give up; every request carries the generic User-Agent.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TransportError } from '../src/http.ts'
import { USER_AGENT, testClient } from './support/fixture.ts'
import { StandIn } from './support/standin.ts'

const TOO_LARGE = new Error('too large')

test('F7. never more than 4 requests at once', async (t) => {
  const standIn = await StandIn.start(t)
  const total = 10
  for (let i = 0; i < total; i++) standIn.on(`/dailymed/item/${i}`, { status: 200, body: `item ${i}` })
  // The stand-in holds requests until 4 are waiting (or all that remain), then answers them together.
  standIn.park(4, total)

  // Counts calls into the transport that have not finished. A client that ignored its cap would make all ten
  // calls at once, before the stand-in could answer any of them.
  let inFlight = 0
  let most = 0
  const counting: typeof fetch = async (input, init) => {
    inFlight++
    most = Math.max(most, inFlight)
    try {
      const response = await fetch(input, init)
      const body = await response.arrayBuffer()
      return new Response(body, { status: response.status, headers: response.headers })
    } finally {
      inFlight--
    }
  }
  const { client } = testClient({ fetch: counting, maxConcurrent: 4 })

  const results = await Promise.all(
    Array.from({ length: total }, (_, i) => client.get(`${standIn.dailymedBase}/item/${i}`, 1024, TOO_LARGE)),
  )

  assert.equal(most, 4)
  assert.equal(standIn.received.length, total)
  results.forEach((result, i) => {
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') assert.equal(result.body.toString(), `item ${i}`)
  })
})

test('F7. a 503 and a dropped connection are tried again, with growing waits, and then succeed', async (t) => {
  const standIn = await StandIn.start(t)
  standIn.on('/dailymed/flaky', { status: 503 }, 'drop', { status: 200, body: 'finally' })
  const { client, waits } = testClient()

  const result = await client.get(`${standIn.dailymedBase}/flaky`, 1024, TOO_LARGE)

  assert.equal(result.status, 'ok')
  if (result.status === 'ok') assert.equal(result.body.toString(), 'finally')
  assert.equal(standIn.requestsTo('/dailymed/flaky'), 3)
  assert.deepEqual(waits, [100, 400])
})

test('F7. a 404 is not tried again', async (t) => {
  const standIn = await StandIn.start(t)
  standIn.on('/dailymed/gone', { status: 404 }, { status: 200, body: 'should not be reached' })
  const { client, waits } = testClient()

  const result = await client.get(`${standIn.dailymedBase}/gone`, 1024, TOO_LARGE)

  assert.deepEqual(result, { status: 'not-found' })
  assert.equal(standIn.requestsTo('/dailymed/gone'), 1)
  assert.deepEqual(waits, [])
})

test('F7. three failures in a row give up', async (t) => {
  const standIn = await StandIn.start(t)
  standIn.on('/dailymed/down', { status: 503 }, 'drop', { status: 500 }, { status: 200, body: 'too late' })
  const { client, waits } = testClient()

  await assert.rejects(client.get(`${standIn.dailymedBase}/down`, 1024, TOO_LARGE), TransportError)
  assert.equal(standIn.requestsTo('/dailymed/down'), 3)
  assert.deepEqual(waits, [100, 400])
})

test('F7. every request carries the generic User-Agent', async (t) => {
  const standIn = await StandIn.start(t)
  standIn.on('/dailymed/a', { status: 200, body: 'a' })
  standIn.on('/dailymed/b', { status: 503 }, { status: 200, body: 'b' })
  standIn.on('/raw/c', { status: 404 })
  const { client } = testClient()

  await client.get(`${standIn.dailymedBase}/a`, 1024, TOO_LARGE)
  await client.get(`${standIn.dailymedBase}/b`, 1024, TOO_LARGE)
  await client.get(`${standIn.rawBase}/c`, 1024, TOO_LARGE)

  assert.equal(standIn.received.length, 4)
  assert.deepEqual(
    standIn.received.map((request) => request.userAgent),
    [USER_AGENT, USER_AGENT, USER_AGENT, USER_AGENT],
  )
})
