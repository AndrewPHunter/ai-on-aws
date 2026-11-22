// V06 to V09. The index with vectors: its definition and identity; an embed report for other chunks; bulk requests cut
// at 8 MB; and a count of documents with a vector that differs from the report.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { bulkBodies, indexChunks } from '../src/search/indexing.ts';
import { indexName } from '../src/search/mapping.ts';
import { DOCUMENT_RECIPE, QUERY_INSTRUCTION } from '../src/vectors/recipe.ts';
import { command } from './support/command.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { startModelStandIn } from './support/model-standin.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import { DIMENSIONS, REPOSITORY, REVISION, embedArgs, embedEnv } from './support/vectors.ts';

async function embedded(t: TestContext, chunks: number) {
  const where = await folders(t);
  await writeChunks(where.dataDir, chunks);
  const model = await startModelStandIn(t);
  const outcome = await command(embedArgs(where.dataDir), embedEnv(model));
  assert.equal(outcome.code, 0, outcome.err.join('\n'));
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine } = testEngine(standIn.url);
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: () => {} });
  return { where, standIn, fake, run };
}

test('V06. with vectors: embedding and hasVector in the definition, the vector left out of _source, the identity in _meta; another name', async (t) => {
  const { where, standIn, fake, run } = await embedded(t, 3);
  const report = JSON.parse(await readFile(join(where.dataDir, 'embed-report.json'), 'utf8')) as { vectorFilesSha256: string };

  const outcome = await run();

  assert.equal(outcome.changed, 'built');
  assert.deepEqual(fake.alias(), [outcome.index]);
  const created = standIn.received.find((r) => r.method === 'PUT');
  const mappings = (created?.body as { mappings: Record<string, unknown> }).mappings;
  const properties = mappings.properties as Record<string, unknown>;
  assert.deepEqual(properties.embedding, { type: 'knn_vector', dimension: DIMENSIONS });
  assert.deepEqual(properties.hasVector, { type: 'boolean' });
  assert.deepEqual(mappings._source, { excludes: ['embedding'] });
  assert.deepEqual(mappings._meta, {
    embedding: { repository: REPOSITORY, revision: REVISION, dimensions: DIMENSIONS, recipe: DOCUMENT_RECIPE, instruction: QUERY_INSTRUCTION, vectorsSha256: report.vectorFilesSha256 },
  });
  // Every document carries its vector and hasVector.
  const documents = standIn.received
    .filter((r) => r.path === '/_bulk')
    .flatMap((r) => r.raw.split('\n').filter((line) => line !== '' && !line.startsWith('{"index"')))
    .map((line) => JSON.parse(line) as { hasVector: boolean; embedding: number[] });
  assert.equal(documents.length, 3);
  assert.ok(documents.every((document) => document.hasVector && document.embedding.length === DIMENSIONS));
  // The same chunks without vectors are another index.
  assert.notEqual(outcome.index, indexName(await readFile(join(where.dataDir, 'chunk-report.json'))));
});

test('V06. without an embed report: no vector fields, and _meta records null', async (t) => {
  const where = await folders(t);
  await writeChunks(where.dataDir, 2);
  const standIn = await startSearchStandIn(t);
  standIn.answer(fakeEngine().handle);
  const outcome = await indexChunks({ engine: testEngine(standIn.url).engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: () => {} });
  assert.equal(outcome.changed, 'built');
  const mappings = (standIn.received.find((r) => r.method === 'PUT')?.body as { mappings: Record<string, unknown> }).mappings;
  assert.deepEqual(mappings._meta, { embedding: null });
  assert.equal('embedding' in (mappings.properties as object), false);
});

test('V07. an embed report for other chunks: exit 1, nothing built, the alias unchanged', async (t) => {
  const { where, standIn } = await embedded(t, 3);
  // A new chunk run after the embedding: other text, other chunk report.
  await writeChunks(where.dataDir, 3, { text: (i) => `Invented passage ${i}, corrected.` });

  const outcome = await command(['index', '--data', where.dataDir, '--search-url', standIn.url, '--alias', 'labels', '--batch-bytes', '1500', '--timeout-ms', '30000']);

  assert.equal(outcome.code, 1);
  assert.match(outcome.out.join('\n'), /embed-report\.json was made from other chunks than the chunk report's: run knowledge\/embed\.sh again\. Nothing was built/);
  assert.deepEqual(standIn.received, []);
});

test('V08. bulk requests are cut at 8 MB and every chunk is sent exactly once', () => {
  const chunks = Array.from({ length: 30 }, (_, i) => indexedChunk(i + 1, { id: `${SET_ID}/3/sec-${i + 1}/body/1`, text: `Invented ${'x'.repeat(600_000)}` })) as { id: string }[];
  const vectors = new Map(chunks.map((chunk) => [chunk.id, Float32Array.from({ length: 1024 }, (_, i) => i / 1024)]));
  const embedding = {
    report: Buffer.from('{}'),
    identity: { repository: REPOSITORY, revision: REVISION, dimensions: 1024, recipe: DOCUMENT_RECIPE, instruction: QUERY_INSTRUCTION, vectorsSha256: 'a'.repeat(64) },
    vectorCount: 30,
    vectors,
  };
  const limit = 8 * 1024 * 1024;

  const bodies = [...bulkBodies('labels-x', chunks, embedding, limit)];

  assert.ok(bodies.length > 1);
  for (const body of bodies) assert.ok(Buffer.byteLength(body, 'utf8') <= limit, `${Buffer.byteLength(body, 'utf8')} bytes`);
  const sent = bodies.flatMap((body) => body.split('\n').filter((line) => line.startsWith('{"index"')).map((line) => (JSON.parse(line) as { index: { _id: string } }).index._id));
  assert.deepEqual([...sent].sort(), chunks.map((chunk) => chunk.id).sort());
  assert.equal(new Set(sent).size, sent.length);
});

test('V09. a count of documents with a vector that differs from the report fails the build and leaves the alias', async (t) => {
  const { fake, run } = await embedded(t, 3);
  // An older index the alias points at, to leave alone.
  fake.indexes.set('labels-00000000000000aa', new Set());
  fake.point('labels-00000000000000aa');
  fake.override((r) => r.method === 'POST' && r.path.endsWith('/_count') && JSON.stringify(r.body).includes('hasVector'), { status: 200, body: { count: 2 } });

  const outcome = await run();

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.changed, 'vectors-differed');
  assert.deepEqual(fake.alias(), ['labels-00000000000000aa']);
  assert.equal(fake.indexes.has(outcome.index), false);
});
