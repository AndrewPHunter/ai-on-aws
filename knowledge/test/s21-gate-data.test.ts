// S21 (D7). The gate reads the data the index was built from without ever putting label text on its output: a chunk
// line, a chunk report or a benchmark question that is not JSON stops the gate as "could not run", naming the file
// and the line, not quoting it.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { CouldNotRun, readData, readQuestions } from '../src/gate/data.ts';
import { folders } from './support/fixture.ts';
import { SET_ID, indexedChunk } from './support/retrieval.ts';

async function dataWith(t: Parameters<typeof folders>[0], chunkLines: string[]) {
  const where = await folders(t);
  await mkdir(join(where.dataDir, 'chunks', SET_ID), { recursive: true });
  await writeFile(join(where.dataDir, 'chunks', SET_ID, '3.jsonl'), `${chunkLines.join('\n')}\n`);
  await writeFile(join(where.dataDir, 'chunk-report.json'), JSON.stringify({ chunks: { total: chunkLines.length }, labels: [{ setId: SET_ID, version: 3, status: 'chunked' }] }));
  await writeFile(join(where.corpusDir, 'manifest.json'), JSON.stringify({ labels: [{ setId: SET_ID }] }));
  return where;
}

function refusedWithout(text: RegExp, said: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof CouldNotRun, String(error));
    assert.match(error.message, said);
    assert.doesNotMatch(error.message, text);
    return true;
  };
}

test('S21. the data reads when every line is JSON', async (t) => {
  const where = await dataWith(t, [JSON.stringify(indexedChunk(1)), JSON.stringify(indexedChunk(2))]);
  const data = readData(where.dataDir, where.corpusDir);
  assert.equal(data.totalChunks, 2);
  assert.equal(data.firstSetId, SET_ID);
});

test('S21. a chunk line that is not JSON: could not run, naming the file and line, quoting nothing', async (t) => {
  const where = await dataWith(t, [JSON.stringify(indexedChunk(1)), '{"text":"Invented passage cut sho']);
  assert.throws(() => readData(where.dataDir, where.corpusDir), refusedWithout(/Invented/, new RegExp(`chunks/${SET_ID}/3\\.jsonl line 2 is not JSON`)));
});

test('S21. a chunk report that is not JSON: could not run, naming the file', async (t) => {
  const where = await dataWith(t, [JSON.stringify(indexedChunk(1))]);
  await writeFile(join(where.dataDir, 'chunk-report.json'), '{"chunks": Invented');
  assert.throws(() => readData(where.dataDir, where.corpusDir), refusedWithout(/Invented/, /chunk-report\.json is not JSON/));
});

test('S21. a benchmark question that is not JSON: could not run, naming the file and line', async (t) => {
  const where = await folders(t);
  await mkdir(join(where.dataDir, 'benchmark'), { recursive: true });
  await writeFile(join(where.dataDir, 'benchmark', 'qa.jsonl'), `${JSON.stringify({ qid: 1, question: 'Invented question?' })}\n{"question": "Invented, cut\n`);
  assert.throws(() => readQuestions(where.dataDir), refusedWithout(/Invented/, /benchmark\/qa\.jsonl line 2 is not JSON/));
});
