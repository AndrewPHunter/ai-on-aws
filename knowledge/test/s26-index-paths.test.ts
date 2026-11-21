// S26 (T5). The index build's other paths: the list of older indexes; the index already complete with the alias
// elsewhere (only the alias moves); the index there with the wrong count and the alias elsewhere (rebuilt); the
// alias pointing at an index with the wrong count (refused, nothing touched).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { IndexingError, indexChunks } from '../src/search/indexing.ts';
import { indexName } from '../src/search/mapping.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import type { SearchRequest } from './support/search-standin.ts';

const changing = (requests: SearchRequest[]): string[] =>
  requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || (r.method === 'POST' && !r.path.endsWith('/_count'))).map((r) => `${r.method} ${r.path}`);

async function rig(t: TestContext) {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine } = testEngine(standIn.url);
  const ids = await writeChunks(where.dataDir, 3);
  const index = indexName(await readFile(join(where.dataDir, 'chunk-report.json')));
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchSize: 2, log: () => {} });
  return { standIn, fake, ids, index, run };
}

test('S26. the older indexes are listed, sorted, without the current one', async (t) => {
  const { fake, run, index } = await rig(t);
  fake.indexes.set('labels-00000000000000bb', new Set());
  fake.indexes.set('labels-00000000000000aa', new Set());
  const outcome = await run();
  assert.equal(outcome.index, index);
  assert.deepEqual(outcome.olderIndexes, ['labels-00000000000000aa', 'labels-00000000000000bb']);
});

test('S26. the index complete and the alias elsewhere: only the alias moves', async (t) => {
  const { standIn, fake, ids, index, run } = await rig(t);
  fake.indexes.set(index, new Set(ids));
  fake.indexes.set('labels-00000000000000aa', new Set());
  fake.point('labels-00000000000000aa');

  const outcome = await run();

  assert.equal(outcome.changed, 'alias-moved');
  assert.deepEqual(fake.alias(), [index]);
  assert.deepEqual(changing(standIn.received), ['POST /_aliases']);
});

test('S26. the index there with the wrong count and the alias elsewhere: rebuilt', async (t) => {
  const { standIn, fake, ids, index, run } = await rig(t);
  fake.indexes.set(index, new Set(ids.slice(0, 1)));

  const outcome = await run();

  assert.equal(outcome.changed, 'built');
  assert.deepEqual(fake.alias(), [index]);
  assert.equal(fake.indexes.get(index)?.size, 3);
  assert.deepEqual(changing(standIn.received).slice(0, 2), [`DELETE /${index}`, `PUT /${index}`]);
});

test('S26. the alias pointing at the index with the wrong count: refused, and nothing is touched', async (t) => {
  const { standIn, fake, ids, index, run } = await rig(t);
  fake.indexes.set(index, new Set(ids.slice(0, 1)));
  fake.point(index);

  await assert.rejects(run(), (error: unknown) => error instanceof IndexingError && /has the wrong count but labels points at it/.test(error.message));

  assert.deepEqual(fake.alias(), [index]);
  assert.deepEqual(changing(standIn.received), []);
});
