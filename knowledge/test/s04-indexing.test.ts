// S4. Indexing against the stand-in: every chunk is sent once; when the engine's count equals the chunks read the
// alias is moved; when it differs the alias is not moved, the new index is removed and the exit is non-zero; when
// the index already exists with the right count and the alias, nothing is sent that changes anything.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { indexChunks } from '../src/search/indexing.ts';
import { indexName } from '../src/search/mapping.ts';
import { folders } from './support/fixture.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import type { SearchRequest } from './support/search-standin.ts';

const CHANGES = new Set(['PUT', 'DELETE']);
const changing = (requests: SearchRequest[]): SearchRequest[] =>
  requests.filter((r) => CHANGES.has(r.method) || (r.method === 'POST' && !r.path.endsWith('/_count')));

test('S4. indexing: every chunk once, the alias moved, then nothing changed on a second run, and a short count refused', async (t) => {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine } = testEngine(standIn.url);
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: () => {} });

  const ids = await writeChunks(where.dataDir, 3);
  const first = await run();
  assert.equal(first.exitCode, 0);
  assert.equal(first.changed, 'built');
  const sent = standIn.received
    .filter((r) => r.path === '/_bulk')
    .flatMap((r) => r.raw.split('\n').filter((line) => line.startsWith('{"index"')).map((line) => (JSON.parse(line) as { index: { _id: string } }).index._id));
  assert.deepEqual([...sent].sort(), [...ids].sort());
  assert.deepEqual(fake.alias(), [first.index]);

  // The same chunks again: only reads.
  const before = standIn.received.length;
  const second = await run();
  assert.equal(second.exitCode, 0);
  assert.equal(second.changed, 'nothing');
  assert.equal(second.index, first.index);
  assert.deepEqual(changing(standIn.received.slice(before)), []);

  // Other chunks, and an engine that counts one short: the alias stays, the new index goes, the exit is 1.
  await writeChunks(where.dataDir, 4);
  const next = indexName(await readFile(join(where.dataDir, 'chunk-report.json')));
  fake.shortCount(next);
  const third = await run();
  assert.equal(third.exitCode, 1);
  assert.equal(third.changed, 'count-differed');
  assert.equal(third.index, next);
  assert.deepEqual(fake.alias(), [first.index]);
  assert.equal(fake.indexes.has(next), false);
  assert.ok(standIn.received.some((r) => r.method === 'DELETE' && r.path === `/${next}`));
});
