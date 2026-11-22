// S14. When the engine's answer to a bulk request reports an error for any item, the run fails: the alias is not
// moved, the index it made is removed, the exit is non-zero, and the output gives the number of items that failed and
// the engine's error type for the first, with no label text. This holds even if the final count happens to match.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { indexChunks } from '../src/search/indexing.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';

test('S14. a refused bulk item fails the run, though the count matches', async (t) => {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine } = testEngine(standIn.url);
  const lines: string[] = [];
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: (line) => lines.push(line) });

  // A complete index first, so there is an alias to leave alone.
  await writeChunks(where.dataDir, 3);
  const first = await run();
  assert.equal(first.exitCode, 0);

  // Other chunks; the engine refuses two items but stores every document, so its count would match.
  await writeChunks(where.dataDir, 5);
  fake.refuse(2);
  lines.length = 0;
  const outcome = await run();

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.changed, 'items-refused');
  assert.notEqual(outcome.index, first.index);
  assert.deepEqual(fake.alias(), [first.index]);
  assert.equal(fake.indexes.has(outcome.index), false);
  // The count was never the deciding test: no refresh or count was asked for after the refusal.
  assert.ok(!standIn.received.some((r) => r.path === `/${outcome.index}/_count`));
  const said = lines.join('\n');
  assert.match(said, /refused 2 items \(first error type: mapper_parsing_exception\)/);
  assert.doesNotMatch(said, /Invented|failed to parse/);
});
