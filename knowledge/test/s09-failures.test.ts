// S9. Failures, one row each: the engine does not answer in time; refuses the connection; answers 500; answers 200
// with something that is not a search result; the alias does not exist. Each is an error result that says which,
// never an empty list.

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { findLabels, searchLabel } from '../src/search/tools.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { indexNotFound, startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply } from './support/search-standin.ts';

// A loopback port with nothing listening on it.
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

const rows: { name: string; reply: SearchReply | 'refuse'; error: string }[] = [
  { name: 'does not answer in time', reply: 'hold', error: 'search_timed_out' },
  { name: 'refuses the connection', reply: 'refuse', error: 'search_unreachable' },
  { name: 'answers 500', reply: { status: 500, body: { error: 'internal' } }, error: 'search_error' },
  { name: 'answers 200 with something that is not a search result', reply: { status: 200, body: { took: 3, results: [] } }, error: 'search_unexpected_answer' },
  { name: 'has no such alias', reply: indexNotFound, error: 'index_not_built' },
];

for (const row of rows) {
  test(`S9. the engine ${row.name}`, async (t) => {
    const standIn = await startSearchStandIn(t);
    const url = row.reply === 'refuse' ? await closedPort() : standIn.url;
    const { engine, expire } = testEngine(url);
    if (row.reply !== 'refuse') {
      const reply = row.reply;
      standIn.answer(() => reply);
    }
    // A held request ends when the test ends its deadline: no clock is waited on.
    standIn.onHold(expire);

    const searched = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });
    assert.equal(searched.ok, false, 'search_label');
    if (!searched.ok) assert.equal(searched.error.error, row.error);

    const found = await findLabels(engine, 'labels', { drug: 'Examplamab' });
    assert.equal(found.ok, false, 'find_labels');
    if (!found.ok) assert.equal(found.error.error, row.error);
  });
}
