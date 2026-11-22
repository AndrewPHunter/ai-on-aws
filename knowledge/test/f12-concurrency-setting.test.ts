// F12. A DailyMed concurrency setting above 4 is refused before any request is made, naming the setting; 4 is
// accepted.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { command, fetchArgs, pinArgs } from './support/command.ts'
import {
  BENCHMARK,
  benchmarkPin,
  folders,
  manifestEntry,
  serveCorpus,
  syntheticLabel,
  writeCorpus,
} from './support/fixture.ts'
import { StandIn } from './support/standin.ts'

test('F12. a DailyMed concurrency above 4 is refused before any request, naming the setting', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const label = syntheticLabel(1, 1)
  serveCorpus(standIn, [label])
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), { labels: [manifestEntry(label)], notPinned: [] })

  for (const argv of [fetchArgs(where, standIn, '5'), pinArgs(where, standIn, '5'), fetchArgs(where, standIn, '40')]) {
    const result = await command(argv)
    assert.equal(result.code, 2)
    assert.ok(result.err.some((line) => line.includes('--dailymed-concurrency')), result.err.join('\n'))
  }
  assert.equal(standIn.received.length, 0, 'a request was made')
})

test('F12. a DailyMed concurrency of 4 is accepted', async (t) => {
  const standIn = await StandIn.start(t)
  const where = await folders(t)
  const label = syntheticLabel(1, 1)
  serveCorpus(standIn, [label])
  await writeCorpus(where.corpusDir, benchmarkPin(BENCHMARK), { labels: [manifestEntry(label)], notPinned: [] })

  const result = await command(fetchArgs(where, standIn, '4'))

  assert.equal(result.code, 0, result.err.join('\n'))
  assert.equal(standIn.requestsTo('/dailymed/getFile.cfm'), 1)
})
