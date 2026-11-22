// S15 (D1). The index is named from what it holds. The chunk command records the sha256 of each label's chunk file
// in its report, so a change to any chunk's text changes the report and so the index name, even when no count
// changes. The index build checks each chunk file against that hash and stops (exit 2) on a difference, and refuses
// a report that has no hashes.

import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { sha256 } from '../src/files.ts';
import { runParse } from '../src/parse/run.ts';
import { indexChunks } from '../src/search/indexing.ts';
import { command } from './support/command.ts';
import { fakeEngine, writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { writeLabels } from './support/folder.ts';
import { P4_TEXT, P6_TABLE } from './support/labels.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';

const indexArgs = (dataDir: string, url: string): string[] => [
  'index', '--data', dataDir, '--search-url', url, '--alias', 'labels', '--batch-bytes', '1500', '--timeout-ms', '5000',
];

test('S15. the chunk command records the sha256 of each chunk file it writes', async (t) => {
  const where = await folders(t);
  await writeLabels(where, [P4_TEXT, P6_TABLE]);
  await runParse({ corpusDir: where.corpusDir, dataDir: where.dataDir, log: () => {} });
  const run = await command(['chunk', '--corpus', where.corpusDir, '--data', where.dataDir, '--text-limit', '300', '--table-limit', '300']);
  assert.equal(run.code, 0, run.err.join('\n'));
  const report = JSON.parse(await readFile(join(where.dataDir, 'chunk-report.json'), 'utf8')) as {
    labels: { setId: string; version: number; status: string; sha256?: string }[];
  };
  for (const label of report.labels) {
    const bytes = await readFile(join(where.dataDir, 'chunks', label.setId, `${label.version}.jsonl`));
    assert.equal(label.sha256, sha256(bytes), label.setId);
  }
});

test('S15. new text with the same counts is a new index, built and moved to; not "nothing to change"', async (t) => {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  const { engine } = testEngine(standIn.url);
  const run = () => indexChunks({ engine, dataDir: where.dataDir, alias: 'labels', batchBytes: 1500, log: () => {} });

  await writeChunks(where.dataDir, 3);
  const first = await run();
  assert.equal(first.changed, 'built');

  // A parser fix changes one chunk's text; every count stays the same.
  await writeChunks(where.dataDir, 3, { text: (i) => (i === 2 ? 'Invented passage 2, corrected.' : `Invented passage ${i}.`) });
  const second = await run();
  assert.notEqual(second.index, first.index);
  assert.equal(second.changed, 'built');
  assert.deepEqual(fake.alias(), [second.index]);
});

test('S15. a chunk file that differs from the hash in the report stops the build with exit 2, before anything is sent', async (t) => {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  const fake = fakeEngine();
  standIn.answer(fake.handle);
  await writeChunks(where.dataDir, 3);
  await appendFile(join(where.dataDir, 'chunks', SET_ID, '3.jsonl'), '\n');

  const run = await command(indexArgs(where.dataDir, standIn.url));

  assert.equal(run.code, 2);
  assert.match(run.err.join('\n'), new RegExp(`chunks/${SET_ID}/3\\.jsonl does not match the sha256 in the chunk report: run knowledge/chunk\\.sh again`));
  assert.deepEqual(standIn.received, []);
});

test('S15. a chunk report without the hashes is refused with the reason, exit 2', async (t) => {
  const where = await folders(t);
  const standIn = await startSearchStandIn(t);
  standIn.answer(fakeEngine().handle);
  await writeChunks(where.dataDir, 3, { hashes: false });

  const run = await command(indexArgs(where.dataDir, standIn.url));

  assert.equal(run.code, 2);
  assert.match(run.err.join('\n'), /chunk-report\.json records no sha256 for the chunk file of .*: run knowledge\/chunk\.sh again/);
  assert.deepEqual(standIn.received, []);
});
