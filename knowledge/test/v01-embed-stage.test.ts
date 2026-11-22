// V01 to V05. The embedding stage against the labelled model stand-in: every chunk in id order in batches of 32, the
// document text, one line per chunk, the report; an over-length batch; retries and failures; a wrong vector length
// and an unlisted model; and the same answers giving byte-identical files.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { sha256 } from '../src/files.ts';
import { DOCUMENT_RECIPE, QUERY_INSTRUCTION, decodeVector, documentText } from '../src/vectors/recipe.ts';
import { command } from './support/command.ts';
import { writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { startModelStandIn, standInVector } from './support/model-standin.ts';
import type { ModelStandInOptions } from './support/model-standin.ts';
import { SET_ID } from './support/retrieval.ts';
import { DIMENSIONS, REPOSITORY, REVISION, TEST_KEY, embedArgs, embedEnv } from './support/vectors.ts';

type Report = {
  model: { repository: string; revision: string; servedAs: string };
  dimensions: number;
  recipe: string;
  instruction: string;
  chunkReportSha256: string;
  counts: { chunks: number; vectors: number; withoutVector: number };
  withoutVector: string[];
  tokens: number;
  files: string[];
  vectorFilesSha256: string;
};

async function rig(t: TestContext, chunks: number, options: ModelStandInOptions = {}, text?: (i: number) => string) {
  const where = await folders(t);
  const ids = await writeChunks(where.dataDir, chunks, text === undefined ? {} : { text });
  const model = await startModelStandIn(t, options);
  const sleeps: number[] = [];
  const run = () => command(embedArgs(where.dataDir), embedEnv(model), sleeps);
  const vectorPath = join(where.dataDir, 'vectors', SET_ID, '3.jsonl');
  const reportPath = join(where.dataDir, 'embed-report.json');
  return { where, ids, model, sleeps, run, vectorPath, reportPath };
}

const embedRequests = (model: { received: { path: string; body: unknown }[] }) => model.received.filter((r) => r.path === '/v1/embeddings');
const inputsOf = (body: unknown): string[] => (Reflect.get(body as object, 'input') as string[]) ?? [];

test('V01. every chunk in id order, in batches of 32, as <context>\\n<text>; one line per chunk; the report', async (t) => {
  const { where, ids, model, run, vectorPath, reportPath } = await rig(t, 40);

  const outcome = await run();

  assert.equal(outcome.code, 0, outcome.err.join('\n'));
  const sorted = [...ids].sort();
  const chunks = (await readFile(join(where.dataDir, 'chunks', SET_ID, '3.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { id: string; text: string; context: string });
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const expectedInputs = sorted.map((id) => {
    const chunk = byId.get(id);
    assert.ok(chunk !== undefined);
    return `${chunk.context}\n${chunk.text}`;
  });

  const requests = embedRequests(model);
  assert.deepEqual(requests.map((r) => inputsOf(r.body).length), [32, 8]);
  assert.deepEqual(requests.flatMap((r) => inputsOf(r.body)), expectedInputs);
  for (const request of requests) {
    assert.equal(Reflect.get(request.body as object, 'model'), 'test-embedding');
    assert.equal(Reflect.get(request.body as object, 'encoding_format'), 'base64');
  }
  assert.ok(model.received.every((r) => r.authorization === `Bearer ${TEST_KEY}`));
  assert.equal(documentText({ text: 'b', context: 'a' }), 'a\nb');
  assert.equal(documentText({ text: 'b', context: '' }), 'b');

  const vectorBytes = await readFile(vectorPath);
  const lines = vectorBytes.toString('utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { id: string; vector: string });
  assert.deepEqual(lines.map((line) => line.id), sorted);
  lines.forEach((line, at) => {
    const vector = decodeVector(line.vector);
    assert.equal(vector.length, DIMENSIONS);
    assert.deepEqual(Array.from(vector), standInVector(expectedInputs[at] ?? '', DIMENSIONS));
  });

  const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
  assert.deepEqual(report.model, { repository: REPOSITORY, revision: REVISION, servedAs: 'test-embedding' });
  assert.equal(report.dimensions, DIMENSIONS);
  assert.equal(report.recipe, DOCUMENT_RECIPE);
  assert.equal(report.instruction, QUERY_INSTRUCTION);
  assert.equal(report.chunkReportSha256, sha256(await readFile(join(where.dataDir, 'chunk-report.json'))));
  assert.deepEqual(report.counts, { chunks: 40, vectors: 40, withoutVector: 0 });
  assert.deepEqual(report.withoutVector, []);
  assert.ok(report.tokens > 0);
  assert.deepEqual(report.files, [`${SET_ID}/3.jsonl`]);
  assert.equal(report.vectorFilesSha256, sha256(vectorBytes));
});

test('V02. a batch refused as over-length: the passage responsible gets no vector and is named; the others get theirs', async (t) => {
  const { ids, model, run, reportPath, vectorPath } = await rig(t, 5, { maxInputCharacters: 200 }, (i) => (i === 3 ? `Invented ${'long '.repeat(60)}` : `Invented passage ${i}.`));
  const long = ids[2] ?? '';

  const outcome = await run();

  assert.equal(outcome.code, 0, outcome.err.join('\n'));
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
  assert.deepEqual(report.counts, { chunks: 5, vectors: 4, withoutVector: 1 });
  assert.deepEqual(report.withoutVector, [long]);
  const written = (await readFile(vectorPath, 'utf8')).split('\n').filter((line) => line !== '').map((line) => (JSON.parse(line) as { id: string }).id);
  assert.deepEqual(written, [...ids].sort().filter((id) => id !== long));
  // The batch, then each of its five passages alone.
  assert.deepEqual(embedRequests(model).map((r) => inputsOf(r.body).length), [5, 1, 1, 1, 1, 1]);
  assert.match(outcome.out.join('\n'), new RegExp(`without a vector \\(over-length\\): ${long.replace(/[/.]/g, '\\$&')}`));
});

test('V03. 503 twice then 200 is retried and succeeds, with the waits given', async (t) => {
  const { model, run, sleeps } = await rig(t, 3);
  model.queue('/v1/embeddings', { status: 503 }, { status: 503 });
  const outcome = await run();
  assert.equal(outcome.code, 0, outcome.err.join('\n'));
  assert.equal(embedRequests(model).length, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test('V03. 503 three times fails the run with exit 1 and writes no report; an old report is removed', async (t) => {
  const { model, run, reportPath } = await rig(t, 3);
  await writeFile(reportPath, '{"an":"old report"}\n');
  model.queue('/v1/embeddings', { status: 503 }, { status: 503 }, { status: 503 });
  const outcome = await run();
  assert.equal(outcome.code, 1);
  assert.equal(existsSync(reportPath), false);
  assert.equal(embedRequests(model).length, 3);
});

test('V03. a 400 that is not over-length fails at once', async (t) => {
  const { model, run, reportPath } = await rig(t, 3);
  model.queue('/v1/embeddings', { status: 400, body: { error: { message: 'unknown field "dimensions"', type: 'BadRequestError', code: 400 } } });
  const outcome = await run();
  assert.equal(outcome.code, 1);
  assert.equal(embedRequests(model).length, 1);
  assert.equal(existsSync(reportPath), false);
});

test('V04. a vector of the wrong length stops the run', async (t) => {
  const { run, reportPath } = await rig(t, 3, { returnedDimensions: DIMENSIONS - 1 });
  const outcome = await run();
  assert.equal(outcome.code, 1);
  assert.match(outcome.out.join('\n'), /a vector of other than 8 numbers/);
  assert.equal(existsSync(reportPath), false);
});

test('V04. a server that does not list the model stops the run before any vector is asked for', async (t) => {
  const { model, run, reportPath } = await rig(t, 3, { models: ['another-model'] });
  const outcome = await run();
  assert.equal(outcome.code, 2);
  assert.match(outcome.err.join('\n'), /does not list the model test-embedding/);
  assert.equal(embedRequests(model).length, 0);
  assert.equal(existsSync(reportPath), false);
});

test('V04. a model setting missing from the environment is named, exit 2', async (t) => {
  const where = await folders(t);
  await writeChunks(where.dataDir, 2);
  const model = await startModelStandIn(t);
  const outcome = await command(embedArgs(where.dataDir), embedEnv(model, { EMBED_DIMENSIONS: undefined }));
  assert.equal(outcome.code, 2);
  assert.match(outcome.err.join('\n'), /^EMBED_DIMENSIONS is not set/);
});

test('V05. the same chunks and the same answers give byte-identical vector files and report', async (t) => {
  const first = await rig(t, 35);
  const second = await rig(t, 35);
  assert.equal((await first.run()).code, 0);
  assert.equal((await second.run()).code, 0);
  assert.deepEqual(await readFile(first.vectorPath), await readFile(second.vectorPath));
  assert.deepEqual(await readFile(first.reportPath), await readFile(second.reportPath));
  // And again in the same folder.
  const before = await readFile(first.reportPath);
  assert.equal((await first.run()).code, 0);
  assert.deepEqual(await readFile(first.reportPath), before);
});
