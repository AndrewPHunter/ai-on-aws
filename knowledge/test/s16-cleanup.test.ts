// S16 (D2). Any failure after the new index is created removes it before the run ends, and leaves the alias as it
// was: a bulk request refused as a whole (429, 413), a bulk request that times out, a failed refresh, a failed count,
// a create that times out, and an alias move that times out. If the removal itself fails, the run says so and names
// the index left behind.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IndexingError, indexChunks } from '../src/search/indexing.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply, SearchRequest } from './support/search-standin.ts';

type Row = { name: string; matches: (request: SearchRequest) => boolean; reply: SearchReply };

const rows: Row[] = [
  { name: 'a bulk request refused as a whole with 429', matches: (r) => r.path === '/_bulk', reply: { status: 429, body: { error: 'too many requests' } } },
  { name: 'a bulk request refused as a whole with 413', matches: (r) => r.path === '/_bulk', reply: { status: 413, body: { error: 'too large' } } },
  { name: 'a bulk request that times out', matches: (r) => r.path === '/_bulk', reply: 'hold' },
  { name: 'a refresh that fails', matches: (r) => r.path.endsWith('/_refresh'), reply: { status: 500, body: { error: 'internal' } } },
  { name: 'a count that fails', matches: (r) => r.method === 'GET' && r.path.endsWith('/_count') && r.path !== '/labels/_count', reply: { status: 500, body: { error: 'internal' } } },
  { name: 'a create that times out', matches: (r) => r.method === 'PUT', reply: 'hold' },
  { name: 'an alias move that times out', matches: (r) => r.path === '/_aliases', reply: 'hold' },
];

async function rig(t: Parameters<typeof folders>[0]) {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine, expire } = testEngine(standIn.url);
  standIn.onHold(expire);
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: () => {} });
  await writeChunks(where.dataDir, 3);
  const first = await run();
  assert.equal(first.changed, 'built');
  // Other chunks, so the next run builds a new index.
  await writeChunks(where.dataDir, 4);
  return { standIn, fake, run, first };
}

for (const row of rows) {
  test(`S16. ${row.name}: the new index is removed and the alias left as it was`, async (t) => {
    const { standIn, fake, run, first } = await rig(t);
    // Index creations made by the second run are counted from here.
    const before = standIn.received.length;
    fake.override(row.matches, row.reply);

    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof IndexingError);
      assert.match(error.message, /removed, labels left as it was/);
      return true;
    });

    assert.deepEqual(fake.alias(), [first.index]);
    assert.deepEqual([...fake.indexes.keys()], [first.index]);
    const created = standIn.received.slice(before).find((r) => r.method === 'PUT');
    assert.ok(created !== undefined);
    assert.ok(standIn.received.slice(before).some((r) => r.method === 'DELETE' && r.path === created.path));
  });
}

test('S16. a removal that fails is said, and names the index left behind', async (t) => {
  const { fake, run, first } = await rig(t);
  fake.override((r) => r.path === '/_bulk', { status: 429, body: { error: 'too many requests' } });
  fake.override((r) => r.method === 'DELETE', { status: 500, body: { error: 'internal' } });

  await assert.rejects(run(), (error: unknown) => {
    assert.ok(error instanceof IndexingError);
    assert.match(error.message, /could not be removed \(the search engine answered with status 500\): labels-[0-9a-f]{16} is left behind; labels left as it was/);
    return true;
  });
  assert.deepEqual(fake.alias(), [first.index]);
});

test('S16. an alias move that times out but was made: the run reads the alias again and does not remove the index it points at', async (t) => {
  const { standIn, fake, run } = await rig(t);
  // The engine makes the move, and the answer never arrives.
  let made = false;
  fake.override((r) => {
    if (r.path !== '/_aliases' || made) return false;
    made = true;
    fake.handle(r);
    return true;
  }, 'hold');
  const before = standIn.received.length;

  const outcome = await run();

  assert.equal(outcome.changed, 'built');
  assert.deepEqual(fake.alias(), [outcome.index]);
  assert.ok(fake.indexes.has(outcome.index));
  assert.ok(!standIn.received.slice(before).some((r) => r.method === 'DELETE'));
});
